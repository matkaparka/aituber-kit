// helixus-live-motion: 每句 TTS 发给本地动作服务（E:\aivup\autoanimation\helixus\helixus_motion_server.py，
// 按语音节奏从 Solomon 动捕检索拼接），生成这句话专属的身体动作。
// 轮换：每 4 句里 3 句用实时生成，1 句照旧用 public/talk 的片段轮播。
// 带 [motion:标签] 的句子不生成（标签动作优先）。服务没开或超时就退回片段轮播，语音不等动作。
import { logger } from '@/lib/logger'
import { loadVRMAnimation } from '@/lib/VRMAnimation/loadVRMAnimation'
import type { VRMAnimation } from '@/lib/VRMAnimation/VRMAnimation'

export const LIVE_MOTION = {
  url: process.env.NEXT_PUBLIC_HELIXUS_MOTION_URL || 'http://127.0.0.1:8097',
  generatedPerCycle: 3, // 每 cycle 句里前这么多句用实时生成
  cycle: 4,
  requestTimeoutMs: 3000,
  waitAtPlaybackMs: 250, // 开口时动作还没好，最多等这么久，否则这句退回片段轮播
  healthRetryMs: 30000, // 服务不可用后，隔这么久再试
}

let counter = 0
let available: boolean | null = null
let lastHealthAt = 0

/** 按句子顺序调用：这句用不用实时生成（3:1 轮换） */
export function nextSentenceUsesLive(): boolean {
  const slot = counter % LIVE_MOTION.cycle
  counter += 1
  return slot < LIVE_MOTION.generatedPerCycle
}

async function serviceAvailable(): Promise<boolean> {
  const now = Date.now()
  if (
    available !== null &&
    (available || now - lastHealthAt < LIVE_MOTION.healthRetryMs)
  ) {
    return available
  }
  lastHealthAt = now
  try {
    const res = await fetch(`${LIVE_MOTION.url}/health`, {
      signal: AbortSignal.timeout(800),
    })
    const j = res.ok ? await res.json() : null
    available = !!j?.ready
  } catch {
    available = false
  }
  logger.log(
    `helixus-live-motion: service ${available ? 'ready' : 'unavailable'} (${LIVE_MOTION.url})`
  )
  return available
}

/** wav: 这句的 TTS 音频（调用方传一份拷贝，原件之后会被解码时转移掉） */
export async function requestLiveMotion(
  wav: ArrayBuffer
): Promise<VRMAnimation | null> {
  if (!(await serviceAvailable())) return null
  const t0 = performance.now()
  try {
    const res = await fetch(`${LIVE_MOTION.url}/motion`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      signal: AbortSignal.timeout(LIVE_MOTION.requestTimeoutMs),
    })
    if (!res.ok) {
      logger.warn(`helixus-live-motion: ${res.status} ${await res.text()}`)
      return null
    }
    const url = URL.createObjectURL(await res.blob())
    try {
      const anim = await loadVRMAnimation(url)
      logger.log(
        `helixus-live-motion: ${anim?.duration.toFixed(1)}s clip in ${(performance.now() - t0).toFixed(0)} ms`
      )
      return anim
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    available = false // 下一句先查一次健康状态
    lastHealthAt = Date.now()
    logger.warn('helixus-live-motion: request failed', e)
    return null
  }
}

/** 开口时取这句的动作：最多等 waitAtPlaybackMs，超时返回 null（这句退回片段轮播） */
export async function takeLiveMotion(
  p: Promise<VRMAnimation | null> | undefined
): Promise<VRMAnimation | null> {
  if (!p) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LIVE_MOTION.waitAtPlaybackMs)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer)
  }
}
