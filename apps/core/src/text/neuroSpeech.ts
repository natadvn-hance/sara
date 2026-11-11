/**
 * The turn of phrase of a neural net that Boris will not have in a bid or a letter to a client (Boris, 01.11.2026:
 * «нужен не подрядчик на разовые задачи, а человек; не просто провести встречи, а понять; главная беда не в
 * качестве работы, а в том. Нейро-речь мне не нравится, человек так не пишет»): the negative parallel «не X, а Y» and
 * its kin. None of the 36 speech examples of Boris has one. A pure function over the text; the first hit is returned.
 *
 * Plain talk of a day or a number, «не во вторник, а в среду», «не в 10, а в 11», is a correction and stays: a part
 * before the «а» with a weekday, a time word or a digit is no parallel.
 */

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/** Words of a plain correction: a day, a time of day, a number. */
const CORRECTION =
  /(?:понедельник|вторник|сред[ауые]|четверг|пятниц|суббот|воскресень|сегодня|завтра|послезавтра|вчера|утр|вечер|днем|днём|час|минут|недел|месяц|числ|январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр|\d)/u

/** After the «а»: a question back («Я не против, а вы?», «а что вы хотели?») is no parallel. */
const QUESTION_BACK =
  '(?!(?:вы|ты|вам|вас|вами|как|что|почему|когда|где|сколько|какой|какая|какие|если|кто)(?!\\p{L}))'

const PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /не просто [^.!?\n]{1,90}?,? а (?!то(?:\p{L}|\s|$))/u, kind: 'не просто …, а' },
  { re: /не только [^.!?\n]{1,90}?,? но и /u, kind: 'не только …, но и' },
  { re: /, а не (?:просто|только) /u, kind: '…, а не просто' },
  {
    re: /(?:дело|беда|проблема|суть|вопрос|секрет|смысл|задача) не в [^.!?\n]{1,70}?, а /u,
    kind: 'дело не в …, а',
  },
  {
    re: new RegExp(
      `(?<![\\p{L}])не (?!просто |только )([^.!?\\n,;:]{1,70}), а (?!то(?:\\p{L}|\\s|$))${QUESTION_BACK}`,
      'u',
    ),
    kind: 'не …, а',
  },
]

/**
 * Stock phrases of a chatbot, from the lists of smixs/humanizer-ru and codemistake/human-writing (both MIT), cut to
 * what a short business letter shows and what none of the 35 examples of Boris has: a ritual opening, a chatbot tail,
 * depth that adds no fact, a «summary», a therapy line. Words Boris uses himself («важно понимать», «широкий спектр»,
 * «уникальные») are left out on purpose.
 */
const STAMPS = [
  /давайте (?:разберем|разберемся|погрузимся|рассмотрим)/u,
  /(?:важно|стоит) отметить/u,
  /следует учитывать/u,
  /вот в чем (?:дело|штука)/u,
  /если говорить (?:честно|прямо)|честно говоря|(?:^|[.!?]\s)честно\?/u,
  /(?:хороший|отличный|отличная|интересный) (?:вопрос|идея|мысль)/u,
  /надеюсь,? (?:это|я) (?:поможет|помог)|дайте знать,? если|рад(?:ы|а)? помочь|не стесняйтесь/u,
  /на самом деле вопрос глубже|истинная проблема|в своей основе/u,
  /не поймите (?:меня )?неправильно|я не говорю,? что/u,
  /подводя итог|в заключение/u,
  /(?:^|[.!?]\s)(?:и )?это нормально[.!]|вы не одиноки/u,
]
/** «Без X. Без Y. Только Z.»: chopped drama. */
const CHOPPED = /(?:^|[.!?]\s)без [^.!?]{2,30}[.!?]\s+без [^.!?]{2,30}[.!?]/u

