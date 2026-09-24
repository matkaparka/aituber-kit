// helixus-motion: 列出 public/talk 或 public/idle 里的 .vrma，加新片段不用改代码
import { logger } from '@/lib/logger'
import { NextApiRequest, NextApiResponse } from 'next'
import fs from 'fs'
import path from 'path'
import { isRestrictedMode } from '@/utils/restrictedMode'
import { withAccessPolicy } from '@/lib/accessPolicy/withAccessPolicy'
import { routePolicies } from '@/lib/accessPolicy/routePolicies'

const DIRS = ['talk', 'idle'] as const

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const dir = String(req.query.dir ?? '')
  if (!(DIRS as readonly string[]).includes(dir)) {
    return res.status(400).json({ error: 'dir must be talk or idle' })
  }
  if (isRestrictedMode()) return res.status(200).json([])

  try {
    const files = await fs.promises.readdir(
      path.join(process.cwd(), 'public', dir)
    )
    const list = files
      .filter((f) => f.toLowerCase().endsWith('.vrma'))
      .sort()
      .map((f) => ({ name: f.replace(/\.vrma$/i, ''), path: `/${dir}/${f}` }))
    res.status(200).json(list)
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return res.status(200).json([])
    }
    logger.error('Error reading motion clips:', error)
    res.status(500).json({ error: 'Failed to list motion clips' })
  }
}

export default withAccessPolicy(routePolicies['/api/get-motion-clips'], handler)
