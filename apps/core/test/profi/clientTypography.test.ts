import { describe, expect, it } from 'vitest'
import { clientTypography } from '../../src/profi/client'

describe('what reaches a client', () => {
  it('FR-CONV-15: no «ё» and no quotes in «ёлочки», plain quotes instead (Boris, 31.10 and 07.11.2026)', () => {
    expect(clientTypography('Ещё раз: вы писали «нужно к пятнице», всё верно?')).toBe(
      'Еще раз: вы писали "нужно к пятнице", все верно?',
    )
    expect(clientTypography('Ёлки')).toBe('Елки')
    expect(clientTypography('Без кавычек и без ё')).toBe('Без кавычек и без е')
  })
})
