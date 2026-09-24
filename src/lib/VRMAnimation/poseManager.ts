import * as THREE from 'three'
import type { Model } from '@/features/vrmViewer/model'
import type { PoseConfigItem } from '@/features/stores/settings'
import { createSequenceClip } from '@/lib/VRMAnimation/createSequenceClip'
import { loadPoseFromJSON } from '@/lib/VRMAnimation/loadPoseFromJSON'
import { loadVRMAnimation } from '@/lib/VRMAnimation/loadVRMAnimation'
import { buildUrl } from '@/utils/buildUrl'

const FADE_DURATION = 0.5

interface PoseState {
  poseAction: THREE.AnimationAction
  additiveAction: THREE.AnimationAction
}

export class PoseManager {
  private poseState: PoseState | null = null
  private applyRequestId = 0
  private currentPoseName: string | null = null
  private oneShot: THREE.AnimationAction | null = null // helixus-vrma-patch

  async applyPose(
    model: Model,
    poseName: string,
    poseConfig: PoseConfigItem
  ): Promise<void> {
    if (!model.vrm || !model.mixer) return

    // helixus-vrma-patch: .vrma は一回だけ再生して待機に戻る
    if (!('sequence' in poseConfig) && /\.vrma$/i.test(poseConfig.json)) {
      await this.playOneShot(model, poseName, poseConfig.json)
      return
    }

    // 同じポーズが既にアクティブなら何もしない
    if (this.currentPoseName === poseName && this.poseState) return

    const requestId = ++this.applyRequestId

    const isSequence = 'sequence' in poseConfig
    let poseClip: THREE.AnimationClip

    if (isSequence) {
      const [poses, idleVrma] = await Promise.all([
        Promise.all(
          poseConfig.sequence.map((p) => loadPoseFromJSON(buildUrl(p)))
        ),
        loadVRMAnimation(buildUrl('/idle_loop.vrma')),
      ])
      if (poses.some((p) => !p) || !idleVrma) return
      if (requestId !== this.applyRequestId) return

      // 既存ポーズをフェードアウト（非同期ロード成功後）
      if (this.poseState) {
        this.poseState.poseAction.fadeOut(FADE_DURATION)
        this.poseState.additiveAction.fadeOut(FADE_DURATION)
      }

      poseClip = createSequenceClip(
        poses.filter((p): p is NonNullable<typeof p> => p !== null),
        model.vrm,
        poseConfig.switchDuration ?? 0.5
      )
      const hipsNode = model.vrm.humanoid.getNormalizedBoneNode('hips')
      if (hipsNode) {
        const pos = hipsNode.position
        poseClip.tracks.push(
          new THREE.VectorKeyframeTrack(
            `${hipsNode.name}.position`,
            [0],
            [pos.x, pos.y, pos.z]
          )
        )
      }
      poseClip.name = `sequence_${poseName}`
      const poseAction = model.mixer.clipAction(poseClip)
      poseAction.loop = THREE.LoopRepeat

      const additiveClip = idleVrma.createAnimationClip(model.vrm)
      THREE.AnimationUtils.makeClipAdditive(additiveClip)
      if (hipsNode) {
        additiveClip.tracks = additiveClip.tracks.filter(
          (track) => track.name !== `${hipsNode.name}.position`
        )
      }
      additiveClip.name = `idle_additive_${poseName}`
      const additiveAction = model.mixer.clipAction(additiveClip)
      additiveAction.blendMode = THREE.AdditiveAnimationBlendMode

      if (!this.poseState) this.takeBody(model) // helixus-motion

      poseAction.reset().fadeIn(FADE_DURATION).play()
      additiveAction.reset().fadeIn(FADE_DURATION).play()

      this.poseState = { poseAction, additiveAction }
      this.currentPoseName = poseName
    } else {
      const [pose, idleVrma] = await Promise.all([
        loadPoseFromJSON(buildUrl(poseConfig.json)),
        loadVRMAnimation(buildUrl('/idle_loop.vrma')),
      ])
      if (!pose || !idleVrma) return
      if (requestId !== this.applyRequestId) return

      // 既存ポーズをフェードアウト（非同期ロード成功後）
      if (this.poseState) {
        this.poseState.poseAction.fadeOut(FADE_DURATION)
        this.poseState.additiveAction.fadeOut(FADE_DURATION)
      }

      poseClip = pose.createAnimationClip(model.vrm)
      const hipsNode = model.vrm.humanoid.getNormalizedBoneNode('hips')
      if (hipsNode) {
        const pos = hipsNode.position
        poseClip.tracks.push(
          new THREE.VectorKeyframeTrack(
            `${hipsNode.name}.position`,
            [0],
            [pos.x, pos.y, pos.z]
          )
        )
      }
      poseClip.name = `pose_${poseName}`
      const poseAction = model.mixer.clipAction(poseClip)

      const additiveClip = idleVrma.createAnimationClip(model.vrm)
      THREE.AnimationUtils.makeClipAdditive(additiveClip)
      if (hipsNode) {
        additiveClip.tracks = additiveClip.tracks.filter(
          (track) => track.name !== `${hipsNode.name}.position`
        )
      }
      additiveClip.name = `idle_additive_${poseName}`
      const additiveAction = model.mixer.clipAction(additiveClip)
      additiveAction.blendMode = THREE.AdditiveAnimationBlendMode

      if (!this.poseState) this.takeBody(model) // helixus-motion

      poseAction.reset().fadeIn(FADE_DURATION).play()
      additiveAction.reset().fadeIn(FADE_DURATION).play()

      this.poseState = { poseAction, additiveAction }
      this.currentPoseName = poseName
    }
  }

