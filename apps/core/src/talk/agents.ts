/**
 * The two who answer in the voice app (ADR-028, Boris 07.11): Lora by default, Sara on call. Each has her voice of the
 * same Silero model, her colour in the app and a greeting said when she is called.
 */
export type Agent = 'lora' | 'sara'
export const AGENT_IDS = ['lora', 'sara'] as const

export const AGENTS: Record<Agent, { name: string; speaker: string; greeting: string }> = {
  lora: { name: 'Лора', speaker: 'baya', greeting: 'Борь, я на связи.' },
  sara: { name: 'Сара', speaker: 'xenia', greeting: 'Да-да, Борь, я тут.' },
}

/** Every form of the name whisper writes: Сара, Сару, Саре, Сарой, Сарочка... */
const NAME: Record<Agent, RegExp> = {
  sara: /^сарр?(?:а|у|е|ой|ы|очк\p{L}*)$/u,
  lora: /^лор(?:а|у|е|ой|ы|очк\p{L}*)$/u,
}
/** Words that call someone: «позови», «переключи на», «дай», «соедини с». */
const CALL = new Set([
  'позови',
  'позовите',
  'зови',
  'дай',
  'давай',
  'переключи',
  'переключись',
  'соедини',
  'подключи',
  'верни',
  'хочу',
])
/** Words between the call and the name that change nothing: «переключи на», «соедини с», «дай мне». */
const FILLER = new Set(['на', 'с', 'со', 'мне', 'мою', 'сюда', 'пожалуйста', 'ко', 'к'])

/** The words of the text with where each ends: lower case, «ё» as «е». */
const tokens = (text: string) =>
  [...text.matchAll(/[\p{L}-]+/gu)].map((m) => ({
    w: m[0].toLowerCase().replace(/ё/g, 'е'),
    end: (m.index ?? 0) + m[0].length,
  }))

/**
 * Whether Boris calls the other one: a call word and her name at the start («позови Сару»), or her name alone
 * («Сара», «Сара, ты тут?»). Words after the call are a question for her (`rest`). Words about her («что Сара
 * делала») call no one.
 */
export function switchTo(text: string, current: Agent): { agent: Agent; rest: string } | null {
  const t = tokens(text)
  if (t.length === 0) return null
  for (const agent of AGENT_IDS) {
    if (agent === current) continue
    const isName = (i: number) => i < t.length && NAME[agent].test(t[i]?.w ?? '')
    let at = -1
    if (CALL.has(t[0]?.w ?? '')) {
      let i = 1
      while (i < t.length && FILLER.has(t[i]?.w ?? '')) i++
      if (isName(i)) at = i
    } else if (isName(0) && t.length <= 4) at = 0
    if (at < 0) continue
    // The question after the name, as he said it.
    const rest = text
      .slice(t[at]?.end ?? text.length)
      .replace(/^[\s,.:;!?-]+/, '')
      .trim()
    const ask = tokens(rest).filter((x) => !['ты', 'тут', 'здесь', 'на', 'связи'].includes(x.w))
    return { agent, rest: ask.length >= 2 ? rest : '' }
  }
  return null
}
