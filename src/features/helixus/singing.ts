// helixus-singing: 唱歌（弹幕点歌）。歌由唱歌服务（E:\aivup\singing，默认 http://127.0.0.1:8765）准备：
// vocals_final.wav（转成 Helixus 声音的人声）+ inst_final.wav（伴奏），加 LRC 歌词。
//
// 流程：每 2 秒看一眼服务队列 → 有就绪的歌、而且他闲着（没在说话 / 等 LLM / 跳舞）→ GET /next 领一首
//   → loading（下载、解码两条音轨，算人声包络、解析歌词）→ playing（在口型用的同一个 AudioContext 里
//   同时起播：伴奏直接出声；人声同时接进口型分析器，嘴型、点头只跟人声走，不被伴奏带着动）
//   → 唱完 / 被切歌 → after（给 LLM 发「刚唱完」，等他开口）→ idle。
// 期间：TTS 暂停（model.speak 先等 waitIdle）、待机站姿不轮换；人声有声时按「在说话」驱动 talk 片段轮播，
// 间奏回待机底姿；状态上报给弹幕桥（helixusSinging），桥暂停转发弹幕。
// 切歌：弹幕桥直接调服务的 /skip（只有桥知道谁是房管），这里轮询发现当前这首没了就淡出停下。
// 轮到的歌还没处理完时不等，照常聊天，处理好了再唱。
import { create } from 'zustand'
import { logger } from '@/lib/logger'
import homeStore from '@/features/stores/home'
import { helixusLiveSettings } from './liveSettings'
import { isDancing } from './dance'

type Phase = 'idle' | 'loading' | 'playing' | 'ending' | 'after'
type EndReason = 'done' | 'skipped' | 'stopped' | 'error'

export interface SongInfo {
  qid: number
  songId: number | string
  name: string
  artists: string[]
  requester: string
  duration: number
}

export interface LyricLine {
  t: number // 秒
  text: string
}

interface SingingState {
  phase: Phase
  song: SongInfo | null
  lyrics: LyricLine[]
  line: number // 当前歌词行，-1 = 还没到第一句
  serviceOk: boolean | null // null = 还没连过
  queue: { name: string; state: string; requester: string }[]
}

export const singingStore = create<SingingState>(() => ({
  phase: 'idle',
  song: null,
  lyrics: [],
  line: -1,
  serviceOk: null,
  queue: [],
}))

/** 弹幕桥要知道的「在唱歌」：从领到歌开始，到唱完后 LLM 开口之前都算 */
export const isSinging = () => singingStore.getState().phase !== 'idle'

export const SINGING = {
  pollSec: 2,
  startDelay: 0.2, // 两条音轨在 currentTime + 这么多秒同时起播
  fadeOut: 0.6, // 切歌淡出
  envFrame: 0.05, // 人声包络帧长（秒）
  envRangeDb: 30, // 比响的部分（95 分位）低这么多 dB 以内算「在唱」
  envHold: 0.5, // 唱完一句后这么久内仍算在唱（不急着回待机）
  envBridge: 0.8, // 两句之间短于这个的空隙填上
  afterTimeout: 8000, // 收尾消息发出后最多等 LLM 这么久（ms）
}

// ---------------------------------------------------------------- 纯函数（有单测）

const CREDIT_RE =
  /^\s*(作词|作曲|编曲|制作人|制作|演唱|原唱|混音|混缩|录音|母带|和声|合声|吉他|贝斯|鼓|键盘|弦乐|监制|出品|发行|企划|统筹|词|曲|编|OP|SP|Producer|Lyricist|Composer|Arranger)\s*[:：]/i

