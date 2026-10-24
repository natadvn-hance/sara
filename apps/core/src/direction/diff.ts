import type { DirectionRules } from '@sara/shared'

export type RulesSection = 'about' | 'stop_factors' | 'red_flags' | 'axes' | 'threshold' | 'notes'
export type RulesDiff = { sections: RulesSection[]; lines: string[] }

const short = (t: string) => (t.length > 120 ? `${t.slice(0, 117)}...` : t)

function byId<T extends { id: string }>(
  a: T[],
  b: T[],
  same: (x: T, y: T) => boolean,
  say: { added(x: T): string; removed(x: T): string; edited(x: T): string },
): string[] {
  const out: string[] = []
  const old = new Map(a.map((x) => [x.id, x]))
  const now = new Map(b.map((x) => [x.id, x]))
  for (const x of b) {
    const was = old.get(x.id)
    if (!was) out.push(say.added(x))
    else if (!same(was, x)) out.push(say.edited(x))
  }
  for (const x of a) if (!now.has(x.id)) out.push(say.removed(x))
  return out
}

/**
 * What a proposal really changes, computed from the rules themselves (not the model's words), section by
 * section, in plain Russian for Boris (FR-MIND-3).
 */
export function rulesDiff(a: DirectionRules, b: DirectionRules): RulesDiff {
  const parts: [RulesSection, string[]][] = [
    ['about', a.about === b.about ? [] : ['Изменено описание направления']],
    [
      'stop_factors',
      byId(a.stop_factors, b.stop_factors, (x, y) => JSON.stringify(x) === JSON.stringify(y), {
        added: (x) => `Новый стоп-фактор: ${short(x.text)}`,
        removed: (x) => `Убран стоп-фактор: ${short(x.text)}`,
        edited: (x) => `Изменён стоп-фактор: ${short(x.text)}`,
      }),
    ],
    [
      'red_flags',
      byId(a.red_flags, b.red_flags, (x, y) => JSON.stringify(x) === JSON.stringify(y), {
        added: (x) => `Новый красный флаг: ${short(x.text)}`,
        removed: (x) => `Убран красный флаг: ${short(x.text)}`,
        edited: (x) => `Изменён красный флаг: ${short(x.text)}`,
      }),
    ],
    [
      'axes',
      (() => {
        const out: string[] = []
        const old = new Map(a.axes.map((x) => [x.id, x]))
        for (const x of b.axes) {
          const was = old.get(x.id)
          if (!was) {
            out.push(`Новая ось «${x.title}», вес ${x.weight}`)
            continue
          }
          if (was.weight !== x.weight) out.push(`Вес «${x.title}»: ${was.weight} → ${x.weight}`)
          if (was.title !== x.title) out.push(`Ось «${was.title}» теперь «${x.title}»`)
          if (was.how !== x.how) out.push(`Как оценивать «${x.title}»: ${short(x.how)}`)
        }
        for (const x of a.axes)
          if (!b.axes.some((y) => y.id === x.id)) out.push(`Убрана ось «${x.title}»`)
        return out
      })(),
    ],
    ['threshold', a.threshold === b.threshold ? [] : [`Порог: ${a.threshold} → ${b.threshold}`]],
    [
      'notes',
      [
        ...b.notes.filter((n) => !a.notes.includes(n)).map((n) => `Новое уточнение: ${short(n)}`),
        ...a.notes.filter((n) => !b.notes.includes(n)).map((n) => `Убрано уточнение: ${short(n)}`),
      ],
    ],
  ]
  const touched = parts.filter(([, l]) => l.length > 0)
  return { sections: touched.map(([s]) => s), lines: touched.flatMap(([, l]) => l) }
}
