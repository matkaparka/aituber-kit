// helixus-dance: 跳舞对拍微调面板。Ctrl+Alt+D 开关（只在开发模式有效）。
// 试播不发收尾消息、不开始冷却；播放中改 offset / speed 实时生效，调好按 S 写回 meta.json。
// 面板本身会被 OBS 窗口捕获拍进去，只在不直播时用。
import { useCallback, useEffect, useRef, useState } from 'react'
import homeStore from '@/features/stores/home'
import {
  danceStore,
  loadDanceList,
  type DanceInfo,
} from '@/features/helixus/dance'

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

const HelixusDanceTuner = () => {
  const [open, setOpen] = useState(false)
  const [dances, setDances] = useState<DanceInfo[]>([])
  const [name, setName] = useState('')
  const [offset, setOffset] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [msg, setMsg] = useState('')
  const [pos, setPos] = useState('')
  const phase = danceStore((s) => s.phase)
  const live = useRef({ offset, speed })
  live.current = { offset, speed }

  const model = () => homeStore.getState().viewer.model

  const selectDance = useCallback((d: DanceInfo | undefined) => {
    if (!d) return
    setName(d.name)
    setOffset(d.meta.offset)
    setSpeed(d.meta.speed)
  }, [])

  const reload = useCallback(async () => {
    const list = await loadDanceList(0)
    setDances(list)
    return list
  }, [])

  useEffect(() => {
    if (!open) return
    void reload().then((list) => {
      if (!name) selectDance(list[0])
    })
    // name 只在第一次打开时用来决定默认选中
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reload, selectDance])

  // 开始播放时把面板上的值（可能还没保存）套上去
  useEffect(() => {
    if (open && phase === 'playing') model()?.dance?.tune(live.current)
  }, [open, phase])

  // 播放位置
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => {
      const p = model()?.dance?.playback
      setPos(p ? `${p.motionTime.toFixed(2)} / ${p.duration.toFixed(2)} s` : '')
    }, 100)
    return () => clearInterval(id)
  }, [open])

  const apply = useCallback((o: number, s: number) => {
    setOffset(o)
    setSpeed(s)
    model()?.dance?.tune({ offset: o, speed: s })
  }, [])

  const play = useCallback(async () => {
    if (!name) return
    const r = await model()?.playDance(name, { tuning: true })
    setMsg(r === 'ok' ? `试播 ${name}` : `不能播：${r ?? '模型没加载'}`)
  }, [name])

  const stop = useCallback(() => model()?.stopDance(), [])

  const save = useCallback(async () => {
    const res = await fetch('/api/dance-meta/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        offset: round(offset),
        speed: round(speed, 4),
      }),
    })
    setMsg(res.ok ? `已写回 ${name}/meta.json` : `保存失败（${res.status}）`)
    if (res.ok) void reload()
  }, [name, offset, speed, reload])

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.code === 'KeyD') {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      if (!open) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return
      }
      const big = e.shiftKey ? 10 : 1
      const { offset: o, speed: s } = live.current
      let handled = true
      if (e.key === 'ArrowLeft') apply(round(o - 0.01 * big), s)
      else if (e.key === 'ArrowRight') apply(round(o + 0.01 * big), s)
      else if (e.key === 'ArrowUp') apply(o, round(s + 0.005 * big, 4))
      else if (e.key === 'ArrowDown')
        apply(o, round(Math.max(0.1, s - 0.005 * big), 4))
      else if (e.key === 'Enter' || e.key === 'p') void play()
      else if (e.key === 'Escape') stop()
      else if (e.key === 's') void save()
      else handled = false
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, apply, play, stop, save])

  if (!open) return null
  const current = dances.find((d) => d.name === name)
  const dirty =
    current &&
    (round(current.meta.offset) !== round(offset) ||
      round(current.meta.speed, 4) !== round(speed, 4))

  return (
    <div className="fixed top-20 left-4 z-40 w-80 rounded-lg bg-black/75 p-4 text-sm text-white shadow-lg">
      <div className="mb-2 flex items-center justify-between font-bold">
        <span>跳舞对拍微调</span>
        <button onClick={() => setOpen(false)} className="px-2">
          ✕
        </button>
      </div>
      <select
        className="mb-3 w-full rounded bg-white/15 p-1"
        value={name}
        onChange={(e) =>
          selectDance(dances.find((d) => d.name === e.target.value))
        }
      >
        {dances.map((d) => (
          <option key={d.name} value={d.name} className="text-black">
            {d.name} — {d.meta.title}
            {d.music ? '' : '（没有音乐）'}
            {d.meta.enabled ? '' : '（未启用）'}
          </option>
        ))}
      </select>
      <div className="mb-1 flex justify-between">
        <span>offset（音乐晚于动作，秒）</span>
        <b>{offset.toFixed(3)}</b>
      </div>
      <div className="mb-3 flex justify-between">
        <span>speed（动作倍速）</span>
        <b>{speed.toFixed(4)}</b>
      </div>
      <div className="mb-3 flex gap-2">
        <button
          className="flex-1 rounded bg-white/20 py-1"
          onClick={() => void play()}
        >
          ▶ 试播
        </button>
        <button className="flex-1 rounded bg-white/20 py-1" onClick={stop}>
          ■ 停
        </button>
        <button
          className={`flex-1 rounded py-1 ${dirty ? 'bg-pink-600' : 'bg-white/20'}`}
          onClick={() => void save()}
        >
          保存
        </button>
      </div>
      <div className="text-xs leading-5 text-white/70">
        ←/→ offset ±0.01 秒（Shift ×10）
        <br />
        ↑/↓ speed ±0.005（Shift ×10）
        <br />
        Enter 试播 · Esc 停 · S 保存 · Ctrl+Alt+D 关
        <br />
        动作比音乐慢（拖拍）→ offset 调大；动作抢拍 → 调小
      </div>
      {(pos || msg) && (
        <div className="mt-2 text-xs text-white/90">
          {pos && <div>动作位置 {pos}</div>}
          {msg && <div>{msg}</div>}
        </div>
      )}
    </div>
  )
}

export default HelixusDanceTuner
