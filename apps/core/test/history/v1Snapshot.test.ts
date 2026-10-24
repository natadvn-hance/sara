import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openV1Snapshot, readV1Snapshot } from '../../src/history/v1Snapshot'

let dir: string
let file: string

// An old snapshot: the leads table of v1 before draft_response_original and dictated_reply were added.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sara-v1-'))
  file = join(dir, 'profi-leads.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE leads (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, category TEXT, description TEXT, city TEXT,
    draft_response TEXT, customer_reply TEXT, client_name TEXT, responded_at TEXT,
    boris_wrote_at TEXT, boris_wrote_text TEXT, taken_by_boris_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  const insert = db.prepare(
    'INSERT INTO leads (id, status, category, client_name, draft_response, responded_at, boris_wrote_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  insert.run(
    '7001',
    'responded',
    'Сайты',
    'Ирина',
    'Здравствуйте, Ирина! Сделаем.',
    '2026-09-10T08:00:00.000Z',
    'Добрый день.\n\nЗавтра пришлю смету.',
    '2026-09-10T07:50:00.000Z',
    '2026-09-11T09:00:00.000Z',
  )
  insert.run(
    '7002',
    'skipped',
    null,
    null,
    null,
    null,
    null,
    '2026-09-09T16:14:00.000Z',
    '2026-09-09T16:15:00.000Z',
  )
  db.close()
})
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('v1 snapshot', () => {
  it('FR-TRAIN-1: the snapshot is opened read only, a write throws', () => {
    const db = openV1Snapshot(file)
    try {
      expect(() => db.exec("UPDATE leads SET status = 'x'")).toThrow(/readonly/i)
    } finally {
      db.close()
    }
  })

  it('FR-TRAIN-1: reading never changes the file', async () => {
    const before = await readFile(file)
    readV1Snapshot(file)
    expect((await readFile(file)).equals(before)).toBe(true)
  })

  it('FR-TRAIN-1: a missing file is an error, never a new empty database', () => {
    expect(() => readV1Snapshot(join(dir, 'nope.db'))).toThrow()
  })

  it('FR-TRAIN-1: leads come with their v1 fields and a missing column reads as null', () => {
    const { leads } = readV1Snapshot(file)
    const lead = leads.find((l) => l.orderId === '7001')
    expect(lead).toEqual({
      orderId: '7001',
      clientName: 'Ирина',
      description: null,
      category: 'Сайты',
      city: null,
      status: 'responded',
      draftResponse: 'Здравствуйте, Ирина! Сделаем.',
      draftResponseOriginal: null,
      respondedAt: '2026-09-10T08:00:00.000Z',
      borisWroteText: 'Добрый день.\n\nЗавтра пришлю смету.',
      borisWroteAt: null,
      takenByBorisAt: null,
      dictatedReply: null,
      proposedReply: null,
      replyApprovedAt: null,
      customerReply: null,
      createdAt: '2026-09-10T07:50:00.000Z',
      updatedAt: '2026-09-11T09:00:00.000Z',
    })
    expect(leads).toHaveLength(2)
  })

  it('FR-TRAIN-1: v1 started with its earliest lead', () => {
    expect(readV1Snapshot(file).startedAt).toBe('2026-09-09T16:14:00.000Z')
  })
})
