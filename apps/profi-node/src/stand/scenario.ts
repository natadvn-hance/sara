import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BEHAVIOURS } from './state'

const Line = z.object({
  /** Seconds after our last message; without it the client's usual pace. */
  wait_s: z.number().int().min(0).max(3600).optional(),
  text: z.string().min(1).max(800),
})

const InlineOrder = z.object({
  title: z.string().min(1),
  category: z.string().default('Маркетинг'),
  city: z.string().default('Краснодар'),
  text: z.string().min(1),
  client_name: z.string().default('Клиент'),
  budget_text: z.string().nullable().default(null),
  bid_price_rub: z.number().int().nonnegative().default(210),
})

/**
 * A scenario file of the stand (docs/ops/staging.md): orders to put into the feed, one after another, and how each
 * client behaves once Sara bids. `order` is `sample`, `sample:<number of a sample>`, `real`, `real:<n>` or the order.
 */
export const Scenario = z.object({
  title: z.string().min(1),
  orders: z
    .array(
      z.object({
        order: z.union([z.string().regex(/^(sample|real)(:\d+)?$/), InlineOrder]),
        client: z
          .object({
            behaviour: z.enum(BEHAVIOURS).optional(),
            persona: z.string().optional(),
            script: z.array(Line).max(20).optional(),
          })
          .default({}),
        /** Seconds after the scenario starts. */
        after_s: z.number().int().min(0).max(3600).default(0),
      }),
    )
    .min(1)
    .max(20),
})
export type Scenario = z.infer<typeof Scenario>
export type InlineOrder = z.infer<typeof InlineOrder>

export const SCENARIOS_DIR = join(import.meta.dirname, 'scenarios')

/** The scenarios kept in the repository, by name (the file name without .json). */
export async function listScenarios(
  dir = SCENARIOS_DIR,
): Promise<{ name: string; title: string }[]> {
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort()
  return Promise.all(
    files.map(async (f) => ({
      name: f.slice(0, -'.json'.length),
      title: Scenario.parse(JSON.parse(await readFile(join(dir, f), 'utf8'))).title,
    })),
  )
}

export async function readScenario(name: string, dir = SCENARIOS_DIR): Promise<Scenario> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`нет сценария ${name}`)
  return Scenario.parse(JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')))
}
