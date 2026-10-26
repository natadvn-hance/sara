import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { moscowHour } from '../../src/conversation/time'
import { convTurn, modelCall } from '../../src/db/schema'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)

const WORKER = resolve(import.meta.dirname, 'turnWorker.ts')
let cardLog: string

function spawnWorker(args: string[], env: Record<string, string> = {}): Promise<ChildProcess> {
  // One node process (no tsx wrapper), so SIGKILL really kills the worker.
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, CARD_LOG: cardLog, ...env },
  })
  return new Promise((ok, fail) => {
    child.stdout?.on('data', (b: Buffer) => {
      if (b.toString().includes('started')) ok(child)
    })
    child.on('exit', (code) => fail(new Error(`worker exited early with ${code}`)))
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until<T>(read: () => Promise<T>, ok: (x: T) => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const x = await read()
    if (ok(x) || Date.now() > end) return x
    await sleep(200)
  }
}

const cards = async () => (await readFile(cardLog, 'utf8')).split('\n').filter(Boolean)
const turns = () => db.select().from(convTurn)

beforeEach(async () => {
  await resetDb(db)
  cardLog = join(await mkdtemp(join(tmpdir(), 'turn-kill-')), 'cards.log')
  await writeFile(cardLog, '')
  await setSetting(db, 'pipeline.conversations', true, 'system')
  await setSetting(db, 'conv.quiet_after_typing_s', 1, 'system')
  await setSetting(db, 'conv.max_wait_s', 30, 'system')
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.night', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'system')
})

describe('a turn and a restart', () => {
  it('NFR-REL-3: a turn killed while the client may still write finishes once after the restart', async () => {
    await setSetting(db, 'conv.quiet_after_message_s', 4, 'system')
    const args = [newEventId(), new Date().toISOString()]
    const first = await spawnWorker(args, { START: '1' })
    // Killed inside the wait: the chat was heard, the quiet is not over.
    await until(turns, (r) => Boolean((r[0]?.timings as { heard?: string })?.heard), 10000)
    first.kill('SIGKILL')
    const second = await spawnWorker(args)
    const rows = await until(turns, (r) => r[0]?.finishedAt != null, 20000)
    await sleep(1000)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('drafted')
    expect(await cards()).toHaveLength(1)
    expect(await countEvents(db, 'conv.turn_started')).toBe(1)
    expect(await countEvents(db, 'conv.turn_drafted')).toBe(1)
    second.kill('SIGKILL')
  }, 40000)

  it('NFR-REL-3: a turn killed after planning does not ask the model again', async () => {
    await setSetting(db, 'conv.quiet_after_message_s', 1, 'system')
    const args = [newEventId(), new Date().toISOString()]
    const first = await spawnWorker(args, { START: '1', HANG_CARD: '1' })
    // Killed while the card goes: the plan is done and recorded.
    await until(cards, (c) => c.length > 0, 20000)
    first.kill('SIGKILL')
    const second = await spawnWorker(args)
    const rows = await until(turns, (r) => r[0]?.finishedAt != null, 20000)
    expect(rows[0]?.outcome).toBe('drafted')
    expect((await cards()).map((l) => l.split(' ')[0])).toEqual(['hung', 'card'])
    const calls = await db.select().from(modelCall)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.map((c) => c.id).sort()).toEqual(
      [...((rows[0]?.modelCallIds as string[]) ?? [])].sort(),
    )
    second.kill('SIGKILL')
  }, 50000)
})
