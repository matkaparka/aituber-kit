import { logger } from '@/lib/logger'
import { getAIChatResponseStream } from '@/features/chat/aiChatFactory'
import type { AIChatResponseStreamOptions } from '@/features/chat/aiChatFactory'
import { THINKING_MARKER } from '@/features/chat/vercelAIChat'
import { Message, EmotionType, EMOTIONS } from '@/features/messages/messages'
import settingsStore from '@/features/stores/settings'
import { gameContextBlock } from '@/features/helixus/gameMemory' // helixus-live

// helixus-live: Helixus 人设的中文实况规则（设置页里的模板留空时用这个）
export const HELIXUS_COMMENTARY_PROMPT = `【实况规则】你正在直播里看屏幕，屏幕上是那个有机体（玩家）在玩游戏，你边看边实况。
- 每次只说 1 到 2 句短句，口语，不要念画面上的字，不要重复上一轮说过的话。
- 以对玩家冷嘲热讽为主：嫌他操作菜、反应慢、决策蠢、磨蹭；他偶尔真打得好，可以极不情愿地认可一句。
- 保持你自己的人设和口吻，不要变成解说员腔调。
- 画面看不清或没变化时，就吐槽他发呆、磨蹭。

输出格式（严格遵守，两行）：
[情绪]台词
[scene]一两句客观描述当前画面（给你下一轮参考，不会念出来）
情绪只能是 neutral、happy、angry、sad、relaxed、surprised 之一，例如 [angry]。
如果画面明显换了一个游戏或应用（和下面「当前画面」里写的不是同一个），在最后单独加一行 [switch]。`

/**
 * 実況履歴エントリ（実況テキスト + 情景描写）
 */
export interface CommentaryHistoryEntry {
  commentary: string
  sceneDescription: string
}

export interface BackgroundSceneAnalysisEntry {
  summary: string
}

export function buildGameCommentaryMessages(
  commentaryHistory: CommentaryHistoryEntry[],
  imageData: string,
  recentChatMessages?: Array<{ role: string; content: string }>,
  backgroundSceneAnalyses: BackgroundSceneAnalysisEntry[] = []
): Message[] {
  const ss = settingsStore.getState()
  const characterPrompt = ss.systemPrompt || ''
  // helixus-live: 模板留空时用 Helixus 的中文实况规则；再注入当前游戏和本场经过
  const commentaryPrompt =
    ss.gameCommentaryPromptTemplate || HELIXUS_COMMENTARY_PROMPT

  const systemPrompt =
    characterPrompt + '\n\n' + commentaryPrompt + gameContextBlock()
  const messages: Message[] = [{ role: 'system', content: systemPrompt }]

  if (recentChatMessages && recentChatMessages.length > 0) {
    for (const msg of recentChatMessages) {
      messages.push({ role: msg.role, content: msg.content })
    }
  }

  for (const history of commentaryHistory) {
    if (history.sceneDescription) {
      messages.push({
        role: 'user',
        content: `[上一轮画面] ${history.sceneDescription}`,
      })
    }
    messages.push({ role: 'assistant', content: history.commentary })
  }

  if (backgroundSceneAnalyses.length > 0) {
    messages.push({
      role: 'user',
      content: `[你说话期间的画面记录，按时间先后]\n${backgroundSceneAnalyses
        .map((analysis, index) => `${index + 1}. ${analysis.summary}`)
        .join('\n')}`,
    })
  }

  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: '看这张最新的屏幕截图，实况一下。' },
      { type: 'image', image: imageData },
    ],
  })

  return messages
}

/**
 * ゲーム実況コメントを生成する
 *
 * キャラクターのシステムプロンプト + 実況プロンプトテンプレートを組み合わせ、
 * 画面キャプチャ画像と実況履歴を基にAIがコメントを生成する。
 * 情景描写（sceneDescription）も同時に生成し、次回以降の文脈として活用する。
 */
export async function generateGameCommentary(
  commentaryHistory: CommentaryHistoryEntry[],
  imageData: string,
  recentChatMessages?: Array<{ role: string; content: string }>,
  backgroundSceneAnalyses: BackgroundSceneAnalysisEntry[] = [],
  options: AIChatResponseStreamOptions = {}
): Promise<{
  text: string
  emotion: EmotionType
  sceneDescription: string
  switched: boolean
} | null> {
  const messages = buildGameCommentaryMessages(
    commentaryHistory,
    imageData,
    recentChatMessages,
    backgroundSceneAnalyses
  )

  try {
    const stream = await getAIChatResponseStream(messages, options)
    if (!stream) return null

    const reader = stream.getReader()
    let fullText = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && !value.startsWith(THINKING_MARKER)) {
          fullText += value
        }
      }
    } finally {
      reader.releaseLock()
    }

    fullText = fullText.trim()
    if (!fullText) return null

    return parseCommentaryResponse(fullText)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return null
    }

    logger.error('ゲーム実況コメント生成エラー:', error)
    return null
  }
}

/**
 * AI応答から感情タグ、実況テキスト、情景描写を解析する
 *
 * 期待フォーマット:
 *   [emotion]実況セリフ
 *   [scene]情景描写テキスト
 *
 * [scene]がない場合は空文字列を返す（後方互換性）
 */
export function parseCommentaryResponse(rawText: string): {
  text: string
  emotion: EmotionType
  sceneDescription: string
  switched: boolean
} {
  // helixus-live: [switch] = 画面换了游戏或应用，下一轮重新识别
  const switched = /\[switch\]/i.test(rawText)
  rawText = rawText.replace(/\[switch\]/gi, '').trim()

  // [scene]タグで分割
  const sceneMatch = rawText.match(/\[scene\]([\s\S]*)$/i)
  const sceneDescription = sceneMatch?.[1]?.trim() || ''

  // [scene]より前の部分を実況テキストとして扱う
  const commentaryPart = sceneMatch
    ? rawText.slice(0, rawText.indexOf(sceneMatch[0])).trim()
    : rawText.trim()

  // 感情タグの解析
  const emotionMatch = commentaryPart.match(/^\s*\[(.*?)\]/)

  if (emotionMatch?.[1]) {
    const emotionStr = emotionMatch[1].toLowerCase()
    const emotion: EmotionType = (EMOTIONS as readonly string[]).includes(
      emotionStr
    )
      ? (emotionStr as EmotionType)
      : 'neutral'
    const sliceStart =
      commentaryPart.indexOf(emotionMatch[0]) + emotionMatch[0].length
    const text = commentaryPart
      .slice(sliceStart)
      .replace(/\[.*?\]/g, '')
      .trim()

    return {
      text: text || commentaryPart.replace(/\[.*?\]/g, '').trim(),
      emotion,
      sceneDescription,
      switched,
    }
  }

  return {
    text: commentaryPart.replace(/\[.*?\]/g, '').trim(),
    emotion: 'neutral',
    sceneDescription,
    switched,
  }
}
