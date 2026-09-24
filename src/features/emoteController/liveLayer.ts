/**
 * helixus-live: 程序动作层（身体 + 面部 + 视线）
 *
 * 叠加在待机动作上，每帧运行，不经过 LLM：
 *   - 不说话时：不规则的呼吸、隔一段随机时间换一次重心、头部缓慢漂移、
 *     眼睛偶尔瞟向一侧再回到镜头、不规则眨眼、眉毛轻微漂移
 *   - 说话时：从正在播放的语音里找重音，重音处点头 / 歪头、挑眉或皱眉、偶尔耸肩和前臂打拍子，
 *     声音越冲上身越往前压
 *   - 情绪标签切换时表情淡入淡出，而不是瞬间跳变；情绪表情期间照样眨眼
 *
 * 角度都按「模型面朝镜头」的方向定义，单位是度。要调幅度，改下面 LIVE 里的数字即可。
 */
import * as THREE from 'three'
import {
  VRM,
  VRMExpressionMorphTargetBind,
  VRMHumanBoneName,
} from '@pixiv/three-vrm'

export const LIVE = {
  enabled: true,
  bodyScale: 1.0, // 身体动作总幅度，0 = 关闭身体部分
  faceScale: 1.0, // 面部动作总幅度，0 = 关闭面部部分

  // 呼吸
  breathPeriod: [3.4, 5.0], // 每一口气的时长（秒），每次随机
  breathChest: 0.8, // 胸口起伏（度）
  breathShoulder: 0.6, // 肩膀随呼吸上下（度）

  // 重心和漂移
  swayInterval: [6, 14], // 多久换一次重心（秒）
  swayChest: 1.2, // 上身左右侧倾（度）
  driftHead: [2.5, 1.5, 1.2], // 头部缓慢漂移：左右 / 上下 / 歪头（度）

  // 说话
  talkLean: 1.8, // 声音越大上身越往前压（度）
  nodAmp: 3.5, // 重音点头（度）
  tiltAmp: 2.5, // 偶尔用歪头或转头代替点头（度）
  shrugAmp: 2.5, // 强重音时耸肩（度）
  beatForearm: 7, // 强重音时前臂抬起打拍子（度）

  // 视线
  glanceInterval: [4, 9], // 不说话时多久瞟一次（秒）
  glanceIntervalTalking: [7, 15], // 说话时多久瞟一次（秒），说话时以看镜头为主
  glanceYaw: [6, 18], // 瞟向一侧的角度（度）
  glancePitch: [-10, 4], // 上下（负数是往下看，比如看弹幕）
  headFollow: 0.35, // 头跟着视线转的比例

  // 面部
  baseLid: 0.12, // 上眼睑常态压低（半垂眼、俯视感），0 = 不压
  baseBrowDown: 0.06, // 眉毛常态微沉
  blinkInterval: [1.6, 5.5], // 两次眨眼间隔（秒），每次随机
  doubleBlink: 0.15, // 连眨两下的概率
  browAccent: 0.35, // 重音挑眉 / 皱眉幅度
  squintAccent: 0.15, // 重音时眯眼
  oneBrowChance: 0.15, // 单边挑眉的概率
  emotionScale: 1.0, // 情绪表情强度
  emotionIn: 0.15, // 情绪淡入时间常数（秒）
  emotionOut: 0.3, // 情绪淡出时间常数（秒）
}

const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised']
const FACE = [
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'browInnerUp',
  'browDownLeft',
  'browDownRight',
  'browOuterUpLeft',
  'browOuterUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
]
const BONES: VRMHumanBoneName[] = [
  'spine',
  'chest',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
]

const DEG = Math.PI / 180
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const rand = (r: number[]) => r[0] + Math.random() * (r[1] - r[0])
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]
const approach = (x: number, target: number, dt: number, tau: number) =>
  x + (target - x) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)))

/** 临界阻尼弹簧：让所有目标值平滑过渡，不会生硬地跳 */
class Spring {
  x = 0
  v = 0
  constructor(public freq: number) {}
  step(target: number, dt: number) {
    const w = 2 * Math.PI * this.freq
    const n = Math.max(1, Math.ceil((dt * w) / 0.2))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      const a = w * w * (target - this.x) - 2 * w * this.v
      this.v += a * h
      this.x += this.v * h
    }
    return this.x
  }
}

