import { type ChildProcess, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { newEventId } from '@sara/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { openTestDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)

const WORKER = resolve(import.meta.dirname, 'decisionWaitWorker.ts')

function spawnWorker(args: string[], env: Record<string, string> = {}): Promise<ChildProcess> {
  // One node process (no tsx wrapper), so SIGKILL really kills the worker.
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ...env },
  })
  return new Promise((ok, fail) => {
    child.stdout?.on('data', (b: Buffer) => {
      if (b.toString().includes('started')) ok(child)
    })
    child.on('exit', (code) => fail(new Error(`worker exited early with ${code}`)))
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForCount(taskId: string, n: number, timeoutMs: number) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if ((await countEvents(db, 'task.reminded', taskId)) >= n) return
    await sleep(200)
  }
}

describe('decision wait', () => {
  it('NFR-REL-3: reminder fires once after the process is killed and restarted', async () => {
    const taskId = newEventId()
    const first = await spawnWorker([taskId, '3000'])
    first.kill('SIGKILL')
    const second = await spawnWorker([taskId, '3000'])
    await waitForCount(taskId, 1, 15000)
    await sleep(2000)
    expect(await countEvents(db, 'task.reminded', taskId)).toBe(1)
    second.kill('SIGKILL')
  }, 40000)

  it('NFR-REL-3: reminder survives a restart with changed code (a deploy)', async () => {
    const taskId = newEventId()
    const first = await spawnWorker([taskId, '3000'])
    first.kill('SIGKILL')
    const second = await spawnWorker([taskId, '3000'], { WORKER_CHANGED_CODE: '1' })
    await waitForCount(taskId, 1, 15000)
    expect(await countEvents(db, 'task.reminded', taskId)).toBe(1)
    second.kill('SIGKILL')
  }, 40000)

  it('NFR-REL-3: delivered decision cancels the reminder', async () => {
    const taskId = newEventId()
    const w = await spawnWorker([taskId, '3000', '500'])
    await sleep(5000)
    expect(await countEvents(db, 'task.reminded', taskId)).toBe(0)
    w.kill('SIGKILL')
  }, 30000)
})