/** 解析 LRC：支持一行多个时间戳；去掉作词作曲之类的署名行和空行，按时间排序 */
export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of (text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)]
    if (stamps.length === 0) continue
    const body = raw.replace(/\[[^\]]*\]/g, '').trim()
    if (!body || CREDIT_RE.test(body)) continue
    for (const m of stamps) {
      const t = parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.'))
      if (Number.isFinite(t)) out.push({ t, text: body })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** 当前时间对应的歌词行（二分），-1 = 还没到第一句 */
export function lyricIndexAt(lines: LyricLine[], t: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * 人声包络 → 每帧「在不在唱」。相对阈值：比响的部分（RMS 的 95 分位）低 envRangeDb 以内算在唱；
 * 唱完后 envHold 秒内仍算，短于 envBridge 的换气空隙填上。间奏才会回待机，不会一句一抖
 */
export function voiceActivity(
  samples: Float32Array,
  sampleRate: number,
  opts = SINGING
): Uint8Array {
  const hop = Math.max(1, Math.round(opts.envFrame * sampleRate))
  const n = Math.floor(samples.length / hop)
  const rms = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = i * hop, e = j + hop; j < e; j++) s += samples[j] * samples[j]
    rms[i] = Math.sqrt(s / hop)
  }
  const sorted = Float32Array.from(rms).sort()
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
  const thr = Math.max(p95 * Math.pow(10, -opts.envRangeDb / 20), 1e-4)
  const act = new Uint8Array(n)
  for (let i = 0; i < n; i++) act[i] = rms[i] > thr ? 1 : 0
  // 填短空隙
  const bridge = Math.round(opts.envBridge / opts.envFrame)
  let last = -1
  for (let i = 0; i < n; i++) {
    if (!act[i]) continue
    if (last >= 0 && i - last - 1 > 0 && i - last - 1 <= bridge) {
      for (let k = last + 1; k < i; k++) act[k] = 1
    }
    last = i
  }
  // 尾部保持
  const hold = Math.round(opts.envHold / opts.envFrame)
  const out = Uint8Array.from(act)
  for (let i = 0; i < n; i++) {
    if (act[i] && (i + 1 >= n || !act[i + 1])) {
      for (let k = i + 1; k <= Math.min(n - 1, i + hold); k++) out[k] = 1
    }
  }
  return out
}

// ---------------------------------------------------------------- 服务接口

interface QueueItem {
  qid: number
  song_id: number | string
  name: string
  artists: string[]
  requester_name: string
  state: string
  duration: number
}

interface NextResponse {
  item: QueueItem | null
  vocals_url?: string
  inst_url?: string
  lyric?: string
  duration?: number
}

