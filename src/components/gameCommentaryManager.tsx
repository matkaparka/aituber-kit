/**
 * GameCommentaryManager Component
 *
 * ゲーム実況モード機能を管理し、画面キャプチャからAI実況コメントを制御する
 */

import { logger } from '@/lib/logger'
import { useGameCommentaryMode } from '@/hooks/useGameCommentaryMode'
import { useTranslation } from 'react-i18next'

const HIDE_ON_STREAM = true

function GameCommentaryManager(): JSX.Element | null {
  const { t } = useTranslation()

  const { isActive, state, secondsUntilNextCapture, isCaptureAvailable } =
    useGameCommentaryMode({
      onCommentaryStart: (phrase) => {
        if (process.env.NODE_ENV !== 'production') {
          logger.log('[GameCommentaryManager] Commentary started:', phrase.text)
        }
      },
      onCommentaryComplete: () => {
        if (process.env.NODE_ENV !== 'production') {
          logger.log('[GameCommentaryManager] Commentary completed')
        }
      },
      onCommentaryInterrupted: () => {
        if (process.env.NODE_ENV !== 'production') {
          logger.log('[GameCommentaryManager] Commentary interrupted')
        }
      },
    })

  // helixus-live: 直播姬直接拍这个窗口，状态指示也算控制 UI，不显示（逻辑照常跑）
  if (!isActive || state === 'disabled' || HIDE_ON_STREAM) {
    return null
  }

  const indicatorColor =
    state === 'speaking'
      ? 'bg-green-500'
      : state === 'capturing'
        ? 'bg-blue-500'
        : state === 'waiting'
          ? 'bg-yellow-500'
          : 'bg-gray-400'

  const animation = state === 'speaking' ? 'animate-pulse' : ''

  const stateLabel =
    state === 'speaking'
      ? t('GameCommentary.Speaking')
      : state === 'capturing'
        ? t('GameCommentary.Capturing')
        : t('GameCommentary.WaitingPrefix')

  return (
    <div
      data-testid="game-commentary-indicator"
      className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/50 backdrop-blur-sm"
    >
      {!isCaptureAvailable && (
        <span
          data-testid="game-commentary-warning"
          className="text-xs text-orange-400"
          title={t('GameCommentary.CaptureUnavailable')}
        >
          ⚠
        </span>
      )}
      <div
        data-testid="game-commentary-indicator-dot"
        className={`w-2.5 h-2.5 rounded-full ${indicatorColor} ${animation}`}
      />
      <span className="text-xs text-white/90 font-medium">{stateLabel}</span>
      {state === 'waiting' && (
        <span
          data-testid="game-commentary-countdown"
          className="text-xs text-white/70 tabular-nums"
        >
          {secondsUntilNextCapture}s
        </span>
      )}
    </div>
  )
}

export default GameCommentaryManager
