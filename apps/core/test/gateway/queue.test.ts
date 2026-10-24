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
})
