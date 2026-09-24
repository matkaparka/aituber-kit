import { logger } from '@/lib/logger'
import * as THREE from 'three'
import {
  VRM,
  VRMExpressionPresetName,
  VRMLoaderPlugin,
  VRMUtils,
} from '@pixiv/three-vrm'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMAnimation } from '../../lib/VRMAnimation/VRMAnimation'
import { VRMLookAtSmootherLoaderPlugin } from '@/lib/VRMLookAtSmootherLoaderPlugin/VRMLookAtSmootherLoaderPlugin'
import { LipSync } from '../lipSync/lipSync'
import { EmoteController } from '../emoteController/emoteController'
import { LiveLayer } from '../emoteController/liveLayer' // helixus-live
import { Talk } from '../messages/messages'
import { PoseManager } from '@/lib/VRMAnimation/poseManager'
import { resolveMotionTag } from '@/features/helixus/motionTags' // helixus-motion
import type { PlaybackObserver } from '../messages/characterRenderer'

/**
 * 3Dキャラクターを管理するクラス
 */
export class Model {
  public externalLipSyncVolume: number | null = null
  public vrm?: VRM | null
  public mixer?: THREE.AnimationMixer
  public emoteController?: EmoteController
  public currentAction?: THREE.AnimationAction
  public poseYRotationOffset: number = 0
  public poseManager: PoseManager
  public liveLayer?: LiveLayer // helixus-live

  private _lookAtTargetParent: THREE.Object3D
  private _lipSync?: LipSync
  private _yOffsetQuat = new THREE.Quaternion()

  constructor(lookAtTargetParent: THREE.Object3D) {
    this._lookAtTargetParent = lookAtTargetParent
    this._lipSync = new LipSync(new AudioContext(), { forceStart: true })
    this.poseManager = new PoseManager()
  }

  public async loadVRM(url: string): Promise<void> {
    const loader = new GLTFLoader()
    loader.register(
      (parser) =>
        new VRMLoaderPlugin(parser, {
          lookAtPlugin: new VRMLookAtSmootherLoaderPlugin(parser),
        })
    )

    const gltf = await loader.loadAsync(url)

    const vrm = (this.vrm = gltf.userData.vrm)
    vrm.scene.name = 'VRMRoot'

    VRMUtils.rotateVRM0(vrm)
    this.mixer = new THREE.AnimationMixer(vrm.scene)

    this.emoteController = new EmoteController(vrm, this._lookAtTargetParent)
    // helixus-live: 眨眼、表情过渡、视线和身体小动作交给程序层
    this.emoteController.disableAutoBlink()
    this.liveLayer = new LiveLayer(
      vrm,
      this._lipSync?.analyser,
      this._lookAtTargetParent
    )
  }

  public unLoadVrm() {
    if (this.vrm) {
      VRMUtils.deepDispose(this.vrm.scene)
      this.vrm = null
      this.liveLayer = undefined // helixus-live
    }
  }

  /**
   * VRMアニメーションを読み込む
   *
   * https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.ja.md
   */
  public async loadAnimation(vrmAnimation: VRMAnimation): Promise<void> {
    const { vrm, mixer } = this
    if (vrm == null || mixer == null) {
      throw new Error('You have to load VRM first')
    }

    const clip = vrmAnimation.createAnimationClip(vrm)
    const action = mixer.clipAction(clip)
    this.currentAction = action
    action.play()
  }

  /**
   * 音声を再生し、リップシンクを行う
   */
  public async speak(
    buffer: ArrayBuffer,
    talk: Talk,
    isNeedDecode: boolean = true,
    observer?: PlaybackObserver
  ) {
    this.emoteController?.playEmotion(talk.emotion)

    if (talk.motion) {
      this.playMotionTag(talk.motion) // helixus-motion
    } else if (this.poseManager.isActive) {
      // モーション指定なしの発話ではアクティブなポーズをリセット
      this.poseManager.resetToIdle(this)
    }

    await new Promise((resolve) => {
      this._lipSync?.playFromArrayBuffer(
        buffer,
        () => {
          resolve(true)
        },
        isNeedDecode,
        24000,
        observer?.onPlaybackStart
      )
    })
  }

  /** ヘッダーなしPCM16を到着したチャンクから順に再生する。 */
  public async speakPcm16Stream(
    stream: ReadableStream<Uint8Array>,
    talk: Talk,
    sampleRate: number,
    observer?: PlaybackObserver
  ) {
    this.emoteController?.playEmotion(talk.emotion)

    if (talk.motion) {
      this.playMotionTag(talk.motion) // helixus-motion
    } else if (this.poseManager.isActive) {
      this.poseManager.resetToIdle(this)
    }

    await this._lipSync?.playPcm16Stream(
      stream,
      undefined,
      sampleRate,
      observer?.onPlaybackStart
    )
  }

  // helixus-motion: 标签按 motionTags.ts 的固定表映射到 /poses/<tag>.vrma，没有文件就跳过
  private playMotionTag(tag: string) {
    void resolveMotionTag(tag)
      .then((poseConfig) => {
        if (!poseConfig) return
        return this.poseManager.applyPose(this, poseConfig.id, poseConfig)
      })
      .catch((e) => logger.error('Failed to apply pose:', e))
  }

  /**
   * 現在の音声再生を停止
   */
  public stopSpeaking() {
    this._lipSync?.stopCurrentPlayback()
  }

  /**
   * 感情表現を再生する
   */
  public async playEmotion(preset: VRMExpressionPresetName) {
    this.emoteController?.playEmotion(preset)
  }

  public update(delta: number): void {
    if (this._lipSync) {
      const { volume, vowels } = this._lipSync.update() // helixus-wlipsync
      if (vowels && this.externalLipSyncVolume === null) {
        this.emoteController?.lipSyncVowels(vowels)
      } else {
        this.emoteController?.lipSync('aa', this.externalLipSyncVolume ?? volume)
      }
    }

    this.emoteController?.update(delta)
    this.mixer?.update(delta)

    if (this.poseYRotationOffset !== 0 && this.vrm) {
      const hipsNode = this.vrm.humanoid.getNormalizedBoneNode('hips')
      if (hipsNode) {
        this._yOffsetQuat.setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          this.poseYRotationOffset
        )
        hipsNode.quaternion.premultiply(this._yOffsetQuat)
      }
    }

    // helixus-live: 动画之后、渲染之前叠加程序动作
    this.liveLayer?.update(delta, {
      emotion: this.emoteController?.currentEmotion ?? 'neutral',
      idleWeight: this.currentAction
        ? this.currentAction.getEffectiveWeight()
        : 1,
      externalVolume: this.externalLipSyncVolume,
    })

    this.vrm?.update(delta)
  }
}
