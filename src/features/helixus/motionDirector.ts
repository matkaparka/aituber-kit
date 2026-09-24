// helixus-motion: 身体动作调度（待机 / 说话轮播 talk 片段 / 动作标签 one-shot）。
//
// 权重由这里每帧手动计算，不用 three.js 的 fadeIn/fadeOut：
// AnimationMixer 在所有动作的权重和小于 1 时会把缺的部分混进绑定姿势（T-pose），
// 切换瞬间身体一跳，尾巴和触手的弹簧骨就会被甩起来。这里每帧把权重归一化到和为 1。
import * as THREE from 'three'
import { VRM } from '@pixiv/three-vrm'
import { VRMAnimation } from '@/lib/VRMAnimation/VRMAnimation'
import { loadVRMAnimation } from '@/lib/VRMAnimation/loadVRMAnimation'
import { buildUrl } from '@/utils/buildUrl'
import { logger } from '@/lib/logger'
import { mirrorVRMAnimation } from './mirrorVRMAnimation'

export const MOTION = {
  talkFade: 0.4, // talk 片段之间、talk ↔ 待机的交叉淡入淡出
  oneShotFade: 0.4,
  externalFade: 0.5, // 让给 poseManager 的 json 静态姿势（和它的 FADE_DURATION 一致）
  release: 0.2, // 声音停了多久算「不说话」；+ talkFade ≈ 0.6 秒回到待机
  resumeWindow: 3, // 停下后这么久内又开口，接着播原来那段，不换新的
  minRemain: 1.5, // 随机起播点至少留这么多秒；剩余不足这个数的片段不再续播
  speed: [0.9, 1.1] as [number, number],
  idleFade: 1.5, // 待机站姿之间的交叉淡入
  baseFade: 0.35, // 从非默认站姿（抱臂等）回到底姿，再开始说话 / 标签动作
  idleSwitch: [180, 360] as [number, number], // 待机站姿轮换间隔（秒）
  defaultIdle: '/idle_loop.vrma',
}

type Kind = 'idle' | 'talk' | 'oneshot'

interface Entry {
  kind: Kind
  action: THREE.AnimationAction
  w: number
  target: number
  fade: number
  idleAge: number // 权重为 0 的时间（talk 用来判断还能不能续播）
}

interface TalkClip {
  name: string
  anim: VRMAnimation
  base: number // 原片和镜像共用同一个 base，洗牌时不让它们挨着
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)

export class MotionDirector {
  private entries: Entry[] = []
  private idle: Entry | null = null
  private talk: Entry | null = null
  private oneShot: Entry | null = null
  private oneShotDone?: () => void
  private external = 0
  private externalTarget = 0
  private silentFor = Infinity
  private clips: TalkClip[] = []
  private clipCache = new Map<TalkClip, THREE.AnimationClip>()
  private bag: number[] = []
  private lastBase = -1
  private idlePaths: string[] = [MOTION.defaultIdle]
  private idleClips = new Map<string, THREE.AnimationClip>()
  private idlePath: string | null = MOTION.defaultIdle
  private idleTimer = rand(MOTION.idleSwitch[0], MOTION.idleSwitch[1])
  private idleSwitching = false
  private defaultIdleAction?: THREE.AnimationAction

  constructor(
    private mixer: THREE.AnimationMixer,
    private vrm: VRM
  ) {}

  /** public/talk/*.vrma 全部读进来，每段再加一个镜像版本 */
  async loadTalkClips(): Promise<void> {
    try {
      const res = await fetch(buildUrl('/api/get-motion-clips') + '?dir=talk')
      const list: { name: string; path: string }[] = res.ok
        ? await res.json()
        : []
      const loaded = await Promise.all(
        list.map((item) =>
          loadVRMAnimation(buildUrl(item.path)).catch((e) => {
            logger.warn(`helixus-motion: failed to load ${item.path}`, e)
            return null
          })
        )
      )
      const clips: TalkClip[] = []
      loaded.forEach((anim, i) => {
        if (!anim) return
        clips.push({ name: list[i].name, anim, base: i })
        clips.push({
          name: list[i].name + '_mirror',
          anim: mirrorVRMAnimation(anim),
          base: i,
        })
      })
      this.clips = clips
      this.bag = []
      logger.log(`helixus-motion: ${clips.length} talk clips (incl. mirrors)`)
    } catch (e) {
      logger.warn('helixus-motion: talk clips unavailable', e)
    }
  }

