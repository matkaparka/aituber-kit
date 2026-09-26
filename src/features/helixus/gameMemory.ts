// helixus-live: 看屏幕 reaction 的「游戏记忆」。
// - 识别当前游戏 {game, scene, confidence}：开 reaction 后第一张图、[switch]、每 N 分钟、手动快捷键
// - 每 N 轮实况压缩成一段不超过 300 字的「本场经过」
// 生命周期是整场直播：关掉 reaction 再开还在；刷新页面或在设置里手动清空才重置（不持久化）。
import { create } from 'zustand'
import { logger } from '@/lib/logger'
import { getAIChatResponseStream } from '@/features/chat/aiChatFactory'
import { THINKING_MARKER } from '@/features/chat/vercelAIChat'
import { Message } from '@/features/messages/messages'
import settingsStore from '@/features/stores/settings'
import { helixusLiveSettings } from './liveSettings'

interface GameMemory {
  game: string // 空 = 还没识别
  scene: string
  confidence: number
  identifiedAt: number
  needIdentify: boolean
  summary: string
  pending: { commentary: string; scene: string }[] // 还没压进摘要的实况
  summarizing: boolean
}

const EMPTY: GameMemory = {
  game: '',
  scene: '',
  confidence: 0,
  identifiedAt: 0,
  needIdentify: true,
  summary: '',
  pending: [],
  summarizing: false,
}

export const gameMemoryStore = create<GameMemory>(() => ({ ...EMPTY }))

export const clearGameMemory = () => gameMemoryStore.setState({ ...EMPTY })

export function requestGameReidentify() {
  gameMemoryStore.setState({ needIdentify: true })
  logger.log('helixus-game: 下一张截图重新识别游戏')
}

const confident = () =>
  gameMemoryStore.getState().confidence >=
  helixusLiveSettings.getState().gameConfidenceMin

/** 这一轮截图要不要先识别游戏 */
export function shouldIdentify(now = Date.now()): boolean {
  const m = gameMemoryStore.getState()
  if (m.needIdentify || !m.game || !confident()) return true
  const every = helixusLiveSettings.getState().gameReidentifyMin
  return every > 0 && now - m.identifiedAt > every * 60000
}

async function collect(messages: Message[]): Promise<string> {
  const stream = await getAIChatResponseStream(messages)
  if (!stream) return ''
  const reader = stream.getReader()
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && !value.startsWith(THINKING_MARKER)) text += value
    }
  } finally {
    reader.releaseLock()
  }
  return text.trim()
}

export async function identifyGame(imageData: string): Promise<void> {
  const prev = gameMemoryStore.getState()
  try {
    const text = await collect([
      {
        role: 'system',
        content:
          '你是直播助手，负责识别屏幕截图里正在玩的游戏或正在用的应用。只输出一个 JSON 对象，不要解释，不要代码块。',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '识别这张截图：正在玩什么游戏（用中文通行译名，没有就用原名；不是游戏就写应用名），当前在什么场景（一句话）。' +
              '按把握程度给 confidence（0 到 1），认不出就给低分，不要乱猜。' +
              '格式：{"game": "游戏名", "scene": "场景", "confidence": 0.8}',
          },
          { type: 'image', image: imageData },
        ],
      },
    ])
    const m = text.match(/\{[\s\S]*\}/)
    const j = m ? JSON.parse(m[0]) : null
    if (!j) throw new Error(`识别结果不是 JSON：${text.slice(0, 100)}`)
    const game = String(j.game || '').trim()
    const confidence = Number(j.confidence) || 0
    const changed = game && prev.game && game !== prev.game
    gameMemoryStore.setState({
      game,
      scene: String(j.scene || '').trim(),
      confidence,
      identifiedAt: Date.now(),
      needIdentify:
        confidence < helixusLiveSettings.getState().gameConfidenceMin,
    })
    logger.log(`helixus-game: 识别为「${game}」(${confidence})`)
    if (changed) {
      // 换游戏了：旧的摘要和未压缩的实况不再适用
      gameMemoryStore.setState({ summary: '', pending: [] })
    }
  } catch (e) {
    logger.error('helixus-game: 识别失败', e)
    gameMemoryStore.setState({ needIdentify: true })
  }
}

/** 实况一轮结束后调用；攒够 N 轮就在后台压缩成摘要 */
export function recordCommentaryRound(commentary: string, scene: string) {
  const m = gameMemoryStore.getState()
  const pending = [...m.pending, { commentary, scene }]
  gameMemoryStore.setState({ pending })
  const every = helixusLiveSettings.getState().gameSummaryEvery
  if (every > 0 && pending.length >= every && !m.summarizing) {
    void summarize()
  }
}

async function summarize() {
  const m = gameMemoryStore.getState()
  const batch = m.pending
  gameMemoryStore.setState({ summarizing: true })
  try {
    const rounds = batch
      .map(
        (r, i) =>
          `${i + 1}. 画面：${r.scene || '（无）'}｜实况：${r.commentary}`
      )
      .join('\n')
    const text = await collect([
      {
        role: 'system',
        content:
          '你负责给直播写「本场经过」：把之前的经过和新的几轮实况合并成一段中文，不超过 300 字。' +
          '只写事实（玩了什么、进行到哪、发生了哪些值得一提的事、玩家表现），不要评论，不要分点。',
      },
      {
        role: 'user',
        content: `游戏：${m.game || '未确定'}\n之前的经过：${m.summary || '（无）'}\n新的实况：\n${rounds}`,
      },
    ])
    if (text) {
      const cur = gameMemoryStore.getState()
      gameMemoryStore.setState({
        summary: [...text].slice(0, 300).join(''),
        pending: cur.pending.slice(batch.length),
      })
      logger.log('helixus-game: 本场经过已更新')
    }
  } catch (e) {
    logger.error('helixus-game: 摘要失败', e)
  } finally {
    gameMemoryStore.setState({ summarizing: false })
  }
}

/** 注入 system prompt 的固定信息；reaction 没开过（什么都没有）时返回空串 */
export function gameContextBlock(): string {
  const m = gameMemoryStore.getState()
  if (!m.game && !m.summary) return ''
  const game =
    m.game && confident()
      ? `正在玩《${m.game}》${m.scene ? `，场景：${m.scene}` : ''}`
      : '未确定'
  let s = `\n\n【当前画面】${game}`
  if (m.summary) s += `\n【本场经过】${m.summary}`
  return s
}

/** 普通弹幕回复也带上游戏信息（reaction 开着时） */
export function gameContextForChat(): string {
  return settingsStore.getState().gameCommentaryPlaying
    ? gameContextBlock()
    : ''
}
