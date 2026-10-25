import { similarity } from '../../conversation/compare'
import type { EditWeight } from '../types'

const NOT_LETTER = '(?<![а-яёa-z])'
const END = '(?![а-яёa-z])'
/** A greeting at the start, with or without the client's name before it: «Анна, добрый день!». */
const GREETING = new RegExp(
  `^\\s*(?:[^,!.?\\n]{1,40},\\s*)?${NOT_LETTER}(?:здравствуйте|добрый\\s+(?:день|вечер)|доброе\\s+утро|доброй\\s+ночи|привет)${END}[\\s,.!)]*`,
  'iu',
)
const WORD_NUMBERS: [RegExp, string][] = [
  [/полтор(?:а|ы)/, '1.5'],
  [/од(?:ин|на|ну|ного|ной)/, '1'],
  [/дв(?:а|е|ух)/, '2'],
  [/тр(?:и|ех|ёх)/, '3'],
  [/четыр(?:е|ех|ёх)/, '4'],
  [/пят(?:ь|и)/, '5'],
  [/шест(?:ь|и)/, '6'],
  [/сем(?:ь|и)/, '7'],
  [/восем(?:ь|и)|восьми/, '8'],
  [/девят(?:ь|и)/, '9'],
  [/десят(?:ь|и)/, '10'],
]

/** The numbers a text names, in digits or in words from one to ten: «50 000», «две недели», «полтора месяца». */
export function numbersIn(text: string): string[] {
  const lower = text.toLowerCase()
  const digits = [...lower.matchAll(/\d[\d\s ]*(?:[.,]\d+)?/g)].map((m) =>
    m[0].replace(/[\s ]/g, '').replace(',', '.'),
  )
  const words = WORD_NUMBERS.flatMap(([re, n]) =>
    [...lower.matchAll(new RegExp(`${NOT_LETTER}(?:${re.source})${END}`, 'gu'))].map(() => n),
  )
  return [...digits, ...words].sort()
}

/** The text as it is compared: no greeting at the start and no client's name. */
function body(text: string, names: string[]): string {
  let t = text.replace(GREETING, '')
  for (const n of names.filter((x) => x.trim().length > 1))
    t = t.replace(
      new RegExp(`${NOT_LETTER}${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${END}`, 'giu'),
      '',
    )
  return t
}

/**
 * How much Boris changed Sara's draft (M5 design 5.15): the same (90% alike or more, the same numbers) is an
 * approval; under `substantialBelow` or other numbers is a substantial edit; anything between is a minor one. The
 * greeting and the client's name are left out, so «Анна, добрый день!» added to a short reply changes nothing.
 */
export function editWeight(
  draft: string,
  boris: string,
  o: { substantialBelow: number; names: string[] },
): EditWeight {
  const a = body(draft, o.names)
  const b = body(boris, o.names)
  const sameNumbers = numbersIn(a).join('|') === numbersIn(b).join('|')
  const alike = similarity(a, b)
  if (!sameNumbers || alike < o.substantialBelow) return 'substantial'
  return alike >= 90 ? 'same' : 'minor'
}
