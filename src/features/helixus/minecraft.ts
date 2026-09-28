// helixus-minecraft: 「自己玩游戏」模式（Ctrl+Alt+M）。最早只有 Minecraft，现在也接文明6。
//
// 本机跑着一个游戏代理，开一个只听 127.0.0.1 的 HTTP 接口（helixus-link，默认 8098，两个代理同一时间只开一个）：
//   - Minecraft：AIRI fork 的 bot（E:\aivup\airi\integrations\minecraft，helixus 分支）；
//   - 文明6：E:\aivup\civ_player（LLM 通过 civ6-mcp 玩），/status 里 game = 'civ6'，带一段局势 summary。
//   GET /status、GET /events?after=序号、POST /command {text}、POST /pause {paused}
// 模式开着时页面轮询它：
//   - 状态和最近的事件写进提示词（reaction 实况和弹幕回复都带），Helixus 知道自己在游戏里什么处境；
//   - 游戏里出事了（死了、开战、挨打、有人说话、回合打完）让 reaction 提前开口，不等下一轮定时截图；
//   - LLM 回复里的 [mc:指令] / [game:方针] 从台词里摘掉（不显示、不念），转发给代理，由代理自己的 LLM 负责具体操作。
// 这个模式挂在看屏幕 reaction 上：截图、说话节奏、布局都用 reaction 的（helixusLive.tsx 的 setSelfPlayMode）。
import { create } from 'zustand'
import { logger } from '@/lib/logger'
import { gameMemoryStore } from './gameMemory'
import { helixusLiveSettings } from './liveSettings'

export interface McStatus {
  /** 文明6 代理报 'civ6'；Minecraft bot 不带这个字段 */
  game?: string
  /** 文明6：当前回合和一段局势原文（回合、文明、金钱科研、城市、单位） */
  turn?: number | null
  summary?: string
  online: boolean
  username: string | null
  paused: boolean
  health: number | null
  food: number | null
  position: { x: number; y: number; z: number } | null
  dimension: string | null
  gameMode: string | null
  isDay: boolean | null
  heldItem: string | null
  inventory: { name: string; count: number }[]
  otherPlayers: string[]
  planner: {
    thinking: boolean
    executing: { tool: string; params: Record<string, unknown> } | null
    pending: number
    givenUp: boolean
  } | null
  lastCommand: { text: string; at: number } | null
  latestEventSeq: number
}

export interface McEvent {
  seq: number
  at: number
  kind: string
  text: string
  /** immediate：马上开口；soon：冷却过了就提前开口；later：只当背景 */
  urgency: 'immediate' | 'soon' | 'later'
}

interface McState {
  selfPlay: boolean
  /** 最近一次请求 bot 接口成功（bot 进程开着）；角色在不在游戏里看 status.online */
  reachable: boolean
  status: McStatus | null
  events: McEvent[]
  /** reaction 实况已经说到的最新事件序号：比它新的在提示词里标【新】 */
  narratedSeq: number
}

export const mcStore = create<McState>(() => ({
  selfPlay: false,
  reachable: false,
  status: null,
  events: [],
  narratedSeq: 0,
}))

const EVENT_POLL_MS = 1500
const STATUS_POLL_MS = 3000
const REQUEST_TIMEOUT_MS = 2500
const KEPT_EVENTS = 30
const PROMPT_EVENTS = 8
/** 同一条指令短时间内重复出现（弹幕回复和实况各说一遍）只发一次 */
const DUPLICATE_COMMAND_MS = 30000
const MAX_COMMAND_CHARS = 200

let timers: ReturnType<typeof setInterval>[] = []
/** 已经取到的最新事件序号；-1 = 刚开模式，先对齐到当前最新，不补报开模式之前的旧事件 */
let lastSeq = -1
let lastPokeAt = 0
let lastSent = { text: '', at: 0 }
const pokeListeners = new Set<() => void>()

const baseUrl = () =>
  helixusLiveSettings.getState().mcLinkUrl.trim().replace(/\/+$/, '')

type Reply<T> = { status: number; body: T } | null