/**
 * An opening frame with a colon (Boris, 11.11.2026, after «Хочу уточнить одну вещь по брендбуку: …» in a ping; his skill
 * «Голос Бориса»: «По опыту:», «Хочу предупредить:» are what gives a model away). A short lead-in at the start of a
 * sentence that only announces what follows, then the colon. A colon inside a living phrase stays: his own «А давайте
 * так: …» and «Возник вопрос: …», «Нужно две вещи: …», «Стоимость: …», a time «16:00».
 */
const SPEAK =
  '(?:уточнить|спросить|предупредить|сказать|отметить|предложить|поделиться|обратить внимание|напомнить|добавить|пояснить|подсказать|подчеркнуть|оговориться|признаться|заметить)'
const SPEAK_NOW =
  '(?:уточню|спрошу|предупрежу|скажу|отмечу|предложу|поделюсь|напомню|добавлю|поясню|подскажу|подчеркну|оговорюсь|признаюсь|замечу)'
const FRAMES = [
  // «Хочу уточнить одну вещь по брендбуку:», «Хотел бы предупредить:», «Должен сказать:».
  `(?:хочу|хотел(?: бы)?|хотелось бы|должен|могу|позвольте|разрешите|давайте я)(?: сразу| заранее| еще| также| честно)? ${SPEAK}(?: [^\\s.!?:;,]+){0,6}`,
  // «Сразу предупрежу:», «Уточню один момент:». His own hedge «честно скажу» is no frame (his skill, 07.11.2026).
  `(?:(?:сразу|заранее|еще|также|коротко|кратко) )?${SPEAK_NOW}(?: [^\\s.!?:;,]+){0,4}`,
  // A lead-in that is a frame all by itself.
  '(?:по (?:моему |нашему )?опыту|из (?:моего |нашего )?опыта|по сути|(?:если )?коротко|кратко|итого|итог|в итоге|вывод|главное|важно|важный момент|суть|мой совет|совет|есть (?:предложение|идея|мысль)|кстати|на практике|для понимания|что важно|обратите внимание|резюмирую)',
]
const FRAME = new RegExp(
  `(?:^|(?<=[.!?…]\\s+)|(?<=\\n\\s*))((?:${FRAMES.join('|')}):)(?=\\s)`,
  'mu',
)

export type NeuroHit = { kind: string; quote: string }

export function neuroSpeech(text: string): NeuroHit | null {
  const chopped = CHOPPED.exec(fold(text))
  const frame = FRAME.exec(fold(text))
  if (frame) return { kind: 'рамка', quote: (frame[1] ?? '').trim() }
  for (const sentence of fold(text).split(/(?<=[.!?\n])/u)) {
    const stamp = STAMPS.map((re) => re.exec(sentence)).find((m) => m !== null)
    if (stamp) return { kind: 'штамп', quote: stamp[0].trim().slice(0, 100) }
    for (const { re, kind } of PATTERNS) {
      const m = re.exec(sentence)
      if (!m) continue
      // «не X, а Y» with a day, a time or a number in X is a plain correction.
      if (kind === 'не …, а' && CORRECTION.test(m[1] ?? '')) continue
      return { kind, quote: m[0].trim().slice(0, 100) }
    }
  }
  return chopped ? { kind: 'штамп', quote: chopped[0].trim().slice(0, 100) } : null
}

/** What a rewrite is told about it. */
export function neuroSpeechReason(hit: NeuroHit): string {
  if (hit.kind === 'рамка')
    return `вводная рамка с двоеточием «${hit.quote}»: так пишет модель, Борис так не начинает. Скажи то же живой фразой, сразу по сути, без рамки и двоеточия`
  if (hit.kind === 'штамп')
    return `фраза «${hit.quote}»: так пишет чат-бот, человек так не говорит. Убери ее и начни с сути`
  return `оборот «${hit.kind}» («${hit.quote}»): так пишет нейросеть, человек так не говорит. Скажи про то, что есть, одной фразой, без противопоставления: не «нужен не подрядчик, а человек», а «нужен человек, который…»`
}
