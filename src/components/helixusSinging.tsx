// helixus-singing: 每 2 秒轮询唱歌服务（有就绪的歌、他闲着就开唱），唱歌时显示歌名和当前这句歌词。
// 歌词开关在设置 →「游戏实况」页底部的「唱歌」一节。
import { useEffect } from 'react'
import { helixusLiveSettings } from '@/features/helixus/liveSettings'
import { SINGING, singing, singingStore } from '@/features/helixus/singing'

const shadow = '0 0 4px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.95)'

const HelixusSinging = () => {
  const enabled = helixusLiveSettings((s) => s.singingEnabled)
  const showLyrics = helixusLiveSettings((s) => s.singingLyrics)
  const phase = singingStore((s) => s.phase)
  const song = singingStore((s) => s.song)
  const line = singingStore((s) => s.line)
  const lyrics = singingStore((s) => s.lyrics)

  useEffect(() => {
    if (!enabled) return
    void singing.poll()
    const id = setInterval(() => void singing.poll(), SINGING.pollSec * 1000)
    return () => clearInterval(id)
  }, [enabled])

  const visible = showLyrics && phase === 'playing' && !!song
  const cur = line >= 0 ? (lyrics[line]?.text ?? '') : ''
  const next = lyrics[line + 1]?.text ?? ''

  return (
    <div
      className="pointer-events-none fixed inset-0 z-30 transition-opacity duration-700"
      style={{ opacity: visible ? 1 : 0 }}
      aria-hidden={!visible}
    >
      {song && (
        <div
          className="absolute top-4 right-6 text-lg font-bold text-white"
          style={{ textShadow: shadow }}
        >
          ♪ {song.name}
          {song.artists.length > 0 && ` — ${song.artists.join(' / ')}`}
          {song.requester && (
            <span className="ml-3 text-base font-normal">
              点歌：{song.requester}
            </span>
          )}
        </div>
      )}
      {/* 和 AssistantText（唱歌时隐藏）同一个位置，让开底部输入框 */}
      <div className="absolute bottom-[86px] left-0 right-0 flex flex-col items-center gap-1 px-8 text-center sm:bottom-[104px]">
        <div
          className="text-4xl font-bold text-white"
          style={{ textShadow: shadow, minHeight: '1.2em' }}
        >
          {cur}
        </div>
        <div
          className="text-2xl text-white/70"
          style={{ textShadow: shadow, minHeight: '1.2em' }}
        >
          {next}
        </div>
      </div>
    </div>
  )
}

export default HelixusSinging
