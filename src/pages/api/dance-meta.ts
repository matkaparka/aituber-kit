// helixus-dance: 跳舞微调面板把调好的 offset / speed / bpm 写回 public/dance/<名字>/meta.json。
// 只在开发模式、只接受本机请求，只改这三个字段，其他字段原样保留
import { logger } from '@/lib/logger'
import { NextApiRequest, NextApiResponse } from 'next'
import fs from 'fs'
import path from 'path'
import { withAccessPolicy } from '@/lib/accessPolicy/withAccessPolicy'
import { routePolicies } from '@/lib/accessPolicy/routePolicies'

const FIELDS = ['offset', 'speed', 'bpm'] as const
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'dev only' })
  }
  if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) {
    return res.status(403).json({ error: 'local only' })
  }
  const name = String(req.body?.name ?? '')
  if (!/^[\w-]+$/.test(name)) {
    return res.status(400).json({ error: 'invalid name' })
  }
  const file = path.join(process.cwd(), 'public', 'dance', name, 'meta.json')
  try {
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(await fs.promises.readFile(file, 'utf-8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      await fs.promises.access(path.dirname(file)) // 舞蹈目录必须已存在
    }
    for (const k of FIELDS) {
      const v = req.body?.[k]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return res.status(400).json({ error: `${k} must be a number` })
      }
      meta[k] = Math.round(v * 1000) / 1000
    }
    await fs.promises.writeFile(file, JSON.stringify(meta, null, 2) + '\n')
    logger.log(`dance-meta: ${name} <- ${JSON.stringify(req.body)}`)
    return res.status(200).json({ ok: true, meta })
  } catch (e) {
    logger.error('dance-meta: failed', e)
    return res.status(500).json({ error: 'failed to write meta.json' })
  }
}

export default withAccessPolicy(routePolicies['/api/dance-meta'], handler)
