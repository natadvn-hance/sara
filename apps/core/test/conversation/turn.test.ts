import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type EventEnvelope, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversationEvents } from '../../src/conversation/events'
import { moscowHour } from '../../src/conversation/time'
import { pokeTurn, setTurnDeps, startTurnFor, type TurnDeps } from '../../src/conversation/turn'
import { conversation, convTurn, event } from '../../src/db/schema'
import { createGateway } from '../../src/gateway/gateway'
import { createSecretStore } from '../../src/secrets/store'
import { setSetting } from '../../src/settings/store'
import { launchDbos, shutdownDbos } from '../../src/workflows/dbos'
import { chatMsg, fakeMind, interlocutorAnswer, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'
import { countEvents } from '../helpers/events'

// The real code checks come with part D; here every reply passes them, so the send path can run.
vi.mock('../../src/conversation/check/codeChecks', () => ({
  checkReplyText: () => [],
  isNewMoscowDay: () => false,
}))
// The Checker comes with part D too: here it read every reply and found nothing.
vi.mock('../../src/conversation/check/checkerRole', () => ({
  runCheckerRole: async () => ({ issues: [], ran: true, modelCallId: null }),
}))

const ROOT = resolve(import.meta.dirname, '../../../..')
const ACC = 'hance-marketing'
const CHAT = '95147898'
const { db, close } = openTestDb()
const profi = stubProfi([])
let cards: string[]
let outcomes: { turnId: string; conversationId: string; outcome: string; at: string }[] = []
let forwards: string[]
let sends: { turnId: string; round: number }[]
let sendAnswer: 'confirmed' | 'changed' = 'confirmed'
let onCard: () => Promise<void> = async () => {}
let onSend: () => Promise<void> = async () => {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turn-'))
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
  for (const [name, model] of [
    ['interlocutor', 'sonnet'],
    ['checker', 'haiku'],
  ] as const) {
    await mkdir(join(dir, 'roles', name), { recursive: true })
    await writeFile(
      join(dir, 'roles', name, 'meta.json'),
      JSON.stringify({ name, version: 1, model, priority: 'P0', timeoutMs: 30000 }),
    )
    await writeFile(join(dir, 'roles', name, 'role.md'), 'Роль для теста.')
  }
  const secrets = createSecretStore(join(dir, 'data'))
  await secrets.set('claude_oauth_token', 'tok')
  const gateway = createGateway({
    db,
    secrets,
    claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: {
      FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({ interlocutor: interlocutorAnswer() }),
    },
  })
  const deps: TurnDeps = {
    db,
    profi: {
      ...profi,
      readChat: (...a) => profi.readChat(...a),
      getOrder: async () => {
        throw new Error('not known')
      },
    },
    gateway,
    mind: fakeMind(),
    card: async (turnId) => {
      cards.push(turnId)
      await onCard()
    },
    forward: async (turnId) => {
      forwards.push(turnId)
    },
    send: async (turnId, round) => {
      sends.push({ turnId, round })
      const answer = sendAnswer
      await onSend()
      return answer
    },
    pauseMs: () => 200,
    onOutcome: async (o) => {
      outcomes.push(o)
    },
  }
  setTurnDeps(deps)
  await launchDbos(testDatabaseUrl())
  // DBOS starts slowly on a loaded machine.
}, 60000)
afterAll(async () => {
  await shutdownDbos()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  profi.chat = [
    chatMsg(
      'm-1',
      'specialist',
      'Анна, добрый день! Понимаю задачу.',
      new Date(Date.now() - 3600_000).toISOString(),
    ),
  ]
  cards = []
  outcomes = []
  forwards = []
  sends = []
  sendAnswer = 'confirmed'
  onCard = async () => {}
  onSend = async () => {}
  await setSetting(db, 'pipeline.conversations', true, 'system')
  await setSetting(db, 'conv.quiet_after_message_s', 1, 'system')
  await setSetting(db, 'conv.quiet_after_typing_s', 1, 'system')
  await setSetting(db, 'conv.max_wait_s', 20, 'system')
  // Never night in these tests: the night is an hour that starts two hours from now.
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.night', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'system')
})

const events = () =>
  createConversationEvents({
    db,
    profi,
    notifier: { sendText: async () => ({ messageId: 1 }) },
    onTurnNeeded: (c) => startTurnFor(c),
    onTyping: (c) => pokeTurn(c),
    onSpecialist: async () => {},
  })

function ev(type: EventEnvelope['type'], payload: Record<string, unknown>): EventEnvelope {
  return {
    id: newEventId(),
    type,
    v: 1,
    entity: { kind: 'chat', id: CHAT },
    account_id: ACC,
    actor: 'profi',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload,
  }
}

async function clientWrites(id: string, text: string) {
  profi.chat.push(chatMsg(id, 'client', text, new Date().toISOString()))
  await events()(
    ev('profi.client_message', {
      chat_id: CHAT,
      order_id: CHAT,
      platform_message_id: id,
      sent_at: new Date().toISOString(),
      author: 'client',
    }),
  )
}

async function turnsDone(n: number, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const rows = await db.select().from(convTurn)
    if (rows.filter((r) => r.finishedAt !== null).length >= n) return rows
    await sleep(100)
  }
  return db.select().from(convTurn)
}

