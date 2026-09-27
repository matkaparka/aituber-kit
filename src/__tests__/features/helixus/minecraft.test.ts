import {
  extractMcCommands,
  McEvent,
  McStatus,
  mcPromptBlock,
  mcStore,
  McTagStreamFilter,
  onCommentaryPoke,
  sendMcCommand,
  startMcSelfPlay,
  stopMcSelfPlay,
} from '@/features/helixus/minecraft'

jest.mock('@/features/chat/aiChatFactory', () => ({
  getAIChatResponseStream: jest.fn(),
}))

const status = (over: Partial<McStatus> = {}): McStatus => ({
  online: true,
  username: 'Helixus',
  paused: false,
  health: 18,
  food: 20,
  position: { x: 10, y: 64, z: -4 },
  dimension: 'overworld',
  gameMode: 'survival',
  isDay: true,
  heldItem: 'stone_pickaxe',
  inventory: [
    { name: 'oak_log', count: 8 },
    { name: 'dirt', count: 2 },
  ],
  otherPlayers: [],
  planner: {
    thinking: false,
    executing: { tool: 'collectBlocks', params: { type: 'oak_log' } },
    pending: 0,
    givenUp: false,
  },
  lastCommand: null,
  latestEventSeq: 3,
  ...over,
})

describe('helixus minecraft [mc:] tags', () => {
  it('pulls commands out of a whole reply, including full-width forms', () => {
    const { text, commands } = extractMcCommands(
      '[angry]砍树去\n[scene]森林边上\n[mc:去砍 10 块橡木]\n【mc：回出生点】'
    )
    expect(commands).toEqual(['去砍 10 块橡木', '回出生点'])
    expect(text).not.toMatch(/mc/i)
    expect(text).toContain('[scene]森林边上')
  })

  it('reassembles a tag split across stream chunks and keeps it out of the text', () => {
    const commands: string[] = []
    const filter = new McTagStreamFilter((c) => commands.push(c))
    const out = [
      filter.push('好，[m'),
      filter.push('c:去砍'),
      filter.push('树]走了'),
    ]
    expect(out.join('') + filter.flush()).toBe('好，走了')
    expect(commands).toEqual(['去砍树'])
  })

  it('does not hold back emotion tags', () => {
    const filter = new McTagStreamFilter(() => {})
    expect(filter.push('[hap')).toBe('[hap')
    // a lone "[" at a chunk end could start [mc:, so it waits for the next chunk
    expect(filter.push('说完了[')).toBe('说完了')
    expect(filter.push('happy]好')).toBe('[happy]好')
  })

  it('treats an unclosed [mc: at the end of the stream as a command', () => {
    const commands: string[] = []
    const filter = new McTagStreamFilter((c) => commands.push(c))
    expect(filter.push('走了\n[mc:回家')).toBe('走了\n')
    expect(filter.flush()).toBe('')
    expect(commands).toEqual(['回家'])
  })

  it('gives back a held "[" that turned out not to be a tag', () => {
    const filter = new McTagStreamFilter(() => {})
    expect(filter.push('abc[')).toBe('abc')
    expect(filter.flush()).toBe('[')
  })
})

describe('helixus minecraft prompt block', () => {
  beforeEach(() => {
    mcStore.setState({
      selfPlay: false,
      reachable: false,
      status: null,
      events: [],
      narratedSeq: 0,
    })
  })

  it('adds nothing outside self-play mode', () => {
    mcStore.setState({ reachable: true, status: status() })
    expect(mcPromptBlock()).toBe('')
  })

  it('tells him the game cannot be controlled while the bot is down', () => {
    mcStore.setState({ selfPlay: true })
    const block = mcPromptBlock()
    expect(block).toContain('连不上')
    expect(block).toContain('不要写 [mc:]')
  })

  it('describes vitals, inventory, current action, and marks unnarrated events', () => {
    const now = Date.now()
    mcStore.setState({
      selfPlay: true,
      reachable: true,
      status: status(),
      narratedSeq: 1,
      events: [
        {
          seq: 1,
          at: now,
          kind: 'command',
          text: '你下达了指令：去砍树',
          urgency: 'later',
        },
        {
          seq: 2,
          at: now,
          kind: 'context',
          text: 'planner internal note',
          urgency: 'later',
        },
        {
          seq: 3,
          at: now,
          kind: 'hurt',
          text: '你受伤了（zombie）',
          urgency: 'soon',
        },
      ],
    })
    const block = mcPromptBlock()
    expect(block).toContain('生命 18/20')
    expect(block).toContain('oak_log×8')
    expect(block).toContain('collectBlocks(type=oak_log)')
    expect(block).toContain('- 你下达了指令：去砍树')
    expect(block).toContain('- 【新】你受伤了（zombie）')
    expect(block).not.toContain('planner internal note')
    expect(block).toContain('[mc:具体指令]')
  })
})

describe('helixus minecraft polling', () => {
  const event = (
    seq: number,
    urgency: McEvent['urgency'],
    kind = 'hurt'
  ): McEvent => ({ seq, at: Date.now(), kind, text: kind, urgency })

  let eventsByAfter: Record<string, { events: McEvent[]; latest: number }>

  beforeEach(() => {
    jest.useFakeTimers()
    mcStore.setState({ selfPlay: false, events: [], narratedSeq: 0 })
    global.fetch = jest.fn(async (url: string) => {
      const path = url.replace('http://127.0.0.1:8098', '')
      let body: unknown = { ok: true }
      if (path === '/status') body = status({ latestEventSeq: 5 })
      const m = path.match(/^\/events\?after=(\d+)$/)
      if (m) body = eventsByAfter[m[1]] ?? { events: [], latest: Number(m[1]) }
      return { status: 200, json: async () => body }
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    stopMcSelfPlay()
    jest.useRealTimers()
  })

  it('skips events from before the mode started, and wakes the commentary loop only for urgent ones', async () => {
    eventsByAfter = {
      '5': { events: [event(6, 'later', 'chat_out')], latest: 6 },
      '6': { events: [event(7, 'immediate', 'death')], latest: 7 },
    }
    const poke = jest.fn()
    const off = onCommentaryPoke(poke)

    startMcSelfPlay()
    await jest.advanceTimersByTimeAsync(0) // first poll: align to seq 5, no old events
    expect(mcStore.getState().events).toEqual([])

    await jest.advanceTimersByTimeAsync(1500) // seq 6, later: kept as context only
    expect(mcStore.getState().events.map((e) => e.seq)).toEqual([6])
    expect(poke).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(1500) // seq 7, death: speak now
    expect(poke).toHaveBeenCalledTimes(1)
    off()
  })
})

describe('helixus minecraft commands', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true }),
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('ignores commands outside self-play mode', async () => {
    mcStore.setState({ selfPlay: false })
    await sendMcCommand('去砍树')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts a command once, then drops the same command repeated right after', async () => {
    mcStore.setState({ selfPlay: true })
    await sendMcCommand('去挖铁矿')
    await sendMcCommand('去挖铁矿')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8098/command')
    expect(JSON.parse(init.body)).toEqual({ text: '去挖铁矿' })
  })
})
