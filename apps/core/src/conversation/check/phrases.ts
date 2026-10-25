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

/** Words for a program that talks: a bot, a neural network, an assistant (folded text, word endings kept narrow). */
const END = '(?!\\p{L})'
const PROGRAM_NOUN = [
  `чат-?бот\\p{L}*`,
  `бот(?:а|у|ом|е|ы|ов|ам|ами|ах)?${END}`,
  `робот(?:а|у|ом|е|ы|ов|ам|ами|ах)?${END}`,
  `нейросет\\p{L}*`,
  `нейронн\\p{L}*\\s+сет\\p{L}*`,
  `искусственн\\p{L}*\\s+интеллект\\p{L}*`,
  `ии${END}`,
  `ai${END}`,
  `llm${END}`,
  `языков\\p{L}*\\s+модел\\p{L}*`,
  `программ(?:а|ой|ы|у|е)?${END}`,
  `алгоритм\\p{L}*`,
  `клод${END}`,
  `claude${END}`,
  `chat-?gpt${END}`,
  `gpt${END}`,
  `openai${END}`,
  `anthropic${END}`,
].join('|')
/** A helper in the house sense: «я ассистент» tells what she is, «мы помощники в продвижении» does not. */
const HELPER_NOUN = '(?:ассистент|помощник)\\p{L}*'
/** Words between «я» and the noun: «я просто виртуальный ассистент», «я не бот». */
const FILLER = '(?:(?:не|тоже|просто|всего|лишь|как|вообще|же|пока|ваш|ваша|такой|такая)\\s+){0,2}'
const KIND =
  '(?:(?:виртуальн|цифров|автоматическ|умн|компьютерн|искусственн|голосов|программн|ии|ai)\\p{L}*[\\s-]+){0,2}'
const WHO = '(?:вам\\s+)?'

/**
 * Sara speaking of herself as a program (robotic.ai): it needs her own voice, «я», «мы», «это пишет», so a
 * sentence about a chatbot Hance builds or about tools it uses is not one.
 */
export const AI_SELF_PATTERNS = [
  // «Я бот», «Я не бот», «Я виртуальный ассистент», «Я Claude», «Мы бот агентства».
  new RegExp(`(?<!\\p{L})я\\s+${FILLER}${KIND}(?:${PROGRAM_NOUN}|${HELPER_NOUN})`, 'u'),
  new RegExp(`(?<!\\p{L})мы\\s+${FILLER}${KIND}(?:${PROGRAM_NOUN})`, 'u'),
  // «Как ИИ, я не могу», but not «как алгоритм подбирает показы».
  /(?<!\p{L})как\s+(?:ии|ai|llm|искусственн\p{L}*\s+интеллект\p{L}*|языков\p{L}*\s+модел\p{L}*)(?!\p{L})/u,
  // «Это пишет искусственный интеллект», «Вам отвечает бот», «Ответила нейросеть».
  new RegExp(
    `(?<!\\p{L})(?:пишет|пишут|отвечает|отвечают|ответил[аи]?|написал[аи]?|говорит|общается)\\s+${WHO}${KIND}(?:${PROGRAM_NOUN})`,
    'u',
  ),
  // «Я не человек», «я не живой».
  /(?<!\p{L})я\s+не\s+(?:человек|живой|живая|настоящ\p{L}*|реальн\p{L}*)(?!\p{L})/u,
  // «Это автоматический ответ», «автоответчик».
  /(?<!\p{L})(?:это|данн\p{L}*|наш\p{L}*|мо[её]|такой)\s+(?:автоматическ\p{L}*\s+(?:ответ|сообщени|реплик)\p{L}*|автоответ\p{L}*)/u,
]

/**
 * The name of a model or its maker (robotic.ai): Sara says it only about herself, so it fails unless the client
 * wrote the same word in this turn («нужна интеграция с ChatGPT»).
 */
export const AI_NAME = /(?<!\p{L})(?:claude|chat-?gpt|gpt|openai|anthropic)(?!\p{L})/u

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
