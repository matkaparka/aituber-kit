import type { VRMExpressionPresetName } from '@pixiv/three-vrm'

export interface LipSyncAnalyzeResult {
  volume: number
  // helixus-wlipsync: 母音ごとの口形の重み（wLipSync が有効なときだけ）
  vowels?: Partial<Record<VRMExpressionPresetName, number>>
}
