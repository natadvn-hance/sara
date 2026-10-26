/**
 * What a client's last words say about reminders (FR-CONV-12): a refusal ends the ladder, «я подумаю» gives the client
 * more time. The model proposes, the code decides: these are plain patterns over the client's own messages, nothing
 * is asked of a model. A word that is no clear sign is no sign: an ordinary «спасибо» is neither.
 */

/** Lower case with ё as е. */
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/** The end of a clause: a client's «не нужно» counts as a refusal only when it ends there. */
const CLAUSE_END = '(?=\\s*(?:[,.!?;:]|$|спасибо|уже|больше|нам|мне))'

const REFUSAL: RegExp[] = [
  // «выбрали другого / другую студию», «выбрали не вас»
  /(?<!\p{L})выбра(?:ли|л|ла)\s+(?:друг\p{L}+|иного|не\s+вас)/u,
  // «нашли исполнителя / подрядчика / другого», «уже нашли»
  /(?<!\p{L})наш(?:ли|ел|ла)\s+(?:уже\s+)?(?:исполнител|подрядчик|специалист|друг|агентств|студи|мастер|команд|компани)\p{L}*/u,
  /(?<!\p{L})уже\s+наш(?:ли|ел|ла)(?!\p{L})/u,
  // «уже не актуально», «не актуален», «неактуально», but not «пока не актуально» (later)
  /(?<!пока\s+)(?<!\p{L})не\s*актуал[ье]н\p{L}*/u,
  // «не нужно», «не надо», «не нужна» at the end of a clause
  new RegExp(`(?<!\\p{L})не\\s+(?:нужн\\p{L}*|надо|понадоби\\p{L}*)${CLAUSE_END}`, 'u'),
  /(?<!\p{L})нет,?\s*спасибо/u,
  /(?<!\p{L})передума\p{L}*/u,
  /(?<!\p{L})отказ(?:ываюсь|ываемся|ываем|алась|ались|ался|алс[яь])/u,
  // «не заинтересованы», «не интересно», «не интересует», «не будем продолжать»
  /(?<!\p{L})не\s*(?:заинтересован\p{L}*|интересн\p{L}*|интересу\p{L}+)/u,
  /(?<!\p{L})не\s+будем\s+(?:больше|продолжать|работать|заказывать|делать|обращаться)/u,
  // «закрыл заказ», «отменили заказ», «сняли задачу»
  /(?<!\p{L})(?:закры|отмени|сня)(?:л|ли|ла)\s+(?:наш\s+)?(?:заказ|задач|запрос)/u,
  // «заказали у другого», «обратились к другим», «взяли другого»
  /(?<!\p{L})заказа(?:ли|л|ла)\s+(?:уже\s+)?(?:у|в)\s+друг/u,
  /(?<!\p{L})обратил\p{L}*\s+(?:уже\s+)?(?:к|в)\s+друг/u,
  /(?<!\p{L})взя(?:ли|л|ла)\s+друг\p{L}+/u,
]

/** The client gave a clear no: the ladder does not start, or ends. */
export function isRefusal(text: string): boolean {
  const t = fold(text)
  return t.trim() !== '' && REFUSAL.some((re) => re.test(t))
}

/** Whom a client says he will talk to before he answers: not us, not Boris. */
const WITH_WHOM =
  'с\\s+(?:коллег|партн[её]р|муж|жен|руковод|директор|команд|начальств|бухгалтер|семь|своими|нашими|отдел|юрист|учредител|собственник)\\p{L}*|внутри|между\\s+собой'

const THINKING: RegExp[] = [
  // «подумаю», «подумаем», «надо подумать»
  /(?<!\p{L})подума(?:ю|ем|ть|ет)(?!\p{L})/u,
  /(?<!\p{L})обдума(?:ть|ю|ем)(?!\p{L})/u,
  /(?<!\p{L})взвеш(?:у|им)(?!\p{L})/u,
  /(?<!\p{L})посовет(?:уюсь|уемся)(?!\p{L})/u,
  // «обсудим с коллегами», «обсужу внутри команды», not «обсудим с вами»
  new RegExp(`(?<!\\p{L})обсу(?:дим|жу|дить)\\s+(?:это\\s+|всё\\s+)?(?:${WITH_WHOM})`, 'u'),
  // «вернусь к вам», «вернёмся к вам»
  /(?<!\p{L})верн\p{L}*\s+к\s+вам/u,
  /(?<!\p{L})дам\s+знать(?!\p{L})/u,
  /(?<!\p{L})(?:напишу|сообщу|отпишусь)\s+(?:вам\s+)?(?:позже|позднее|потом|сам|сама|как\s+решу)/u,
]

/** The client went to think it over: the first reminder waits longer. */
export function isThinking(text: string): boolean {
  const t = fold(text)
  return t.trim() !== '' && THINKING.some((re) => re.test(t))
}

/**
 * The client's messages right before our message `anchorId`: the turn our message answered, joined by line breaks.
 * Messages of the platform are passed over; the first message of anyone else ends the turn. Empty when our message
 * is not found or follows another message of ours (a bid, a second message), then there is nothing to read.
 */
export function clientTurnBefore(
  messages: { id: string; side: string; text: string }[],
  anchorId: string,
): string {
  const at = messages.findIndex((m) => m.id === anchorId)
  const turn: string[] = []
  for (let k = at - 1; at >= 0 && k >= 0; k--) {
    const m = messages[k]
    if (!m || m.side === 'system') continue
    if (m.side !== 'client') break
    turn.unshift(m.text)
  }
  return turn.join('\n')
}
