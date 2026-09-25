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
import { MotionDirector } from '@/features/helixus/motionDirector' // helixus-motion
import { DanceController } from '@/features/helixus/dance' // helixus-dance
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
  public motionDirector?: MotionDirector // helixus-motion
  public dance?: DanceController // helixus-dance
  private _audioActive = 0 // helixus-motion: 正在播放的语音数

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
    // helixus-motion: 待机 / talk 轮播 / 动作标签统一由 director 调度权重
    this.motionDirector = new MotionDirector(this.mixer, vrm)
    void this.motionDirector.loadTalkClips()
    void this.motionDirector.loadIdleClips()
    this.dance = new DanceController(
      vrm,
      this.mixer,
      this.motionDirector,
      () => this._audioActive > 0
    )
    if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
      // 开发模式调试入口：控制台里用 __helixusModel.speak(...) 直接测动作
      ;(window as unknown as { __helixusModel?: Model }).__helixusModel = this
    }

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
      this.dance?.stop() // helixus-dance
      this.dance = undefined
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
    const hadIdle = !!this.currentAction
    this.currentAction = action
    if (this.motionDirector) {
      this.motionDirector.setIdle(action, hadIdle ? 0.4 : 0) // helixus-motion
      if (hadIdle) this.motionDirector.markExternalIdle() // 拖放进来的动作不参与轮换
    } else {
      action.play()
    }
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
    await this.dance?.waitIdle() // helixus-dance: 跳舞期间 TTS 暂停，跳完接着念
    this.emoteController?.playEmotion(talk.emotion)

    if (talk.motion) {
      this.playMotionTag(talk.motion) // helixus-motion
    } else if (this.poseManager.isActive) {
      // モーション指定なしの発話ではアクティブなポーズをリセット
      this.poseManager.resetToIdle(this)
    }

    this._audioActive++ // helixus-motion
    try {
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
    } finally {
      this._audioActive = Math.max(0, this._audioActive - 1)
    }
  }

  /** ヘッダーなしPCM16を到着したチャンクから順に再生する。 */
  public async speakPcm16Stream(
    stream: ReadableStream<Uint8Array>,
    talk: Talk,
    sampleRate: number,
    observer?: PlaybackObserver
  ) {
    await this.dance?.waitIdle() // helixus-dance
    this.emoteController?.playEmotion(talk.emotion)

    if (talk.motion) {
      this.playMotionTag(talk.motion) // helixus-motion
    } else if (this.poseManager.isActive) {
      this.poseManager.resetToIdle(this)
    }

    this._audioActive++ // helixus-motion
    try {
      await this._lipSync?.playPcm16Stream(
        stream,
        undefined,
        sampleRate,
        observer?.onPlaybackStart
      )
    } finally {
      this._audioActive = Math.max(0, this._audioActive - 1)
    }
  }

  // helixus-motion: 标签按 motionTags.ts 的固定表映射到 /poses/<tag>.vrma，没有文件就跳过
  private playMotionTag(tag: string) {
    // helixus-dance: [motion:dance] 不是一个动作文件，而是请求跳舞（这轮话说完后开跳）
    if (tag.trim().toLowerCase() === 'dance') {
      void this.dance?.request({ source: 'tag' }).then((r) => {
        if (r !== 'ok') {
          logger.log(`helixus-dance: [motion:dance] ignored (${r})`)
        }
      })
      return
    }
    void resolveMotionTag(tag)
      .then((poseConfig) => {
        if (!poseConfig) return
        return this.poseManager.applyPose(this, poseConfig.id, poseConfig)
      })
      .catch((e) => logger.error('Failed to apply pose:', e))
  }

  /** helixus-dance: 开发用，控制台直接播指定的舞（不受冷却和 enabled 限制） */
  public async playDance(name: string) {
    const r = await this.dance?.request({ source: 'dev', name })
    logger.log(`helixus-dance: playDance('${name}') -> ${r}`)
    return r
  }

  /** helixus-dance: 紧急停舞（0.5 秒淡出，不发收尾消息） */
  public stopDance() {
    this.dance?.stop()
  }

  /**
   * 現在の音声再生を停止
   */
  public stopSpeaking() {
    this._lipSync?.stopCurrentPlayback()
    this.motionDirector?.stopOneShot() // helixus-motion: 停止按钮连标签动作一起停
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
    this.dance?.update() // helixus-dance: 按音频时钟设置舞蹈时间，要在 director / mixer 之前
    this.motionDirector?.update(delta, this._audioActive > 0) // helixus-motion
    this.mixer?.update(delta)
    this.dance?.afterMixer() // helixus-dance: 根骨骼水平位移限幅

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
      // helixus-dance: 跳舞时表情固定开心
      emotion:
        this.dance?.faceOverride ??
        this.emoteController?.currentEmotion ??
        'neutral',
      idleWeight: this.motionDirector
        ? this.motionDirector.idleWeight
        : this.currentAction
          ? this.currentAction.getEffectiveWeight()
          : 1,
      bodyYield: this.motionDirector?.danceWeight ?? 0, // helixus-dance
      externalVolume: this.externalLipSyncVolume,
    })

    this.vrm?.update(delta)
  }
}
