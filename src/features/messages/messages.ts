import type { VRMAnimation } from '@/lib/VRMAnimation/VRMAnimation' // helixus-live-motion

export type Message = {
  id?: string
  role: string // "assistant" | "system" | "user";
  content?:
    | string
    | [{ type: 'text'; text: string }, { type: 'image'; image: string }] // マルチモーダル拡張
  liveTranscript?: { delta: string; start_ms: number; end_ms: number }[]
  audio?: { id: string }
  timestamp?: string
  embedding?: number[] // メモリ機能用のembedding
  userName?: string // YouTubeコメント主名
  thinking?: string // 推論/思考内容（UI表示・永続化用、LLMには送信しない）
}

export const EMOTIONS = [
  'neutral',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
] as const
export type EmotionType = (typeof EMOTIONS)[number]

export type Talk = {
  emotion: EmotionType
  message: string
  buffer?: ArrayBuffer
  motion?: string
  // helixus-live-motion: 这句 TTS 对应的实时生成动作（合成完就开始请求，开口时取）
  liveMotion?: Promise<VRMAnimation | null>
}

export const splitSentence = (text: string): string[] => {
  const splitMessages = text.split(/(?<=[。．！？\n])/g)
  return splitMessages.filter((msg) => msg !== '')
}
