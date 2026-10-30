import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RoleMeta } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { buildConverseArgs } from '../../src/gateway/claudeCli'
import { createRedactor, restore } from '../../src/gateway/redact'
import { looksLikeRequest } from '../../src/learning/inbox'
import type { QuestionRow } from '../../src/learning/questions'
import { answerParts, turnInput } from '../../src/secretary/secretary'
import { SECRETARY_TOOLS } from '../../src/secretary/tools'
import { ROOT } from '../helpers/app'

const DASH = String.fromCharCode(0x2014)
const at = new Date('2026-10-28T12:40:00Z')

describe('the Secretary, its parts', () => {
  it('FR-NOTIF-4: the turn runs on Opus at medium effort with no built-in tool, only the tools of Sara', async () => {
    const meta = RoleMeta.parse(
      JSON.parse(await readFile(join(ROOT, 'roles/secretary/meta.json'), 'utf8')),
    )
    expect(meta).toMatchObject({ model: 'opus', effort: 'medium', priority: 'P0' })
    const args = buildConverseArgs(
      meta,
      '/r/role.md',
      { configPath: '/d/mcp.json', server: 'sara', tools: ['leads', 'offer_bid'] },
      3,
    )
    const after = (flag: string) => args[args.indexOf(flag) + 1]
    expect(after('--model')).toBe('opus')
    expect(after('--effort')).toBe('medium')
    expect(after('--tools')).toBe('')
    expect(after('--mcp-config')).toBe('/d/mcp.json')
    expect(
      args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--setting-sources')),
    ).toEqual(['mcp__sara__leads', 'mcp__sara__offer_bid'])
    expect(after('--permission-mode')).toBe('dontAsk')
    expect(after('--max-budget-usd')).toBe('3')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--json-schema')
  })

  it('FR-NOTIF-4: no tool spends money or writes to a client by itself: those only send Boris the button', () => {
    // A new tool is a decision (ADR-027): one that spends or sends must go through Boris's press, and this list
    // changes with it.
    expect(Object.keys(SECRETARY_TOOLS).sort()).toEqual(
      [
        'today',
        'leads',
        'lead',
        'conversations',
        'conversation',
        'settings',
        'health',
        'analytics',
        'set_setting',
        'skip_lead',
        'offer_bid',
        'set_bid_text',
        'client_action',
        'offer_client_text',
        'offer_draft',
        'answer_question',
      ].sort(),
    )
  })

  it('FR-NOTIF-4: words that ask for something are told from a reason, and a bid text stays a bid text', () => {
    const why = { bidText: false }
    const bid = { bidText: true }
    for (const t of [
      'откликнись на 95147898',
      'Покажи очередь',
      'Сара, глянь заявки',
      'поставь на паузу',
    ]) {
      expect(looksLikeRequest(t, why), t).toBe(true)
      expect(looksLikeRequest(t, bid), t).toBe(true)
    }
    for (const t of [
      'Что в очереди',
      'почему не откликнулась?',
      'скок на балансе',
      'а это дорого?',
    ])
      expect(looksLikeRequest(t, why), t).toBe(true)
    for (const t of [
      'Понимаю вашу задачу. Когда нужен запуск?',
      'Как быстро нужен сайт?',
      'Посмотрим сайт вместе',
    ])
      expect(looksLikeRequest(t, bid), t).toBe(false)
    for (const t of ['дорого', 'не наш профиль', 'что-то не то с бюджетом', 'Давайте позже'])
      expect(looksLikeRequest(t, why), t).toBe(false)
  })

  it('FR-NOTIF-4: the answer reaches Telegram as plain text without a long dash, in parts that fit', () => {
    expect(answerParts(`**Очередь** ${DASH} две заявки\n## Итог\nвсё`)).toEqual([
      'Очередь - две заявки\nИтог\nвсё',
    ])
    const long = Array.from({ length: 300 }, (_, i) => `строка номер ${i} про заявки`).join('\n')
    const parts = answerParts(long)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4000)
    expect(parts.join('\n')).toBe(long)
  })

  it('FR-NOTIF-4: a turn reads the chat so far, the open question and the new words', () => {
    const q = {
      id: '0199a000-0000-7000-8000-000000000001',
      kind: 'why_skip',
      entityId: '95147898',
      telegramMessageId: 5,
      askedAt: '2026-10-28T12:30:00.000Z',
      answeredAt: null,
      answer: null,
    } satisfies QuestionRow
    const input = turnInput({
      now: at,
      memory: [
        { author: 'boris', text: 'что в очереди', at: '2026-10-28T12:00:00.000Z' },
        { author: 'sara', text: 'Две заявки', at: '2026-10-28T12:01:00.000Z' },
      ],
      said: [
        {
          text: 'откликнись на 95147898',
          voice: false,
          at,
          replyToText: null,
          questions: [q],
        },
      ],
      titles: new Map([[q.id, 'Маркетолог для кофейни']]),
    })
    expect(input).toContain('## Сейчас\n28 октября 2026 г. в 15:40 по Москве')
    expect(input).toContain('[Борис, 28.10, 15:00] что в очереди\n[Сара, 28.10, 15:01] Две заявки')
    expect(input).toContain(
      `questionId ${q.id}: почему он пропустил заявку («Маркетолог для кофейни»), спросила в 15:30`,
    )
    expect(input).toMatch(/## Новое сообщение Бориса\nоткликнись на 95147898$/)
  })

  it('FR-NOTIF-4: one hiding spans the whole turn: a client keeps one tag in every text, and the answer gets him back', () => {
    const r = createRedactor(['Ирина Петрова'])
    const first = r.hide('Ирина спросила про сайт, тел. +7 916 123-45-67')
    const second = r.hide(
      '{"clientName":"Ирина Петрова","note":"Ирине перезвонить +7 916 123-45-67"}',
    )
    expect(first).toBe('[имя 1] спросила про сайт, тел. [телефон 1]')
    expect(second).toContain('"clientName":"[имя 2]"')
    expect(second).toContain('[имя 3] перезвонить [телефон 1]')
    expect(restore('Напомню [имя 3], номер [телефон 1]', r.tags)).toBe(
      'Напомню Ирине, номер +7 916 123-45-67',
    )
  })
})
