import type { MindHit, MindSearch } from '../conversation/types'
import { VOICE_ALWAYS, voiceOn } from '../conversation/voice'
import type { Db } from '../db/client'
import { markdownSections } from '../mind/loader'

/**
 * Boris's voice in a bid (10.11.2026: the bids were still written without his skill «Голос Бориса»). Where the voice
 * is on (a test order, or every order after conv.voice = «all», as in a conversation) the Analyst reads the speech
 * portrait, the form of the text and the voice's own rules, a few of his samples that fit a first touch, and the
 * phrases he never says. A bid is a first touch: the skill's «строже». Elsewhere the Analyst reads what it always did.
 */

/** The records a bid with the voice reads: the speech portrait, the form of the text, the voice's own rules. */
export const BID_VOICE_RECORDS = ['s-portrait', ...VOICE_ALWAYS]

/**
 * His samples (sara-mind, trial) that fit a first touch, in this order: a strict «Добрый день» and the matter at once
 * (52), what he looked at of the client's own and a question (54), a niche he knows and a question about the client's
 * way (55), «я» and a soft «на мой взгляд» (51). The others are chats in full swing, freer than a bid may be.
 */
export const BID_VOICE_SAMPLES = ['e-boris-52', 'e-boris-54', 'e-boris-55', 'e-boris-51']

export type BidVoice = {
  /** The portrait, the form of the text and the voice rules, as the mind holds them. */
  records: MindHit[]
  /** His samples for a first touch, each with what the client said and what he answered. */
  samples: MindHit[]
  /** The portrait's «Никогда не говорит». */
  banned: string[]
}

/**
 * The voice for the bid of this order, or null where it is off. A mind without the voice records (not pulled yet, or
 * none at all) gives null too: the bid is written as it always was.
 */
export async function bidVoiceFor(
  db: Db,
  mind: (Pick<MindSearch, 'byIds'> & Partial<Pick<MindSearch, 'bannedPhrases'>>) | undefined,
  orderId: string | null | undefined,
): Promise<BidVoice | null> {
  if (!mind || !(await voiceOn(db, orderId))) return null
  const [hits, banned] = await Promise.all([
    mind.byIds([...BID_VOICE_RECORDS, ...BID_VOICE_SAMPLES]),
    mind.bannedPhrases ? mind.bannedPhrases({ trial: true }) : Promise.resolve([]),
  ])
  const records = hits.filter((h) => BID_VOICE_RECORDS.includes(h.id))
  const samples = hits.filter((h) => BID_VOICE_SAMPLES.includes(h.id) && h.exampleBoris)
  return records.length > 0 || samples.length > 0 ? { records, samples, banned } : null
}

/** How the Analyst is to write with the voice: the mode of a first touch, and what stays the role's and the code's. */
const HOW = [
  'Голос Бориса (проба на тестовых заявках, по его скиллу «Голос Бориса», 07.11.2026). Пиши отклик и серию вдогонку его голосом: интонацию, обороты и ритм бери из записей и образцов ниже.',
  '- Отклик это первое касание, режим «строже» из портрета: полные предложения, сленга почти нет, скобка «)» в тексте отклика редко. Одно живое слово или мягкая оговорка («на мой взгляд», «честно скажу», «если удобно») к месту: совсем канцелярски Борис не пишет.',
  '- Приветствие, как и раньше, ставит программа: ты его не пишешь и к клиенту по имени не обращаешься.',
  '- Серия вдогонку тем же голосом, чуть живее, как Борис дописывал следом за собой. Это все еще первое знакомство: сленга почти нет и тут.',
  '- Строение отклика (начало, кейс, вопрос в конце, длина) задают твои правила и «Формат отклика этого направления», если он есть. Форма текста тоже по твоим правилам: без тире, без дефисов в обычных словах, без точки в конце абзаца, без эмодзи, без буквы «ё». Где записи ниже говорят иначе, правила роли главнее.',
  '- j-tone писан для переписки: бери из него тон и форму текста, а длину и строение отклика из своих правил.',
  '- Образцы это ответы Бориса в переписке, не отклики. Бери из них голос, не содержание: опыт, проекты, сроки, цены и личное Бориса из образцов не переноси. Опыт называй только из кейсов во входе.',
]

const sampleText = (s: MindHit): string => {
  const note = markdownSections(s.body).Контекст?.trim()
  return [
    `[${s.id}]`,
    `Клиент: ${s.exampleClient?.trim() ?? ''}`,
    `Борис: ${s.exampleBoris?.trim() ?? ''}`,
    ...(note ? [`Пометка: ${note}`] : []),
  ].join('\n')
}

/** The voice as the Analyst reads it: how to write with it, the phrases he never says, the records, the samples. */
export function bidVoiceText(v: BidVoice): string {
  const head = [
    ...HOW,
    ...(v.banned.length > 0
      ? [`- Никогда не пиши: ${v.banned.map((p) => `«${p}»`).join(', ')}`]
      : []),
  ].join('\n')
  return [
    head,
    ...(v.records.length > 0
      ? [
          [
            'Записи разума о голосе:',
            ...v.records.map((r) => `[${r.id}] ${r.title}\n${r.body.trim()}`),
          ].join('\n\n'),
        ]
      : []),
    ...(v.samples.length > 0
      ? [['Образцы Бориса:', ...v.samples.map(sampleText)].join('\n\n')]
      : []),
  ].join('\n\n')
}

/** Folded words, one space between them and one at each end, for whole-word matching. */
const words = (s: string): string =>
  ` ${s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `

/** The first phrase Boris never says that one of the texts holds, as the portrait writes it; null when none does. */
export function bannedIn(texts: readonly string[], banned: readonly string[]): string | null {
  const said = texts.map(words)
  for (const phrase of banned) {
    const p = words(phrase)
    if (p.trim() && said.some((t) => t.includes(p))) return phrase
  }
  return null
}