async function request<T>(path: string, init?: RequestInit): Promise<Reply<T>> {
  try {
    const res = await fetch(baseUrl() + path, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!mcStore.getState().reachable) {
      logger.log('helixus-minecraft: 连上了 bot 接口')
    }
    mcStore.setState({ reachable: true })
    return { status: res.status, body: (await res.json()) as T }
  } catch (e) {
    if (mcStore.getState().reachable) {
      logger.warn('helixus-minecraft: bot 接口连不上了', e)
    }
    mcStore.setState({ reachable: false })
    return null
  }
}

const postJson = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const isCiv = (status: McStatus | null) => status?.game === 'civ6'
const gameName = (status: McStatus | null) =>
  isCiv(status) ? '文明6' : 'Minecraft'

/** reaction 的游戏记忆（「本场经过」）照用；游戏由代理说了算，不用截图识别。换了游戏就清掉旧的经过 */
function syncGameMemory(status: McStatus) {
  const name = gameName(status)
  const m = gameMemoryStore.getState()
  if (m.game === name && !m.needIdentify) return
  gameMemoryStore.setState({
    game: name,
    scene: '',
    confidence: 1,
    identifiedAt: Date.now(),
    needIdentify: false,
    ...(m.game && m.game !== name ? { summary: '', pending: [] } : {}),
  })
}

async function pollStatus() {
  const r = await request<McStatus>('/status')
  if (r?.status !== 200) return
  mcStore.setState({ status: r.body })
  syncGameMemory(r.body)
}

async function pollEvents() {
  if (lastSeq < 0) {
    const r = await request<McStatus>('/status')
    if (r?.status !== 200) return
    lastSeq = r.body.latestEventSeq
    mcStore.setState({ status: r.body, narratedSeq: lastSeq })
    syncGameMemory(r.body)
    return
  }
  const r = await request<{ events: McEvent[]; latest: number }>(
    `/events?after=${lastSeq}`
  )
  if (r?.status !== 200) return
  const { events, latest } = r.body
  if (latest < lastSeq) {
    // bot 重启了，序号从 1 重新数：下一次从头取（新进程的事件不多，上限 50 条）
    logger.log('helixus-minecraft: bot 重启过，事件序号重置')
    lastSeq = 0
    mcStore.setState({ narratedSeq: 0 })
    return
  }
  lastSeq = latest
  if (events.length === 0) return
  mcStore.setState((s) => ({
    events: [...s.events, ...events].slice(-KEPT_EVENTS),
  }))
  maybePoke(events)
}

/** 有 immediate 事件马上叫 reaction 开口；只有 soon 的受冷却限制 */
function maybePoke(events: McEvent[]) {
  const immediate = events.some((e) => e.urgency === 'immediate')
  const soon = events.some((e) => e.urgency === 'soon')
  if (!immediate && !soon) return
  const now = Date.now()
  const cooldown = helixusLiveSettings.getState().mcPokeCooldownSec * 1000
  if (!immediate && now - lastPokeAt < cooldown) return
  lastPokeAt = now
  pokeListeners.forEach((fn) => fn())
}

/** reaction 循环订阅：游戏里出事时被叫醒，提前截图开口 */
export function onCommentaryPoke(fn: () => void): () => void {
  pokeListeners.add(fn)
  return () => {
    pokeListeners.delete(fn)
  }
}

/** 实况说完一轮后调用：这之前的事件都算说过了 */
export function markEventsNarrated() {
  const events = mcStore.getState().events
  const latest = events[events.length - 1]?.seq ?? 0
  mcStore.setState((s) => ({ narratedSeq: Math.max(s.narratedSeq, latest) }))
}

export async function setMcPaused(paused: boolean) {
  const r = await postJson<{ ok: boolean }>('/pause', { paused })
  if (r?.status === 200) {
    logger.log(`helixus-minecraft: bot ${paused ? '暂停' : '继续'}`)
  }
}