  // helixus-motion: json 姿势接管身体时，让 director 把待机 / talk 淡出
  private takeBody(model: Model) {
    if (model.motionDirector) model.motionDirector.setExternal(true)
    else model.currentAction?.fadeOut(FADE_DURATION)
  }

  private giveBackBody(model: Model) {
    if (model.motionDirector) model.motionDirector.setExternal(false)
    else model.currentAction?.reset().fadeIn(FADE_DURATION).play()
  }

  private oneShotClips = new Map<string, THREE.AnimationClip>() // helixus-motion
  private oneShotVrm: Model['vrm'] = undefined

  // helixus-vrma-patch
  private async playOneShot(model: Model, poseName: string, path: string): Promise<void> {
    const requestId = ++this.applyRequestId
    if (this.oneShotVrm !== model.vrm) {
      this.oneShotClips.clear() // 换了模型，缓存的 clip 骨骼名对不上
      this.oneShotVrm = model.vrm
    }
    let clip = this.oneShotClips.get(path)
    if (!clip) {
      const vrma = await loadVRMAnimation(buildUrl(path))
      if (!vrma || !model.vrm || !model.mixer) return
      clip = vrma.createAnimationClip(model.vrm)
      clip.name = `oneshot_${poseName}`
      this.oneShotClips.set(path, clip)
    }
    if (!model.vrm || !model.mixer) return
    if (requestId !== this.applyRequestId) return
    const mixer = model.mixer
    const action = mixer.clipAction(clip)
    // helixus-motion: 由 director 播放，播完自动接回 talk（还在说话）或待机
    if (model.motionDirector) {
      if (this.poseState) {
        this.poseState.poseAction.fadeOut(FADE_DURATION)
        this.poseState.additiveAction.fadeOut(FADE_DURATION)
        this.poseState = null
        this.currentPoseName = null
        model.motionDirector.setExternal(false)
      }
      model.motionDirector.playOneShot(action)
      return
    }
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    if (this.poseState) {
      this.poseState.poseAction.fadeOut(FADE_DURATION)
      this.poseState.additiveAction.fadeOut(FADE_DURATION)
      this.poseState = null
      this.currentPoseName = null
    }
    if (this.oneShot && this.oneShot !== action) this.oneShot.fadeOut(FADE_DURATION)
    if (model.currentAction) model.currentAction.fadeOut(FADE_DURATION)
    action.reset().fadeIn(FADE_DURATION).play()
    this.oneShot = action
    const onFinished = (e: { action: THREE.AnimationAction }) => {
      if (e.action !== action) return
      mixer.removeEventListener('finished', onFinished)
      if (this.oneShot !== action) return
      this.oneShot = null
      action.fadeOut(FADE_DURATION)
      model.currentAction?.reset().fadeIn(FADE_DURATION).play()
    }
    mixer.addEventListener('finished', onFinished)
  }

  resetToIdle(model: Model): void {
    if (!model.mixer) return

    model.poseYRotationOffset = 0
    if (this.oneShot) {
      this.oneShot.fadeOut(FADE_DURATION) // helixus-vrma-patch
      this.oneShot = null
    }

    if (this.poseState) {
      this.poseState.poseAction.fadeOut(FADE_DURATION)
      this.poseState.additiveAction.fadeOut(FADE_DURATION)
      this.poseState = null
      this.currentPoseName = null
    }
    // helixus-motion: 标签动作（director 管）不在这里切断，播完自己回去；停止按钮走 model.stopSpeaking
    this.giveBackBody(model)
  }

  get isActive(): boolean {
    return this.poseState !== null
  }
}
