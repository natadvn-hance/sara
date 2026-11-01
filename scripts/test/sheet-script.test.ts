import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { fillScript, SCRIPT } from '../sheet-script'

const SECRET = 'ab'.repeat(24)
type Cell = string | number

/**
 * A made-up Google Sheet with only what the script calls: cells, row inserts that carry the row labels (developer
 * metadata) along, and the range of Boris's formulas, which grows when a row is inserted inside it.
 */
function fakeSheet(rows: Cell[][]) {
  const grid: Cell[][] = rows.map((r) => [...r])
  let labels: { value: string; row: number }[] = []
  const formulas = { first: 3, last: 102 }
  const at = (r: number) => {
    while (grid.length < r) grid.push([])
    return grid[r - 1] as Cell[]
  }
  const range = (row: number, col: number, nr: number, nc: number) => ({
    getValues: () =>
      Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => at(row + i)[col - 1 + j] ?? ''),
      ),
    setValues: (v: Cell[][]) =>
      v.forEach((line, i) => {
        line.forEach((x, j) => {
          at(row + i)[col - 1 + j] = x
        })
      }),
    setValue: (x: Cell) => {
      at(row)[col - 1] = x
    },
    addDeveloperMetadata: (key: string, value: string) => {
      if (key === 'sara') labels.push({ value, row })
    },
  })
  const sheet = {
    getName: () => '📋 Лог клиентов',
    getLastRow: () => {
      for (let r = grid.length; r > 0; r--) if ((grid[r - 1] ?? []).some((x) => x !== '')) return r
      return 0
    },
    getRange: (a: number | string, col?: number, nr?: number, nc?: number) =>
      typeof a === 'string'
        ? range(Number(a.split(':')[0]), 1, 1, 8)
        : range(a, col ?? 1, nr ?? 1, nc ?? 1),
    insertRowAfter: (r: number) => {
      grid.splice(r, 0, [])
      labels = labels.map((l) => (l.row > r ? { ...l, row: l.row + 1 } : l))
      if (r >= formulas.first && r < formulas.last) formulas.last += 1
    },
    deleteRow: (r: number) => {
      grid.splice(r - 1, 1)
      labels = labels
        .filter((l) => l.row !== r)
        .map((l) => (l.row > r ? { ...l, row: l.row - 1 } : l))
    },
    createDeveloperMetadataFinder: () => ({
      withKey: () => ({
        find: () =>
          labels.map((l) => ({
            getValue: () => l.value,
            getLocation: () => ({
              getLocationType: () => 'ROW',
              getRow: () => ({ getRow: () => l.row }),
            }),
          })),
      }),
    }),
  }
  return { sheet, grid, formulas, labels: () => labels }
}

function loadScript(sheet: ReturnType<typeof fakeSheet>['sheet'], secret = SECRET) {
  const source = fillScript(readFileSync(SCRIPT, 'utf8'), secret)
  const ctx = createContext({
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheets: () => [{ getName: () => '🔻 Воронка' }, sheet] }),
      flush: () => {},
      DeveloperMetadataLocationType: { ROW: 'ROW' },
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text: string) => ({ text, setMimeType: () => ({ text }) }),
    },
  })
  runInContext(source, ctx)
  const post = (body: unknown) =>
    JSON.parse(
      (ctx.doPost as (e: unknown) => { text: string })({
        postData: { contents: JSON.stringify(body) },
      }).text,
    )
  return { post }
}

const HEAD: Cell[][] = [
  [],
  [
    'Месяц',
    'Клиент',
    'Тип услуги',
    'Этап воронки',
    'Сумма сделки, ₽',
    'Расходы Профи.ру, ₽',
    'LTV клиента, ₽',
    'Заметка',
  ],
  ['Апрель', 'Ольга', 'Сайт', 'Отвалился', 30000, 120, '', ''],
  ['Май', 'Пётр', 'Консультация', 'Закрыта', 5000, 60, 5000, 'Отзыв'],
]
const VALUES = {
  month: 'Октябрь',
  client: 'Гена',
  service: 'Сайт',
  stage: 'Отклик',
  deal: 30000,
  spend: 437,
  ltv: '',
  note: '',
}