const baseUrl = () =>
  (helixusLiveSettings.getState().singingUrl || '').replace(/\/+$/, '')

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(baseUrl() + path, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`)
  return (await res.json()) as T
}

// ---------------------------------------------------------------- 播放

interface Nodes {
  ctx: AudioContext
  inst: AudioBufferSourceNode
  voc: AudioBufferSourceNode
  gInst: GainNode
  gVoc: GainNode
}

type AudioHandles = { ctx: AudioContext; analyser: AnalyserNode }

class SingingController {
  /** 人声轨此刻有没有在唱（Model.update 每帧读，驱动 talk 轮播） */
  voiceActive = false
  private nodes?: Nodes
  private env = new Uint8Array(0)
  private t0 = 0
  private duration = 0
  private endAt = 0
  private endReason: EndReason = 'done'
  private afterUntil = 0
  private token = 0
  private polling = false
  private waiters: (() => void)[] = []

  /** TTS 在唱歌期间暂停：读取、唱、淡出这几个阶段里，model.speak 先等这里 */
  waitIdle(): Promise<void> {
    const phase = singingStore.getState().phase
    if (phase !== 'loading' && phase !== 'playing' && phase !== 'ending') {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** 每帧（Model.update 里，director.update 之前） */
  tick() {
    const st = singingStore.getState()
    if ((st.phase === 'playing' || st.phase === 'ending') && this.nodes) {
      const now = this.nodes.ctx.currentTime
      const t = now - this.t0
      const f = Math.floor(t / SINGING.envFrame)
      this.voiceActive =
        st.phase === 'playing' && f >= 0 && f < this.env.length && !!this.env[f]
      const line = lyricIndexAt(st.lyrics, t)
      if (line !== st.line) singingStore.setState({ line })
      if (st.phase === 'playing' && t >= this.duration) this.finish('done')
      else if (st.phase === 'ending' && now >= this.endAt)
        this.finish(this.endReason)
    } else if (st.phase === 'after') {
      this.voiceActive = false
      if (
        homeStore.getState().chatProcessing ||
        performance.now() > this.afterUntil
      ) {
        singingStore.setState({
          phase: 'idle',
          song: null,
          lyrics: [],
          line: -1,
        })
      }
    } else {
      this.voiceActive = false
    }
  }

  /** 轮询服务（2 秒一次，由 HelixusSinging 组件驱动） */
  async poll() {
    if (this.polling) return
    if (!helixusLiveSettings.getState().singingEnabled) return
    this.polling = true
    try {
      const q = await api<{
        current: QueueItem | null
        items: QueueItem[]
      }>('/queue')
      singingStore.setState({
        serviceOk: true,
        queue: q.items.map((x) => ({
          name: x.name,
          state: x.state,
          requester: x.requester_name,
        })),
      })
      const st = singingStore.getState()
      if (st.phase === 'playing' && st.song) {
        // 弹幕桥切歌了：服务那边当前这首已经不是它
        if (!q.current || q.current.qid !== st.song.qid)
          this.stop('skipped', false)
      } else if (
        st.phase === 'idle' &&
        q.items.some((x) => x.state === 'ready') &&
        this.canStart()
      ) {
        const n = await api<NextResponse>('/next')
        if (n.item) await this.start(n)
      }
    } catch (e) {
      if (singingStore.getState().serviceOk !== false) {
        logger.warn('helixus-singing: service unreachable', e)
      }
      singingStore.setState({ serviceOk: false })
    } finally {
      this.polling = false
    }
  }

  /** 切歌 / 停止。notify=true 时顺便告诉服务（设置页按钮）；桥切的歌服务已经知道了 */
  stop(reason: EndReason = 'stopped', notify = true) {
    const st = singingStore.getState()
    if (notify && st.song) void api('/skip', { method: 'POST' }).catch(() => {})
    if (st.phase === 'loading') {
      this.token++
      this.toIdle()
    } else if (st.phase === 'playing' && this.nodes) {
      const { ctx, gInst, gVoc, inst, voc } = this.nodes
      const now = ctx.currentTime
      for (const g of [gInst.gain, gVoc.gain]) {
        g.cancelScheduledValues(now)
        g.setValueAtTime(g.value, now)
        g.linearRampToValueAtTime(0, now + SINGING.fadeOut)
      }
      for (const s of [inst, voc]) {
        try {
          s.stop(now + SINGING.fadeOut + 0.05)
        } catch {
          // 还没起播
        }
      }
      this.endAt = now + SINGING.fadeOut
      this.endReason = reason
      singingStore.setState({ phase: 'ending' })
      logger.log(`helixus-singing: stopping (${reason})`)
    }
  }

  private canStart(): boolean {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState !== 'visible'
    ) {
      return false // 隐藏的标签页（比如开发用的内置浏览器）不抢歌
    }
    const hs = homeStore.getState()
    const model = hs.viewer.model
    return (
      !!model?.lipSyncAudio &&
      !hs.chatProcessing &&
      !hs.isSpeaking &&
      !model.audioActive &&
      !isDancing()
    )
  }

  private async start(n: NextResponse) {
    const item = n.item!
    const token = ++this.token
    const song: SongInfo = {
      qid: item.qid,
      songId: item.song_id,
      name: item.name,
      artists: item.artists || [],
      requester: item.requester_name || '',
      duration: n.duration || item.duration || 0,
    }
    singingStore.setState({ phase: 'loading', song, lyrics: [], line: -1 })
    try {
      const audio = homeStore.getState().viewer.model?.lipSyncAudio
      if (!audio) throw new Error('no model / lip sync')
      const { ctx, analyser } = audio
      if (!(await resumeAudio(ctx))) throw new Error('AudioContext not running')
      const [instBuf, vocBuf] = await Promise.all([
        fetchDecode(ctx, n.inst_url!),
        fetchDecode(ctx, n.vocals_url!),
      ])
      if (token !== this.token || singingStore.getState().phase !== 'loading') {
        return // 读取期间被停了
      }
      this.env = voiceActivity(vocBuf.getChannelData(0), vocBuf.sampleRate)
      const lyrics = parseLrc(n.lyric || '')

      const inst = ctx.createBufferSource()
      inst.buffer = instBuf
      const gInst = ctx.createGain()
      inst.connect(gInst).connect(ctx.destination)
      const voc = ctx.createBufferSource()
      voc.buffer = vocBuf
      const gVoc = ctx.createGain()
      voc.connect(gVoc)
      gVoc.connect(ctx.destination)
      gVoc.connect(analyser) // 只有人声进口型分析（嘴型、LiveLayer 的点头挑眉）
      this.t0 = ctx.currentTime + SINGING.startDelay
      inst.start(this.t0)
      voc.start(this.t0)
      this.nodes = { ctx, inst, voc, gInst, gVoc }
      this.duration = Math.max(instBuf.duration, vocBuf.duration)
      singingStore.setState({ phase: 'playing', lyrics })
      logger.log(
        `helixus-singing: 《${song.name}》 start — ${this.duration.toFixed(1)}s, ` +
          `${lyrics.length} lyric lines, requested by ${song.requester}`
      )
    } catch (e) {
      logger.error('helixus-singing: failed to start', e)
      // 放不了就把这首让出去，队列继续往下走
      void api('/skip', { method: 'POST' }).catch(() => {})
      if (token === this.token) this.toIdle()
    }
  }

  private finish(reason: EndReason) {
    const song = singingStore.getState().song
    if (this.nodes) {
      const { inst, voc, gInst, gVoc } = this.nodes
      for (const s of [inst, voc]) {
        try {
          s.stop()
        } catch {
          // 已经停了
        }
      }
      gInst.disconnect()
      gVoc.disconnect()
      this.nodes = undefined
    }
    this.voiceActive = false
    if (reason === 'done' && song) {
      void api('/done', {
        method: 'POST',
        body: JSON.stringify({ qid: song.qid }),
      }).catch(() => {})
    }
    logger.log(`helixus-singing: 《${song?.name}》 ${reason}`)
    if (!song || reason === 'error') {
      this.toIdle()
      return
    }
    // 收尾消息发出去之后，等 LLM 开始处理再把「在唱歌」撤掉，防止弹幕桥抢在前面发下一条
    this.afterUntil = performance.now() + SINGING.afterTimeout
    singingStore.setState({ phase: 'after' })
    this.flushWaiters()
    const who = song.requester ? `，是 ${song.requester} 点的` : ''
    const title = `《${song.name}》${song.artists.length ? `（${song.artists.join('/')}）` : ''}`
    void sendInternalMessage(
      reason === 'done'
        ? `【系统】你刚唱完${title}${who}。按人设说一句收尾的话。`
        : `【系统】你正在唱的${title}${who}，被切掉了，没唱完。按人设说一句。`
    )
  }

  private toIdle() {
    this.voiceActive = false
    singingStore.setState({ phase: 'idle', song: null, lyrics: [], line: -1 })
    this.flushWaiters()
  }

  private flushWaiters() {
    const w = this.waiters
    this.waiters = []
    w.forEach((resolve) => resolve())
  }
}

async function fetchDecode(
  ctx: AudioContext,
  url: string
): Promise<AudioBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`)
  return ctx.decodeAudioData(await res.arrayBuffer())
}

