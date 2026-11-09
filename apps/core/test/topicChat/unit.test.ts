import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoleMeta } from '@sara/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildConverseArgs } from '../../src/gateway/claudeCli'
import { createSocketTranscriber } from '../../src/notify/transcribe'
import { topicInput, transcriptPost } from '../../src/topicChat/chat'
import { TOPIC_TOOLS } from '../../src/topicChat/tools'
import { ROOT } from '../helpers/app'

const DASH = String.fromCharCode(0x2014)
const at = new Date('2026-11-07T09:00:00Z')
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
})

describe('the topic chat, its parts', () => {
  it('FR-NOTIF-4: the turn runs on Opus with web search and page reading only, no files or commands, and the tools of Sara', async () => {
    const meta = RoleMeta.parse(
      JSON.parse(await readFile(join(ROOT, 'roles/topic-chat/meta.json'), 'utf8')),
    )
    expect(meta).toMatchObject({ model: 'opus', effort: 'medium' })
    const args = buildConverseArgs(
      meta,
      '/r/role.md',
      { configPath: '/d/mcp.json', server: 'sara', tools: ['chat', 'propose'] },
      3,
    )
    const after = (flag: string) => args[args.indexOf(flag) + 1]
    expect(after('--tools')).toBe('WebSearch,WebFetch')
    expect(
      args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--setting-sources')),
    ).toEqual(['WebSearch', 'WebFetch', 'mcp__sara__chat', 'mcp__sara__propose'])
    expect(args.join(' ')).not.toMatch(/Bash|Read|Write|Edit/)
    // The Secretary and every other role keep no built-in tool at all.
    const plain = buildConverseArgs({ ...meta, tools: undefined }, '/r/role.md', {
      configPath: '/d/mcp.json',
      server: 'sara',
      tools: ['leads'],
    })
    expect(plain[plain.indexOf('--tools') + 1]).toBe('')
  })

  it('FR-NOTIF-4: no tool of the topic chat sends to the client: a version only shows the button', () => {
    expect(Object.keys(TOPIC_TOOLS).sort()).toEqual(
      ['chat', 'client', 'meeting', 'mind', 'order', 'propose', 'remember'].sort(),
    )
    expect(TOPIC_TOOLS.propose.description).toContain('«Отправить»')
  })

  it('FR-NOTIF-4: the input has the order, the chat, the draft, his standing words, the talk so far and his new words', () => {
    const input = topicInput({
      now: at,
      order: { title: 'Сайт для клиники', text: 'Нужен сайт', clientName: 'Анна' },
      chat: [
        { side: 'client', text: 'Сколько стоит?', at: '2026-11-07T08:00:00Z' },
        { side: 'specialist', text: 'Добрый день!', at: '2026-11-07T08:10:00Z' },
      ],
      draft: 'Добрый день! Стоимость от 80 000 ₽.',
      borisNote: '06.11: цену в чате не называем',
      discussion: [
        { kind: 'boris', text: 'короче', at: '2026-11-07T08:20:00Z' },
        { kind: 'version', text: 'Добрый день! Давайте созвонимся.', at: '2026-11-07T08:21:00Z' },
      ],
      said: [{ conversationId: 'c', text: 'добавь про четверг', voice: true, at }],
    })
    for (const part of [
      '## Заявка',
      'Сайт для клиники',
      '[Клиент, 07.11, 11:00] Сколько стоит?',
      '[Мы, 07.11, 11:10] Добрый день!',
      '## Черновик Сары, который ждёт решения\nДобрый день! Стоимость от 80 000 ₽.',
      '06.11: цену в чате не называем',
      '[Борис, 11:20] короче',
      '[Сара, вариант для клиента, 11:21] Добрый день! Давайте созвонимся.',
      '## Новое от Бориса\n(голосом) добавь про четверг',
    ])
      expect(input).toContain(part)
    expect(input).not.toContain(DASH)
  })

  it('FR-NOTIF-4: the transcript is a folded quote, escaped', () => {
    expect(transcriptPost('цена <5> & сроки')).toBe(
      '<blockquote expandable>🎙 цена &lt;5&gt; &amp; сроки</blockquote>',
    )
  })
})

