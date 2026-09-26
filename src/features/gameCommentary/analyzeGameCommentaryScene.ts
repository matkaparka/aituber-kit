import { logger } from '@/lib/logger'
import { getAIChatResponseStream } from '@/features/chat/aiChatFactory'
import { THINKING_MARKER } from '@/features/chat/vercelAIChat'
import { Message } from '@/features/messages/messages'
import settingsStore from '@/features/stores/settings'

export function normalizeGameCommentarySceneAnalysis(rawText: string): string {
  const normalized = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('\n')
    .trim()

  return normalized.slice(0, 200).trim()
}

export async function analyzeGameCommentaryScene(
  imageData: string
): Promise<string | null> {
  const ss = settingsStore.getState()
  const systemPrompt =
    ss.gameCommentaryBackgroundAnalysisPromptTemplate ||
    `你是游戏实况的辅助分析器，不需要台词和情绪。
只从截图里提取下一轮实况用得上的事实，用中文简洁地写。

规则：
- 写 1 到 3 行
- 优先写画面中央发生的事、UI 和血条/计量条、玩家和敌人的位置与状态、影响接下来判断的信息
- 看不出来的不要猜
- 画面基本没变化时，只写「没有明显变化」即可`

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '从这一张截图里，只返回给实况参考的事实记录。',
        },
        { type: 'image', image: imageData },
      ],
    },
  ]

  try {
    const stream = await getAIChatResponseStream(messages)
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

    const normalized = normalizeGameCommentarySceneAnalysis(fullText)
    return normalized || null
  } catch (error) {
    logger.error('ゲーム実況シーン解析エラー:', error)
    return null
  }
}