/** 一次性的起伏（点头、挑眉等）：先升后落的平滑包络，可叠加 */
class Pulses {
  private list: { t: number; tau: number; amp: number }[] = []
  add(amp: number, tau: number) {
    this.list.push({ t: 0, tau, amp })
  }
  step(dt: number) {
    let v = 0
    for (const p of this.list) {
      p.t += dt
      const u = p.t / p.tau
      v += p.amp * u * Math.exp(1 - u)
    }
    this.list = this.list.filter((p) => p.t < p.tau * 6)
    return v
  }
}

/** 不重复的缓慢漂移：几条频率互不整除的正弦叠加 */
class Drift {
  private f = [0.047, 0.083, 0.131].map((f) => f * (0.8 + 0.4 * Math.random()))
  private p = [0, 0, 0].map(() => Math.random() * Math.PI * 2)
  value(t: number) {
    return (
      (Math.sin(2 * Math.PI * this.f[0] * t + this.p[0]) +
        0.6 * Math.sin(2 * Math.PI * this.f[1] * t + this.p[1]) +
        0.35 * Math.sin(2 * Math.PI * this.f[2] * t + this.p[2])) /
      1.95
    )
  }
}

/**
 * 从正在播放的语音里提取音量、重音和一句话的开始 / 结束。
 * 重音的判断：逐个找音节的响度峰值，比最近几个音节的平均峰值明显更响的，算重读音节。
 * 这样不管 TTS 的音节之间是否停得干净，都只在真正加重的地方触发，不会每个字都点头。
 */
class Voice {
  level = 0
  talking = false
  private fast = 0
  private prevFast = 0
  private quiet = 0
  private sinceAccent = 10
  private rising = false
  private valley = 0
  private peak = 0
  private meanPeak = -1
  private firstInPhrase = false
  private buf: Float32Array

  constructor(private analyser?: AnalyserNode) {
    this.buf = new Float32Array(analyser ? analyser.fftSize : 2048)
  }

  update(dt: number, external: number | null) {
    let lv = 0
    if (external != null) {
      lv = clamp(external, 0, 1)
    } else if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.buf)
      let s = 0
      for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i]
      const db = 20 * Math.log10(Math.sqrt(s / this.buf.length) + 1e-7)
      lv = clamp((db + 48) / 33, 0, 1) // -48 dB 以下算静音，-15 dB 算满
    }
    this.prevFast = this.fast
    this.fast = approach(this.fast, lv, dt, lv > this.fast ? 0.015 : 0.06)
    this.level = approach(this.level, lv, dt, lv > this.level ? 0.05 : 0.25)

    let phraseStart = false
    let phraseEnd = false
    if (this.level > 0.12) {
      this.quiet = 0
      if (!this.talking) {
        this.talking = true
        phraseStart = true
        this.firstInPhrase = true
      }
    } else if (this.talking) {
      this.quiet += dt
      if (this.quiet > 0.4) {
        this.talking = false
        phraseEnd = true
        this.meanPeak = -1
      }
    }

    // 音节峰值：响度先涨后落，涨幅够大才算一个音节
    let accent = 0
    this.sinceAccent += dt
    if (this.fast >= this.prevFast) {
      if (!this.rising) this.valley = this.prevFast
      this.rising = true
      this.peak = this.fast
    } else if (this.rising && this.prevFast - this.fast > 0.004) {
      this.rising = false
      const pk = this.peak
      if (pk > 0.3 && pk - this.valley > 0.05) {
        if (this.meanPeak < 0) this.meanPeak = pk
        const above = pk - this.meanPeak
        if (this.sinceAccent > 0.3 && (above > 0.06 || this.firstInPhrase)) {
          accent = this.firstInPhrase ? 0.6 : clamp(0.35 + above / 0.2, 0.35, 1)
          this.sinceAccent = 0
        }
        this.firstInPhrase = false
        this.meanPeak += (pk - this.meanPeak) * 0.3
      }
    }
    return { accent, phraseStart, phraseEnd }
  }
}

interface BoneSlot {
  node: THREE.Object3D
  base: THREE.Quaternion
  out: THREE.Quaternion
}

