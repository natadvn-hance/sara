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

/** Advert words that kill a case told in a living chat (case.ad); the cases requirement, section 4. */
export const CASE_AD_PHRASES = [
  'Взгляните на наш кейс',
  'Взгляните на наши кейсы',
  'Посмотрите наш кейс',
  'Посмотрите наши кейсы',
  'Ознакомьтесь с нашим кейсом',
  'Ознакомьтесь с нашими кейсами',
  'Посмотрите наше портфолио',
  'Взгляните на наше портфолио',
  'Ознакомьтесь с нашим портфолио',
  'У нас богатый опыт',
  'У нас огромный опыт',
  'Наш богатый опыт',
  'Наши кейсы говорят сами за себя',
  'Успешные кейсы',
  'Успешно реализованные проекты',
]

/**
 * Past verbs of project work, folded: the stems that take «л», «ла», «ло», «ли» («сделал», «делали»), and the verbs with
 * a root of their own («вели», «помогли», «пришли»). `PAST_ANY` is every gender and number, `PAST_PLURAL` the plural
 * only: a bare plural («Сделали похожее для клиники») is a team speaking of its work, a bare «сделал» is some man.
 */
const PAST_STEMS = [
  'сдела',
  'дела',
  'запусти',
  'запуска',
  'настро[иь]',
  'настраива',
  'постро[иь]',
  'строи',
  'собра',
  'созда',
  'создава',
  'разработа',
  'разрабатыва',
  'внедри',
  'подключи',
  'реализова',
  'работа',
  'занима',
  'начина',
  'продвига',
  'подня',
  'выстро[иь]',
  'оптимизирова',
  'масштабирова',
  'увеличи',
  'снизи',
  'сократи',
  'раскрути',
].join('|')
const PAST_ROOTS = 'вел|вывел|провел|перевел|довел|привел'
const AFTER = '(?!\\p{L})'
const PAST_ANY = `(?:(?:${PAST_STEMS})(?:л|ла|ло|ли)(?:сь|ся)?|(?:${PAST_ROOTS})(?:а|о|и)?|помог(?:ла|ло|ли)?|пришел|пришла|пришло|пришли|вырос(?:ла|ло|ли)?)${AFTER}`
const PAST_PLURAL = `(?:(?:${PAST_STEMS})ли(?:сь)?|(?:${PAST_ROOTS})и|помогли|пришли|выросли)${AFTER}`
/** Words before a bare verb at the start of a sentence: «Недавно помогли», «Раньше тоже делали». */
const TIME_WORD =
  '(?:недавно|раньше|ранее|уже|еще|тоже|также|потом|затем|как-то|однажды|давно|весной|летом|осенью|зимой|в\\s+прошлом\\s+году|в\\s+этом\\s+году|не\\s+так\\s+давно)'
const LEAD = '(?:(?:и|а|но|да|ну|вот|кстати|тогда)\\s+)?'
/** What a client of ours is called when a story starts with «был у нас». */
const OUR_NOUN =
  '(?:проект|клиент|заказчик|кейс|случа|опыт|истори|клиник|студи|магазин|салон|школ|ресторан|кафе|агентств|сет[иь]|производств|автосервис|стоматолог|фирм|бизнес|компани|организаци|заказ|сайт|лендинг)\\p{L}*'
const BE = '(?:был|была|было|были)'

/**
 * Where a reply starts a story of a project of ours (case.unknown when no case of this turn stands behind it). Each
 * pattern is read on one statement of the folded reply, never on a question to the client or on a negated clause.
 * «did»: our team's past work in its own words («мы делали», «Сделали похожее для клиники», «Недавно помогли
 * автосервису»). «intro»: another client or project brought in («один клиент из Краснодара», «была у нас клиника»,
 * «у клиента с похожим бюджетом», «наш клиент начинал»). Present work talk («делаем лендинги») and a remark about
 * clients in general («для большинства наших клиентов первый шаг это аудит») match neither.
 */
