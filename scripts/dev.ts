// pnpm dev: database in Docker, migrations, then core, fake Profi.ru and the web panel in one terminal.
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  console.log('Docker не запущен. Запусти OrbStack или Docker Desktop и повтори.')
  process.exit(1)
}

console.log('Поднимаю базу данных…')
execSync('docker compose -f infra/compose.dev.yml up -d --wait', { cwd: root, stdio: 'inherit' })
execSync('pnpm --filter @sara/core exec tsx src/db/migrate.ts', { cwd: root, stdio: 'inherit' })
// On the Mac leads come as cards (M0 path); on the server the default is shadow.
execSync('pnpm --filter @sara/core exec tsx src/settings/cli.ts leads on', {
  cwd: root,
  stdio: 'inherit',
})

const procs: { name: string; cmd: string; args: string[] }[] = [
  {
    name: 'ядро',
    cmd: 'pnpm',
    args: ['--filter', '@sara/core', 'exec', 'tsx', 'watch', 'src/main.ts'],
  },
  {
    name: 'профи',
    cmd: 'pnpm',
    args: ['--filter', '@sara/profi-node', 'exec', 'tsx', 'src/fake/main.ts'],
  },
  {
    name: 'пульт',
    cmd: 'pnpm',
    args: ['--filter', '@sara/web', 'exec', 'vite', '--port', '5173', '--strictPort'],
  },
]

const children: ChildProcess[] = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean))
      console.log(`[${p.name}] ${line}`)
  }
  child.stdout?.on('data', prefix)
  child.stderr?.on('data', prefix)
  return child
})

console.log('Пульт: http://localhost:5173')
console.log('Фальшивая заявка: pnpm fake:order. Остановить всё: Ctrl+C.')

const stop = () => {
  for (const c of children) c.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
