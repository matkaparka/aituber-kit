// helixus-motion: 生成左右镜像的 VRMAnimation。
// humanoidTracks 里是 VRM1 归一化空间的数据（createAnimationClip 才做 VRM0 的翻转），
// 关于 YZ 平面镜像：旋转 (x,y,z,w) → (x,-y,-z,w)，平移 (x,y,z) → (-x,y,z)，左右骨骼对调。
import * as THREE from 'three'
import { VRMHumanBoneName } from '@pixiv/three-vrm'
import { VRMAnimation } from '@/lib/VRMAnimation/VRMAnimation'

const swapSide = (name: string) =>
  name.startsWith('left')
    ? 'right' + name.slice(4)
    : name.startsWith('right')
      ? 'left' + name.slice(5)
      : name

export function mirrorVRMAnimation(src: VRMAnimation): VRMAnimation {
  const out = new VRMAnimation()
  out.duration = src.duration
  out.restHipsPosition = src.restHipsPosition.clone()

  for (const [name, track] of src.humanoidTracks.rotation) {
    const v = Float32Array.from(track.values)
    for (let i = 0; i < v.length; i += 4) {
      v[i + 1] = -v[i + 1]
      v[i + 2] = -v[i + 2]
    }
    const target = swapSide(name) as VRMHumanBoneName
    out.humanoidTracks.rotation.set(
      target,
      new THREE.VectorKeyframeTrack(`${target}.quaternion`, track.times, v)
    )
  }
  for (const [name, track] of src.humanoidTracks.translation) {
    const v = Float32Array.from(track.values)
    for (let i = 0; i < v.length; i += 3) v[i] = -v[i]
    const target = swapSide(name) as VRMHumanBoneName
    out.humanoidTracks.translation.set(
      target,
      new THREE.VectorKeyframeTrack(`${target}.position`, track.times, v)
    )
  }
  // 表情左右（blinkLeft 等）也对调；视线轨道这里不用（交给程序层）
  for (const [name, track] of src.expressionTracks) {
    const target = name
      .replace(/Left$/, '@')
      .replace(/Right$/, 'Left')
      .replace(/@$/, 'Right')
    const t = track.clone()
    t.name = `${target}.weight`
    out.expressionTracks.set(target, t)
  }
  return out
}
