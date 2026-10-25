#!/usr/bin/env node
// Fake `claude` CLI for tests. Controlled by FAKE_CLAUDE_* environment variables.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok'
const argv = process.argv.slice(2)
const argOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
// FAKE_CLAUDE_OUTPUT_BY_ROLE: {"<role>": output, "<role>@<model>": output}; the role comes from the prompt path.
const role = /roles\/([^/]+)\/role\.md$/.exec(argOf('--system-prompt-file') ?? '')?.[1]
const byRole = JSON.parse(process.env.FAKE_CLAUDE_OUTPUT_BY_ROLE ?? '{}')
const picked = nextOf(byRole[`${role}@${argOf('--model')}`] ?? byRole[role], role)
// {"$sequence": [a, b, ...]} answers a, then b, ... and the last one for every call after (the position is kept
// in FAKE_CLAUDE_COUNTER_FILE, so a test can have a role fail once and then answer well).
function nextOf(picked, key) {
  if (!picked || !Array.isArray(picked.$sequence)) return picked
  const file = process.env.FAKE_CLAUDE_COUNTER_FILE
  let counts = {}
  if (file) {
    try {
      counts = JSON.parse(readFileSync(file, 'utf8'))
    } catch {}
  }
  const n = counts[key] ?? 0
  counts[key] = n + 1
  if (file) writeFileSync(file, JSON.stringify(counts))
  return picked.$sequence[Math.min(n, picked.$sequence.length - 1)]
}
const output =
  picked !== undefined ? JSON.stringify(picked) : (process.env.FAKE_CLAUDE_OUTPUT ?? '{"ok":true}')
const log = process.env.FAKE_CLAUDE_ARGS_LOG
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 300)

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  stdin += c
})
process.stdin.on('end', async () => {
  const start = Date.now()
  if (mode === 'sleep') await new Promise((r) => setTimeout(r, sleepMs))
  // FAKE_CLAUDE_DELAY_MS: any mode answers this much later (a slow limit answer, say).
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0)))
  if (log) {
    appendFileSync(
      log,
      `${JSON.stringify({ args: process.argv.slice(2), stdin, start, end: Date.now(), token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null })}\n`,
    )
  }
  if (mode === 'hang') await new Promise((r) => setTimeout(r, 60_000))
  if (mode === 'exit1') {
    process.stderr.write('Something went wrong\n')
    process.exit(1)
  }
  const limitText = process.env.FAKE_CLAUDE_LIMIT_TEXT ?? 'Claude AI usage limit reached'
  // FAKE_CLAUDE_LIMIT_MODELS=sonnet: the limit modes hold only these models, the others answer as usual.
  const limitModels = process.env.FAKE_CLAUDE_LIMIT_MODELS?.split(',')
  const limited = !limitModels || limitModels.includes(argOf('--model') ?? '')
  if (mode === 'limit' && limited) {
    process.stdout.write(`${limitText}\n`)
    process.exit(1)
  }
  if (mode === 'limit_json' && limited) {
    // How CLI 2.1.310 answers a spent subscription limit in print mode: an error result, exit code 1.
    process.stdout.write(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: limitText }),
    )
    process.exit(1)
  }
  if (mode === 'auth_error') {
    // What CLI 2.1.308 prints when the token is expired or wrong (checked on 22.10.2026).
    process.stdout.write(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      }),
    )
    process.exit(1)
  }
  if (mode === 'bad_json') {
    process.stdout.write('not json')
    return
  }
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'done' }
  if (mode !== 'no_structured') result.structured_output = JSON.parse(output)
  process.stdout.write(JSON.stringify(result))
})
