/**
 * The turn of phrase of a neural net that Boris will not have in a bid or a letter to a client (Boris, 01.11.2026:
 * «нужен не подрядчик на разовые задачи, а человек; не просто провести встречи, а понять; главная беда не в
 * качестве работы, а в том. Нейро-речь мне не нравится, человек так не пишет»): the negative parallel «не X, а Y» and
 * its kin. None of the 35 speech examples of Boris has one. A pure function over the text; the first hit is returned.
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

export type NeuroHit = { kind: string; quote: string }

export function neuroSpeech(text: string): NeuroHit | null {
  for (const sentence of fold(text).split(/(?<=[.!?\n])/u)) {
    for (const { re, kind } of PATTERNS) {
      const m = re.exec(sentence)
      if (!m) continue
      // «не X, а Y» with a day, a time or a number in X is a plain correction.
      if (kind === 'не …, а' && CORRECTION.test(m[1] ?? '')) continue
      return { kind, quote: m[0].trim().slice(0, 100) }
    }
  }
  return null
}

/** What a rewrite is told about it. */
export function neuroSpeechReason(hit: NeuroHit): string {
  return `оборот «${hit.kind}» («${hit.quote}»): так пишет нейросеть, человек так не говорит. Скажи про то, что есть, одной фразой, без противопоставления: не «нужен не подрядчик, а человек», а «нужен человек, который…»`
}