  /** 待机站姿列表：/idle_loop.vrma + public/idle/*.vrma。只有一个时不轮换 */
  async loadIdleClips(): Promise<void> {
    try {
      const res = await fetch(buildUrl('/api/get-motion-clips') + '?dir=idle')
      const list: { name: string; path: string }[] = res.ok
        ? await res.json()
        : []
      this.idlePaths = [MOTION.defaultIdle, ...list.map((i) => i.path)]
      logger.log(`helixus-motion: ${this.idlePaths.length} idle poses`)
    } catch (e) {
      logger.warn('helixus-motion: idle list unavailable', e)
    }
  }

  /** 立刻换一个待机站姿（仍然只在真正待机时才换）。返回是否换了 */
  async switchIdle(): Promise<boolean> {
    const candidates = this.idlePaths.filter((p) => p !== this.idlePath)
    if (candidates.length === 0 || this.idleSwitching) return false
    const path = candidates[Math.floor(Math.random() * candidates.length)]
    this.idleSwitching = true
    try {
      let clip = this.idleClips.get(path)
      if (!clip) {
        const anim = await loadVRMAnimation(buildUrl(path))
        if (!anim) return false
        clip = anim.createAnimationClip(this.vrm)
        clip.name = `idle_${path}`
        this.idleClips.set(path, clip)
      }
      if (!this.isIdle) return false // 加载期间开口了：下次再换
      this.setIdle(this.mixer.clipAction(clip), MOTION.idleFade)
      this.idlePath = path
      logger.log(`helixus-motion: idle -> ${path}`)
      return true
    } catch (e) {
      logger.warn(`helixus-motion: failed to load idle ${path}`, e)
      return false
    } finally {
      this.idleSwitching = false
    }
  }

  /** 外部（viewer 拖放等）直接指定的待机，不在轮换列表里 */
  markExternalIdle() {
    this.idlePath = null
  }

  // ------------------------------------------------------------ 待机
  /** 换待机动作。fade=0 表示立刻切（第一次加载时） */
  setIdle(action: THREE.AnimationAction, fade = 0) {
    if (this.idle?.action === action) return
    if (!this.defaultIdleAction) this.defaultIdleAction = action // 第一次设置的就是 /idle_loop.vrma
    // fade 同时决定旧待机淡出、新待机淡入的速度（两边一样，权重和才不变）
    const f = fade > 0 ? fade : MOTION.talkFade
    if (this.idle) {
      this.idle.target = 0
      this.idle.fade = f
      if (fade <= 0) this.idle.w = 0
    }
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.enabled = true
    action.play()
    const e = this.add('idle', action, f)
    if (fade <= 0 || this.entries.length === 1) e.w = 1
    this.idle = e
  }

  get idleAction(): THREE.AnimationAction | undefined {
    return this.idle?.action
  }

  /** 待机动作当前的实际权重（liveLayer 的身体层按它让开） */
  idleWeight = 1

  /** 真正待机：没说话、没播片段、没摆 json 姿势，且没有任何过渡在进行 */
  get isIdle(): boolean {
    return (
      !this.oneShot &&
      this.externalTarget === 0 &&
      this.silentFor > MOTION.release &&
      this.entries.every(
        (e) => e === this.idle || (e.w === 0 && e.target === 0)
      )
    )
  }

  // ------------------------------------------------------------ 动作标签
  playOneShot(action: THREE.AnimationAction, onDone?: () => void) {
    if (this.oneShot && this.oneShot.action !== action) this.oneShot.target = 0
    this.oneShotDone?.()
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.reset()
    action.play()
    const existing = this.entries.find((e) => e.action === action)
    const e = existing ?? this.add('oneshot', action, MOTION.oneShotFade)
    e.target = 1
    this.oneShot = e
    this.oneShotDone = onDone
  }