describe('the script in Boris sheet', () => {
  it('FR-ANL-7: a new bid is one row under the last one, inside the range of his formulas', () => {
    const s = fakeSheet(HEAD)
    const { post } = loadScript(s.sheet)
    const r = post({
      secret: SECRET,
      ops: [{ key: '95000001', create: true, values: VALUES, expect: {} }],
    })
    expect(r).toEqual({
      ok: true,
      results: [{ key: '95000001', status: 'created', written: Object.keys(VALUES), kept: [] }],
    })
    expect(s.grid[4]).toEqual(['Октябрь', 'Гена', 'Сайт', 'Отклик', 30000, 437, '', ''])
    expect(s.labels()).toEqual([{ value: '95000001', row: 5 }])
    expect(s.formulas.last).toBe(103)
  })

  it('FR-ANL-7: the same bid sent again (its answer was lost) updates its row, never a second one', () => {
    const s = fakeSheet(HEAD)
    const { post } = loadScript(s.sheet)
    const op = { key: '95000001', create: true, values: VALUES, expect: {} }
    post({ secret: SECRET, ops: [op] })
    const again = post({ secret: SECRET, ops: [op] })
    expect(again.results[0]).toMatchObject({ status: 'updated', kept: [] })
    expect(s.grid.filter((r) => r[1] === 'Гена')).toHaveLength(1)
  })

  it('FR-ANL-7: Sara changes a cell only when it holds what she wrote; a cell Boris changed is kept', () => {
    const s = fakeSheet(HEAD)
    const { post } = loadScript(s.sheet)
    post({ secret: SECRET, ops: [{ key: '95000001', create: true, values: VALUES, expect: {} }] })
    // Boris types his own note and sum; then the client answers and Sara moves the stage.
    ;(s.grid[4] as Cell[])[4] = 45000
    ;(s.grid[4] as Cell[])[7] = 'Звонить в среду'
    const r = post({
      secret: SECRET,
      ops: [
        {
          key: '95000001',
          create: false,
          values: { stage: 'Переговоры', deal: 35000, note: 'Вернули на баланс' },
          expect: { stage: 'Отклик', deal: 30000, note: '' },
        },
      ],
    })
    expect(r.results[0]).toEqual({
      key: '95000001',
      status: 'updated',
      written: ['stage'],
      kept: ['deal', 'note'],
    })
    expect(s.grid[4]).toEqual([
      'Октябрь',
      'Гена',
      'Сайт',
      'Переговоры',
      45000,
      437,
      '',
      'Звонить в среду',
    ])
  })

  it('FR-ANL-7: rows inserted above move the label along; a row Boris deleted is gone, not written again', () => {
    const s = fakeSheet(HEAD)
    const { post } = loadScript(s.sheet)
    post({ secret: SECRET, ops: [{ key: '95000001', create: true, values: VALUES, expect: {} }] })
    s.sheet.insertRowAfter(3)
    expect(
      post({
        secret: SECRET,
        ops: [
          {
            key: '95000001',
            create: false,
            values: { stage: 'В работе' },
            expect: { stage: 'Отклик' },
          },
        ],
      }).results[0].status,
    ).toBe('updated')
    expect(s.grid[5]?.[3]).toBe('В работе')
    s.sheet.deleteRow(6)
    const r = post({
      secret: SECRET,
      ops: [
        {
          key: '95000001',
          create: false,
          values: { stage: 'Закрыта' },
          expect: { stage: 'В работе' },
        },
      ],
    })
    expect(r.results[0]).toEqual({ key: '95000001', status: 'gone' })
    expect(s.grid.some((row) => row[1] === 'Гена')).toBe(false)
  })

  it('FR-ANL-7: a wrong secret or a script with no secret writes nothing', () => {
    const s = fakeSheet(HEAD)
    const op = { key: '95000001', create: true, values: VALUES, expect: {} }
    expect(loadScript(s.sheet).post({ secret: 'nope', ops: [op] })).toEqual({
      ok: false,
      error: 'secret',
    })
    expect(s.grid).toHaveLength(4)
    expect(() => fillScript('var SECRET = 1', SECRET)).toThrow()
    expect(() => fillScript(readFileSync(SCRIPT, 'utf8'), 'short')).toThrow()
  })

  it('FR-ANL-7: a ping answers with the tab and how many rows the log has', () => {
    const s = fakeSheet(HEAD)
    expect(loadScript(s.sheet).post({ secret: SECRET, ping: true })).toEqual({
      ok: true,
      sheet: '📋 Лог клиентов',
      rows: 2,
    })
  })
})