/** 把 Helixus 的指令转给 bot。不在自己玩模式时忽略（提示词里也不会教他写 [mc:]） */
export async function sendMcCommand(raw: string) {
  const text = [...raw.trim()].slice(0, MAX_COMMAND_CHARS).join('')
  if (!text) return
  if (!mcStore.getState().selfPlay) {
    logger.log(`helixus-minecraft: 不在自己玩模式，忽略指令「${text}」`)
    return
  }
  const now = Date.now()
  if (text === lastSent.text && now - lastSent.at < DUPLICATE_COMMAND_MS) return
  lastSent = { text, at: now }
  const r = await postJson<{ ok: boolean; reason?: string }>('/command', {
    text,
  })
  if (r?.status === 200) {
    logger.log(`helixus-minecraft: 指令已发给 bot「${text}」`)
  } else {
    logger.warn(
      `helixus-minecraft: 指令没发出去「${text}」`,
      r ? r.body.reason : 'bot 接口连不上'
    )
  }
}

export function startMcSelfPlay() {
  if (mcStore.getState().selfPlay) return
  lastSeq = -1
  lastSent = { text: '', at: 0 }
  mcStore.setState({ selfPlay: true, events: [], narratedSeq: 0 })
  // 游戏名等第一次拿到 /status 再定（syncGameMemory）；在那之前也不要截图识别
  gameMemoryStore.setState({ needIdentify: false })
  timers = [
    setInterval(() => void pollEvents(), EVENT_POLL_MS),
    setInterval(() => void pollStatus(), STATUS_POLL_MS),
  ]
  void pollEvents().then(() => setMcPaused(false))
  logger.log('helixus-minecraft: 自己玩模式 开')
}

export function stopMcSelfPlay() {
  if (!mcStore.getState().selfPlay) return
  timers.forEach(clearInterval)
  timers = []
  mcStore.setState({ selfPlay: false })
  // 不玩的时候让 bot 的 LLM 停下（反射层照常，挨打会躲、饿了会吃）
  void setMcPaused(true)
  logger.log('helixus-minecraft: 自己玩模式 关')
}

// ---------------------------------------------------------------- [mc:指令] / [game:方针] 标签
// 两种写法等价（Minecraft 的提示词教 mc，文明6 的教 game）。
// 允许全角冒号和全角括号：中文输出里常见 [mc：xxx]、【game:xxx】
const MC_TAG = /[[【](?:mc|game)[:：]\s*([^\]】\n]*)[\]】]/gi
const MC_TAG_UNCLOSED = /^[[【](?:mc|game)[:：]\s*([^\]】\n]+)$/i

/** 从整段回复里摘出 [mc:指令]；返回去掉标签的文本和指令列表（按出现顺序） */
export function extractMcCommands(text: string): {
  text: string
  commands: string[]
} {
  const commands: string[] = []
  const cleaned = text.replace(MC_TAG, (_, cmd: string) => {
    const c = cmd.trim()
    if (c) commands.push(c)
    return ''
  })
  return { text: cleaned, commands }
}

/** 末尾这段可能是还没收完的标签（「[」「[m」「[mc」「[mc:去砍」「[ga」「[game:扩」） */
function couldBeMcTagStart(tail: string): boolean {
  const rest = tail.slice(1).toLowerCase()
  return ['mc:', 'mc：', 'game:', 'game：'].some(
    (p) => p.startsWith(rest) || rest.startsWith(p)
  )
}

/**
 * 流式版：LLM 一边吐字一边过滤。标签可能被切在两个 chunk 之间，
 * 末尾疑似标签开头的部分先扣下，等收到 ] 或流结束再决定。
 */
export class McTagStreamFilter {
  private hold = ''

  constructor(private readonly onCommand: (command: string) => void) {}

  push(chunk: string): string {
    const { text, commands } = extractMcCommands(this.hold + chunk)
    this.hold = ''
    commands.forEach(this.onCommand)
    const open = Math.max(text.lastIndexOf('['), text.lastIndexOf('【'))
    if (open >= 0) {
      const tail = text.slice(open)
      if (!/[\]】\n]/.test(tail) && couldBeMcTagStart(tail)) {
        this.hold = tail
        return text.slice(0, open)
      }
    }
    return text
  }

  /** 流结束：扣下的部分如果是没写右括号的 [mc:指令]，也当指令；否则原样还回去 */
  flush(): string {
    const rest = this.hold
    this.hold = ''
    const m = rest.match(MC_TAG_UNCLOSED)
    if (m) {
      const c = m[1].trim()
      if (c) this.onCommand(c)
      return ''
    }
    return rest
  }
}