  /** 立即淡出标签动作（停止按钮用） */
  stopOneShot() {
    if (!this.oneShot) return
    this.oneShot.target = 0
    this.oneShot = null
    const done = this.oneShotDone
    this.oneShotDone = undefined
    done?.()
  }

  get oneShotActive(): boolean {
    return this.oneShot !== null
  }

  // ------------------------------------------------------------ json 静态姿势
  /** poseManager 的 json 姿势接管身体时调用 true，放回时调用 false */
  setExternal(on: boolean) {
    this.externalTarget = on ? 1 : 0
  }

  // ------------------------------------------------------------ 每帧
  update(delta: number, audioPlaying: boolean) {
    const dt = Math.min(Math.max(delta, 0), 0.1)
    this.silentFor = audioPlaying ? 0 : this.silentFor + dt

    // 待机站姿轮换：到点后等到真正待机再换
    if (this.idlePaths.length > 1) {
      this.idleTimer -= dt
      if (this.idleTimer <= 0 && this.isIdle && !this.idleSwitching) {
        this.idleTimer = rand(MOTION.idleSwitch[0], MOTION.idleSwitch[1])
        void this.switchIdle()
      }
    }
    const wantTalk = this.silentFor < MOTION.release && this.clips.length > 0

    // 非默认站姿（抱臂等）直接和说话 / 标签动作混合时，中间姿势会让前臂穿过胸甲
    // （Blender 里实测：抱臂 → laugh 半程穿入 15 cm）。所以先回到底姿，再开始
    const busy = !!this.oneShot || wantTalk
    if (
      busy &&
      this.defaultIdleAction &&
      this.idle?.action !== this.defaultIdleAction
    ) {
      this.setIdle(this.defaultIdleAction, MOTION.baseFade)
      this.idlePath = MOTION.defaultIdle
    }
    const settling =
      busy &&
      this.entries.some((e) => e.kind === 'idle' && e !== this.idle && e.w > 0)
    if (this.oneShot) this.oneShot.action.paused = settling // 回底姿期间标签动作停在第一帧

    // 标签动作快播完了：开始淡出，交还给 talk / 待机
    if (
      !settling &&
      this.oneShot &&
      this.remaining(this.oneShot) <= MOTION.oneShotFade
    ) {
      this.oneShot.target = 0
      this.oneShot = null
      const done = this.oneShotDone
      this.oneShotDone = undefined
      done?.()
    }

    if (settling) {
      this.setTargets('idle')
    } else if (this.oneShot) {
      this.setTargets('oneshot')
    } else if (wantTalk) {
      this.ensureTalk()
      this.setTargets('talk')
    } else {
      this.setTargets('idle')
    }

    // talk 片段快播完了还在说话：交叉淡入下一段
    if (
      wantTalk &&
      !settling &&
      !this.oneShot &&
      this.talk &&
      this.remaining(this.talk) <= MOTION.talkFade
    ) {
      this.talk.target = 0
      this.talk.fade = MOTION.talkFade
      this.talk = this.startTalk()
      if (this.talk) this.talk.target = 1
    }

    this.external +=
      Math.sign(this.externalTarget - this.external) *
      Math.min(
        Math.abs(this.externalTarget - this.external),
        dt / MOTION.externalFade
      )

    // 各自按淡入淡出速度走向目标
    for (const e of this.entries) {
      const step = e.fade > 0 ? dt / e.fade : 1
      if (e.w < e.target) e.w = Math.min(e.target, e.w + step)
      else if (e.w > e.target) e.w = Math.max(e.target, e.w - step)
      e.idleAge = e.w === 0 && e.target === 0 ? e.idleAge + dt : 0
      // talk 完全淡出后暂停在原处，重新开口时从这里接着播（不重新开始）
      if (e.kind === 'talk') e.action.paused = e.w === 0 && e.target === 0
    }

    // 清理：权重归零且不会再用的动作停掉
    this.entries = this.entries.filter((e) => {
      const keep =
        e.w > 0 ||
        e.target > 0 ||
        e === this.idle ||
        e === this.oneShot || // 回底姿期间标签动作权重为 0，但还在排队，不能清掉
        (e.kind === 'talk' && e.idleAge < MOTION.resumeWindow)
      if (!keep) {
        e.action.stop()
        if (e === this.talk) this.talk = null
        // 为避免重复而复制出来的 clip 用完就释放
        const clip = e.action.getClip()
        if (e.kind === 'talk' && ![...this.clipCache.values()].includes(clip)) {
          this.mixer.uncacheClip(clip)
        }
      }
      return keep
    })

    // 归一化：director 管的动作总和 = 1 - external
    const sum = this.entries.reduce((s, e) => s + e.w, 0)
    const share = 1 - this.external
    let idleW = 0
    for (const e of this.entries) {
      const w = sum > 1e-4 ? (e.w / sum) * share : e === this.idle ? share : 0
      e.action.setEffectiveWeight(w)
      e.action.enabled = true
      if (e.kind === 'idle') idleW += w
    }
    this.idleWeight = idleW
  }