export interface LiveState {
  emotion: string
  idleWeight: number // 待机动作当前的权重：播放动作标签的 VRMA 时会降到 0，身体层随之让开
  externalVolume: number | null
}

export class LiveLayer {
  private vrm: VRM
  private camera?: THREE.Object3D
  private voice: Voice
  private flip: boolean
  private time = Math.random() * 100
  private bones = new Map<VRMHumanBoneName, BoneSlot>()
  private face = new Set<string>()
  private emoW: Record<string, number> = {}
  private emoBinds: Record<string, Map<string, number>> = {}
  private faceKey: Record<string, string> = {}

  // 身体
  private breathPhase = Math.random()
  private breathPeriod = rand(LIVE.breathPeriod)
  private swayTarget = 0
  private swayTimer = rand(LIVE.swayInterval)
  private sway = new Spring(0.35)
  private lean = new Spring(0.8)
  private drift = [new Drift(), new Drift(), new Drift(), new Drift()]
  private headYaw = new Spring(1.2)
  private headPitch = new Spring(2.2)
  private headRoll = new Spring(1.5)
  private nod = new Pulses()
  private tilt = new Pulses()
  private turn = new Pulses()
  private shrug = new Pulses()
  private chestKick = new Pulses()
  private beatL = new Pulses()
  private beatR = new Pulses()
  private beatSide = Math.random() < 0.5
  private armL = new Spring(3)
  private armR = new Spring(3)

  // 视线
  private gazeTarget: THREE.Vector2 = new THREE.Vector2()
  private gaze: THREE.Vector2 = new THREE.Vector2()
  private glanceTimer = rand(LIVE.glanceInterval)
  private glanceHold = -1

  // 面部
  private blinkT = -1
  private blinkTimer = rand(LIVE.blinkInterval)
  private sinceBlink = 10
  private pendingDouble = false
  private blinkGap = -1
  private browUp = new Pulses()
  private browUpL = new Pulses()
  private browUpR = new Pulses()
  private browDown = new Pulses()
  private squint = new Pulses()
  private sneer = new Pulses()
  private browDrift = new Drift()

  private _v = new THREE.Vector3()
  private _w = new THREE.Vector3()
  private _q = new THREE.Quaternion()
  private _e = new THREE.Euler()

  constructor(vrm: VRM, analyser?: AnalyserNode, camera?: THREE.Object3D) {
    this.vrm = vrm
    this.camera = camera
    this.voice = new Voice(analyser)
    this.flip = vrm.meta?.metaVersion === '0'

    for (const name of BONES) {
      const node = vrm.humanoid?.getNormalizedBoneNode(name)
      if (node) {
        this.bones.set(name, {
          node,
          base: node.quaternion.clone(),
          out: node.quaternion.clone(),
        })
      }
    }

    const em = vrm.expressionManager
    const keyOf = (b: VRMExpressionMorphTargetBind) =>
      (b.primitives[0]?.uuid ?? '') + ':' + b.index
    for (const name of FACE) {
      const ex = em?.getExpression(name)
      const bind = ex?.binds.find(
        (b) => b instanceof VRMExpressionMorphTargetBind
      ) as VRMExpressionMorphTargetBind | undefined
      if (bind) {
        this.face.add(name)
        this.faceKey[name] = keyOf(bind)
      }
    }
    for (const name of EMOTIONS) {
      this.emoW[name] = 0
      const map = new Map<string, number>()
      const ex = em?.getExpression(name)
      for (const b of ex?.binds ?? []) {
        if (b instanceof VRMExpressionMorphTargetBind) {
          map.set(keyOf(b), (map.get(keyOf(b)) ?? 0) + b.weight)
        }
      }
      this.emoBinds[name] = map
    }
  }

  public update(delta: number, state: LiveState) {
    if (!LIVE.enabled) return
    const dt = clamp(delta, 0, 0.1)
    this.time += dt
    const { accent, phraseStart, phraseEnd } = this.voice.update(
      dt,
      state.externalVolume
    )
    const talking = this.voice.talking
    const emotion = state.emotion

    if (accent > 0) this.onAccent(accent, emotion)
    this.updateGaze(dt, talking, phraseStart, phraseEnd)
    this.updateBody(dt, clamp(state.idleWeight, 0, 1), talking)
    this.updateFace(dt, emotion, talking, phraseStart || phraseEnd)
  }

