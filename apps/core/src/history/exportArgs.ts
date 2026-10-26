const FLAGS = { '--v1': 'v1', '--telegram': 'telegram', '--account': 'account' } as const

export type ExportArgs = { v1: string | null; telegram: string | null; account: string | null }

/**
 * The arguments of `history:export`. A mistake is an error, never a quiet run without the snapshot: a flag without
 * its value, a value glued with «=», or an unknown flag.
 */
export function parseExportArgs(argv: string[]): ExportArgs {
  const out: ExportArgs = { v1: null, telegram: null, account: null }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? ''
    const key = FLAGS[flag as keyof typeof FLAGS]
    if (!key)
      throw new Error(
        `Не знаю аргумент ${flag}. Можно: --v1 <снимок>, --telegram <result.json>, --account <аккаунт>.`,
      )
    const value = argv[i + 1]
    if (value === undefined || value.trim() === '' || value.startsWith('--'))
      throw new Error(`После ${flag} нужно значение.`)
    out[key] = value
    i++
  }
  return out
}
