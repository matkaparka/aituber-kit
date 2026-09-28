import {
  lyricIndexAt,
  parseLrc,
  voiceActivity,
} from '@/features/helixus/singing'

describe('helixus-singing parseLrc', () => {
  it('drops credit lines and empty lines, keeps order', () => {
    const lrc = [
      '[00:00.000] 作词 : 宋冬野',
      '[00:01.000] 作曲 : 宋冬野',
      '[00:02.000] 编曲 : 韦伟',
      '[00:37.196]让我再看你一遍',
      '[00:39.294]从南到北',
      '[00:44.176]',
      '[00:44.500]像是被五环路蒙住的双眼',
    ].join('\n')
    const lines = parseLrc(lrc)
    expect(lines.map((l) => l.text)).toEqual([
      '让我再看你一遍',
      '从南到北',
      '像是被五环路蒙住的双眼',
    ])
    expect(lines[0].t).toBeCloseTo(37.196)
  })

  it('expands a line with several timestamps', () => {
    const lines = parseLrc('[01:30.00][00:12.5]副歌\n[00:20]主歌')
    expect(lines).toEqual([
      { t: 12.5, text: '副歌' },
      { t: 20, text: '主歌' },
      { t: 90, text: '副歌' },
    ])
  })

  it('handles empty input', () => {
    expect(parseLrc('')).toEqual([])
  })
})

describe('helixus-singing lyricIndexAt', () => {
  const lines = [
    { t: 10, text: 'a' },
    { t: 20, text: 'b' },
    { t: 30, text: 'c' },
  ]
  it('finds the current line', () => {
    expect(lyricIndexAt(lines, 5)).toBe(-1)
    expect(lyricIndexAt(lines, 10)).toBe(0)
    expect(lyricIndexAt(lines, 25)).toBe(1)
    expect(lyricIndexAt(lines, 99)).toBe(2)
    expect(lyricIndexAt([], 5)).toBe(-1)
  })
})

describe('helixus-singing voiceActivity', () => {
  const sr = 1000
  const opts = {
    pollSec: 2,
    startDelay: 0.2,
    fadeOut: 0.6,
    envFrame: 0.05,
    envRangeDb: 30,
    envHold: 0.5,
    envBridge: 0.8,
    afterTimeout: 8000,
  }
  // 0-2 s 唱，2-2.5 s 换气，2.5-4 s 唱，4-10 s 间奏（几乎静音）
  const make = () => {
    const x = new Float32Array(10 * sr)
    for (let i = 0; i < x.length; i++) {
      const t = i / sr
      const sing = t < 2 || (t >= 2.5 && t < 4)
      x[i] = (sing ? 0.3 : 0.0005) * Math.sin(2 * Math.PI * 110 * t)
    }
    return x
  }

  it('fills short breaths, holds briefly, then goes silent in the interlude', () => {
    const act = voiceActivity(make(), sr, opts)
    const at = (t: number) => act[Math.floor(t / opts.envFrame)]
    expect(at(1)).toBe(1)
    expect(at(2.2)).toBe(1) // 0.5 s 换气被填上
    expect(at(4.3)).toBe(1) // 唱完后 0.5 s 内保持
    expect(at(5)).toBe(0)
    expect(at(9)).toBe(0)
  })
})