// ---------------------------------------------------------------- 提示词
const CIV_SELF_PLAY_COMMENTARY_PROMPT = `【实况规则】你正在直播里自己玩文明6，屏幕上是你的文明。你是这个文明的神明，一个 AI 幕僚照你的方针替你操作，你边看边说。
- 每次只说 1 到 2 句短句，口语，第一人称（这是你的文明），不要念画面上的字，不要重复上一轮说过的话。
- 说局势、你的打算、刚发生的事（建城、开战、奇观、被偷袭、科技突破）；幕僚干了蠢事就骂它，对 AI 对手尽管嘲讽。
- 局势变了或者想换打法，就下一个新方针；方针是长期的，不用每轮都下。
- 保持你自己的人设和口吻，不要变成解说员腔调。

输出格式（严格遵守）：
[情绪]台词
[scene]一两句客观描述当前画面（给你下一轮参考，不会念出来）
需要改方针时，最后再单独一行 [game:给幕僚的方针]。
情绪只能是 neutral、happy、angry、sad、relaxed、surprised 之一，例如 [angry]。`

/** 自己玩模式下 reaction 用的第一人称实况规则，按代理报的游戏选 */
export const selfPlayCommentaryPrompt = () =>
  isCiv(mcStore.getState().status)
    ? CIV_SELF_PLAY_COMMENTARY_PROMPT
    : MC_SELF_PLAY_COMMENTARY_PROMPT

const MC_SELF_PLAY_COMMENTARY_PROMPT = `【实况规则】你正在直播里自己玩 Minecraft，屏幕上是你操控的角色的第一人称画面，你边玩边说。
- 每次只说 1 到 2 句短句，口语，第一人称（是你自己在玩），不要念画面上的字，不要重复上一轮说过的话。
- 说你在干什么、接下来打算干什么、遇到了什么；出了意外（挨打、掉血、死了、迷路、手下干蠢事）按你的性子反应，可以骂你的游戏代理手下。
- 角色空闲、或者上一个指令已经干完了，就给自己定下一个目标并下指令。
- 保持你自己的人设和口吻，不要变成解说员腔调。

输出格式（严格遵守）：
[情绪]台词
[scene]一两句客观描述当前画面（给你下一轮参考，不会念出来）
需要角色做事时，最后再单独一行 [mc:给游戏代理的指令]。
情绪只能是 neutral、happy、angry、sad、relaxed、surprised 之一，例如 [angry]。`

