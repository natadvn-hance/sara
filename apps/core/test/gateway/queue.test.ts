import { describe, expect, it } from 'vitest'
import { createSlots } from '../../src/gateway/queue'

describe('gateway slots', () => {
  it('FR-OPS-3: a freed slot goes to the highest priority, in arrival order within it', async () => {
    const slots = createSlots(1)
    await slots.acquire('P2')
    const order: string[] = []
    const queued = (['P3', 'P2#1', 'P0', 'P1', 'P2#2'] as const).map((name) =>
      slots.acquire(name.slice(0, 2) as 'P0' | 'P1' | 'P2' | 'P3').then(() => order.push(name)),
    )
    for (let i = 0; i < 5; i++) {
      slots.release()
      await new Promise((r) => setImmediate(r))
    }
    await Promise.all(queued)
    expect(order).toEqual(['P0', 'P1', 'P2#1', 'P2#2', 'P3'])
  })

  it('FR-OPS-3: no more than the limit hold a slot at once', async () => {
    const slots = createSlots(2)
    let held = 0
    await slots.acquire('P1')
    await slots.acquire('P1')
    held = 2
    const third = slots.acquire('P0').then(() => {
      held++
    })
    await new Promise((r) => setImmediate(r))
    expect(held).toBe(2)
    slots.release()
    held--
    await third
    expect(held).toBe(2)
  })
  it('FR-ACC-5: P3 calls never take the last free slot', async () => {
    const slots = createSlots(2)
    const started: string[] = []
    const take = (name: string, p: 'P0' | 'P1' | 'P2' | 'P3') =>
      slots.acquire(p).then(() => started.push(name))
    await take('first P3', 'P3')
    take('second P3', 'P3')
    await new Promise((r) => setImmediate(r))
    // One slot is free, yet the second P3 waits: it is kept for the work Boris is waiting for.
    expect(started).toEqual(['first P3'])
    await take('P1', 'P1')
    expect(started).toEqual(['first P3', 'P1'])
    slots.release('P3')
    await new Promise((r) => setImmediate(r))
    expect(started).toEqual(['first P3', 'P1', 'second P3'])
  })

  it('FR-ACC-5: a P3 call may use the only slot of a gateway with one slot', async () => {
    const slots = createSlots(1)
    await slots.acquire('P3')
    const next = slots.acquire('P1')
    slots.release('P3')
    await next
  })

  it('FR-ACC-5: a freed P3 slot goes to a waiting P1 before a waiting P3', async () => {
    const slots = createSlots(2)
    await slots.acquire('P3')
    await slots.acquire('P1')
    const order: string[] = []
    const p3 = slots.acquire('P3').then(() => order.push('P3'))
    const p1 = slots.acquire('P1').then(() => order.push('P1'))
    slots.release('P1')
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual(['P1'])
    slots.release('P3')
    await Promise.all([p1, p3])
    expect(order).toEqual(['P1', 'P3'])
  })
})
