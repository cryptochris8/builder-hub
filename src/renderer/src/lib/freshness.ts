import type { ContextFreshness } from '@shared/types'

/** Chip wording for a freshness verdict. 'unknown' covers two cases: never
 *  indexed, or the git probe failed/timed out — reported as unknown on purpose,
 *  since a slow repo must never pass for verified — and the two must not read the same. */
export function freshnessLabel(f: ContextFreshness): string {
  if (f.status === 'stale') return 'STALE'
  if (f.status === 'fresh') return 'fresh'
  return f.reasons.includes('never indexed') || f.reasons.length === 0 ? 'not indexed' : 'unknown'
}
