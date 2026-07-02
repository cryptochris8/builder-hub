import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { allProjects, onPersist } from './db'
import {
  HUB_BLOCK_END,
  HUB_BLOCK_START,
  buildGlobalClaudeBlock,
  buildRegistryMarkdown,
  upsertMarkedBlock
} from '../shared/hubLogic'

// Keeps Claude aware of EVERY registered project, from any terminal:
//  1. ~/.claude/builder-hub-projects.md — the full registry, regenerated on every
//     change (name → path · type · stack · status · notes).
//  2. A small marked block in ~/.claude/CLAUDE.md (user memory, loads in every
//     Claude session) pointing at that file. Only the marked block is ever
//     touched — the rest of the hand-curated file is preserved byte-for-byte,
//     written atomically (tmp + rename) with a .bak of the previous version.
//  3. pty.ts also exports BUILDER_HUB_PROJECTS into embedded terminals.

export function registryFilePath(): string {
  return join(app.getPath('home'), '.claude', 'builder-hub-projects.md')
}

// Atomic replace (same pattern as db.ts persist) — a crash mid-write must never
// truncate the target, especially the user's hand-curated CLAUDE.md.
function writeAtomic(target: string, content: string, backup: boolean): void {
  const tmp = `${target}.tmp`
  writeFileSync(tmp, content, 'utf8')
  if (backup) {
    try {
      if (existsSync(target)) copyFileSync(target, `${target}.bak`)
    } catch {
      /* best-effort backup */
    }
  }
  renameSync(tmp, target)
}

export function syncHubContext(): void {
  try {
    const registry = registryFilePath()
    mkdirSync(dirname(registry), { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    writeAtomic(registry, buildRegistryMarkdown(allProjects(), today), false)

    // Upsert the pointer block in the user's global CLAUDE.md (only if it exists —
    // we never create or restructure the user's memory file from scratch).
    const globalMd = join(app.getPath('home'), '.claude', 'CLAUDE.md')
    if (existsSync(globalMd)) {
      const current = readFileSync(globalMd, 'utf8')
      const next = upsertMarkedBlock(
        current,
        HUB_BLOCK_START,
        HUB_BLOCK_END,
        buildGlobalClaudeBlock(registry)
      )
      if (next !== current) writeAtomic(globalMd, next, true)
    }
  } catch {
    /* context sync is best-effort — never block the app on it */
  }
}

let pending: NodeJS.Timeout | null = null

/** Write the context now and keep it fresh on every registry change (debounced,
 *  so a burst of persists — e.g. rescan adding N projects — syncs once). */
export function registerHubContext(): void {
  syncHubContext()
  onPersist(() => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      syncHubContext()
    }, 250)
  })
}
