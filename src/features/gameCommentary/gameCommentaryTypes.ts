/**
 * Game Commentary Mode Types
 *
 * Type definitions and constants for the game commentary feature
 */

// Game commentary settings interface
export interface GameCommentarySettings {
  gameCommentaryEnabled: boolean
  gameCommentaryPlaying: boolean // メインページのボタンで制御（YouTubeのyoutubePlayingと同じ）
  gameCommentaryCaptureInterval: number // 秒 (10-60)
  gameCommentaryContextCount: number // 実況履歴参照数 (0-20)
  gameCommentaryPromptTemplate: string
  gameCommentaryBackgroundAnalysisPromptTemplate: string
  gameCommentaryImageQuality: number // JPEG品質 (0.3-1.0)
  gameCommentaryResizeWidth: number // リサイズ幅px (0=なし)
  gameCommentarySaveToChat: boolean // chatLogにも保存するか（opt-in）
  gameCommentaryBackgroundAnalysisEnabled: boolean // 発話中の補助画像解析
  gameCommentaryBackgroundAnalysisInterval: number // 秒 (1-10)
}

// Default configuration
export const DEFAULT_GAME_COMMENTARY_CONFIG: GameCommentarySettings = {
  gameCommentaryEnabled: false,
  gameCommentaryPlaying: false,
  gameCommentaryCaptureInterval: 8, // helixus-live: 控制成本
  gameCommentaryContextCount: 5,
  gameCommentaryPromptTemplate: '',
  gameCommentaryBackgroundAnalysisPromptTemplate: '',
  gameCommentaryImageQuality: 0.7,
  gameCommentaryResizeWidth: 768, // helixus-live: Gemini 按图块计费，768 约一块（~258 token）
  gameCommentarySaveToChat: true,
  gameCommentaryBackgroundAnalysisEnabled: false,
  gameCommentaryBackgroundAnalysisInterval: 2,
}

// Interval validation constants
export const GAME_COMMENTARY_INTERVAL = { MIN: 0, MAX: 20 }

// Context count validation constants
export const GAME_COMMENTARY_CONTEXT_COUNT = { MIN: 0, MAX: 20 }

// Background analysis interval validation constants
export const GAME_COMMENTARY_BACKGROUND_ANALYSIS_INTERVAL = {
  MIN: 1,
  MAX: 10,
}

// Background scene analysis constants
export const GAME_COMMENTARY_BACKGROUND_ANALYSIS = {
  MAX_BUFFERED_ITEMS: 3,
  RESIZE_WIDTH: 512,
  IMAGE_QUALITY: 0.5,
}

// Validate and clamp capture interval value
export function clampCaptureInterval(value: number): number {
  if (value < GAME_COMMENTARY_INTERVAL.MIN) return GAME_COMMENTARY_INTERVAL.MIN
  if (value > GAME_COMMENTARY_INTERVAL.MAX) return GAME_COMMENTARY_INTERVAL.MAX
  return value
}

// Validate and clamp context count value
export function clampContextCount(value: number): number {
  if (value < GAME_COMMENTARY_CONTEXT_COUNT.MIN)
    return GAME_COMMENTARY_CONTEXT_COUNT.MIN
  if (value > GAME_COMMENTARY_CONTEXT_COUNT.MAX)
    return GAME_COMMENTARY_CONTEXT_COUNT.MAX
  return value
}

// Validate and clamp background analysis interval value
export function clampBackgroundAnalysisInterval(value: number): number {
  if (value < GAME_COMMENTARY_BACKGROUND_ANALYSIS_INTERVAL.MIN)
    return GAME_COMMENTARY_BACKGROUND_ANALYSIS_INTERVAL.MIN
  if (value > GAME_COMMENTARY_BACKGROUND_ANALYSIS_INTERVAL.MAX)
    return GAME_COMMENTARY_BACKGROUND_ANALYSIS_INTERVAL.MAX
  return value
}
