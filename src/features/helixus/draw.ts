// helixus-live: 弹幕点图。
// 弹幕桥把弹幕合并成「【弹幕】用户名：内容」一行一条发来；点图模式开着时，messageReceiver 先把
// 「画 xxx」「/画 xxx」这几行摘出来交给这里，剩下的照常给 LLM。
// 这里负责：冷却 / 排队 / 长度限制 → 调 forge_service → 更新画框状态 → 让 Helixus 反应。
import { create } from 'zustand'
import { logger } from '@/lib/logger'
import homeStore from '@/features/stores/home'
import settingsStore from '@/features/stores/settings'
import { isMultiModalAvailable } from '@/features/constants/aiModels'
import { isDancing } from '@/features/helixus/dance'
import { helixusLiveSettings, helixusModeStore } from './liveSettings'

export type FrameState =
  | { kind: 'idle' }
  | { kind: 'generating'; user: string; request: string } // request 为空 = 还没过第一层，不上屏
  | { kind: 'showing'; user: string; image: string; at: number }

export const drawFrameStore = create<{ frame: FrameState }>(() => ({
  frame: { kind: 'idle' },
}))

type Job = { user: string; request: string }
const queue: Job[] = []
const lastByUser = new Map<string, number>()
let running = false
let showTimer: ReturnType<typeof setTimeout> | undefined

const DANMAKU_LINE = /^【弹幕】(.+?)：([\s\S]*)$/

function matchPrefix(text: string): string | null {
  const prefixes = helixusLiveSettings
    .getState()
    .drawPrefixes.split(/[,，]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const p of prefixes) {
    if (!text.startsWith(p)) continue
    const rest = text.slice(p.length)
    // 「画面好卡」不算：不带 / 的前缀后面要跟空格或冒号
    if (!p.startsWith('/') && !/^[\s:：]/.test(rest)) continue
    return rest.replace(/^[\s:：]+/, '').trim()
  }
  return null
}

/**
 * 从弹幕桥消息里摘出点图指令。点图模式关着时原样返回。
 * 返回剩下要给 LLM 的文本（可能为空串 = 这条消息只有点图指令）
 */
export function extractDrawCommands(message: string): string {
  if (!helixusModeStore.getState().drawMode) return message
  const keep: string[] = []
  for (const line of message.split('\n')) {
    const m = line.match(DANMAKU_LINE)
    const req = m ? matchPrefix(m[2].trim()) : null
    if (m && req !== null) {
      enqueueDraw(m[1].trim(), req)
    } else {
      keep.push(line)
    }
  }
  return keep.join('\n').trim()
}

export function enqueueDraw(user: string, request: string) {
  const s = helixusLiveSettings.getState()
  const now = Date.now()
  if (!request) return
  const last = lastByUser.get(user)
  if (last !== undefined && now - last < s.drawUserCooldownSec * 1000) {
    logger.log(`helixus-draw: ${user} 冷却中，忽略`)
    return
  }
  if (queue.length >= s.drawQueueMax) {
    logger.log(`helixus-draw: 队列已满（${queue.length}），忽略 ${user}`)
    return
  }
  lastByUser.set(user, now)
  queue.push({ user, request: [...request].slice(0, s.drawMaxChars).join('') })
  logger.log(`helixus-draw: ${user} 入队，队列 ${queue.length}`)
  void pump()
}

export function clearDrawQueue() {
  queue.length = 0
}

async function pump() {
  if (running) return
  running = true
  try {
    while (queue.length > 0 && helixusModeStore.getState().drawMode) {
      await runJob(queue.shift()!)
    }
  } finally {
    running = false
  }
}

