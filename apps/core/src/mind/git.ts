import { execFile } from 'node:child_process'

/** Runs git in a folder; the default runs the git binary, tests may pass their own. */
export type GitRunner = {
  run(
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }>
}

/** Sara's own name on every commit she makes in sara-mind (ADR-025). */
export const SARA_AUTHOR = ['-c', 'user.name=Сара', '-c', 'user.email=sara@hance.local']

export const gitBinary: GitRunner = {
  run: (args, cwd, env) =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? ((err as { code?: number }).code ?? 1) : 0
          resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr })
        },
      )
    }),
}
