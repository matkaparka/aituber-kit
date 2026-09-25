// helixus-dance: 跳舞时在画面右上角显示 meta.json 里的 credit，跳完隐藏
import { danceStore } from '@/features/helixus/dance'

const HelixusDanceCredit = () => {
  const phase = danceStore((s) => s.phase)
  const credit = danceStore((s) => s.current?.meta.credit ?? '')
  // 淡出阶段（ending）开始就隐藏，0.7 秒渐隐
  const visible = phase === 'playing' && !!credit

  return (
    <div
      className="pointer-events-none fixed top-4 right-6 z-30 text-lg font-bold text-white transition-opacity duration-700"
      style={{
        opacity: visible ? 1 : 0,
        textShadow: '0 0 4px rgba(0,0,0,0.8), 0 1px 2px rgba(0,0,0,0.9)',
      }}
      aria-hidden={!visible}
    >
      {credit}
    </div>
  )
}

export default HelixusDanceCredit