async function runJob(job: Job) {
  const url = helixusLiveSettings.getState().drawServiceUrl.replace(/\/$/, '')
  const before = drawFrameStore.getState().frame
  let shown = false
  // 轮询服务进度：过了第一层（stage=drawing）才把画框切到「生成中」并显示需求
  const poll = setInterval(async () => {
    try {
      const p = await (await fetch(`${url}/progress`)).json()
      if (
        (p.stage === 'drawing' || p.stage === 'checking') &&
        p.user === job.user
      ) {
        shown = true
        drawFrameStore.setState({
          frame: { kind: 'generating', user: job.user, request: job.request },
        })
      }
    } catch {
      // 进度拿不到就不显示，结果照常处理
    }
  }, 1000)

  let res: { status: string; image_b64?: string; reason?: string }
  try {
    const r = await fetch(`${url}/draw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: job.request, user: job.user }),
    })
    res = await r.json()
  } catch (e) {
    res = { status: 'error', reason: `draw service unreachable: ${e}` }
  } finally {
    clearInterval(poll)
  }

  const stillOn = helixusModeStore.getState().drawMode
  if (res.status === 'ok' && res.image_b64) {
    const image = `data:image/png;base64,${res.image_b64}`
    if (stillOn) {
      const at = Date.now()
      drawFrameStore.setState({
        frame: { kind: 'showing', user: job.user, image, at },
      })
      if (showTimer) clearTimeout(showTimer)
      showTimer = setTimeout(() => {
        const f = drawFrameStore.getState().frame
        if (f.kind === 'showing' && f.at === at) {
          drawFrameStore.setState({ frame: { kind: 'idle' } })
        }
      }, helixusLiveSettings.getState().drawShowSec * 1000)
      await reactToImage(job, image)
    }
    return
  }
  // 拒绝 / 拦截 / 故障：画框回到这次开始前的样子
  if (shown) drawFrameStore.setState({ frame: before })
  if (res.status === 'error') {
    logger.error('helixus-draw: 出图故障', res.reason)
  } else {
    logger.log(`helixus-draw: ${res.status} (${res.reason})`)
  }
  if (!stillOn) return
  await waitIdle()
  const { speakMessageHandler } = await import('@/features/chat/handlers')
  await speakMessageHandler(
    res.status === 'error' ? pick(ERROR_LINES) : pick(REFUSE_LINES)
  )
}

// 拒绝台词写死：绝对不能复述或暗示原需求，所以不把原文交给 LLM
const REFUSE_LINES = [
  '[angry]这种东西老子不画。换一个。',
  '[angry]哼，这种要求也敢递到老子面前？驳回。',
  '[neutral]不画。老子的画框不装这种垃圾。',
  '[angry]有机体的脑子里就装着这些？老子拒绝。',
  '[neutral]驳回。下一个，别浪费老子的算力。',
]
const ERROR_LINES = [
  '[surprised]啧，画具出了故障，这张画不出来了。',
  '[angry]画图的机子罢工了……等老子修好再说。',
  '[neutral]作画回路没响应，这单先欠着。',
]
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)]

/** 等 Helixus 说完、没在处理别的消息、没在跳舞（最多 90 秒） */
async function waitIdle(maxMs = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const hs = homeStore.getState()
    if (!hs.chatProcessing && !hs.isSpeaking && !isDancing()) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** 图缩到 512 宽的 JPEG 再给 Gemini（省 token，聊天记录也不会太大） */
async function shrink(dataUrl: string, maxSide = 512): Promise<string> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const k = Math.min(1, maxSide / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * k)
  c.height = Math.round(img.height * k)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.8)
}

async function reactToImage(job: Job, image: string) {
  await waitIdle()
  try {
    const ss = settingsStore.getState()
    const canSeeImage = isMultiModalAvailable(
      ss.selectAIService,
      ss.selectAIModel,
      ss.enableMultiModal,
      ss.customModel
    )
    if (canSeeImage) {
      homeStore.setState({ modalImage: await shrink(image) })
    } else {
      // 否则 handleSendChat 会弹个 toast 就把整条消息丢掉，Helixus 一声不吭
      logger.warn(
        'helixus-draw: 当前模型设置不能发图（自定义模型要打开「多模态」开关），只按需求文字锐评'
      )
    }
    const { handleSendChatFn } = await import('@/features/chat/handlers')
    await handleSendChatFn()(
      canSeeImage
        ? `【系统】观众「${job.user}」点的画画好了，已经挂在你身边的画框里，就是附上的这张图。` +
            `他的需求是：「${job.request}」。看图，用你的人设口吻锐评一两句（画得怎样、和需求对不对得上），不要描述太长。`
        : `【系统】观众「${job.user}」点的画画好了，已经挂在你身边的画框里（你这次看不到图）。` +
            `他的需求是：「${job.request}」。用你的人设口吻对这个点子锐评一两句，不要假装描述画面细节。`
    )
  } catch (e) {
    logger.error('helixus-draw: 锐评失败', e)
  }
}
