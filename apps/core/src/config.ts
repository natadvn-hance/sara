import { resolve } from 'node:path'

export type Config = {
  databaseUrl: string
  dataDir: string
  port: number
  host: string
  publicUrl: string
  profiMcpUrl: string
  profiScreenUrl: string
  accounts: { id: string; title: string; egressIp: string }[]
  nodeToken: string
  /** The token of Lora's input for meeting outcomes; none: the input is off. */
  loraToken: string | undefined
  permitSecret: string
  claudeBin: string
  telegramApiRoot: string | undefined
  rolesDir: string
  /**
   * The root of a read-only clone of sara-mind (M4 design 5.2): records under `<mindDir>/mind/`, exam scenarios under
   * `<mindDir>/exam/`. A missing folder is an empty mind.
   */
  mindDir: string
  /** Voice recognition on the server: whisper.cpp and its model, ffmpeg for the conversion. */
  whisperBin: string
  whisperModel: string
  ffmpegBin: string
  /** Lora's speech service through the shared folder (the topic chat spec, section 4); unset, whisper.cpp above. */
  voiceSocket: string | null
  voiceDropDir: string
  /** Sara's voice for the voice app: the `voice` service (Silero, ADR-028); unset, the app answers in text only. */
  voiceUrl: string | null
  /** The host's backup log (infra/backup), mounted read only for the pult's health screen; unset: not seen. */
  backupLog: string | undefined
  /**
   * Boris's Google Sheet (FR-ANL-7, docs/ops/google-sheet.md): the address of the script in it and the secret it
   * knows. Both live only in /opt/sara/.env; without them nothing goes to the sheet.
   */
  sheet: { url: string | undefined; secret: string | undefined }
  production: boolean
}

const ROOT = resolve(import.meta.dirname, '../../..')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production'
  const required = (name: string, devDefault: string): string => {
    const v = env[name]
    if (v) return v
    if (production)
      throw new Error(`Не задана переменная ${name}: без неё Сара в работе не запускается.`)
    return devDefault
  }
  const dataDir = resolve(env.SARA_DATA_DIR ?? resolve(ROOT, '.sara'))
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://sara:sara@localhost:54329/sara',
    dataDir,
    port: Number(env.SARA_PORT ?? 3300),
    host: env.SARA_HOST ?? '127.0.0.1',
    publicUrl: env.SARA_PUBLIC_URL ?? 'http://localhost:5173',
    profiMcpUrl: env.SARA_PROFI_MCP_URL ?? 'http://localhost:7070/mcp',
    profiScreenUrl:
      env.SARA_PROFI_SCREEN_URL ??
      (env.SARA_PROFI_MCP_URL ?? 'http://localhost:7070/mcp')
        .replace(/^http/, 'ws')
        .replace(/\/mcp$/, ''),
    accounts: JSON.parse(
      env.SARA_ACCOUNTS ??
        '[{"id":"hance-marketing","title":"Hance маркетинг","egressIp":"127.0.0.1"}]',
    ),
    nodeToken: required('SARA_NODE_TOKEN', 'dev-node-token'),
    loraToken: env.SARA_LORA_TOKEN || undefined,
    permitSecret: required('SARA_PERMIT_SECRET', 'dev-permit-secret'),
    claudeBin: env.SARA_CLAUDE_BIN ?? 'claude',
    telegramApiRoot: env.SARA_TELEGRAM_API_ROOT || undefined,
    rolesDir: resolve(env.SARA_ROLES_DIR ?? resolve(ROOT, 'roles')),
    mindDir: resolve(env.SARA_MIND_DIR ?? resolve(dataDir, 'mind')),
    whisperBin: env.SARA_WHISPER_BIN ?? 'whisper-cli',
    whisperModel: env.SARA_WHISPER_MODEL ?? resolve(dataDir, 'whisper/ggml-small.bin'),
    ffmpegBin: env.SARA_FFMPEG_BIN ?? 'ffmpeg',
    voiceSocket: env.SARA_VOICE_SOCKET || null,
    voiceDropDir: env.SARA_VOICE_DROP_DIR ?? '/srv/voice-share/in',
    voiceUrl: env.SARA_VOICE_URL || null,
    backupLog: env.SARA_BACKUP_LOG || undefined,
    sheet: { url: env.SARA_SHEET_URL || undefined, secret: env.SARA_SHEET_SECRET || undefined },
    production,
  }
}
