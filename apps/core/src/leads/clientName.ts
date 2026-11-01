import { formalName } from './russianNames'

/** What Profi.ru shows instead of a name while it hides one. */
const PLACEHOLDER = /^(клиент|заказчик|пользовател|имя|аноним|скры)/iu

/**
 * The name Sara calls a client by, from what his profile says (Boris, 01.11.2026): the first word of it as a formal
 * Russian first name, «alexander» as «Александр», «Таня» as «Татьяна». A profession («Психотерапевт»), a company
 * («ООО Ромашка»), a nick, a stand-in of the site or a name Sara does not know gives null: the greeting then goes
 * without a name, «Добрый день!». Only letters and hyphens ever reach a pattern.
 */
export function firstName(clientName: string): string | null {
  const word = /^\p{L}[\p{L}-]*/u.exec(clientName.trim())?.[0] ?? ''
  if (!word || PLACEHOLDER.test(word)) return null
  const parts = word.split('-').filter(Boolean)
  const formal = parts.map(formalName)
  return formal.length > 0 && formal.every((p): p is string => p !== null) ? formal.join('-') : null
}

/** «ИП», «ООО»: a company form in capitals is no part of a person's name, and hiding it would mangle the text. */
const COMPANY_FORM = /^\p{Lu}{1,3}$/u

/**
 * The client names to hide from a model (ADR-016): the letters of each name as the site gave it, without the words
 * it shows in place of one and without company forms; a hyphenated name also by its parts. A name appears once
 * however many places gave it; no names at all gives an empty list.
 */
export function namesToHide(...names: (string | null | undefined)[]): string[] {
  const seen = new Map<string, string>()
  const add = (name: string) => {
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
  }
  for (const n of names) {
    const words = (n?.match(/\p{L}[\p{L}-]*/gu) ?? []).filter(
      (w) => !PLACEHOLDER.test(w) && !COMPANY_FORM.test(w),
    )
    add(words.join(' '))
    for (const w of words) if (w.includes('-')) for (const part of w.split('-')) add(part)
  }
  return [...seen.values()]
}