describe("voice through Lora's speech service", () => {
  async function service(answer: (req: { op: string; path: string }) => unknown) {
    const dir = await mkdtemp(join(tmpdir(), 'stt-'))
    const sock = join(dir, 'stt.sock')
    const seen: { op: string; path: string; existed: boolean }[] = []
    const server = createServer((c) => {
      let buf = ''
      c.on('data', async (b) => {
        buf += b.toString()
        if (!buf.includes('\n')) return
        const req = JSON.parse(buf.split('\n')[0] ?? '{}') as { op: string; path: string }
        const existed = await readFile(req.path).then(
          () => true,
          () => false,
        )
        seen.push({ ...req, existed })
        const r = answer(req)
        if (r !== undefined) c.end(`${JSON.stringify(r)}\n`)
      })
    })
    await new Promise<void>((ok) => server.listen(sock, ok))
    closers.push(async () => {
      server.close()
      await rm(dir, { recursive: true, force: true })
    })
    const voice = join(dir, 'voice.oga')
    await writeFile(voice, 'OggS fake')
    return { dir, sock, voice, seen }
  }

  it('FR-NOTIF-4: the voice is copied to the shared folder, heard by the socket, and the copy is removed', async () => {
    const s = await service(() => ({ ok: true, text: ' предложи четверг ' }))
    const drop = join(s.dir, 'in')
    const t = createSocketTranscriber({ socketPath: s.sock, dropDir: drop })
    expect(await t.transcribe(s.voice)).toBe('предложи четверг')
    expect(s.seen).toHaveLength(1)
    expect(s.seen[0]).toMatchObject({ op: 'transcribe', existed: true })
    expect(s.seen[0]?.path.startsWith(drop)).toBe(true)
    await expect(readFile(s.seen[0]?.path ?? '')).rejects.toThrow()
  })

  it('FR-NOTIF-4: a voice not heard says why in the log, with time and size, never words (09.11.2026)', async () => {
    const said: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      said.push(a.join(' '))
    })
    try {
      const bad = await service(() => ({ ok: false, error: 'decode failed' }))
      await createSocketTranscriber({ socketPath: bad.sock, dropDir: bad.dir }).transcribe(
        bad.voice,
      )
      const empty = await service(() => ({ ok: true, text: ' ' }))
      await createSocketTranscriber({ socketPath: empty.sock, dropDir: empty.dir }).transcribe(
        empty.voice,
      )
      const ok = await service(() => ({ ok: true, text: 'предложи четверг' }))
      await createSocketTranscriber({ socketPath: ok.sock, dropDir: ok.dir }).transcribe(ok.voice)
    } finally {
      spy.mockRestore()
    }
    expect(said).toHaveLength(2)
    expect(said[0]).toMatch(/^voice socket: the service failed: decode failed \(\d+ ms, 9 B\)$/)
    expect(said[1]).toMatch(/^voice socket: no words heard \(\d+ ms, 9 B\)$/)
    expect(said.join(' ')).not.toContain('четверг')
  })

  it('FR-NOTIF-4: no socket, an error, an empty text or a silent service is null, never a throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stt-none-'))
    await writeFile(join(dir, 'v.oga'), 'x')
    const none = createSocketTranscriber({ socketPath: join(dir, 'no.sock'), dropDir: dir })
    expect(await none.transcribe(join(dir, 'v.oga'))).toBeNull()
    const bad = await service(() => ({ ok: false, error: 'model failed' }))
    expect(
      await createSocketTranscriber({ socketPath: bad.sock, dropDir: bad.dir }).transcribe(
        bad.voice,
      ),
    ).toBeNull()
    const empty = await service(() => ({ ok: true, text: '  ' }))
    expect(
      await createSocketTranscriber({ socketPath: empty.sock, dropDir: empty.dir }).transcribe(
        empty.voice,
      ),
    ).toBeNull()
    const silent = await service(() => undefined)
    expect(
      await createSocketTranscriber({
        socketPath: silent.sock,
        dropDir: silent.dir,
        timeoutMs: 200,
      }).transcribe(silent.voice),
    ).toBeNull()
    await rm(dir, { recursive: true, force: true })
  })
})
