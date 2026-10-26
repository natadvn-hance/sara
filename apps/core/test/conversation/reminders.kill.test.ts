import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { moscowHour } from '../../src/conversation/time'
import { convTurn, modelCall, outbox } from '../../src/db/schema'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'
import { seedChat } from '../helpers/reminders'

const { db, close } = openTestDb()
afterAll(close)

const WORKER = resolve(import.meta.dirname, 'remindWorker.ts')
const CHAT = '95147898'
const HOUR = 3600_000
let sendLog: string

function spawnWorker(args: string[], env: Record<string, string> = {}): Promise<ChildProcess> {
  // One node process (no tsx wrapper), so SIGKILL really kills the worker.
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, SEND_LOG: sendLog, ...env },
  })
  return new Promise((ok, fail) => {
    child.stdout?.on('data', (b: Buffer) => {
      if (b.toString().includes('started') || b.toString().includes('cancelled')) ok(child)
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

const log = async () => (await readFile(sendLog, 'utf8')).split('\n').filter(Boolean)
const rows = () =>
  db.select().from(convTurn).where(eq(convTurn.kind, 'reminder')).orderBy(asc(convTurn.createdAt))

beforeEach(async () => {
  await resetDb(db)
  sendLog = join(await mkdtemp(join(tmpdir(), 'remind-kill-')), 'send.log')
  await writeFile(sendLog, '')
  await setSetting(db, 'pipeline.conversations', true, 'system')
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await setSetting(db, 'conv.autopilot', true, 'system')
  await setSetting(db, 'outbound.messages', true, 'system')
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.reminder_quiet', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'system')
})

/** Our message `agoMs` ago in the chat, in the core and in the worker's stub of the service. */
async function scene(agoMs: number) {
  const at = new Date(Date.now() - agoMs).toISOString()
  const conv = await seedChat(db, CHAT, [
    { id: 'm-1', side: 'specialist', text: 'Анна, добрый день! Понимаю задачу.', at },
  ])
  return { conv, at }
}

/** The ladder goes on to the next step after the first: what waits is cancelled so no other test meets it. */
async function clean(conversationId: string, at: string) {
  const c = await spawnWorker([conversationId, CHAT, at], { CANCEL: '1' })
  c.kill('SIGKILL')
}

describe('a reminder and a restart', () => {
  it('NFR-REL-3: a reminder survives a restart', async () => {
    // The first reminder is due in 8 seconds.
    const { conv, at } = await scene(24 * HOUR - 8000)
    const first = await spawnWorker([conv.id, CHAT, at], { START: '1' })
    await sleep(1500)
    first.kill('SIGKILL')
    expect(await rows()).toHaveLength(0)
    const second = await spawnWorker([conv.id, CHAT, at])
    const done = await until(rows, (r) => r.some((x) => x.finishedAt), 30000)
    await sleep(1000)
    expect(done).toHaveLength(1)
    expect(done[0]?.outcome).toBe('sent')
    expect(await log()).toEqual([`send msg:conv-remind:${conv.id}:m-1:1`])
    const queued = (await db.select().from(outbox)).filter((o) => o.kind === 'message')
    expect(queued).toHaveLength(1)
    expect(queued[0]?.state).toBe('confirmed')
    expect(await countEvents(db, 'conv.reminder_sent')).toBe(1)
    expect(await db.select().from(modelCall)).toHaveLength(1)
    second.kill('SIGKILL')
    await clean(conv.id, at)
  }, 60000)

  it('NFR-REL-3: a reminder killed while it is being sent goes once with its key and does not ask the model again', async () => {
    const { conv, at } = await scene(25 * HOUR)
    const first = await spawnWorker([conv.id, CHAT, at], { START: '1', HANG_SEND: '1' })
    await until(log, (l) => l.length > 0, 30000)
    first.kill('SIGKILL')
    expect(await log()).toEqual([`hung msg:conv-remind:${conv.id}:m-1:1`])
    const second = await spawnWorker([conv.id, CHAT, at])
    const done = await until(rows, (r) => r.some((x) => x.finishedAt), 30000)
    await sleep(1000)
    expect(done).toHaveLength(1)
    expect(done[0]?.outcome).toBe('sent')
    // The service is asked again with the same key, which it never sends twice.
    expect(await log()).toEqual([
      `hung msg:conv-remind:${conv.id}:m-1:1`,
      `send msg:conv-remind:${conv.id}:m-1:1`,
    ])
    expect((await db.select().from(outbox)).filter((o) => o.kind === 'message')).toHaveLength(1)
    expect(await countEvents(db, 'conv.reminder_sent')).toBe(1)
    // The text was written once: the replay used the recorded step.
    expect(await db.select().from(modelCall)).toHaveLength(1)
    second.kill('SIGKILL')
    await clean(conv.id, at)
  }, 60000)
})
