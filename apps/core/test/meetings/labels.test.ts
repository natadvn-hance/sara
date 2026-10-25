import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cityOffset,
  joinOptions,
  slotLabel,
  zoneNote,
  zoneNoteList,
} from '../../src/meetings/labels'

// Sunday 25.10.2026 10:00 Moscow.
const now = new Date('2026-10-25T07:00:00.000Z')

describe('meeting labels', () => {
  it('FR-MEET-2: labels say today and tomorrow, then the weekday and the date', () => {
    expect(slotLabel('2026-10-25T14:00:00.000Z', now)).toBe('сегодня в 17:00')
    expect(slotLabel('2026-10-26T08:00:00.000Z', now)).toBe('завтра в 11:00')
    expect(slotLabel('2026-10-27T12:30:00.000Z', now)).toBe('во вторник, 27 октября, в 15:30')
    expect(slotLabel('2026-10-29T12:00:00.000Z', now)).toBe('в четверг, 29 октября, в 15:00')
    expect(slotLabel('2026-11-02T07:00:00.000Z', now)).toBe('в понедельник, 2 ноября, в 10:00')
  })

  it('FR-MEET-2: a label just after midnight Moscow belongs to the next day', () => {
    // 21:30 UTC on the 25th is 00:30 Moscow on the 26th.
    expect(slotLabel('2026-10-25T21:30:00.000Z', now)).toBe('завтра в 00:30')
  })

  it('FR-MEET-2: Novosibirsk gets "по Москве, у вас 19:00" for 15:00', () => {
    expect(cityOffset('Новосибирск')).toBe(7)
    expect(cityOffset('  краснодар ')).toBe(3)
    expect(cityOffset('Атлантида')).toBeNull()
    expect(cityOffset(null)).toBeNull()
    expect(zoneNote('2026-10-29T12:00:00.000Z', 'Новосибирск')).toBe('по Москве, у вас 19:00')
    expect(zoneNote('2026-10-29T12:00:00.000Z', 'Краснодар')).toBe('время московское')
    expect(zoneNote('2026-10-29T12:00:00.000Z', null)).toBe('время московское')
    expect(zoneNote('2026-10-29T12:00:00.000Z', 'Калининград')).toBe('по Москве, у вас 14:00')
    expect(zoneNoteList('Новосибирск')).toBe('время московское, у вас на 4 часа больше')
    expect(zoneNoteList('Калининград')).toBe('время московское, у вас на 1 час меньше')
    expect(zoneNoteList('Москва')).toBe('время московское')
  })

  it('FR-MEET-2: options read "a, b или c"', () => {
    expect(joinOptions(['а'])).toBe('а')
    expect(joinOptions(['а', 'б'])).toBe('а или б')
    expect(joinOptions(['а', 'б', 'в'])).toBe('а, б или в')
  })

  it('FR-MEET-1: labels and windows do not depend on the host time zone', () => {
    const code = `
      import { slotLabel } from './src/meetings/labels.ts'
      import { freeSlots } from './src/meetings/slots.ts'
      import { DEFAULT_AVAILABILITY } from '@sara/shared'
      const now = new Date('2026-10-25T07:00:00.000Z')
      console.log(JSON.stringify({
        label: slotLabel('2026-10-27T12:30:00.000Z', now),
        first: freeSlots(DEFAULT_AVAILABILITY, [], {}, now)[0],
      }))`
    const root = join(__dirname, '../../../..')
    for (const tz of ['Asia/Vladivostok', 'America/New_York']) {
      const out = execFileSync('pnpm', ['exec', 'tsx', '--eval', code], {
        cwd: join(root, 'apps/core'),
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      })
      expect(JSON.parse(out.trim().split('\n').at(-1) as string)).toEqual({
        label: 'во вторник, 27 октября, в 15:30',
        // Monday 26.10 10:00 Moscow: Saturday and Sunday are off.
        first: '2026-10-26T07:00:00.000Z',
      })
    }
  })

  it('FR-MEET-1: the meetings code never uses the host time zone', () => {
    const dir = join(__dirname, '../../src/meetings')
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk(dir)
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/\.(getHours|setHours|getDay|getDate|setDate|getMonth|setMonth)\(/)
      for (const m of src.matchAll(/toLocale\w*\(([^)]*)\)/g)) expect(m[1], f).toMatch(/timeZone/)
    }
  })
})
