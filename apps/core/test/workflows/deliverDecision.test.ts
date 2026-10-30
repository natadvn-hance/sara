import { newEventId } from '@sara/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchDbos, shutdownDbos } from '../../src/workflows/dbos'
import { deliverDecision } from '../../src/workflows/decisionWait'
import { testDatabaseUrl } from '../helpers/db'

beforeAll(async () => {
  await launchDbos(testDatabaseUrl())
})
afterAll(async () => {
  await shutdownDbos()
})

describe('the end of a decision wait', () => {
  it('FR-UI-6: a press on a task that has no wait (made before it, or by hand) decides it without an error', async () => {
    await expect(deliverDecision(newEventId(), 'skip')).resolves.toBeUndefined()
  })
})
