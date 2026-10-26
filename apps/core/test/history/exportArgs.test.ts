import { describe, expect, it } from 'vitest'
import { parseExportArgs } from '../../src/history/exportArgs'

describe('history:export arguments', () => {
  it('FR-TRAIN-1: the known flags take their values', () => {
    expect(
      parseExportArgs(['--v1', 'a.db', '--telegram', 'r.json', '--account', 'hance-marketing']),
    ).toEqual({
      v1: 'a.db',
      telegram: 'r.json',
      account: 'hance-marketing',
    })
    expect(parseExportArgs([])).toEqual({ v1: null, telegram: null, account: null })
  })

  it('FR-TRAIN-1: a flag without its value, a value glued with =, or an unknown flag is an error', () => {
    expect(() => parseExportArgs(['--v1'])).toThrow(/--v1/)
    expect(() => parseExportArgs(['--v1', '--account', 'x'])).toThrow(/--v1/)
    expect(() => parseExportArgs(['--v1=a.db'])).toThrow(/--v1=a.db/)
    expect(() => parseExportArgs(['--snapshot', 'a.db'])).toThrow(/--snapshot/)
    expect(() => parseExportArgs(['--account', ''])).toThrow(/--account/)
  })
})
