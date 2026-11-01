import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ClientTurn } from '@sara/profi-node/stand'
import { describe, expect, it } from 'vitest'
import { createClientModel } from '../../src/testLeads/clientModel'

const ROOT = resolve(import.meta.dirname, '../../../..')
const turn: ClientTurn = {
  persona: { archetype: 'владелица кафе', name: 'Вера' },
  order: { title: 'Реклама кафе', text: 'Нужны гости в будни', budget_text: null },
  behaviour: null,
  dialog: [{ who: 'исполнитель', text: 'Добрый день!' }],
}

describe('the client of a test order', () => {
  it('NFR-COST-1: the trainer client role answers one line through the CLI on haiku with the core token', async () => {
    const log = join(await mkdtemp(join(tmpdir(), 'client-model-')), 'args.log')
    const model = createClientModel({
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      rolesDir: join(ROOT, 'roles'),
      token: async () => 'core-token',
      cwd: tmpdir(),
      extraEnv: () => ({
        FAKE_CLAUDE_ARGS_LOG: log,
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
          'trainer-client': { text: 'А сколько стоит?', ends: 'no', mood: 'doubt' },
        }),
      }),
    })
    expect(await model(turn)).toEqual({ text: 'А сколько стоит?', ends: 'no', mood: 'doubt' })
    const call = JSON.parse((await readFile(log, 'utf8')).trim())
    expect(call.token).toBe('core-token')
    expect(call.args[call.args.indexOf('--model') + 1]).toBe('haiku')
    expect(JSON.parse(call.stdin)).toEqual(turn)
  })

  it('NFR-COST-1: without the token nothing is called and the client stays quiet, saying why', async () => {
    const model = createClientModel({
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      rolesDir: join(ROOT, 'roles'),
      token: async () => null,
      cwd: tmpdir(),
    })
    expect(await model(turn)).toEqual({
      error: expect.stringContaining('нет токена Claude'),
      skipped: true,
    })
  })
})
