import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '@/lib/logger'

/**
 * 1ラウンド（1回のストリーミング応答）の記録。
 * コンソールに1行出力し、logs/chat-rounds/YYYY-MM-DD.jsonl にも追記する
 * （Google検索の日次回数を後から集計するため）。
 */
export type ChatRoundRecord = {
  service: string
  model: string
  searchEnabled: boolean
  queries: string[]
  sources: number
  firstTokenMs: number | null
  totalMs: number
  status: 'ok' | 'error' | 'aborted'
  /** 応答全文（ファイルにのみ記録し、コンソールには出さない） */
  text?: string
}

const LOG_DIR = path.join(process.cwd(), 'logs', 'chat-rounds')

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`

const sec = (ms: number | null) =>
  ms === null ? '-' : `${(ms / 1000).toFixed(2)}s`

export function logChatRound(record: ChatRoundRecord) {
  const searched = record.queries.length > 0
  const search = !record.searchEnabled ? 'off' : searched ? 'yes' : 'no'
  logger.log(
    `[chat-round] search=${search}` +
      (searched ? ` queries=${JSON.stringify(record.queries)}` : '') +
      (record.sources ? ` sources=${record.sources}` : '') +
      ` first=${sec(record.firstTokenMs)} total=${sec(record.totalMs)}` +
      ` model=${record.service}/${record.model}` +
      (record.status !== 'ok' ? ` status=${record.status}` : '')
  )

  const now = new Date()
  const line =
    JSON.stringify({ time: now.toISOString(), searched, ...record }) + '\n'
  mkdir(LOG_DIR, { recursive: true })
    .then(() => appendFile(path.join(LOG_DIR, `${localDate(now)}.jsonl`), line))
    .catch((e) => logger.warn('[chat-round] failed to write log file:', e))
}
