import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

// Atomic file replace (tmp + rename, optional .bak) — the same pattern db.ts /
// settings.ts / hubContext.ts use, factored out for the upgrade's new stores.
// A crash mid-write must never truncate a store or a file under ~/.claude.

export function writeAtomic(target: string, content: string, backup = false): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, content, 'utf8')
  if (backup) {
    try {
      if (existsSync(target)) copyFileSync(target, `${target}.bak`)
    } catch {
      /* best-effort backup */
    }
  }
  renameSync(tmp, target) // MoveFileEx on Windows — atomic replace
}

/** Parse a JSON file; missing/corrupt → null (callers decide how to recover). */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