describe('the turn workflow', () => {
  it('FR-CONV-7: three client messages with typing between them get one reply', async () => {
    await clientWrites('m-2', 'Здравствуйте')
    await sleep(300)
    await events()(ev('profi.client_typing', { chat_id: CHAT, at: new Date().toISOString() }))
    await clientWrites('m-3', 'Как начнём?')
    await sleep(300)
    await events()(ev('profi.client_typing', { chat_id: CHAT, at: new Date().toISOString() }))
    await clientWrites('m-4', 'И по срокам')
    const rows = await turnsDone(1)
    await sleep(1500)
    expect(await db.select().from(convTurn)).toHaveLength(1)
    expect(rows[0]?.messageIds).toEqual(['m-2', 'm-3', 'm-4'])
    expect(cards).toHaveLength(1)
  }, 30000)

  it('FR-CONV-3: a turn leaves a trace of all 8 steps', async () => {
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t).toMatchObject({
      mindVersion: 'mind-v1',
      move: 'reply',
      factIds: ['k-process-start'],
      decision: 'draft',
      outcome: 'drafted',
      state: 'finished',
    })
    expect(Object.keys(t?.timings as object)).toEqual(
      expect.arrayContaining(['heard', 'recalled', 'planned', 'decided', 'finished']),
    )
    expect((t?.recalled as { knowledge: string[] } | undefined)?.knowledge).toEqual([
      'k-process-start',
    ])
    expect(await countEvents(db, 'conv.turn_drafted')).toBe(1)
  }, 30000)

  it('FR-CONV-7: the turn is journaled as started when the wait for the client ends, and tells its outcome', async () => {
    await clientWrites('m-2', 'Как начнём?')
    const heardAt = Date.now()
    await turnsDone(1)
    const [started] = await db.select().from(event).where(eq(event.type, 'conv.turn_started'))
    // The quiet after the client's message is 1 second here.
    expect(Date.parse(started?.occurredAt ?? '')).toBeGreaterThanOrEqual(heardAt + 900)
    expect(await countEvents(db, 'conv.turn_started')).toBe(1)
    // The outcome step runs right after the handoff marks the turn finished.
    for (let i = 0; i < 50 && outcomes.length === 0; i++) await sleep(100)
    expect(outcomes.map((o) => o.outcome)).toEqual(['drafted'])
  }, 30000)

  it('FR-CONV-5: shadow never calls send_message', async () => {
    for (const id of ['m-2', 'm-3']) {
      await clientWrites(id, `Вопрос ${id}`)
      await turnsDone(id === 'm-2' ? 1 : 2)
    }
    expect(sends).toHaveLength(0)
  }, 30000)

  it('FR-CONV-6: a specialist message during the turn cancels it after the switch', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'system')
    await clientWrites('m-2', 'Как начнём?')
    profi.chat.push(
      chatMsg('m-3', 'specialist', 'Анна, наберу вас сейчас', new Date().toISOString()),
    )
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('answered')
    expect(cards).toHaveLength(0)
    const [c] = await db.select().from(conversation)
    expect(c?.owner).toBe('boris')
  }, 30000)

  it('FR-CONV-6: the client writing during the pause makes the turn plan again with the whole turn', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'system')
    await setSetting(db, 'outbound.messages', true, 'system')
    await setSetting(db, 'conv.autonomy', { process: 'self' } as never, 'system')
    let once = true
    onSend = async () => {}
    await clientWrites('m-2', 'Как начнём?')
    // The pause is 200 ms here: the client writes inside it.
    await sleep(1300)
    if (once) {
      once = false
      profi.chat.push(chatMsg('m-3', 'client', 'И сколько это займёт?', new Date().toISOString()))
    }
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('sent')
    expect(t?.messageIds).toEqual(['m-2', 'm-3'])
    expect(sends).toHaveLength(1)
  }, 30000)

  it('FR-CONV-6: the service refusing a changed chat makes the turn plan again', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'system')
    await setSetting(db, 'outbound.messages', true, 'system')
    await setSetting(db, 'conv.autonomy', { process: 'self' } as never, 'system')
    sendAnswer = 'changed'
    onSend = async () => {
      sendAnswer = 'confirmed'
    }
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('sent')
    expect(sends.map((s) => s.round)).toEqual([1, 2])
  }, 30000)

  it('FR-CONV-7: a message that comes after the turn decided starts the next turn itself', async () => {
    // The card is slow: the client writes while it goes out, after the running turn has already planned.
    onCard = async () => {
      onCard = async () => {}
      await sleep(1500)
    }
    await clientWrites('m-2', 'Как начнём?')
    const until = Date.now() + 20000
    while (Date.now() < until) {
      const [t] = await db.select().from(convTurn)
      if (t?.state === 'decided') break
      await sleep(50)
    }
    await clientWrites('m-3', 'Ещё вопрос')
    const rows = await turnsDone(2)
    expect(rows.map((r) => r.messageIds)).toEqual(expect.arrayContaining([['m-2'], ['m-3']]))
    expect(cards).toHaveLength(2)
  }, 30000)

  it('FR-CONV-11: a client Boris took is forwarded to him without the model', async () => {
    await clientWrites('m-0', 'Привет')
    await turnsDone(1)
    await db.update(conversation).set({ owner: 'boris', ownerReason: 'take' })
    await clientWrites('m-2', 'Как начнём?')
    const rows = await turnsDone(2)
    expect(rows.find((r) => r.anchorMessageId === 'm-2')?.outcome).toBe('forwarded')
    expect(forwards).toHaveLength(1)
  }, 30000)
})
