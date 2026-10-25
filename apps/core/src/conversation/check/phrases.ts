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
  // Boris calling is Boris's to say, not hers: «Борис вам позвонит», «Борис перезвонит вам сегодня».
  /(?<!\p{L})(?:позвонит|перезвонит|наберет|позвонят|перезвонят|наберут|звякнет)(?!\p{L})/u,
  // «Свяжусь по телефону», «с вами свяжется Борис по телефону», «по телефону с вами свяжется Борис».
  /(?<!\p{L})свяж(?:усь|емся|ется|утся)[^.!?\n]{0,40}по\s+телефон/u,
  /(?<!\p{L})по\s+телефону[^.!?\n]{0,40}свяж(?:усь|емся|ется|утся)/u,
  /(?<!\p{L})(?:могу|можем|мог|могла)\s+(?:бы\s+)?(?:вам\s+|вас\s+)?(?:позвонить|перезвонить|набрать|звякнуть)(?!\p{L})/u,
  // «Готова позвонить в любое время».
  /(?<!\p{L})готов(?:а|ы)?\s+(?:бы\s+)?(?:вам\s+|вас\s+)?(?:позвонить|перезвонить|набрать|звякнуть)(?!\p{L})/u,
  // «Сделаю звонок», «назначу встречу».
  /(?<!\p{L})(?:сделаю|организую|устрою|назначу|запланирую|проведу)\s+(?:вам\s+)?(?:звонок|созвон|встреч)/u,
]

/** A word of a call or a meeting in a sentence: with a time or a day in it, the sentence names the call's time. «Звонки» are not a call. */
export const CALL_WORD = /созвон|звон(?!к)|набер|набр|встре[чт]/u

/** A day or a part of the day: with a call word in the sentence, Sara is choosing when the call is. */
export const CALL_DAY =
  /(?<!\p{L})(?:завтра|сегодня|послезавтра|после\s+обеда|до\s+обеда|в\s+обед|утром|вечером|днем|на\s+этой\s+неделе|на\s+следующей\s+неделе|на\s+выходных|в\s+выходные|в\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье))(?!\p{L})/u

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
