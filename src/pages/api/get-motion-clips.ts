// helixus-motion: 列出 public/talk、public/idle 里的 .vrma，或 public/dance 下的舞蹈目录。
// 加新片段 / 新舞不用改代码
import { logger } from '@/lib/logger'
import { NextApiRequest, NextApiResponse } from 'next'
import fs from 'fs'
import path from 'path'
import { isRestrictedMode } from '@/utils/restrictedMode'
import { withAccessPolicy } from '@/lib/accessPolicy/withAccessPolicy'
import { routePolicies } from '@/lib/accessPolicy/routePolicies'

const DIRS = ['talk', 'idle', 'dance'] as const
const MUSIC = ['music.ogg', 'music.mp3', 'music.wav']

const isEnoent = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT'

/** public/dance/<名字>/ 里有 motion.vrma 的目录；meta.json 原样返回（缺省值在客户端补） */
async function listDances() {
  const root = path.join(process.cwd(), 'public', 'dance')
  const dirs = await fs.promises.readdir(root, { withFileTypes: true })
  const list = []
  for (const d of dirs
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const files = await fs.promises.readdir(path.join(root, d.name))
    if (!files.includes('motion.vrma')) continue
    let meta: unknown = {}
    if (files.includes('meta.json')) {
      try {
        meta = JSON.parse(
          await fs.promises.readFile(
            path.join(root, d.name, 'meta.json'),
            'utf-8'
          )
        )
      } catch (e) {
        logger.warn(`dance/${d.name}/meta.json is invalid, skipped`, e)
        continue
      }
    }
    const music = MUSIC.find((m) => files.includes(m))
    const base = `/dance/${encodeURIComponent(d.name)}`
    list.push({
      name: d.name,
      motion: `${base}/motion.vrma`,
      music: music ? `${base}/${music}` : null,
      meta,
    })
  }
  return list
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const dir = String(req.query.dir ?? '')
  if (!(DIRS as readonly string[]).includes(dir)) {
    return res.status(400).json({ error: 'dir must be talk, idle or dance' })
  }
  if (isRestrictedMode()) return res.status(200).json([])

  try {
    if (dir === 'dance') return res.status(200).json(await listDances())
    const files = await fs.promises.readdir(
      path.join(process.cwd(), 'public', dir)
    )
    const list = files
      .filter((f) => f.toLowerCase().endsWith('.vrma'))
      .sort()
      .map((f) => ({ name: f.replace(/\.vrma$/i, ''), path: `/${dir}/${f}` }))
    res.status(200).json(list)
  } catch (error: unknown) {
    if (isEnoent(error)) return res.status(200).json([])
    logger.error('Error reading motion clips:', error)
    res.status(500).json({ error: 'Failed to list motion clips' })
  }
}

export default withAccessPolicy(routePolicies['/api/get-motion-clips'], handler)
