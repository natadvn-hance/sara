// pnpm mind:key < key: stores the sara-mind deploy key (write access to natadvn-hance/sara-mind only) in the core's
// secret store as mind_push_key (ADR-025). The key is read from stdin, so it never lands in the shell history.
import { loadConfig } from '../config'
import { createSecretStore } from '../secrets/store'

const chunks: Buffer[] = []
for await (const c of process.stdin) chunks.push(c as Buffer)
const key = Buffer.concat(chunks).toString('utf8').trim()
if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/.test(key)) {
  console.log('Это не закрытый ключ: ничего не сохранила')
  process.exitCode = 1
} else {
  await createSecretStore(loadConfig().dataDir).set('mind_push_key', `${key}\n`)
  console.log('Ключ отправки разума сохранён')
}