  // ---------------------------------------------------------------- 重音
  private onAccent(s: number, emotion: string) {
    const r = Math.random()
    if (r < 0.62) this.nod.add(LIVE.nodAmp * s, rand([0.12, 0.18]))
    else if (r < 0.82) this.tilt.add(pick([-1, 1]) * LIVE.tiltAmp * s, 0.25)
    else this.turn.add(pick([-1, 1]) * LIVE.tiltAmp * s, 0.3)
    this.chestKick.add(0.6 * s, 0.2)

    if (s > 0.75 && Math.random() < 0.3) this.shrug.add(LIVE.shrugAmp * s, 0.22)
    if (s > 0.6 && Math.random() < 0.45) {
      const both = Math.random() < 0.2
      this.beatSide = !this.beatSide
      if (both || this.beatSide) this.beatL.add(s, rand([0.18, 0.24]))
      if (both || !this.beatSide) this.beatR.add(s, rand([0.18, 0.24]))
    }

    const a = LIVE.browAccent * s
    if (emotion === 'angry') {
      this.browDown.add(a, 0.2)
      this.squint.add(LIVE.squintAccent * 1.5 * s, 0.25)
      if (Math.random() < 0.4) this.sneer.add(0.25 * s, 0.25)
    } else if (emotion === 'sad') {
      this.browUp.add(a * 0.8, 0.25)
    } else if (Math.random() < LIVE.oneBrowChance) {
      ;(Math.random() < 0.5 ? this.browUpL : this.browUpR).add(a * 1.3, 0.3)
    } else {
      this.browUp.add(a, 0.2)
      this.squint.add(LIVE.squintAccent * s, 0.2)
    }
  }

  // ---------------------------------------------------------------- 视线
  private startGlance(hold: number[]) {
    const yaw = pick([-1, 1]) * rand(LIVE.glanceYaw)
    const pitch = rand(LIVE.glancePitch)
    this.gazeTarget.set(yaw, pitch)
    this.glanceHold = rand(hold)
    if (Math.abs(yaw) > 10 && Math.random() < 0.5) this.triggerBlink()
    // 不说话时偶尔一边瞟一边单边挑眉，带点审视的意思
    if (Math.random() < 0.2) {
      ;(yaw > 0 ? this.browUpL : this.browUpR).add(LIVE.browAccent, 0.5)
      this.squint.add(LIVE.squintAccent, 0.5)
    }
  }

  private updateGaze(
    dt: number,
    talking: boolean,
    phraseStart: boolean,
    phraseEnd: boolean
  ) {
    if (this.glanceHold >= 0) {
      this.glanceHold -= dt
      if (this.glanceHold < 0) {
        this.gazeTarget.set(0, 0)
        this.glanceTimer = rand(
          talking ? LIVE.glanceIntervalTalking : LIVE.glanceInterval
        )
      }
    } else {
      this.glanceTimer -= dt
      if (phraseStart && Math.random() < 0.3) this.startGlance([0.35, 0.8])
      else if (phraseEnd && Math.random() < 0.3) this.startGlance([0.6, 1.4])
      else if (this.glanceTimer <= 0)
        this.startGlance(talking ? [0.4, 0.9] : [0.6, 1.8])
    }
    // 眼睛跳得快，像真的扫视
    this.gaze.x = approach(this.gaze.x, this.gazeTarget.x, dt, 0.035)
    this.gaze.y = approach(this.gaze.y, this.gazeTarget.y, dt, 0.035)

    const target = this.vrm.lookAt?.target
    const head = this.vrm.humanoid?.getNormalizedBoneNode('head')
    if (target && head && this.camera && target.parent === this.camera) {
      const dist = Math.max(
        0.5,
        head.getWorldPosition(this._v).distanceTo(this.camera.getWorldPosition(this._w))
      )
      target.position.set(
        dist * Math.tan(this.gaze.x * DEG),
        dist * Math.tan(this.gaze.y * DEG),
        0
      )
    }
  }

