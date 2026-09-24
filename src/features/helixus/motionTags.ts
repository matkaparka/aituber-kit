// helixus-motion: LLM 动作标签 → public/poses/<tag>.vrma
// 标签表固定在这里，不走设置里持久化的 poseConfigs（那份存在浏览器里，和代码对不上）。
// 文件还不存在的标签直接跳过，不报错。
import { logger } from '@/lib/logger'
import type { PoseConfigItem } from '@/features/stores/settings'

export const HELIXUS_MOTION_TAGS = [
  'nod',
  'shake',
  'laugh',
  'disdain',
  'point',
  'spread_arms',
  'crossed_arms',
  'wave',
  'shrug',
  'think',
  'clap',
] as const

export type HelixusMotionTag = (typeof HELIXUS_MOTION_TAGS)[number]

const motionPath = (name: string) => `/poses/${name}.vrma`

/** 同一个标签的所有版本：nod.vrma、nod_2.vrma、nod_3.vrma… */
const variantsOf = (tag: string, available: Set<string>) =>
  [...available].filter(
    (n) =>
      n === tag ||
      (n.startsWith(tag + '_') && /^\d+$/.test(n.slice(tag.length + 1)))
  )

let availablePromise: Promise<Set<string>> | null = null

/** public/poses 里实际存在的 .vrma（去掉扩展名），只查一次 */
export function loadAvailableMotions(): Promise<Set<string>> {
  if (!availablePromise) {
    availablePromise = fetch('/api/get-pose-list')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { name: string; path: string }[]) => {
        const s = new Set<string>()
        for (const item of list) {
          if (/\.vrma$/i.test(item.path)) s.add(item.name)
        }
        return s
      })
      .catch((e) => {
        logger.warn('helixus-motion: pose list unavailable', e)
        availablePromise = null
        return new Set<string>()
      })
  }
  return availablePromise
}

const warned = new Set<string>()
const lastPick = new Map<string, string>()

/** 标签 → PoseConfigItem；不在表里或文件不存在时返回 null */
export async function resolveMotionTag(
  tag: string
): Promise<PoseConfigItem | null> {
  const id = tag.trim().toLowerCase()
  if (!(HELIXUS_MOTION_TAGS as readonly string[]).includes(id)) {
    if (!warned.has(id)) {
      warned.add(id)
      logger.log(`helixus-motion: unknown tag "${tag}", skipped`)
    }
    return null
  }
  const available = await loadAvailableMotions()
  const variants = variantsOf(id, available)
  if (variants.length === 0) {
    if (!warned.has(id)) {
      warned.add(id)
      logger.log(`helixus-motion: no file for "${id}" yet, skipped`)
    }
    return null
  }
  // 有多个版本时随机选一个，尽量不和上次一样
  let pick = variants[Math.floor(Math.random() * variants.length)]
  if (variants.length > 1 && pick === lastPick.get(id)) {
    pick = variants[(variants.indexOf(pick) + 1) % variants.length]
  }
  lastPick.set(id, pick)
  return { id: pick, json: motionPath(pick) }
}

/** 当前有文件的标签（按表的顺序），给系统提示词用 */
export async function availableMotionTags(): Promise<string[]> {
  const available = await loadAvailableMotions()
  return HELIXUS_MOTION_TAGS.filter((t) => variantsOf(t, available).length > 0)
}
