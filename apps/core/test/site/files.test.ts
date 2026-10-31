import { newEventId, type OrderAttachment } from '@sara/shared'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { orderScreenFromAnswer } from '../../../profi-node/src/bid/screen'
import { lead } from '../../src/db/schema'
import { type Fetched, fetchPage } from '../../src/site/fetch'
import { FILE_CHARS, fileText, profiHost, studyFiles } from '../../src/site/files'
import { leadSiteOf, studyLeadSite } from '../../src/site/lead'
import { siteLines, studiedLine } from '../../src/site/view'
import { openTestDb, resetDb } from '../helpers/db'
import { type FakeGateway, fakeGateway } from '../helpers/gateway'

const { db, close } = openTestDb()
afterAll(close)

const docx = (text: string) =>
  Buffer.from(
    zipSync({
      'word/document.xml': strToU8(
        `<w:document><w:body>${text
          .split('\n')
          .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
          .join('')}</w:body></w:document>`,
      ),
    }),
  )
const xlsx = (rows: string[]) =>
  Buffer.from(
    zipSync({
      'xl/sharedStrings.xml': strToU8(
        `<sst>${rows.map((r) => `<si><t>${r}</t></si>`).join('')}</sst>`,
      ),
    }),
  )
/** A one-page PDF with plain text, written by hand: no library made it. */
const pdf = (text: string) => {
  const stream = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const at: number[] = []
  objs.forEach((o, k) => {
    at.push(out.length)
    out += `${k + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(out, 'latin1')
}
const ok = (url: string, bytes: Buffer, truncated = false): Fetched => ({
  ok: true,
  url,
  html: '',
  truncated,
  bytes,
})

describe("the text of the order's files", () => {
  it('FR-FILE-1: a PDF, a DOCX and an XLSX give their text; a text file too', async () => {
    expect(await fileText(pdf('Launch in two weeks, online booking'), 'tz.pdf')).toContain(
      'Launch in two weeks',
    )
    expect(await fileText(docx('Запуск за две недели\nНужна запись онлайн'), 'ТЗ.docx')).toBe(
      'Запуск за две недели\nНужна запись онлайн',
    )
    expect(await fileText(xlsx(['Услуга', 'Пломба &amp; чистка']), 'прайс.xlsx')).toBe(
      'Услуга\nПломба & чистка',
    )
    expect(await fileText(Buffer.from('Бюджет 100000'), 'brief.txt')).toBe('Бюджет 100000')
  })

  it('FR-FILE-1: a kind Sara does not read, a broken file, and a zip with other entries give no text and no crash', async () => {
    expect(await fileText(Buffer.from('MZ....'), 'setup.exe')).toBeNull()
    expect(await fileText(Buffer.from(zipSync({ 'a.txt': strToU8('x') })), 'a.zip')).toBeNull()
    await expect(fileText(Buffer.from('PK not a zip'), 'broken.docx')).rejects.toBeTruthy()
  })
})

describe("reading the order's files", () => {
  const att = (name: string, kind: OrderAttachment['kind'] = 'document'): OrderAttachment => ({
    kind,
    url: `https://cdn.profi.ru/f/${name}`,
    name,
  })

  it('FR-FILE-2: documents are read, pictures only counted, at most three documents, too big and unreadable ones are notes', async () => {
    const bytes: Record<string, Buffer> = {
      'tz.docx': docx('Запуск за две недели'),
      'big.pdf': Buffer.alloc(1),
      'odd.bin': Buffer.from('MZ..'),
    }
    const got = await studyFiles(
      [
        att('tz.docx'),
        att('big.pdf'),
        att('odd.bin'),
        att('maket.png', 'image'),
        att('fourth.docx'),
      ],
      {
        fetchPage: async (u) => {
          const name = u.split('/').pop() ?? ''
          return name === 'big.pdf'
            ? ok(u, Buffer.alloc(10), true)
            : ok(u, bytes[name] ?? docx('x'))
        },
      },
    )
    expect(got.files).toEqual([
      {
        kind: 'document',
        name: 'tz.docx',
        opened: true,
        error: null,
        chars: 'Запуск за две недели'.length,
      },
      { kind: 'document', name: 'big.pdf', opened: false, error: 'too_big', chars: 0 },
      { kind: 'document', name: 'odd.bin', opened: false, error: 'unsupported', chars: 0 },
      { kind: 'image', name: 'maket.png', opened: false, error: 'not_read', chars: 0 },
      { kind: 'document', name: 'fourth.docx', opened: false, error: 'not_read', chars: 0 },
    ])
    expect(got.texts).toEqual([{ name: 'tz.docx', text: 'Запуск за две недели' }])
  })

  it('FR-FILE-3: a long file is cut for the model; a download that fails is a note', async () => {
    const long = docx('слово '.repeat(2000))
    const got = await studyFiles([att('long.docx'), att('gone.pdf')], {
      fetchPage: async (u) =>
        u.endsWith('gone.pdf') ? { ok: false, error: 'http_404', url: u } : ok(u, long),
    })
    expect(got.texts[0]?.text.length).toBeLessThanOrEqual(FILE_CHARS)
    expect(got.files[1]).toMatchObject({ opened: false, error: 'http_404' })
  })

  it("FR-FILE-4: only Profi.ru's own hosts are asked, with the default fetch; any other host is refused", async () => {
    expect(profiHost('cdn.profi.ru')).toBe(true)
    expect(profiHost('profi.ru')).toBe(true)
    expect(profiHost('evilprofi.ru')).toBe(false)
    expect(profiHost('profi.ru.evil.example')).toBe(false)
    const r = await fetchPage('https://evil.example/tz.pdf', { raw: true, hostOk: profiHost })
    expect(!r.ok && r.error).toBe('blocked')
    const local = await fetchPage('http://127.0.0.1/tz.pdf', { raw: true, hostOk: profiHost })
    expect(!local.ok && local.error).toBe('blocked')
  })
})

