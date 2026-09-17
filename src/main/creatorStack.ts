import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { allProjects } from './db'
import { readJsonFile, writeAtomic } from './fsAtomic'
import {
  emptyStack,
  findCapabilities,
  mergeSeed,
  normalizeStack,
  projectForPath,
  removeEntry,
  renderCreatorStackMarkdown,
  seedEntries,
  upsertEntry
} from '../shared/creatorStack'
import type { CapabilityMatch, CreatorStack, CreatorStackEntry } from '../shared/types'

// The Creator Stack registry on disk: creator-stack.json in userData (atomic,
// .bak), seeded from entries VERIFIED on this machine (see SEED_CREATOR_STACK),
// and rendered for Claude at ~/.claude/builder-hub/creator-stack.md. Reindex
// re-verifies every path and re-links entries to registered projects. Nothing
// here is hard-coded as present: seeding only registers what exists.

let cache: CreatorStack | null = null

function file(): string {
  return join(app.getPath('userData'), 'creator-stack.json')
}

/** Where Claude reads the rendered registry. */
export function creatorStackFilePath(): string {
  return join(app.getPath('home'), '.claude', 'builder-hub', 'creator-stack.md')
}

function load(): CreatorStack {
  if (cache) return cache
  const f = file()
  let raw = readJsonFile(f)
  if (!raw && existsSync(f)) raw = readJsonFile(`${f}.bak`)
  cache = normalizeStack(raw, Date.now())
  return cache
}

function persist(stack: CreatorStack): { ok: boolean; error?: string } {
  cache = stack
  try {
    writeAtomic(file(), JSON.stringify(stack, null, 2), true)
    return { ok: true }
  } catch (e) {
    console.error('[builder-hub] could not save creator-stack.json:', e)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function getStack(): CreatorStack {
  return load()
}

/** Seed + merge against the machine. Persists only when something changed. */
export function reindexStack(): CreatorStack {
  const now = Date.now()
  const home = app.getPath('home')
  const projects = allProjects()
  const seeded = seedEntries(home, (p) => existsSync(p), projects, now, join)
  let next = mergeSeed(load(), seeded, now)
  // Re-verify every entry (user/discovered included) and re-link projects.
  const entries: CreatorStackEntry[] = next.entries.map((e) => ({
    ...e,
    exists: existsSync(e.path),
    projectId: projectForPath(e.path, projects)?.id ?? e.projectId,
    indexedAt: now
  }))
  next = { ...next, entries, updatedAt: now }
  // Compare without the per-run index stamp, or every startup rewrites the file (+ .bak).
  const strip = (list: CreatorStackEntry[]): string =>
    JSON.stringify(list.map((e) => ({ ...e, indexedAt: undefined })))
  const changed =
    strip(next.entries) !== strip(load().entries) ||
    (next.removed?.length ?? 0) !== (load().removed?.length ?? 0)
  if (changed) persist(next)
  else {
    // Nothing changed: keep the stamps in memory but not the timestamp churn.
    next = { ...next, updatedAt: load().updatedAt }
    cache = next
  }
  // The rendered markdown follows the same rule (a project touch must not rewrite
  // a file under ~/.claude), except when it is missing (deleted — documented as safe).
  if (changed || !existsSync(creatorStackFilePath())) renderStackFile()
  return next
}

export function upsertStackEntry(entry: CreatorStackEntry): CreatorStack {
  const next = upsertEntry(load(), { ...entry, exists: existsSync(entry.path) }, Date.now())
  persist(next)
  renderStackFile()
  return next
}

export function removeStackEntry(id: string): CreatorStack {
  const next = removeEntry(load(), id, Date.now())
  persist(next)
  renderStackFile()
  return next
}

export function findForPrompt(prompt: string, limit = 2): CapabilityMatch[] {
  const stack = load()
  if (stack.entries.length === 0 || !prompt) return []
  return findCapabilities(prompt, stack, limit)
}

/** Best-effort render of ~/.claude/builder-hub/creator-stack.md. Never throws. */
export function renderStackFile(): void {
  try {
    const today = new Date().toISOString().slice(0, 10)
    writeAtomic(creatorStackFilePath(), renderCreatorStackMarkdown(load(), today), false)
  } catch (e) {
    console.error('[builder-hub] could not render creator-stack.md:', e)
  }
}

/** Startup: make sure the file exists and the seed has been applied once. */
export function initCreatorStack(): void {
  try {
    if (load().entries.length === 0) cache = emptyStack(Date.now())
    reindexStack()
  } catch (e) {
    console.error('[builder-hub] creator stack init failed:', e)
  }
}
