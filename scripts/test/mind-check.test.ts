import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { checkMind } from '../mind-check'

const FIX = resolve(import.meta.dirname, 'fixtures/mind')

async function put(
  root: string,
  rel: string,
  front: Record<string, unknown>,
  body = 'Текст.',
): Promise<void> {
  const full = {
    scope: 'shared',
    status: 'confirmed',
    version: 1,
    sources: ['boris:test'],
    valid_from: '2026-01-01',
    valid_to: null,
    ...front,
  }
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), `---\n${stringify(full)}---\n\n${body}\n`)
}

describe('mind check', () => {
  it('FR-MIND-1: valid record passes', async () => {
    expect(await checkMind(join(FIX, 'good'))).toEqual([])
  })

  it('FR-MIND-1: wrong status names the file and the field', async () => {
    expect(await checkMind(join(FIX, 'bad'))).toEqual([
      { file: join(FIX, 'bad', 'price.md'), field: 'status', message: expect.any(String) },
    ])
  })

  it('FR-MIND-1: a file without fields at the top is reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    await writeFile(join(dir, 'plain.md'), 'Просто текст\n')
    expect(await checkMind(dir)).toEqual([
      { file: join(dir, 'plain.md'), field: 'frontmatter', message: expect.any(String) },
    ])
  })

  it('FR-MIND-1: an id repeated in another file is reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    await put(dir, 'shared/knowledge/k-a.md', { id: 'k-a', type: 'knowledge' })
    await put(dir, 'shared/knowledge/k-b.md', { id: 'k-a', type: 'knowledge' })
    expect(await checkMind(dir)).toEqual([
      {
        file: join(dir, 'shared/knowledge/k-b.md'),
        field: 'id',
        message: expect.stringMatching(/k-a/),
      },
    ])
  })

  it('FR-MIND-1: a proposal may carry the id of the record it replaces', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    await put(dir, 'shared/knowledge/k-a.md', { id: 'k-a', type: 'knowledge' })
    await put(dir, 'proposals/shared/knowledge/k-a.md', {
      id: 'k-a',
      type: 'knowledge',
      status: 'proposal',
      version: 2,
    })
    await put(dir, 'proposals/shared/knowledge/k-other.md', {
      id: 'k-a',
      type: 'knowledge',
      status: 'proposal',
    })
    expect(await checkMind(dir)).toEqual([
      {
        file: join(dir, 'proposals/shared/knowledge/k-other.md'),
        field: 'id',
        message: expect.stringMatching(/k-a/),
      },
    ])
  })

  it('FR-MIND-1: an id must start with the letter of its type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    await put(dir, 'shared/understanding/price.md', { id: 'k-price', type: 'understanding' })
    expect(await checkMind(dir)).toEqual([
      {
        file: join(dir, 'shared/understanding/price.md'),
        field: 'id',
        message: expect.stringMatching(/u-/),
      },
    ])
  })

  it('FR-MIND-1: version 2 fields are checked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    await put(dir, 'shared/understanding/u-price.md', {
      id: 'u-price',
      type: 'understanding',
      title: 'Вопрос о цене',
      tags: ['цена', 'стоимость'],
      topic: 'money',
      tones: ['neutral'],
      stages: ['talking'],
    })
    await put(dir, 'shared/understanding/u-cases.md', {
      id: 'u-cases',
      type: 'understanding',
      topic: 'cases',
      examples: ['e-cases', 'e-missing'],
    })
    await put(dir, 'shared/speech/examples/e-cases.md', { id: 'e-cases', type: 'example' })
    expect(await checkMind(dir)).toEqual([
      {
        file: join(dir, 'shared/understanding/u-cases.md'),
        field: 'examples',
        message: expect.stringMatching(/e-missing/),
      },
      {
        file: join(dir, 'shared/understanding/u-price.md'),
        field: 'topic',
        message: expect.any(String),
      },
    ])
  })

  it('FR-MIND-2: a knowledge record tagged «кейс» needs the section «Как показывать клиенту» with items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    const k = (id: string, tags: string[]) => ({ id, type: 'knowledge', title: id, tags })
    const body = (rules: string) => `Суть.\n\n## Результат\nСто заявок.\n\n${rules}`
    await put(dir, 'shared/knowledge/cases/k-case-01.md', k('k-case-01', ['кейс']), body(''))
    await put(
      dir,
      'shared/knowledge/cases/k-case-02.md',
      k('k-case-02', ['Кейс', 'сайт']),
      body('## Как показывать клиенту\n- Компанию и ссылку можно называть.\n'),
    )
    await put(
      dir,
      'shared/knowledge/cases/k-case-03.md',
      k('k-case-03', ['КЕЙС']),
      body('## Как показывать клиенту\nБез пунктов.\n'),
    )
    await put(dir, 'shared/knowledge/k-about.md', k('k-about', ['портфолио']), body(''))
    await put(
      dir,
      'shared/speech/examples/e-case.md',
      { id: 'e-case', type: 'example', tags: ['кейс'] },
      body(''),
    )
    await put(
      dir,
      'proposals/shared/knowledge/cases/k-case-04.md',
      { ...k('k-case-04', ['кейс']), status: 'proposal' },
      body(''),
    )
    expect(await checkMind(dir)).toEqual([
      {
        file: join(dir, 'proposals/shared/knowledge/cases/k-case-04.md'),
        field: 'section',
        message: expect.stringContaining('Как показывать клиенту'),
      },
      {
        file: join(dir, 'shared/knowledge/cases/k-case-01.md'),
        field: 'section',
        message: expect.stringContaining('Как показывать клиенту'),
      },
      {
        file: join(dir, 'shared/knowledge/cases/k-case-03.md'),
        field: 'section',
        message: expect.stringContaining('пункт'),
      },
    ])
  })
})