describe('the node reads the files from the order answer', () => {
  it('FR-FILE-5: documents and gallery become attachments; odd items are left out', () => {
    const body = {
      data: {
        orders: [
          {
            _id: '777',
            boOrderScreen: {
              id: '777',
              documents: [
                { url: 'https://cdn.profi.ru/d/tz.pdf', name: 'ТЗ.pdf', preview: 'x' },
                { name: 'без адреса' },
                'https://cdn.profi.ru/d/brief.docx',
              ],
              gallery: [{ src: '//cdn.profi.ru/g/maket.jpg' }, null],
            },
          },
        ],
      },
    }
    expect(orderScreenFromAnswer('https://profi.ru/graphql', body, '777')?.attachments).toEqual([
      { kind: 'document', url: 'https://cdn.profi.ru/d/tz.pdf', name: 'ТЗ.pdf' },
      { kind: 'document', url: 'https://cdn.profi.ru/d/brief.docx', name: 'brief.docx' },
      { kind: 'image', url: 'https://cdn.profi.ru/g/maket.jpg', name: 'maket.jpg' },
    ])
    expect(
      orderScreenFromAnswer(
        'https://profi.ru/graphql',
        { data: { orders: [{ _id: '1', boOrderScreen: { id: '1' } }] } },
        '1',
      )?.attachments,
    ).toEqual([])
  })
})

describe('the files on a lead', () => {
  let gw: FakeGateway
  const DIGEST = {
    valuable: ['в ТЗ важен запуск за две недели'],
    cares: ['скорость'],
    missing: ['бюджет'],
    hooks: ['по вашему ТЗ видно, что важна скорость запуска'],
    summary: 'ТЗ: запуск за две недели, запись онлайн',
  }
  beforeEach(async () => {
    await resetDb(db)
    gw = await fakeGateway(db, { 'links-digest': DIGEST })
  })
  const seed = async () => {
    const correlationId = newEventId()
    await db.insert(lead).values({
      id: '1',
      accountId: 'hance-marketing',
      title: 'Сайт',
      category: 'Сайты',
      city: 'К',
      text: 'Нужен сайт, ТЗ во вложении',
      clientName: 'Ирина',
      bidPriceRub: 210,
      seenAt: new Date().toISOString(),
      correlationId,
    })
    return correlationId
  }
  const i = (correlationId: string, attachments: OrderAttachment[]) => ({
    leadId: '1',
    correlationId,
    text: 'Нужен сайт, ТЗ во вложении',
    source: 'order' as const,
    order: { title: 'Сайт', category: 'Сайты', text: 'Нужен сайт, ТЗ во вложении' },
    attachments,
  })
  const tz: OrderAttachment = {
    kind: 'document',
    url: 'https://cdn.profi.ru/d/tz.docx',
    name: 'ТЗ.docx',
  }

  it("FR-FILE-6: the file's text goes to the cheap summary, the lead keeps the note, the card line names the file", async () => {
    const correlationId = await seed()
    const fileFetch = async (u: string) => ok(u, docx('Запуск за две недели. Нужна запись онлайн.'))
    const site = await studyLeadSite(
      { db, gateway: gw.gateway, fileFetch },
      i(correlationId, [tz, { kind: 'image', url: 'https://cdn.profi.ru/g/m.png', name: 'm.png' }]),
    )
    expect(site?.files?.map((f) => [f.name, f.opened])).toEqual([
      ['ТЗ.docx', true],
      ['m.png', false],
    ])
    expect(site?.digest).toEqual(DIGEST)
    const [call] = (await gw.calls()).filter((c) => c.role === 'links-digest')
    expect(call?.stdin).toContain('## Файлы заказа')
    expect(call?.stdin).toContain('Запуск за две недели')
    expect(call?.stdin).toMatch(/<<< данные ссылки[\s\S]*Запуск за две недели[\s\S]*>>>/)
    expect(studiedLine(site)).toBe(
      'ТЗ.docx, картинок 1 (не разбирала) · ТЗ: запуск за две недели, запись онлайн',
    )
    expect(siteLines(site).join('\n')).toContain(
      'Ценное для задачи: в ТЗ важен запуск за две недели',
    )
    const [row] = await db.select({ s: lead.clientSite }).from(lead)
    expect(leadSiteOf(row?.s)?.files).toHaveLength(2)
  })

  it('FR-FILE-7: the same files are not downloaded again; a file that does not come: the bid goes on, the card says so', async () => {
    const correlationId = await seed()
    let n = 0
    const fileFetch = async (u: string): Promise<Fetched> => {
      n++
      return { ok: false, error: 'http_403', url: u }
    }
    const site = await studyLeadSite({ db, gateway: gw.gateway, fileFetch }, i(correlationId, [tz]))
    expect(site?.files?.[0]).toMatchObject({ opened: false, error: 'http_403' })
    expect(site?.digest ?? null).toBeNull()
    expect((await gw.calls()).filter((c) => c.role === 'links-digest')).toHaveLength(0)
    expect(studiedLine(site)).toBe('файлов не прочитано: 1')
    expect(siteLines(site).join('\n')).toContain('не пиши, что изучала их')
    await studyLeadSite({ db, gateway: gw.gateway, fileFetch }, i(correlationId, [tz]))
    expect(n).toBe(1)
  })
})