export const CASE_CLAIM_DID: RegExp[] = [
  // «Мы делали», «мы тоже запускали», «мы с Борисом вели».
  new RegExp(`(?<!\\p{L})мы(?:\\s+\\p{L}+){0,2}?\\s+${PAST_PLURAL}`, 'u'),
  // A bare plural at the start of a statement.
  new RegExp(`^\\s*${LEAD}(?:${TIME_WORD}\\s+){0,2}${PAST_PLURAL}`, 'u'),
]
export const CASE_CLAIM_INTRO: RegExp[] = [
  // «Один клиент из Краснодара», «один из наших клиентов», «одна из наших заказчиц».
  /(?<!\p{L})(?:один|одна|одно)\s+(?:из\s+)?(?:наш\p{L}*\s+)?(?:клиент\p{L}*|заказчик\p{L}*)/u,
  // «У одного из наших клиентов», «у другого клиента», «у нашего клиента».
  /(?<!\p{L})у\s+(?:одного|другого|нашего|нашей|похожего|такого)\s+(?:из\s+)?(?:наш\p{L}*\s+)?(?:клиент\p{L}*|заказчик\p{L}*)/u,
  // «У клиента с похожим бюджетом», «клиент из такой же ниши».
  /(?<!\p{L})клиент\p{L}*\s+(?:с|из|в)\s+(?:похож|такой|такого|подобн)\p{L}*/u,
  // «У нас был похожий проект», «Была у нас клиника».
  new RegExp(
    `(?<!\\p{L})у\\s+нас\\s+(?:\\p{L}+\\s+){0,2}?${BE}\\s+(?:\\p{L}+\\s+){0,2}?${OUR_NOUN}`,
    'u',
  ),
  new RegExp(`(?<!\\p{L})${BE}\\s+у\\s+нас\\s+(?:\\p{L}+\\s+){0,2}?${OUR_NOUN}`, 'u'),
  // «Похожий проект», «похожая история» as something that happened.
  new RegExp(
    `(?<!\\p{L})похож\\p{L}+\\s+(?:проект\\p{L}*|истори\\p{L}+|случай)(?:\\s+\\p{L}+){0,3}\\s+${BE}`,
    'u',
  ),
  // «Для трёх клиентов», «у нескольких клиник».
  /(?<!\p{L})(?:для|у)\s+(?:трех|двух|четырех|пяти|нескольких)\s+(?:\p{L}+\s+)?(?:клиент\p{L}*|компани\p{L}+|студи\p{L}+|клиник\p{L}+)/u,
]
/** «Наш клиент начинал»: our client and a past verb in one statement is a story, our client alone is a remark. */
export const CASE_OUR_CLIENT = /(?<!\p{L})наш(?:а|им|его|ему|их|ими|и)?\s+клиент\p{L}*/u
export const CASE_PAST_ANY = new RegExp(`(?<!\\p{L})${PAST_ANY}`, 'u')
/** Words of a sentence that brings in another story, not the next sentence of the chosen case: «ещё делали», «для трёх». */
export const CASE_NEW_STORY =
  /(?<!\p{L})(?:еще|также|друг(?:ой|ому|им|ие|их|ая|ую)|тр[её]х|двух|четыр[её]х|пяти|нескольк\p{L}+)(?!\p{L})/u
/** A negation within a few words before a claim: «не делали», «у нас не было», «никогда не запускали». */
export const CASE_NEGATION = /(?<!\p{L})(?:не|нет|ни|никогда)(?!\p{L})/u

/** A link or a bare domain written in a reply (case.link): the model writes none, the code adds a case's link. */
export const CASE_LINK =
  /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\d@.])[\p{L}\d][\p{L}\d-]*(?:\.[\p{L}\d-]+)*\.(?:ru|рф|com|net|org|io|app|su|pro|dev|me|co|site|online|biz|info)(?![\p{L}\d])/iu

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

/**
 * Words that open a message before a comma and are not a name (folded): a greeting or an opener like «Понимаю,
 * добрый день у вас был» is no «name, greeting». Shared by the greeting check and by the dossier's name guess.
 */
export const NOT_NAMES = new Set([
  'здравствуйте',
  'здравствуй',
  'привет',
  'приветствую',
  'добрый',
  'доброе',
  'доброго',
  'добрая',
  'доброй',
  'спасибо',
  'благодарю',
  'хорошо',
  'отлично',
  'конечно',
  'да',
  'нет',
  'итак',
  'извините',
  'простите',
  'понимаю',
  'понял',
  'поняла',
  'ясно',
  'понятно',
  'видимо',
  'кстати',
  'ладно',
  'тогда',
  'сейчас',
  'смотрите',
  'скажите',
  'подскажите',
  'вижу',
  'согласна',
  'согласен',
  'договорились',
  'отвечу',
  'напишу',
  'уточню',
  'сделаем',
  'посмотрим',
  'обсудим',
  'давайте',
  'верно',
  'точно',
  'безусловно',
  'разумеется',
  'жаль',
  'пожалуйста',
  'еще',
])
