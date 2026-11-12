import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSocketTranscriber } from '../../src/notify/transcribe'

/**
 * 12.11.2026: every recognition through Lora's service failed with `[Errno 13] Permission denied` on the dropped
 * file. Node's copyFile gives the copy the owner and group of the source (gid 0 in the core's container), not the
 * group of the setgid drop folder (`root:voice-share 2770`), so the service (user lora, group voice-share) could not
 * read it. On a Mac a temp folder has the same group as the user, so the end state alone proves nothing: the tests
 * also watch what the code does, with the folder's group made different.
 */
const hook = vi.hoisted(() => ({
  /** The group the drop folder pretends to have; null: the real one. */
  dirGid: null as number | null,
  dropDir: '',
  /** The chown calls, when they are recorded instead of done (a user cannot hand a file to a group it is not in). */
  chowned: null as unknown[][] | null,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    stat: (async (path: string, ...rest: unknown[]) => {
      const s = await (real.stat as (...a: unknown[]) => Promise<import('node:fs').Stats>)(
        path,
        ...rest,
      )
      return hook.dirGid !== null && path === hook.dropDir
        ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { gid: hook.dirGid })
        : s
    }) as typeof real.stat,
    chown: (async (...a: unknown[]) => {
      if (hook.chowned) {
        hook.chowned.push(a)
        return
      }
      return (real.chown as (...b: unknown[]) => Promise<void>)(...a)
    }) as typeof real.chown,
  }
})

/** A group of this user other than its main one, as voice-share is for the core: a runner with one group skips the real-group test. */
const other = (process.getgroups?.() ?? []).find((g) => g !== process.getgid?.())

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  hook.dirGid = null
  hook.dropDir = ''
  hook.chowned = null
  for (const c of closers.splice(0)) await c()
})

/** Lora's service as the core sees it: looks at the dropped file the moment it is asked, then hears it. */
async function service() {
  const dir = await mkdtemp(join(tmpdir(), 'stt-drop-'))
  const sock = join(dir, 'stt.sock')
  const drop = join(dir, 'in')
  const seen: { path: string; mode: number; gid: number; chownsBefore: number }[] = []
  const server = createServer((c) => {
    let buf = ''
    c.on('data', async (b) => {
      buf += b.toString()
      if (!buf.includes('\n')) return
      const req = JSON.parse(buf.split('\n')[0] ?? '{}') as { path: string }
      const s = await stat(req.path)
      seen.push({
        path: req.path,
        mode: s.mode & 0o777,
        gid: s.gid,
        chownsBefore: hook.chowned?.length ?? 0,
      })
      c.end(`${JSON.stringify({ ok: true, text: 'предложи четверг' })}\n`)
    })
  })
  await new Promise<void>((ok) => server.listen(sock, ok))
  closers.push(async () => {
    server.close()
    await rm(dir, { recursive: true, force: true })
  })
  const voice = join(dir, 'voice.oga')
  await writeFile(voice, 'OggS fake')
  hook.dropDir = drop
  return { sock, drop, voice, seen }
}

describe("the voice dropped for Lora's speech service is readable by it", () => {
  it("FR-NOTIF-4: the copy is handed to the drop folder's group and closed to others, before the service is asked", async () => {
    const s = await service()
    hook.dirGid = 986
    hook.chowned = []
    const t = createSocketTranscriber({ socketPath: s.sock, dropDir: s.drop })
    expect(await t.transcribe(s.voice)).toBe('предложи четверг')
    expect(s.seen).toHaveLength(1)
    const [path, uid, gid] = hook.chowned[0] ?? []
    // Its group becomes the folder's (986: voice-share), its owner stays: -1 means "no change".
    expect(hook.chowned).toHaveLength(1)
    expect([path, uid, gid]).toEqual([s.seen[0]?.path, -1, 986])
    // Done before the service looked, and the mode is 640 then, not the 600 the copy was born with.
    expect(s.seen[0]).toMatchObject({ mode: 0o640, chownsBefore: 1 })
    // The copy does not stay behind.
    await expect(readFile(s.seen[0]?.path ?? '')).rejects.toThrow()
  })

  // Root may give a file to any group: there is nothing to refuse.
  it.skipIf(process.getuid?.() === 0)(
    "FR-NOTIF-4: a copy that cannot be handed to the folder's group is not asked about: null, and no copy stays",
    async () => {
      const s = await service()
      hook.dirGid = 986
      // The chown is really done here, and a user that is not in group 986 and not root is refused.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const t = createSocketTranscriber({ socketPath: s.sock, dropDir: s.drop })
        expect(await t.transcribe(s.voice)).toBeNull()
        expect(s.seen).toEqual([])
        expect(spy.mock.calls.map((a) => a.join(' ')).join('\n')).toMatch(
          /voice socket .*(EPERM|not permitted)/i,
        )
      } finally {
        spy.mockRestore()
      }
    },
  )

  it.skipIf(other === undefined)(
    'FR-NOTIF-4: with a real group of the folder the copy ends in it, mode 640, as the service sees it',
    async () => {
      const s = await service()
      const group = other as number
      await mkdir(s.drop, { recursive: true })
      await chown(s.drop, -1, group)
      await chmod(s.drop, 0o2770)
      const t = createSocketTranscriber({ socketPath: s.sock, dropDir: s.drop })
      expect(await t.transcribe(s.voice)).toBe('предложи четверг')
      expect(s.seen[0]).toMatchObject({ mode: 0o640, gid: group })
    },
  )
})