  // ---------------------------------------------------------------- 身体
  private updateBody(dt: number, idleW: number, talking: boolean) {
    const S = LIVE.bodyScale
    const torsoW = S * (0.5 + 0.5 * idleW)
    const armW = S * idleW
    const t = this.time

    // 呼吸：吸气快、呼气慢，每口气时长不同
    this.breathPhase += dt / this.breathPeriod
    if (this.breathPhase >= 1) {
      this.breathPhase -= 1
      this.breathPeriod = rand(LIVE.breathPeriod) * (talking ? 0.8 : 1)
    }
    const ph = this.breathPhase
    const warped = ph < 0.4 ? (ph / 0.4) * 0.5 : 0.5 + ((ph - 0.4) / 0.6) * 0.5
    const breath = (0.5 - 0.5 * Math.cos(warped * 2 * Math.PI)) * (talking ? 0.6 : 1)

    // 重心：隔一段随机时间换到另一侧，慢慢移过去再停住
    this.swayTimer -= dt
    if (this.swayTimer <= 0) {
      this.swayTimer = rand(LIVE.swayInterval)
      const side = this.swayTarget > 0 ? -1 : 1
      this.swayTarget = Math.random() < 0.8 ? side * rand([0.4, 1]) : rand([-0.3, 0.3])
    }
    const sway = this.sway.step(this.swayTarget, dt)
    const lean = this.lean.step(talking ? this.voice.level : 0, dt)
    const kick = this.chestKick.step(dt)

    this.setBone('spine', breath * 0.3 * LIVE.breathChest, 0, -sway * 0.4 * LIVE.swayChest, torsoW)
    this.setBone(
      'chest',
      breath * LIVE.breathChest + lean * LIVE.talkLean + kick,
      this.drift[3].value(t) * 1.0 + this.gaze.x * 0.08,
      sway * LIVE.swayChest,
      torsoW
    )

    // 头：慢漂 + 跟随视线 + 重音点头 / 歪头 / 转头
    const dh = LIVE.driftHead
    const yaw = this.headYaw.step(
      this.drift[0].value(t) * dh[0] + this.gaze.x * LIVE.headFollow + this.turn.step(dt),
      dt
    )
    const pitch = this.headPitch.step(
      this.drift[1].value(t) * dh[1] - this.gaze.y * LIVE.headFollow + this.nod.step(dt),
      dt
    )
    const roll = this.headRoll.step(
      this.drift[2].value(t) * dh[2] + this.tilt.step(dt) - sway * 0.5,
      dt
    )
    const headW = S * (0.5 + 0.5 * idleW)
    this.setBone('neck', pitch * 0.4, yaw * 0.4, roll * 0.4, headW)
    this.setBone('head', pitch * 0.6, yaw * 0.6, roll * 0.6, headW)

    // 肩：随呼吸微抬 + 强重音耸肩
    const sh = breath * LIVE.breathShoulder + this.shrug.step(dt)
    this.setBone('leftShoulder', 0, 0, sh, torsoW)
    this.setBone('rightShoulder', 0, 0, -sh, torsoW)

    // 手臂：只往离开身体的方向动（前臂抬起、上臂微微前摆外展），不会往身上贴
    const bl = this.armL.step(this.beatL.step(dt), dt)
    const br = this.armR.step(this.beatR.step(dt), dt)
    const fa = LIVE.beatForearm
    this.setBone('leftUpperArm', -bl * fa * 0.3, 0, bl * fa * 0.25, armW)
    this.setBone('rightUpperArm', -br * fa * 0.3, 0, -br * fa * 0.25, armW)
    this.setBone('leftLowerArm', 0, -bl * fa, 0, armW)
    this.setBone('rightLowerArm', 0, br * fa, 0, armW)
  }

  /** 在动画给出的姿势上，再叠加一个小旋转（x 前后、y 左右转、z 侧倾，单位度） */
  private setBone(name: VRMHumanBoneName, x: number, y: number, z: number, w: number) {
    const slot = this.bones.get(name)
    if (!slot) return
    const q = slot.node.quaternion
    // 这根骨骼这一帧如果没被动画写过，先撤掉上一帧叠加的量，避免越叠越多
    if (q.equals(slot.out)) q.copy(slot.base)
    slot.base.copy(q)
    this._e.set(x * w * DEG, y * w * DEG, z * w * DEG, 'YXZ')
    this._q.setFromEuler(this._e)
    if (this.flip) {
      this._q.x = -this._q.x
      this._q.z = -this._q.z
    }
    q.premultiply(this._q)
    slot.out.copy(q)
  }

