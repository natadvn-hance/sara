#!/usr/bin/env node
// Fake whisper-cli for tests: prints FAKE_WHISPER_TEXT to stdout, exits FAKE_WHISPER_EXIT (default 0).
import { existsSync } from 'node:fs'

const args = process.argv.slice(2)
const wav = args[args.indexOf('-f') + 1]
if (!wav || !existsSync(wav)) {
  process.stderr.write('no input file\n')
  process.exit(2)
}
process.stdout.write(process.env.FAKE_WHISPER_TEXT ?? '')
process.exit(Number(process.env.FAKE_WHISPER_EXIT ?? 0))
