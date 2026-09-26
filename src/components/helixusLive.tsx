// helixus-live: 点图画框 + 两个模式的快捷键、互斥、布局切换。
// 快捷键：Ctrl+Alt+P 点图模式，Ctrl+Alt+G 看屏幕 reaction，Ctrl+Alt+I 重新识别游戏
import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import settingsStore from '@/features/stores/settings'
import homeStore from '@/features/stores/home'
import menuStore from '@/features/stores/menu'
import { buildUrl } from '@/utils/buildUrl'
import {
  helixusLiveSettings,
  helixusModeStore,
  CharLayout,
} from '@/features/helixus/liveSettings'
import { clearDrawQueue, drawFrameStore } from '@/features/helixus/draw'
import { requestGameReidentify } from '@/features/helixus/gameMemory'

const FRAME_BG = '/backgrounds/drawing_frame.png'

export function setDrawMode(on: boolean) {
  helixusModeStore.setState({ drawMode: on })
  if (on && settingsStore.getState().gameCommentaryPlaying) {
    settingsStore.setState({ gameCommentaryPlaying: false })
  }
  if (!on) clearDrawQueue()
  logger.log(`helixus-live: 点图模式 ${on ? '开' : '关'}`)
}

export function setReactionMode(on: boolean) {
  if (on) {
    helixusModeStore.setState({ drawMode: false })
    clearDrawQueue()
    settingsStore.setState({
      gameCommentaryEnabled: true,
      gameCommentaryPlaying: true,
    })
    // 和菜单按钮一样：没在共享屏幕就打开共享
    if (!menuStore.getState().showCapture) {
      menuStore.setState({ showCapture: true, showWebcam: false })
      homeStore.setState({ webcamStatus: false })
    }
  } else {
    settingsStore.setState({ gameCommentaryPlaying: false })
  }
  logger.log(`helixus-live: reaction 模式 ${on ? '开' : '关'}`)
}

/** 当前角色布局：点图 / reaction 各一套，都没开时 null（保持原样） */
export function useHelixusCharLayout(): CharLayout | null {
  const drawMode = helixusModeStore((s) => s.drawMode)
  const reaction = settingsStore((s) => s.gameCommentaryPlaying)
  const drawLayout = helixusLiveSettings((s) => s.drawCharLayout)
  const reactionLayout = helixusLiveSettings((s) => s.reactionCharLayout)
  if (drawMode) return drawLayout
  if (reaction) return reactionLayout
  return null
}

export const charLayoutStyle = (l: CharLayout | null) =>
  l
    ? {
        transform: `translate(${l.x}vw, ${l.y}vh) scale(${l.scale})`,
        transformOrigin: '100% 100%',
        transition: 'transform 0.6s ease',
      }
    : { transition: 'transform 0.6s ease' }

/** 点图模式下的页面背景：有 drawing_frame.png 就用它，没有返回 null（用 CSS 占位相框） */
export function useDrawBackground(): string | null {
  const drawMode = helixusModeStore((s) => s.drawMode)
  const [exists, setExists] = useState<boolean | null>(null)
  useEffect(() => {
    if (!drawMode || exists !== null) return
    const img = new Image()
    img.onload = () => setExists(true)
    img.onerror = () => setExists(false)
    img.src = buildUrl(FRAME_BG)
  }, [drawMode, exists])
  return drawMode && exists ? buildUrl(FRAME_BG) : null
}

export function HelixusLive() {
  const drawMode = helixusModeStore((s) => s.drawMode)
  const frame = drawFrameStore((s) => s.frame)
  const rect = helixusLiveSettings((s) => s.drawFrameRect)
  const hasBgImage = useDrawBackground() !== null

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.repeat) return
      const k = e.key.toLowerCase()
      if (k === 'p') {
        setDrawMode(!helixusModeStore.getState().drawMode)
      } else if (k === 'g') {
        setReactionMode(!settingsStore.getState().gameCommentaryPlaying)
      } else if (k === 'i') {
        requestGameReidentify()
      } else {
        return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 互斥：菜单按钮打开 reaction 时关掉点图；reaction 开时把共享画面铺成背景，关时恢复原设置
  useEffect(() => {
    let savedVideoBg: boolean | null = null
    const apply = (playing: boolean) => {
      if (playing) {
        if (helixusModeStore.getState().drawMode) setDrawMode(false)
        if (savedVideoBg === null) {
          savedVideoBg = settingsStore.getState().useVideoAsBackground
        }
        if (!settingsStore.getState().useVideoAsBackground) {
          settingsStore.setState({ useVideoAsBackground: true })
        }
      } else if (savedVideoBg !== null) {
        settingsStore.setState({ useVideoAsBackground: savedVideoBg })
        savedVideoBg = null
      }
    }
    apply(settingsStore.getState().gameCommentaryPlaying)
    return settingsStore.subscribe((s, prev) => {
      if (s.gameCommentaryPlaying !== prev.gameCommentaryPlaying) {
        apply(s.gameCommentaryPlaying)
      }
    })
  }, [])

  if (!drawMode) return null

  const box = {
    left: `${rect.left}vw`,
    top: `${rect.top}vh`,
    width: `${rect.width}vw`,
    height: `${rect.height}vh`,
  }
  return (
    <div
      className="absolute z-[2] pointer-events-none flex flex-col"
      style={box}
    >
      <div
        className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden"
        style={
          hasBgImage
            ? {}
            : {
                // 占位相框：等 drawing_frame.png 做好就不画了
                border: '14px solid #6b4a1f',
                outline: '4px solid #c9a24a',
                boxShadow:
                  'inset 0 0 0 4px #c9a24a, 0 10px 40px rgba(0,0,0,0.55)',
                background: 'rgba(20,16,12,0.82)',
              }
        }
      >
        {frame.kind === 'showing' ? (
          <img
            key={frame.at}
            src={frame.image}
            alt=""
            className="w-full h-full"
            style={{
              objectFit: 'contain',
              opacity: 0,
              transition: 'opacity 1.2s ease',
            }}
            onLoad={(e) => (e.currentTarget.style.opacity = '1')}
          />
        ) : frame.kind === 'generating' ? (
          <div className="text-center text-amber-100 px-6">
            <div className="mx-auto mb-5 h-14 w-14 rounded-full border-4 border-amber-200/30 border-t-amber-300 animate-spin" />
            <div className="text-2xl font-bold tracking-wide">
              作画中 · {truncate(frame.user, 12)}
            </div>
            {frame.request && (
              <div className="mt-2 text-lg opacity-90">
                {truncate(frame.request, 30)}
              </div>
            )}
          </div>
        ) : (
          <div className="text-center text-amber-100/90 text-2xl font-bold px-6">
            弹幕发送『画 + 内容』召唤作品
          </div>
        )}
      </div>
      {frame.kind === 'showing' && (
        <div className="mt-2 text-center text-lg font-bold text-white drop-shadow-[0_2px_2px_rgba(0,0,0,0.9)]">
          点图：{truncate(frame.user, 16)}
        </div>
      )}
    </div>
  )
}

const truncate = (s: string, n: number) =>
  [...s].length > n ? [...s].slice(0, n).join('') + '…' : s