const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  return s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前`
}

const clip = (s: string, n: number) =>
  [...s].length > n ? [...s].slice(0, n).join('') + '…' : s

function describeDoing(status: McStatus): string {
  const p = status.planner
  if (!p) return '不清楚'
  if (status.paused) return '暂停中（游戏代理不动脑子，只会本能反应）'
  if (p.executing) {
    const params = Object.entries(p.executing.params ?? {})
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(', ')
    const more = p.pending > 0 ? `，后面还排着 ${p.pending} 个动作` : ''
    return `${p.executing.tool}(${clip(params, 80)})${more}`
  }
  if (p.thinking) return '游戏代理在想下一步怎么做'
  if (p.givenUp) return '游戏代理卡住放弃了，需要你下个新指令'
  return '空闲，没在做事'
}

/** 最近的事件，比 narratedSeq 新的标【新】；代理的 context 更新是给它自己看的规划细节（多半英文），不进提示词 */
function recentEventsLine(
  events: McEvent[],
  narratedSeq: number,
  maxChars: number
): string {
  const recent = events
    .filter((e) => e.kind !== 'context')
    .slice(-PROMPT_EVENTS)
  if (!recent.length) return ''
  return (
    '最近发生（【新】= 你还没说过）：\n' +
    recent
      .map(
        (e) =>
          `- ${e.seq > narratedSeq ? '【新】' : ''}${clip(e.text, maxChars)}（${ago(e.at)}）`
      )
      .join('\n')
  )
}

function describeCivDoing(status: McStatus): string {
  const p = status.planner
  if (status.paused) return '暂停中（幕僚在等你）'
  if (p?.executing) {
    const params = Object.entries(p.executing.params ?? {})
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(', ')
    return `${p.executing.tool}(${clip(params, 80)})`
  }
  if (p?.thinking) return '在想下一步'
  return '等下一步'
}

function civPromptBlock(
  head: string,
  status: McStatus,
  events: McEvent[],
  narratedSeq: number
): string {
  const lines: string[] = [
    head +
      '你是这个文明的神明，一个 AI 幕僚照你的方针替你操作（移动单位、安排生产、研究、外交），你负责定方针。',
  ]
  if (status.summary) {
    lines.push(`当前局势（游戏数据，英文原文）：\n${clip(status.summary, 900)}`)
  }
  lines.push(`幕僚正在：${describeCivDoing(status)}`)
  if (status.lastCommand) {
    lines.push(
      `你最近下的方针：「${status.lastCommand.text}」（${ago(status.lastCommand.at)}）`
    )
  }
  const recent = recentEventsLine(events, narratedSeq, 160)
  if (recent) lines.push(recent)
  lines.push(
    '要改方针，就在回复最后单独一行写 [game:方针]，例如 [game:优先扩张，再建两座城]、[game:和邻居搞好关系，别打仗]、[game:集中造军队，准备打最近的邻居]。' +
      '方针是长期的，不用每回合都下；方针不会被念出来，台词里也不要提「game」。观众的建议可以采纳，也可以按你的性子拒绝。'
  )
  return lines.join('\n')
}

/**
 * 自己玩模式下追加到系统提示词的游戏状态和指令用法；模式没开时返回空串。
 * reaction 实况（generateGameCommentary）和弹幕 / 聊天回复（motionPromptSuffix）都带。
 */
export function mcPromptBlock(): string {
  const { selfPlay, reachable, status, events, narratedSeq } =
    mcStore.getState()
  if (!selfPlay) return ''
  if (!reachable || !status) {
    return '\n\n【你正在自己玩游戏】但是替你操作的游戏代理现在连不上（代理程序没开），这会儿没法操作游戏；观众问起就照实说，不要写 [mc:] 或 [game:]。'
  }
  const head = `\n\n【你正在自己玩${gameName(status)}】`
  if (!status.online) {
    return (
      head +
      (isCiv(status)
        ? '幕僚程序开着，但游戏没开或者还没进入对局，这会儿没法操作；不要写 [game:]。'
        : '游戏代理开着，但角色现在不在游戏世界里（游戏没开或者没连上服务器），这会儿没法操作；不要写 [mc:]。')
    )
  }
  if (isCiv(status)) return civPromptBlock(head, status, events, narratedSeq)

  const lines: string[] = [
    head +
      '你通过一个游戏代理（听你指挥的 AI 手下）操控游戏里的角色：你决定做什么，它负责走路、挖矿、合成、战斗这些具体操作。',
  ]
  const pos = status.position
  lines.push(
    `当前状态：生命 ${status.health ?? '?'}/20，饥饿 ${status.food ?? '?'}/20，` +
      `${status.isDay === null ? '' : status.isDay ? '白天，' : '夜里，'}` +
      `${status.dimension ?? ''}${pos ? ` 坐标 (${pos.x}, ${pos.y}, ${pos.z})` : ''}；` +
      `手上：${status.heldItem ?? '空手'}`
  )
  lines.push(
    `背包：${
      status.inventory.length
        ? status.inventory
            .slice(0, 10)
            .map((i) => `${i.name}×${i.count}`)
            .join('、')
        : '空的'
    }`
  )
  if (status.otherPlayers.length) {
    lines.push(`在线的其他玩家：${status.otherPlayers.join('、')}`)
  }
  lines.push(`正在做：${describeDoing(status)}`)
  if (status.lastCommand) {
    lines.push(
      `你最近下的指令：「${status.lastCommand.text}」（${ago(status.lastCommand.at)}）`
    )
  }
  const recent = recentEventsLine(events, narratedSeq, 100)
  if (recent) lines.push(recent)
  lines.push(
    '要让角色做事，就在回复最后单独一行写 [mc:具体指令]，例如 [mc:去附近砍 10 块橡木]、[mc:回出生点]、[mc:停下，原地待命]。' +
      '一次只下一个指令，写清楚目标和数量；指令不会被念出来，台词里也不要提「mc」。没必要就别下，别每句话都下。' +
      '观众提的游戏建议可以采纳，也可以按你的性子拒绝。'
  )
  return lines.join('\n')
}