  // ---------------------------------------------------------------- 面部
  private triggerBlink() {
    if (this.blinkT < 0 && this.blinkGap < 0 && this.sinceBlink > 0.5) {
      this.blinkT = 0
      this.pendingDouble = Math.random() < LIVE.doubleBlink
    }
  }

  /** 眨眼曲线：70ms 闭上、停 30ms、140ms 睁开；偶尔隔 80ms 再眨一次 */
  private blinkValue(dt: number) {
    this.sinceBlink += dt
    if (this.blinkGap >= 0) {
      this.blinkGap -= dt
      if (this.blinkGap < 0) this.blinkT = 0
    } else if (this.blinkT < 0) {
      this.blinkTimer -= dt
      if (this.blinkTimer <= 0) {
        this.blinkTimer = rand(LIVE.blinkInterval)
        this.triggerBlink()
      }
    }
    if (this.blinkT < 0) return 0

    this.blinkT += dt
    const close = 0.07
    const hold = 0.03
    const open = 0.14
    const t = this.blinkT
    if (t < close) return (t / close) * (t / close)
    if (t < close + hold) return 1
    if (t < close + hold + open) {
      const u = (t - close - hold) / open
      return 1 - u * (2 - u)
    }
    this.blinkT = -1
    this.sinceBlink = 0
    if (this.pendingDouble) {
      this.pendingDouble = false
      this.blinkGap = 0.08
    }
    return 0
  }

  private updateFace(dt: number, emotion: string, talking: boolean, boundary: boolean) {
    const em = this.vrm.expressionManager
    if (!em) return

    // 情绪表情淡入淡出
    const contrib = new Map<string, number>()
    for (const name of EMOTIONS) {
      const want = name === emotion ? LIVE.emotionScale : 0
      const tau = want > this.emoW[name] ? LIVE.emotionIn : LIVE.emotionOut
      this.emoW[name] = approach(this.emoW[name], want, dt, tau)
      if (em.getExpression(name)) em.setValue(name, this.emoW[name])
      this.emoBinds[name].forEach((w, k) =>
        contrib.set(k, (contrib.get(k) ?? 0) + w * this.emoW[name])
      )
    }
    const E = (name: string) => contrib.get(this.faceKey[name]) ?? 0

    if (boundary && Math.random() < 0.5) this.triggerBlink()
    const blink = this.blinkValue(dt)

    const F = LIVE.faceScale
    const surprised = this.emoW['surprised'] > 0.3
    const set = (name: string, v: number) => {
      if (!this.face.has(name)) return
      const e = E(name)
      em.setValue(name, clamp(v * F * (1 - e), 0, Math.max(0, 1 - e)))
    }

    // 眼睑：常态微垂 + 眨眼；和情绪表情里已有的闭眼量合并，保证眨眼能完全闭上又不过头
    for (const side of ['Left', 'Right']) {
      const name = 'eyeBlink' + side
      if (!this.face.has(name)) continue
      const e = E(name)
      const base = Math.max(e, surprised ? 0 : LIVE.baseLid * F)
      const want = base + (1 - base) * blink
      em.setValue(name, clamp(want - e, 0, 1))
    }

    const up = this.browUp.step(dt)
    const upL = this.browUpL.step(dt)
    const upR = this.browUpR.step(dt)
    const down = this.browDown.step(dt)
    const sq = this.squint.step(dt)
    const sn = this.sneer.step(dt)
    const drift = this.browDrift.value(this.time) * (talking ? 0.04 : 0.06)
    const baseDown = surprised ? 0 : LIVE.baseBrowDown

    set('browInnerUp', up + Math.max(0, drift))
    set('browOuterUpLeft', up * 0.7 + upL + Math.max(0, drift) * 0.5)
    set('browOuterUpRight', up * 0.7 + upR + Math.max(0, drift) * 0.5)
    set('browDownLeft', baseDown + down + Math.max(0, -drift))
    set('browDownRight', baseDown + down + Math.max(0, -drift))
    set('eyeSquintLeft', sq)
    set('eyeSquintRight', sq)
    set('noseSneerLeft', sn)
    set('noseSneerRight', sn * 0.85)
  }
}
