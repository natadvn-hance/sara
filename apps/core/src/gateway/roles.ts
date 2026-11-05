import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RoleMeta } from '@sara/shared'

export type RoleName =
  | 'probe'
  | 'sorter'
  | 'scorer'
  | 'rules-proposer'
  | 'analyst'
  | 'interlocutor'
  | 'checker'
  | 'reminder'
  | 'examiner'
  | 'onboarding-about'
  | 'onboarding-stops'
  | 'onboarding-ideal'
  | 'onboarding-format'
  | 'onboarding-cases'
  | 'trainer-client'
  | 'trainer-coach'
  | 'lesson-maker'
  | 'teacher'
  | 'persona-builder'
  | 'dialog-generator'
  | 'secretary'
  | 'site-reader'
  | 'links-digest'
  | 'meeting'
  | 'meeting-result'

export async function loadRole(
  rolesDir: string,
  name: RoleName,
): Promise<{ meta: RoleMeta; promptPath: string }> {
  const meta = RoleMeta.parse(JSON.parse(await readFile(join(rolesDir, name, 'meta.json'), 'utf8')))
  return { meta, promptPath: join(rolesDir, name, 'role.md') }
}
