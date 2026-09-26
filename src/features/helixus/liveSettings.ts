// helixus-live: 弹幕点图 / 看屏幕 reaction 的设置和模式开关。
// 设置持久化到 localStorage（初值来自 .env 的 NEXT_PUBLIC_HELIXUS_*）；两个模式本身不持久化，刷新后都是关。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { logger } from '@/lib/logger'

export type CharLayout = { x: number; y: number; scale: number } // x: vw，y: vh，scale 以脚底为原点
export type Rect = { left: number; top: number; width: number; height: number } // 视口百分比

const num = (v: string | undefined, d: number) => {
  const n = parseFloat(v ?? '')
  return Number.isFinite(n) ? n : d
}

export interface HelixusLiveSettings {
  drawServiceUrl: string
  drawPrefixes: string // 逗号分隔
  drawUserCooldownSec: number
  drawQueueMax: number
  drawMaxChars: number
  drawShowSec: number
  drawFrameRect: Rect
  drawCharLayout: CharLayout
  reactionCharLayout: CharLayout
  gameReidentifyMin: number
  gameSummaryEvery: number
  gameConfidenceMin: number
  ttsBlockWords: string // 逗号或换行分隔；命中的词在 TTS 前换成「哔」
}

export const DEFAULT_HELIXUS_LIVE: HelixusLiveSettings = {
  drawServiceUrl:
    process.env.NEXT_PUBLIC_HELIXUS_DRAW_URL || 'http://127.0.0.1:7870',
  drawPrefixes: process.env.NEXT_PUBLIC_HELIXUS_DRAW_PREFIXES || '画,/画',
  drawUserCooldownSec: num(
    process.env.NEXT_PUBLIC_HELIXUS_DRAW_USER_COOLDOWN,
    300
  ),
  drawQueueMax: num(process.env.NEXT_PUBLIC_HELIXUS_DRAW_QUEUE_MAX, 3),
  drawMaxChars: num(process.env.NEXT_PUBLIC_HELIXUS_DRAW_MAX_CHARS, 60),
  drawShowSec: num(process.env.NEXT_PUBLIC_HELIXUS_DRAW_SHOW_SEC, 600),
  drawFrameRect: { left: 5, top: 10, width: 50, height: 75 },
  drawCharLayout: { x: 25, y: 0, scale: 0.9 },
  reactionCharLayout: { x: 36, y: 0, scale: 0.45 },
  gameReidentifyMin: num(
    process.env.NEXT_PUBLIC_HELIXUS_GAME_REIDENTIFY_MIN,
    15
  ),
  gameSummaryEvery: num(process.env.NEXT_PUBLIC_HELIXUS_GAME_SUMMARY_EVERY, 10),
  gameConfidenceMin: 0.6,
  ttsBlockWords:
    process.env.NEXT_PUBLIC_HELIXUS_TTS_BLOCK_WORDS ||
    '习近平,毛泽东,六四,天安门事件,法轮功,台独,藏独,色情,做爱,自慰,强奸,裸体',
}

export const helixusLiveSettings = create<HelixusLiveSettings>()(
  persist(() => ({ ...DEFAULT_HELIXUS_LIVE }), {
    name: 'helixus-live-settings',
  })
)

/** 两个模式互斥：打开一个自动关另一个（布局冲突、抢 GPU） */
export const helixusModeStore = create<{ drawMode: boolean }>(() => ({
  drawMode: false,
}))

// ---------------------------------------------------------------- TTS 前的兜底过滤
let cachedSrc = ''
let cachedRe: RegExp | null = null

export function filterSpeechText(text: string): string {
  const src = helixusLiveSettings.getState().ttsBlockWords || ''
  if (src !== cachedSrc) {
    cachedSrc = src
    const words = src
      .split(/[,，\n]/)
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    cachedRe = words.length ? new RegExp(words.join('|'), 'gi') : null
  }
  if (!cachedRe) return text
  return text.replace(cachedRe, (m) => {
    logger.warn('helixus-live: TTS 前过滤掉敏感词', m)
    return '哔'
  })
}