  // ------------------------------------------------------------ 内部
  private add(kind: Kind, action: THREE.AnimationAction, fade: number): Entry {
    const e: Entry = { kind, action, w: 0, target: 1, fade, idleAge: 0 }
    this.entries.push(e)
    return e
  }

  /** 目标变了的动作统一用 talkFade 过渡：淡入淡出同速，权重和保持 1 */
  private setTargets(active: Kind) {
    for (const e of this.entries) {
      const on =
        active === 'oneshot'
          ? e === this.oneShot
          : active === 'talk'
            ? e === this.talk
            : e === this.idle
      const target = on ? 1 : 0
      if (e.target !== target) {
        e.target = target
        e.fade = MOTION.talkFade
      }
    }
  }

  private remaining(e: Entry): number {
    const clip = e.action.getClip()
    return (clip.duration - e.action.time) / Math.max(e.action.timeScale, 0.01)
  }

  /** 要说话了：刚停下不久的那段还有得播就接着播，否则开新的一段 */
  private ensureTalk() {
    if (this.talk && this.remaining(this.talk) > MOTION.minRemain) return
    if (this.talk) this.talk.target = 0
    this.talk = this.startTalk()
  }

  private startTalk(): Entry | null {
    const clip = this.nextClip()
    if (!clip) return null
    let ac = this.clipCache.get(clip)
    if (!ac) {
      ac = clip.anim.createAnimationClip(this.vrm)
      ac.name = `talk_${clip.name}`
      this.clipCache.set(clip, ac)
    }
    let action = this.mixer.clipAction(ac)
    // 同一段的 action 还在淡出（片段很少时会遇到）：复制一份 clip，拿一个独立的 action
    if (this.entries.some((e) => e.action === action)) {
      action = this.mixer.clipAction(ac.clone())
    }
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.reset()
    action.timeScale = rand(MOTION.speed[0], MOTION.speed[1])
    action.time = rand(0, Math.max(0, ac.duration - MOTION.minRemain - 1))
    action.play()
    return this.add('talk', action, MOTION.talkFade)
  }

  /** 洗牌袋：一轮里每段各出现一次；原片和它的镜像不挨着出 */
  private nextClip(): TalkClip | null {
    if (this.clips.length === 0) return null
    if (this.bag.length === 0) {
      const idx = this.clips.map((_, i) => i)
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[idx[i], idx[j]] = [idx[j], idx[i]]
      }
      this.bag = idx
    }
    let k = this.bag.findIndex((i) => this.clips[i].base !== this.lastBase)
    if (k < 0) k = 0
    const clip = this.clips[this.bag.splice(k, 1)[0]]
    this.lastBase = clip.base
    return clip
  }
}
