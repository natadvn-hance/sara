/**
 * A client asking for a call or giving a phone, found by code before any model call (old Sara's callDetector.js,
 * П-48): a Russian number is 8 or +7 then exactly 10 digits, so a budget like 89000000 is not one.
 */
const PHONE = /(?<![\d+])(?:\+7|8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/
const CALL_WORDS = /созвон|позвон|перезвон|набер/i

export function detectCallRequest(text: string): { phone: string | null; keyword: boolean } | null {
  const phone = PHONE.exec(text)?.[0] ?? null
  const keyword = CALL_WORDS.test(text)
  if (!phone && !keyword) return null
  return { phone, keyword }
}

/** A message of ours that proposes a call or a meeting: «Удобно созвониться?», «Давайте обсудим по телефону». */
const CALL_PROPOSAL = /созвон|позвон|звонок|звонить|встреч|по\s+телефону/

/** The words of a bare «yes»; a reply made only of these, with at least one of the core, is an agreement. */
const AGREEING = new Set([
  'да',
  'ага',
  'угу',
  'хорошо',
  'ок',
  'окей',
  'ok',
  'okay',
  'давайте',
  'давай',
  'удобно',
  'согласен',
  'согласна',
  'конечно',
  'отлично',
  'договорились',
  'можно',
  'вполне',
  'пожалуйста',
  'спасибо',
  'созвонимся',
  'созвон',
  'созвониться',
  'звоните',
  'позвоните',
])
const CORE_AGREEMENT = new Set([
  'да',
  'ага',
  'угу',
  'хорошо',
  'ок',
  'окей',
  'ok',
  'okay',
  'давайте',
  'давай',
  'удобно',
  'согласен',
  'согласна',
  'конечно',
  'договорились',
])
const MAX_AGREEMENT_WORDS = 6

const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .match(/[\p{L}\p{N}]+/gu) ?? []

/**
 * «Да», «хорошо», «давайте», «ок», «удобно» right after our message that proposed a call: the client agrees to the
 * call, which is a call request even though the words have no call word in them. The model is told the same
 * (roles/interlocutor/role.md); the code does not wait for it, as with a phone. A longer answer («Да, но сначала
 * цена») is the Interlocutor's to read.
 */
export function agreesToCallProposal(clientTurn: string, ourLast: string | null): boolean {
  if (!ourLast || !CALL_PROPOSAL.test(ourLast.toLowerCase().replace(/ё/g, 'е'))) return false
  const words = wordsOf(clientTurn)
  return (
    words.length > 0 &&
    words.length <= MAX_AGREEMENT_WORDS &&
    words.every((w) => AGREEING.has(w)) &&
    words.some((w) => CORE_AGREEMENT.has(w))
  )
}
