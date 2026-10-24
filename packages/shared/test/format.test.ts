import { expect, it } from 'vitest'
import { formatRub, normalizeText, plural } from '../src/index'

it('NFR-UX-1: formatRub uses a no-break space', () => {
  expect(formatRub(1250)).toBe('1 250 ₽')
  expect(formatRub(210)).toBe('210 ₽')
})

it('NFR-UX-1: plural picks the Russian form by the number', () => {
  const forms = ['решение', 'решения', 'решений'] as const
  const cases: [number, string][] = [
    [0, 'решений'],
    [1, 'решение'],
    [2, 'решения'],
    [4, 'решения'],
    [5, 'решений'],
    [11, 'решений'],
    [12, 'решений'],
    [14, 'решений'],
    [21, 'решение'],
    [22, 'решения'],
    [25, 'решений'],
    [101, 'решение'],
    [111, 'решений'],
    [114, 'решений'],
    [122, 'решения'],
  ]
  for (const [n, want] of cases) expect([n, plural(n, forms)]).toEqual([n, want])
})

it('FR-TRAIN-1: normalizeText compares messages as people read them', () => {
  expect(normalizeText('  Ёлка \u2014  Сайт– под\n\nключ.  ')).toBe('елка - сайт- под ключ')
  expect(normalizeText('«Добрый день!»')).toBe(normalizeText('добрый день'))
  expect(normalizeText('Цена 50 000 ₽')).toBe('цена 50 000 ₽')
})
