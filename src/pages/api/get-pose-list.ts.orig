import { logger } from '@/lib/logger'
import { NextApiRequest, NextApiResponse } from 'next'
import fs from 'fs'
import path from 'path'
import { isRestrictedMode } from '@/utils/restrictedMode'
import assetManifest from '@/constants/assetManifest.json'
import { withAccessPolicy } from '@/lib/accessPolicy/withAccessPolicy'
import { routePolicies } from '@/lib/accessPolicy/routePolicies'

interface PoseListItem {
  name: string
  path: string
}

interface AssetManifest {
  poses?: PoseListItem[]
  [key: string]: unknown
}

const manifest = assetManifest as AssetManifest

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (isRestrictedMode()) {
    const poses = Array.isArray(manifest.poses)
      ? manifest.poses.filter(
          (item): item is PoseListItem =>
            typeof item === 'object' &&
            item !== null &&
            typeof item.name === 'string' &&
            typeof item.path === 'string'
        )
      : []
    return res.status(200).json(poses)
  }

  const posesDir = path.join(process.cwd(), 'public', 'poses')

  try {
    const files = await fs.promises.readdir(posesDir)
    const jsonFiles = files.filter((file) => file.endsWith('.json'))

    const poseFiles: PoseListItem[] = []

    for (const file of jsonFiles) {
      try {
        const filePath = path.join(posesDir, file)
        const content = await fs.promises.readFile(filePath, 'utf-8')
        const json = JSON.parse(content)

        if ((json.specVersion && json.bones) || (json.version && json.pose)) {
          poseFiles.push({
            name: file.replace('.json', ''),
            path: `/poses/${file}`,
          })
        }
      } catch (error) {
        logger.warn(`Skip invalid pose JSON: ${file}`, error)
      }
    }

    res.status(200).json(poseFiles)
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return res.status(200).json([])
    }
    logger.error('Error reading pose files:', error)
    res.status(500).json({ error: 'Failed to get pose file list' })
  }
}

export default withAccessPolicy(routePolicies['/api/get-pose-list'], handler)
