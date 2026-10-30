import { EventEmitter } from 'node:events'
import type { StreamEvent } from '@sara/shared'

/**
 * The live wire of the core (pult v2 design 6): every event the journal writes is told here too, in memory, so the
 * pult's stream can say «something changed» without reading the journal. Never the data itself: type, kind, id.
 */
const bus = new EventEmitter()
bus.setMaxListeners(100)

/**
 * Told after the current step, never inside it: the journal's write (often inside a transaction) must not wait for
 * a listener, and a listener that fails must not fail the write.
 */
export function publish(e: StreamEvent): void {
  setImmediate(() => {
    for (const fn of bus.listeners('event') as ((e: StreamEvent) => void)[]) {
      try {
        fn(e)
      } catch (err) {
        console.error(
          'stream listener failed',
          err instanceof Error ? err.message.slice(0, 200) : err,
        )
      }
    }
  })
}

export function subscribe(fn: (e: StreamEvent) => void): () => void {
  bus.on('event', fn)
  return () => bus.off('event', fn)
}
