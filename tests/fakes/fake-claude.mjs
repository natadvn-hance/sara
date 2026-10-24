#!/usr/bin/env node
// Fake `claude` CLI for tests. Controlled by FAKE_CLAUDE_* environment variables.
import { appendFileSync } from 'node:fs'

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok'
const argv = process.argv.slice(2)
const argOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
// FAKE_CLAUDE_OUTPUT_BY_ROLE: {"<role>": output, "<role>@<model>": output}; the role comes from the prompt path.
const role = /roles\/([^/]+)\/role\.md$/.exec(argOf('--system-prompt-file') ?? '')?.[1]
const byRole = JSON.parse(process.env.FAKE_CLAUDE_OUTPUT_BY_ROLE ?? '{}')
const picked = byRole[`${role}@${argOf('--model')}`] ?? byRole[role]
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
  if (mode === 'limit') {
    process.stdout.write('Claude AI usage limit reached\n')
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