async function resumeAudio(ctx: AudioContext): Promise<boolean> {
  if (ctx.state === 'running') return true
  try {
    await Promise.race([
      ctx.resume(),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ])
  } catch {
    // 浏览器不让自动播放
  }
  return (ctx.state as AudioContextState) === 'running'
}

/** 唱完给 LLM 的内部消息：和跳舞收尾一样，走聊天框输入的路径（带人设） */
async function sendInternalMessage(text: string) {
  try {
    const { handleSendChatFn } = await import('@/features/chat/handlers')
    await handleSendChatFn()(text)
  } catch (e) {
    logger.error('helixus-singing: failed to send outro message', e)
  }
}

export const singing = new SingingController()

if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  // 开发模式调试入口：控制台里看 __helixusSinging.store.getState()、__helixusSinging.stop()
  ;(
    window as unknown as {
      __helixusSinging?: { store: typeof singingStore; stop: () => void }
    }
  ).__helixusSinging = { store: singingStore, stop: () => singing.stop() }
}

/** 追加到系统提示词：弹幕桥发来的【点歌】【歌单】消息怎么回 */
export function singingPromptLine(): string {
  if (!helixusLiveSettings.getState().singingEnabled) return ''
  return (
    '【点歌】【歌单】开头的消息是点歌系统发来的结果，不是观众的原话。点歌成功：用人设接一句（可以嘴硬，' +
    '可以提歌名和点歌的人）；没点成：用你自己的话把原因说出来，不要照念系统的原文。' +
    '歌准备好了会自动开始唱，你不用、也不能自己决定什么时候唱。'
  )
}
