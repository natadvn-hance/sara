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
