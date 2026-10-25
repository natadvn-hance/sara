import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newEventId, parseCallback } from '@sara/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lesson, mindProposal } from '../../../src/db/schema'
import type { Notifier } from '../../../src/notify/notifier'
import { onSchoolPress, writePending } from '../../../src/school/lessons/batches'
import { historyCards, importMind, readable } from '../../../src/school/lessons/history'
import type { MindWriter } from '../../../src/school/types'
import { setSetting } from '../../../src/settings/store'
import { openTestDb, resetDb } from '../../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  await setSetting(db, 'school.on', true, 'boris')
})

const msk = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`)

function fakes() {
  const cards: { text: string; rows: { text: string; callbackData: string }[][] }[] = []
  const edits: { id: number; text: string }[] = []
  const applied: string[][] = []
  let next = 1
  const notifier: Notifier = {
    sendLeadCard: async () => ({ messageId: next++ }),
    sendText: async () => ({ messageId: next++ }),
    sendButtons: async (text, rows) => {
      cards.push({ text, rows })
      return { messageId: next++ }
    },
    editText: async (id, text) => {
      edits.push({ id, text })
    },
  }
  const writer: MindWriter = {
    apply: async (ids) => {
      applied.push([...ids].sort())
      // As the real writer: a written proposal is accepted and never comes back.
      await db.update(mindProposal).set({ state: 'accepted' }).where(inArray(mindProposal.id, ids))
      return {
        ok: true,
        commitId: newEventId(),
        sha: 'a',
        mindVersion: 'v',
        written: ids,
        refused: [],
      }
    },
    revert: async (id) => ({ ok: true, commitId: id }),
    sync: async () => ({ pushed: false, pulled: 0, error: null }),
  }
  return { d: { db, notifier, writer }, cards, edits, applied }
}

async function historyExamples(n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = newEventId()
    ids.push(id)
    await db.insert(mindProposal).values({
      id,
      path: `mind/proposals/shared/speech/examples/e-h-${i}.md`,
      content: `---\nid: e-h-${i}\ntype: example\n---\n## Клиент\nцена?\n## Борис\nсозвонимся`,
      kind: 'example',
      source: `history:hance-marketing:${i}`,
    })
  }
  return ids
}

const button = (card: { rows: { text: string; callbackData: string }[][] }, text: string) =>
  parseCallback(card.rows.flat().find((b) => b.text === text)?.callbackData ?? '') as {
    taskId: string
    action: 'apply'
  }

describe('history and the starting mind', () => {
  it('FR-TRAIN-6: history examples are offered once with «Да, все»', async () => {
    const f = fakes()
    await historyExamples(3)
    await historyCards(f.d, msk('2026-10-26', '11:00'))
    await historyCards(f.d, msk('2026-10-26', '11:01'))
    expect(f.cards).toHaveLength(1)
    expect(f.cards[0]?.text).toContain('Нашла 3 твоих сообщения в чатах Профи.ру')
    expect(f.cards[0]?.rows.flat().map((b) => b.text)).toEqual([
      'Да, все',
      'Посмотреть по 5',
      'Не сейчас',
    ])
  })

  it('FR-MIND-3: «Да, все» writes all of them in one commit', async () => {
    const f = fakes()
    const ids = await historyExamples(3)
    await historyCards(f.d, msk('2026-10-26', '11:00'))
    const p = button(f.cards[0] as never, 'Да, все')
    expect(await onSchoolPress(f.d, p, new Date())).toContain('Записываю в разум: 3')
    // Written on the school's tick, never inside the press; the result goes on the card.
    expect(f.applied).toEqual([])
    await writePending(f.d)
    await writePending(f.d)
    expect(f.applied).toEqual([[...ids].sort()])
    expect(f.edits.map((e) => e.text)).toEqual(['Записала в разум: 3'])
    const [l] = await db.select().from(lesson)
    expect(l).toMatchObject({ source: 'history', kind: 'bulk', state: 'yes' })
    expect(await onSchoolPress(f.d, p, new Date())).toBe('Уже сделано')
  })

  it('FR-TRAIN-6: «Посмотреть по 5» turns them into lessons for batches', async () => {
    const f = fakes()
    await historyExamples(3)
    await historyCards(f.d, msk('2026-10-26', '11:00'))
    await onSchoolPress(f.d, button(f.cards[0] as never, 'Посмотреть по 5'), new Date())
    const ls = await db.select().from(lesson)
    expect(ls.map((l) => [l.source, l.state])).toEqual([
      ['history', 'ready'],
      ['history', 'ready'],
      ['history', 'ready'],
    ])
    // Boris reads the example itself, not its front matter.
    expect(ls[0]?.after).toBe('## Клиент\nцена?\n## Борис\nсозвонимся')
    const linked = await db.select().from(mindProposal)
    expect(linked.every((r) => r.lessonId !== null)).toBe(true)
    expect(f.applied).toEqual([])
  })

  it('FR-TRAIN-6: «Не сейчас» asks again in a week', async () => {
    const f = fakes()
    await historyExamples(2)
    await historyCards(f.d, msk('2026-10-26', '11:00'))
    await onSchoolPress(f.d, button(f.cards[0] as never, 'Не сейчас'), msk('2026-10-26', '11:05'))
    await historyCards(f.d, msk('2026-10-30', '11:00'))
    expect(f.cards).toHaveLength(1)
    await historyCards(f.d, msk('2026-11-03', '11:00'))
    expect(f.cards).toHaveLength(2)
  })

  it('FR-MIND-3: a starting record in mind/proposals becomes a lesson and reaches the mind only after yes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    await mkdir(join(dir, 'mind/proposals/shared/speech'), { recursive: true })
    await writeFile(
      join(dir, 'mind/proposals/shared/speech/portrait.md'),
      '---\nid: s-portrait\ntype: speech\nstatus: proposal\n---\n## Форма\nКоротко',
    )
    await writeFile(join(dir, 'mind/proposals/shared/speech/notes.md'), 'без полей')
    expect(await importMind({ db, mindDir: dir })).toBe(1)
    expect(await importMind({ db, mindDir: dir })).toBe(0)
    const [l] = await db.select().from(lesson)
    expect(l).toMatchObject({
      source: 'import',
      state: 'ready',
      kind: 'voice',
      after: '## Форма\nКоротко',
    })
    const [p] = await db
      .select()
      .from(mindProposal)
      .where(eq(mindProposal.lessonId, l?.id ?? ''))
    expect(p).toMatchObject({ path: 'mind/proposals/shared/speech/portrait.md', state: 'new' })
  })

  it('FR-TRAIN-6: a mind file is shown by its title and body, a scenario by its title and the client', () => {
    expect(readable('---\nid: k-1\ntitle: "Цены"\ntype: knowledge\n---\n## Факт\nОт 50 000')).toBe(
      'Цены\n## Факт\nОт 50 000',
    )
    expect(
      readable(
        JSON.stringify({
          title: 'Торг',
          messages: [
            { author: 'client', text: 'Дорого' },
            { author: 'boris', text: 'Почему?' },
            { author: 'client', text: 'Нашёл дешевле' },
          ],
        }),
      ),
    ).toBe('Торг\nКлиент: Нашёл дешевле')
    expect(readable('просто текст')).toBe('просто текст')
  })
})
