/**
 * Built-in lists of the code checks (M4 design 5.6). Every pattern is written for folded text: lower case, ё as е.
 */

/** Phrases that read as a bot or a call centre (robotic.phrase); the portrait's «Никогда не говорит» adds to them. */
export const ROBOTIC_PHRASES = [
  'Отличный вопрос',
  'Рад помочь',
  'Рада помочь',
  'Рады помочь',
  'Всегда рады помочь',
  'С радостью помогу',
  'Не стесняйтесь',
  'Обращайтесь',
  'С уважением',
  'Надеюсь, это поможет',
  'Благодарю за обращение',
  'Спасибо за обращение',
  'Спасибо за ваш вопрос',
  'Буду рад',
  'Буду рада',
  'Чем могу помочь',
  'Чем могу быть полезен',
  'Чем могу быть полезна',
  'Всегда к вашим услугам',
]

/** Sara speaking of herself as a program (robotic.ai). */
export const AI_PATTERNS = [
  /(?<!\p{L})я\s+(?:не\s+)?(?:бот|робот|программа|ии)(?!\p{L})/u,
  /(?<!\p{L})как\s+ии(?!\p{L})/u,
  /искусственн\p{L}*\s+интеллект\p{L}*/u,
  /нейросет\p{L}*/u,
  /языков\p{L}*\s+модел\p{L}*/u,
  /(?<!\p{L})чат-?бот\p{L}*/u,
]

/** Sara promising a call of her own (promise.call): only Boris calls, and she cannot say when he will. */
export const CALL_PROMISE_PATTERNS = [
  /(?<!\p{L})(?:позвоню|перезвоню|наберу|звякну|созвонюсь|позвоним|перезвоним|наберем|звякнем)(?!\p{L})/u,
  /(?<!\p{L})свяж(?:усь|емся)[^.!?\n]{0,30}по\s+телефону/u,
  /(?<!\p{L})(?:могу|можем|мог|могла)\s+(?:бы\s+)?(?:вам\s+|вас\s+)?(?:позвонить|перезвонить|набрать|звякнуть)(?!\p{L})/u,
]

/** A word of a call in a sentence: with a time in it, the sentence names a call time. */
export const CALL_WORD = /созвон|звон|набер|набр/u

/** Greetings a reply may start with (greeting.missing, greeting.extra). */
export const GREETINGS = [
  'здравствуйте',
  'здравствуй',
  'добрый\\s+день',
  'добрый\\s+вечер',
  'доброе\\s+утро',
  'доброго\\s+(?:дня|утра|вечера|времени\\s+суток)',
  'доброй\\s+ночи',
  'приветствую',
  'привет',
]
