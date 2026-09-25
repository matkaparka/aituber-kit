// helixus-dance: 跳舞。public/dance/<名字>/{motion.vrma, music.ogg|mp3|wav, meta.json}，加新舞不改代码。
//
// 流程：请求（LLM 标签 [motion:dance] / 弹幕桥礼物点舞 / 控制台 playDance）→ pending（等这轮话说完）
//   → loading（读动作和音乐）→ playing（淡入后动作和音乐按同一个音频时钟对齐）
//   → ending（最后 danceFadeOut 秒淡回默认底姿、音乐淡出）→ after（给 LLM 发「刚跳完舞」，等他开口）→ idle
// 期间：TTS 暂停（model.speak 等 waitIdle）、表情固定开心、liveLayer 身体层让开、弹簧骨加阻尼、
// 根骨骼水平位移限幅、画面角落显示署名；状态上报给弹幕桥（helixusDancing），桥暂停转发。
import * as THREE from 'three'
import { create } from 'zustand'
import type {
  VRM,
  VRMHumanBoneName,
  VRMSpringBoneJoint,
} from '@pixiv/three-vrm'
import { VRMAnimation } from '@/lib/VRMAnimation/VRMAnimation'
import { loadVRMAnimation } from '@/lib/VRMAnimation/loadVRMAnimation'
import { buildUrl } from '@/utils/buildUrl'
import { logger } from '@/lib/logger'
import homeStore from '@/features/stores/home'
import { MOTION, type MotionDirector } from './motionDirector'

export interface DanceMeta {
  title: string
  offset: number // 音乐相对动作第 0 帧的偏移（秒），正数 = 音乐晚于动作开始
  bpm: number
  speed: number // 动作整体调速倍率
  volume: number
  credit: string
  enabled: boolean
}

export interface DanceInfo {
  name: string
  motion: string
  music: string | null
  meta: DanceMeta
}

type Phase = 'idle' | 'pending' | 'loading' | 'playing' | 'ending' | 'after'

interface DanceState {
  phase: Phase
  current: DanceInfo | null
  lastName: string | null
  lastEndAt: number // 上一支跳完的时间（ms），冷却从这里算
}

const LAST_END_KEY = 'helixus-dance-last-end'
const SKIP_BONES: VRMHumanBoneName[] = ['leftEye', 'rightEye', 'jaw'] // 交给程序层和口型

const readLastEnd = () => {
  try {
    return Number(window.localStorage.getItem(LAST_END_KEY)) || 0
  } catch {
    return 0
  }
}

export const danceStore = create<DanceState>(() => ({
  phase: 'idle',
  current: null,
  lastName: null,
  lastEndAt: typeof window === 'undefined' ? 0 : readLastEnd(),
}))

/** 弹幕桥要知道的「在跳舞」：从排队等跳到跳完后 LLM 开口之前都算 */
export const isDancing = () => danceStore.getState().phase !== 'idle'

