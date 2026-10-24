#!/usr/bin/env node
// Fake ffmpeg for tests: copies the -i input to the last argument, as a conversion would.
import { copyFileSync } from 'node:fs'

const args = process.argv.slice(2)
copyFileSync(args[args.indexOf('-i') + 1], args.at(-1))
