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
  it('FR-MIND-2: a case whose rules are unclear about the company name is reported, an allow or a ban of any wording passes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    const rules: Record<string, string[]> = {
      'k-case-10': ['Цифры из «Результата» можно называть как есть, не округляя в свою пользу.'],
      'k-case-11': ['Приоритетный кейс для портфолио.', 'Цифр результата нет.'],
      'k-case-12': ['Микро-кейс: только как дополнительный пример; компания не названа.'],
      'k-case-13': ['Компанию называть нельзя.'],
      'k-case-14': ['Анонимно'],
      'k-case-15': ['Без названия компании.', 'Цифры можно называть.'],
      'k-case-16': ['Название скрыть.'],
      'k-case-17': ['Компанию и ссылку можно\n  называть.'],
    }
    for (const [id, items] of Object.entries(rules)) {
      const list = items.map((i) => `- ${i}`).join('\n')
      await put(
        dir,
        `shared/knowledge/cases/${id}.md`,
        { id, type: 'knowledge', title: id, tags: ['кейс'] },
        `Суть.\n\n## Как показывать клиенту\n${list}\n`,
      )
    }
    const problems = await checkMind(dir)
    expect(problems.map((p) => p.file)).toEqual(
      ['k-case-10', 'k-case-11', 'k-case-12'].map((id) =>
        join(dir, `shared/knowledge/cases/${id}.md`),
      ),
    )
    for (const p of problems) {
      expect(p).toMatchObject({
        field: 'section',
        message: expect.stringContaining('название компании'),
      })
    }
  })

  it('FR-MIND-2: the rules of the 28 real cases all say something about the company name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    const name = 'Компанию и ссылку можно называть.'
    const numbers = 'Цифры из «Результата» можно называть как есть, не округляя в свою пользу.'
    const noNumbers =
      'Цифр результата нет: говорить о том, что сделали, не обещать и не придумывать результат.'
    const ndaName = 'Компанию не называть: NDA. Город и сфера можно.'
    const real: string[][] = [
      [name, noNumbers],
      [name, numbers, 'Приоритетный кейс для портфолио.'],
      [name],
      [
        name,
        'Это работа в найме (in-house): говорить как об опыте Бориса изнутри компании, не как о проекте агентства.',
        noNumbers,
      ],
      [name, numbers, 'Можно упомянуть отзыв клиента 5★.'],
      [name, 'Микро-кейс: только как дополнительный пример, не как главный.', numbers],
      [
        'Компанию не называть: NDA. Детали и название не раскрывать.',
        numbers,
        'Можно упомянуть отзыв клиента 5★.',
      ],
      [
        name,
        'Результаты контекстной рекламы не акцентировать: упор на исследование, сайт, SEO и систему маркетинга.',
      ],
      [
        name,
        'Подавать как разработку стратегии, аналитической модели и плана роста. Клиент не внедрял: о росте не говорить.',
        noNumbers,
      ],
      [
        'Компанию, отрасль и чувствительные детали не называть: NDA. Говорить о подходе и составе работ.',
        noNumbers,
      ],
      [name, 'Отделять сделанное от планов; результаты рекламы не заявлять.'],
      [
        name,
        'Проект в развитии: говорить как о текущей работе.',
        'Приоритетный кейс для портфолио.',
      ],
      [ndaName, numbers],
    ]
    for (const [i, items] of real.entries()) {
      const id = `k-case-${String(i + 1).padStart(2, '0')}`
      await put(
        dir,
        `shared/knowledge/cases/${id}.md`,
        { id, type: 'knowledge', title: id, tags: ['кейс'] },
        `Суть.\n\n## Как показывать клиенту\n${items.map((r) => `- ${r}`).join('\n')}\n`,
      )
    }
    expect(await checkMind(dir)).toEqual([])
  })
})
