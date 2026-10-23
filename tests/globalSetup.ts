import { prepareTestDatabase } from '../apps/core/test/globalSetup'
import { prepareNodeTestDatabase } from '../apps/profi-node/test/globalSetup'

export default async () => {
  await prepareTestDatabase('sara_e2e')
  // Its own node database: the profi-node tests run at the same time on sara_node_test.
  await prepareNodeTestDatabase('sara_node_e2e')
}
