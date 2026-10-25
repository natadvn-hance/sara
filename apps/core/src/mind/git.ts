/** Runs git in a folder; the default runs the git binary, tests may pass their own. Part B writes the default. */
export type GitRunner = {
  run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}
