import { describe, expect, it } from 'vitest'
import { turnMessageIds } from '../../src/conversation/dossier'
import { humanPauseMs, quietLeftSeconds } from '../../src/conversation/timing'

const s = { quietAfterMessageS: 45, quietAfterTypingS: 20, maxWaitS: 600 }
const t0 = new Date('2026-10-20T10:00:00.000Z')
const at = (sec: number) => new Date(t0.getTime() + sec * 1000)

describe('waiting for the client', () => {
  it('FR-CONV-7: the turn waits 45 seconds after the last message and 20 after typing', () => {
    expect(
      quietLeftSeconds({ lastClientHeardAt: t0.toISOString(), typingAt: null }, s, t0, at(10)),
    ).toBe(35)
    expect(
      quietLeftSeconds(
        { lastClientHeardAt: t0.toISOString(), typingAt: at(40).toISOString() },
        s,
        t0,
        at(50),
      ),
    ).toBe(10)
    expect(
      quietLeftSeconds({ lastClientHeardAt: t0.toISOString(), typingAt: null }, s, t0, at(46)),
    ).toBe(0)
  })

  it('FR-CONV-7: the turn gives up waiting after max_wait_s', () => {
    expect(
      quietLeftSeconds(
        { lastClientHeardAt: at(599).toISOString(), typingAt: at(599).toISOString() },
        s,
        t0,
        at(600),
      ),
    ).toBe(0)
  })

  it('FR-CONV-8: the human pause is between 1 and 4 minutes and grows with length', () => {
    expect(humanPauseMs(0, 0)).toBe(60_000)
    expect(humanPauseMs(100, 0)).toBe(90_000)
    expect(humanPauseMs(100, 1)).toBe(120_000)
    expect(humanPauseMs(5000, 1)).toBe(240_000)
    expect(humanPauseMs(200, 0.5)).toBeGreaterThan(humanPauseMs(50, 0.5))
  })

  it('FR-CONV-7: a turn is the client messages after our last one and after what a turn covered', () => {
    const m = (id: string, side: 'client' | 'specialist') => ({
      author: side === 'client' ? ('client' as const) : ('unknown' as const),
      side,
      text: id,
      sentAt: t0.toISOString(),
      platformMessageId: id,
    })
    const chat = [m('b', 'specialist'), m('c1', 'client'), m('c2', 'client'), m('c3', 'client')]
    expect(turnMessageIds(chat, null)).toEqual(['c1', 'c2', 'c3'])
    expect(turnMessageIds(chat, 'c2')).toEqual(['c3'])
    expect(turnMessageIds([...chat, m('s', 'specialist')], null)).toEqual([])
  })
})
