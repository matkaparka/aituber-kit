import {
  danceCooldownLeft,
  dancePromptLine,
  danceStore,
  handleDanceRequest,
  loadDanceList,
} from '@/features/helixus/dance'
import { MOTION } from '@/features/helixus/motionDirector'
import homeStore from '@/features/stores/home'

jest.mock('@/lib/VRMAnimation/loadVRMAnimation', () => ({
  loadVRMAnimation: jest.fn(),
}))

jest.mock('@/features/stores/home', () => ({
  __esModule: true,
  default: { getState: jest.fn() },
}))

const mockHomeGetState = homeStore.getState as jest.Mock

const danceList = (enabled: boolean) => [
  {
    name: 'otagei',
    motion: '/dance/otagei/motion.vrma',
    music: null,
    meta: { title: 'ヲタ芸', credit: 'モーション: テスト', enabled },
  },
]

const mockFetchList = (list: unknown) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => list,
  }) as unknown as typeof fetch
}

describe('helixus dance', () => {
  beforeEach(() => {
    danceStore.setState({
      phase: 'idle',
      current: null,
      lastName: null,
      lastEndAt: 0,
    })
    mockHomeGetState.mockReturnValue({ viewer: { model: undefined } })
  })

  describe('loadDanceList', () => {
    it('fills meta defaults', async () => {
      mockFetchList([
        { name: 'x', motion: '/dance/x/motion.vrma', music: null, meta: {} },
      ])
      const [d] = await loadDanceList(0)
      expect(d.meta).toEqual({
        title: 'x',
        offset: 0,
        bpm: 0,
        speed: 1,
        volume: 1,
        credit: '',
        enabled: true,
      })
    })

    it('ignores a non-positive speed', async () => {
      mockFetchList([
        { name: 'x', motion: '/m', music: null, meta: { speed: 0 } },
      ])
      const [d] = await loadDanceList(0)
      expect(d.meta.speed).toBe(1)
    })
  })

  describe('danceCooldownLeft', () => {
    it('counts down from the last dance end', () => {
      const now = 1_000_000
      danceStore.setState({ lastEndAt: now - 100_000 })
      expect(danceCooldownLeft(now)).toBeCloseTo(MOTION.danceCooldown - 100)
      expect(danceCooldownLeft(now + MOTION.danceCooldown * 1000)).toBe(0)
    })
  })

  describe('dancePromptLine', () => {
    it('describes the tag when a dance is available', async () => {
      mockFetchList(danceList(true))
      await loadDanceList(0)
      const line = await dancePromptLine()
      expect(line.startsWith('[motion:dance]')).toBe(true)
      expect(line).toContain('otagei（ヲタ芸）')
      expect(line).toContain('[motion:dance:otagei]')
    })

    it('tells him to refuse during cooldown', async () => {
      mockFetchList(danceList(true))
      await loadDanceList(0)
      danceStore.setState({ lastEndAt: Date.now() - 60_000 })
      const line = await dancePromptLine()
      expect(line).toContain('刚跳过')
      expect(line).toContain('不要写 [motion:dance]')
    })

    it('says nothing when no dance is enabled', async () => {
      mockFetchList(danceList(false))
      await loadDanceList(0)
      expect(await dancePromptLine()).toBe('')
    })
  })

  describe('handleDanceRequest', () => {
    const text = '【点舞】观众A 送了 3 个 打call，点名要看你跳舞'

    it('queues the dance and asks for an opening line', async () => {
      const request = jest.fn().mockResolvedValue('ok')
      mockHomeGetState.mockReturnValue({
        viewer: { model: { dance: { request } } },
      })
      const out = await handleDanceRequest(text)
      expect(request).toHaveBeenCalledWith({
        source: 'gift',
        requester: '观众A',
      })
      expect(out.startsWith(text)).toBe(true)
      expect(out).toContain('说完会自动开始跳')
    })

    it('asks him to refuse in character during cooldown', async () => {
      const request = jest.fn().mockResolvedValue('cooldown')
      mockHomeGetState.mockReturnValue({
        viewer: { model: { dance: { request } } },
      })
      danceStore.setState({ lastEndAt: Date.now() - 60_000 })
      const out = await handleDanceRequest(text)
      expect(out).toContain('刚跳过舞')
      expect(out).toContain('不要写 [motion:dance]')
    })

    it('falls back to a polite refusal without a model', async () => {
      const out = await handleDanceRequest(text)
      expect(out).toContain('现在没有能跳的舞')
    })
  })
})
