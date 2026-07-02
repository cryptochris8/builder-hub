// Tiny renderer-side bus so other panes (e.g. Files) can paste text into a
// project's Claude terminal. Keyed by project cwd (lowercased) — App enforces
// one Claude tab per project, so the key is unambiguous. Text sent before the
// terminal is ready is queued (with a TTL) and flushed on registration.

type Writer = (text: string) => void

interface Queued {
  text: string
  at: number
}

// Long enough to cover fonts + rAF + PTY spawn + Claude booting; short enough
// that nothing stale ever pastes into a session opened much later.
const QUEUE_TTL_MS = 30_000

const writers = new Map<string, Writer>()
const queues = new Map<string, Queued[]>()

const keyOf = (cwd: string): string => cwd.toLowerCase()

export function registerClaudeTerminal(cwd: string, writer: Writer): () => void {
  const key = keyOf(cwd)
  writers.set(key, writer)
  const queued = queues.get(key)
  if (queued) {
    queues.delete(key)
    const now = Date.now()
    for (const q of queued) if (now - q.at < QUEUE_TTL_MS) writer(q.text)
  }
  return () => {
    if (writers.get(key) === writer) writers.delete(key)
  }
}

export function sendToClaudeTerminal(cwd: string, text: string): void {
  const key = keyOf(cwd)
  const writer = writers.get(key)
  if (writer) {
    writer(text)
  } else {
    const queued = queues.get(key) ?? []
    queued.push({ text, at: Date.now() })
    queues.set(key, queued)
  }
}

/** Drop anything still queued for a project (e.g. its terminal failed to start). */
export function clearClaudeQueue(cwd: string): void {
  queues.delete(keyOf(cwd))
}