const num = (v: unknown, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : d

const normalizeMeta = (name: string, raw: unknown): DanceMeta => {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  return {
    title: typeof m.title === 'string' && m.title ? m.title : name,
    offset: num(m.offset, 0),
    bpm: num(m.bpm, 0),
    speed: num(m.speed, 1) > 0 ? num(m.speed, 1) : 1,
    volume: Math.max(0, num(m.volume, 1)),
    credit: typeof m.credit === 'string' ? m.credit : '',
    enabled: m.enabled !== false,
  }
}

let listCache: { at: number; list: DanceInfo[] } | null = null

/** public/dance 下的舞（maxAge 毫秒内用缓存；加新舞后最多这么久生效） */
export async function loadDanceList(maxAge = 15000): Promise<DanceInfo[]> {
  if (listCache && Date.now() - listCache.at < maxAge) return listCache.list
  try {
    const res = await fetch(buildUrl('/api/get-motion-clips') + '?dir=dance')
    const raw: {
      name: string
      motion: string
      music: string | null
      meta: unknown
    }[] = res.ok ? await res.json() : []
    const list = raw.map((d) => ({ ...d, meta: normalizeMeta(d.name, d.meta) }))
    listCache = { at: Date.now(), list }
    return list
  } catch (e) {
    logger.warn('helixus-dance: dance list unavailable', e)
    return listCache?.list ?? []
  }
}

/** 冷却还剩多少秒 */
export const danceCooldownLeft = (now = Date.now()) =>
  Math.max(
    0,
    (danceStore.getState().lastEndAt + MOTION.danceCooldown * 1000 - now) / 1000
  )

export type DanceAvailability =
  | { ok: true; dances: DanceInfo[] }
  | { ok: false; reason: 'none' | 'busy' | 'cooldown'; cooldownLeft: number }

export async function danceAvailability(): Promise<DanceAvailability> {
  const dances = (await loadDanceList()).filter((d) => d.meta.enabled)
  const cooldownLeft = danceCooldownLeft()
  if (dances.length === 0) return { ok: false, reason: 'none', cooldownLeft }
  if (isDancing()) return { ok: false, reason: 'busy', cooldownLeft }
  if (cooldownLeft > 0) return { ok: false, reason: 'cooldown', cooldownLeft }
  return { ok: true, dances }
}

const minutes = (sec: number) => Math.max(1, Math.ceil(sec / 60))

/** 追加到系统提示词：能跳时说明 dance 标签怎么用，冷却中让他按人设拒绝 */
export async function dancePromptLine(): Promise<string> {
  const a = await danceAvailability()
  if (a.ok) {
    return (
      '[motion:dance]：跳一支完整的舞（放音乐，约一两分钟，跳的时候不说话）。' +
      '只在观众明确要你跳舞时用，一次回复最多一次；和别的动作标签一样写在句子开头，' +
      '放在最后一句话的开头，例如「[happy][motion:dance]看好了，小东西。」（不要写在句子末尾，末尾的标签会被忽略）。' +
      '跳完系统会提醒你收尾。'
    )
  }
  if (a.reason === 'cooldown') {
    return (
      `跳舞现在不行：你刚跳过，还要约 ${minutes(a.cooldownLeft)} 分钟才能再跳。` +
      '观众要看跳舞就按人设拒绝（「刚跳过，别得寸进尺」这个方向），不要写 [motion:dance]。'
    )
  }
  return ''
}

export type DanceRequestResult =
  | 'ok'
  | 'busy'
  | 'cooldown'
  | 'none'
  | 'notfound'

interface MusicNodes {
  source: AudioBufferSourceNode
  gain: GainNode
}

export class DanceController {
  private ctx?: AudioContext
  private action?: THREE.AnimationAction
  private clips = new Map<string, THREE.AnimationClip>()
  private music?: MusicNodes
  private clock: () => number = () => performance.now() / 1000
  private t0 = 0
  private speed = 1
  private duration = 0
  private endAt = 0
  private pendingSince = 0
  private afterUntil = 0
  private requester?: string
  private noOutro = false
  private tuning = false // 微调面板的试播：不发收尾消息、不计冷却
  private offset = 0
  private musicStart = 0 // 音乐起播时刻（音频时钟）；微调 offset 时音乐不动，挪动作
  private token = 0
  private springBackup = new Map<
    VRMSpringBoneJoint,
    { dragForce: number; stiffness: number }
  >()
  private waiters: (() => void)[] = []
  private hips: THREE.Object3D | null
  private restXZ = new THREE.Vector2()
  private _d = new THREE.Vector2()

  constructor(
    private vrm: VRM,
    private mixer: THREE.AnimationMixer,
    private director: MotionDirector,
    private isAudioActive: () => boolean
  ) {
    this.hips = vrm.humanoid.getNormalizedBoneNode('hips')
    const rest = vrm.humanoid.normalizedRestPose.hips?.position
    if (rest) this.restXZ.set(rest[0], rest[2])
  }

  // ---------------------------------------------------------------- 请求
  /**
   * source=dev（控制台 playDance）不受冷却和 enabled 限制。
   * 成功后进入 pending：等这一轮的话（包括带标签的那句）说完才开跳
   */
  async request(opts: {
    source: 'tag' | 'gift' | 'dev'
    name?: string
    requester?: string
    tuning?: boolean
  }): Promise<DanceRequestResult> {
    if (isDancing()) return 'busy'
    const force = opts.source === 'dev'
    const list = await loadDanceList(force ? 0 : 15000)
    let pick: DanceInfo | undefined
    if (opts.name) {
      pick = list.find((d) => d.name === opts.name)
      if (!pick) return 'notfound'
      if (!force && !pick.meta.enabled) return 'none'
    } else {
      const enabled = list.filter((d) => d.meta.enabled)
      if (enabled.length === 0) return 'none'
      const last = danceStore.getState().lastName
      const pool =
        enabled.length > 1 ? enabled.filter((d) => d.name !== last) : enabled
      pick = pool[Math.floor(Math.random() * pool.length)]
    }
    if (!force && danceCooldownLeft() > 0) return 'cooldown'
    if (isDancing()) return 'busy' // 读列表期间别处已经开始了
    this.requester = opts.requester
    this.tuning = !!opts.tuning
    this.noOutro = this.tuning
    this.pendingSince = performance.now()
    danceStore.setState({ phase: 'pending', current: pick })
    logger.log(`helixus-dance: ${pick.name} requested (${opts.source})`)
    return 'ok'
  }

  /** 紧急停止：排队 / 读取中直接取消；正在跳就 0.5 秒淡出，不发收尾消息 */
  stop() {
    const phase = danceStore.getState().phase
    if (phase === 'pending' || phase === 'loading') {
      this.token++
      this.toIdle()
    } else if (phase === 'playing') {
      this.noOutro = true
      this.beginEnding(0.5)
    }
  }

  /**
   * 微调面板用：播放中实时改 offset / speed。音乐已经按原 offset 起播、不再移动，
   * 所以改 offset 挪的是动作时间轴（动作时间 = (音乐时间 + offset) × speed）
   */
  tune(p: { offset?: number; speed?: number }) {
    if (p.offset !== undefined) {
      this.offset = p.offset
      this.t0 = this.musicStart - p.offset
    }
    if (p.speed !== undefined && p.speed > 0) this.speed = p.speed
  }

  /** 当前播放位置（微调面板显示用）；没在跳时 null */
  get playback(): {
    offset: number
    speed: number
    motionTime: number
    duration: number
  } | null {
    const phase = danceStore.getState().phase
    if (phase !== 'playing' && phase !== 'ending') return null
    return {
      offset: this.offset,
      speed: this.speed,
      motionTime: Math.max(0, this.clock() - this.t0) * this.speed,
      duration: this.duration,
    }
  }

  /** TTS 在跳舞期间暂停：读取、跳、淡出这几个阶段里，model.speak 先等这里 */
  waitIdle(): Promise<void> {
    const phase = danceStore.getState().phase
    if (phase !== 'loading' && phase !== 'playing' && phase !== 'ending') {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** 跳舞时脸上固定的表情；不跳时 null */
  get faceOverride(): string | null {
    const phase = danceStore.getState().phase
    return phase === 'loading' || phase === 'playing' || phase === 'ending'
      ? 'happy'
      : null
  }

  // ---------------------------------------------------------------- 每帧
  /** 在 director.update / mixer.update 之前调用：推进状态、按音频时钟设置舞蹈时间 */
  update() {
    const phase = danceStore.getState().phase
    if (phase === 'pending') {
      if (
        performance.now() - this.pendingSince >
        MOTION.dancePendingTimeout * 1000
      ) {
        logger.warn(
          'helixus-dance: waited too long for speech to end, cancelled'
        )
        this.toIdle()
        return
      }
      const hs = homeStore.getState()
      if (
        hs.chatProcessing ||
        hs.isSpeaking ||
        this.isAudioActive() ||
        this.director.oneShotActive
      ) {
        return
      }
      const info = danceStore.getState().current
      if (info) void this.start(info)
      else this.toIdle()
    } else if (phase === 'playing' || phase === 'ending') {
      const now = this.clock()
      const t = Math.max(0, now - this.t0) * this.speed
      if (this.action) this.action.time = Math.min(t, this.duration)
      if (
        phase === 'playing' &&
        (this.duration - t) / this.speed <= MOTION.danceFadeOut
      ) {
        this.beginEnding(MOTION.danceFadeOut)
      } else if (phase === 'ending' && now >= this.endAt) {
        this.finish()
      }
    } else if (phase === 'after') {
      if (
        homeStore.getState().chatProcessing ||
        performance.now() > this.afterUntil
      ) {
        danceStore.setState({ phase: 'idle' })
      }
    }
  }

  /** 在 mixer.update 之后调用：根骨骼水平位移先乘倍率，再软限幅到 danceRootClamp 以内 */
  afterMixer() {
    if (!this.hips || this.director.danceWeight <= 0) return
    const p = this.hips.position
    const d = this._d.set(p.x - this.restXZ.x, p.z - this.restXZ.y)
    d.multiplyScalar(MOTION.danceRootScale)
    const L = MOTION.danceRootClamp
    const len = d.length()
    if (L > 0 && len > 1e-6) d.multiplyScalar((L * Math.tanh(len / L)) / len)
    p.x = this.restXZ.x + d.x
    p.z = this.restXZ.y + d.y
  }

  // ---------------------------------------------------------------- 内部
  private async start(info: DanceInfo) {
    const token = ++this.token
    danceStore.setState({ phase: 'loading' })
    try {
      let clip = this.clips.get(info.motion)
      if (!clip) {
        const anim = await loadVRMAnimation(buildUrl(info.motion))
        if (!anim) throw new Error(`failed to load ${info.motion}`)
        clip = this.createClip(anim, info.name)
        this.clips.set(info.motion, clip)
      }
      const ctx = this.audioContext()
      const running = await this.resumeAudio(ctx)
      let buffer: AudioBuffer | null = null
      if (info.music && running) {
        try {
          const res = await fetch(buildUrl(info.music))
          buffer = await ctx.decodeAudioData(await res.arrayBuffer())
        } catch (e) {
          logger.warn(`helixus-dance: music failed, dancing without it`, e)
        }
      } else if (info.music) {
        logger.warn('helixus-dance: AudioContext not running, music skipped')
      }
      if (token !== this.token || danceStore.getState().phase !== 'loading') {
        return // 读取期间被 stop 了
      }

      const m = info.meta
      this.clock = running
        ? () => ctx.currentTime
        : () => performance.now() / 1000
      this.speed = m.speed
      this.duration = clip.duration
      const now = this.clock()
      // 动作第 0 帧在 t0；音乐在 t0 + offset 起播（offset 为负时整体推后，保证两者都在将来）
      this.t0 = now + MOTION.danceFadeIn + Math.max(0, -m.offset)
      this.offset = m.offset
      this.musicStart = this.t0 + m.offset
      if (buffer) {
        const source = ctx.createBufferSource()
        source.buffer = buffer
        const gain = ctx.createGain()
        gain.gain.value = m.volume
        source.connect(gain).connect(ctx.destination)
        source.start(this.t0 + m.offset)
        this.music = { source, gain }
      }
      this.action = this.mixer.clipAction(clip)
      this.director.playDance(this.action, MOTION.danceFadeIn)
      this.dampSprings(true)
      danceStore.setState({ phase: 'playing', lastName: info.name })
      logger.log(
        `helixus-dance: ${info.name} start — ${(this.duration / this.speed).toFixed(1)}s, ` +
          `speed ${this.speed}, offset ${m.offset}, music ${buffer ? 'on' : 'off'}, ` +
          `clock ${running ? 'audio' : 'performance'}`
      )
    } catch (e) {
      logger.error('helixus-dance: failed to start', e)
      if (token === this.token) this.toIdle()
    }
  }

  /** 只要人形骨骼（跳过眼球、下巴），并把 hips 第 0 帧的水平位置对齐到底姿 */
  private createClip(anim: VRMAnimation, name: string): THREE.AnimationClip {
    const humanoid = this.vrm.humanoid
    const skip = new Set(
      SKIP_BONES.map((b) => humanoid.getNormalizedBoneNode(b)?.name).filter(
        (n): n is string => !!n
      )
    )
    const tracks = anim
      .createHumanoidTracks(this.vrm)
      .filter((t) => !skip.has(t.name.slice(0, t.name.lastIndexOf('.'))))
    const hipsName = this.hips?.name
    const hipsTrack = tracks.find((t) => t.name === `${hipsName}.position`)
    if (hipsTrack && hipsTrack.values.length >= 3) {
      const dx = this.restXZ.x - hipsTrack.values[0]
      const dz = this.restXZ.y - hipsTrack.values[2]
      for (let i = 0; i < hipsTrack.values.length; i += 3) {
        hipsTrack.values[i] += dx
        hipsTrack.values[i + 2] += dz
      }
    }
    return new THREE.AnimationClip(`dance_${name}`, anim.duration, tracks)
  }

  private audioContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext()
    return this.ctx
  }

  private async resumeAudio(ctx: AudioContext): Promise<boolean> {
    if (ctx.state === 'running') return true
    try {
      await Promise.race([
        ctx.resume(),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ])
    } catch {
      // 浏览器不让自动播放：退回 performance 时钟，不放音乐
    }
    return (ctx.state as AudioContextState) === 'running'
  }

  private beginEnding(fade: number) {
    danceStore.setState({ phase: 'ending' })
    this.director.stopDance(fade)
    const now = this.clock()
    this.endAt = now + fade
    if (this.music && this.ctx) {
      const g = this.music.gain.gain
      g.cancelScheduledValues(now)
      g.setValueAtTime(g.value, now)
      g.linearRampToValueAtTime(0, now + fade)
      try {
        this.music.source.stop(now + fade + 0.05)
      } catch {
        // 还没起播就停：忽略
      }
    }
  }

  private finish() {
    this.dampSprings(false)
    this.music = undefined
    this.action = undefined
    const info = danceStore.getState().current
    // 微调试播不算一次跳舞，不开始冷却
    const lastEndAt = this.tuning ? danceStore.getState().lastEndAt : Date.now()
    if (!this.tuning) {
      try {
        window.localStorage.setItem(LAST_END_KEY, String(lastEndAt))
      } catch {
        // 存不了就只在这次页面里记
      }
    }
    logger.log(`helixus-dance: ${info?.name} finished`)
    if (this.noOutro || !info) {
      danceStore.setState({ phase: 'idle', current: null, lastEndAt })
      this.flushWaiters()
      return
    }
    // 收尾消息发出去之后，等 LLM 开始处理再把「在跳舞」撤掉，防止弹幕桥抢在前面发下一条
    this.afterUntil = performance.now() + 8000
    danceStore.setState({ phase: 'after', lastEndAt })
    this.flushWaiters()
    const who = this.requester ? `（是 ${this.requester} 点的）` : ''
    void sendInternalMessage(
      `【系统】你刚跳完一支舞「${info.meta.title}」${who}。按人设说一句收尾的话。`
    )
  }

  private toIdle() {
    danceStore.setState({ phase: 'idle', current: null })
    this.flushWaiters()
  }

  private flushWaiters() {
    const w = this.waiters
    this.waiters = []
    w.forEach((resolve) => resolve())
  }

  /** 跳舞期间弹簧骨加阻尼、加硬度，快节奏下尾巴和触手不被甩飞；跳完恢复原值 */
  private dampSprings(on: boolean) {
    const joints = this.vrm.springBoneManager?.joints
    if (!joints) return
    if (on) {
      if (this.springBackup.size > 0) return
      for (const j of joints) {
        const s = j.settings
        this.springBackup.set(j, {
          dragForce: s.dragForce,
          stiffness: s.stiffness,
        })
        s.dragForce += (1 - s.dragForce) * MOTION.danceSpringDrag
        s.stiffness *= MOTION.danceSpringStiffness
      }
    } else {
      for (const [j, s] of this.springBackup) {
        j.settings.dragForce = s.dragForce
        j.settings.stiffness = s.stiffness
      }
      this.springBackup.clear()
    }
  }
}

export const DANCE_REQUEST_PREFIX = '【点舞】'

/**
 * 弹幕桥发来的礼物点舞（「【点舞】<用户名> 送了 N 个 <礼物>，…」）。
 * 能跳就排队（这轮开场白说完后开跳）；不能跳就告诉 LLM 按人设拒绝。返回改写后给 LLM 的消息
 */
export async function handleDanceRequest(text: string): Promise<string> {
  const requester = text
    .slice(DANCE_REQUEST_PREFIX.length)
    .match(/^\s*(.+?) 送了/)?.[1]
  const dance = homeStore.getState().viewer.model?.dance
  const result = dance
    ? await dance.request({ source: 'gift', requester })
    : 'none'
  logger.log(`helixus-dance: gift request from ${requester} -> ${result}`)
  switch (result) {
    case 'ok':
      return `${text}\n（你马上就要跳舞：用一句话开场、顺便谢礼物，不要写 [motion:dance]，说完会自动开始跳。）`
    case 'cooldown':
      return (
        `${text}\n（但你刚跳过舞，还要约 ${minutes(danceCooldownLeft())} 分钟才能再跳。` +
        '按人设拒绝，「刚跳过，别得寸进尺」这个方向，礼物照样谢；不要写 [motion:dance]。）'
      )
    case 'busy':
      return `${text}\n（你已经要跳 / 正在跳了，谢一下礼物就行，不要写 [motion:dance]。）`
    default:
      return `${text}\n（现在没有能跳的舞，按人设推掉，礼物照样谢；不要写 [motion:dance]。）`
  }
}

/** 跳完舞给 LLM 的内部消息：走和聊天框输入一样的路径（带人设、进聊天记录） */
async function sendInternalMessage(text: string) {
  try {
    const { handleSendChatFn } = await import('@/features/chat/handlers')
    await handleSendChatFn()(text)
  } catch (e) {
    logger.error('helixus-dance: failed to send outro message', e)
  }
}
