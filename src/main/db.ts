import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { recoverRegistry } from '../shared/projectLogic'
import type { Project } from '../shared/types'

// Local-first storage: a single JSON file in the app's userData dir.
// Writes are atomic (tmp + rename) and keep a .bak, and a corrupt file is moved
// aside rather than silently overwritten — so a crash mid-write can't wipe the
// registry. (Deliberately dependency-free — no native module to compile. If this
// ever outgrows a JSON file, swap in SQLite behind allProjects()/persist().)

let cache: Project[] | null = null

// Subscribers notified after every successful persist (e.g. the hub-context
// writer that keeps ~/.claude/builder-hub-projects.md fresh for Claude).
type PersistListener = (rows: Project[]) => void
const persistListeners: PersistListener[] = []

export function onPersist(listener: PersistListener): void {
  persistListeners.push(listener)
}

function file(): string {
  return join(app.getPath('userData'), 'projects.json')
}

function readJson(path: string): Project[] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? (parsed as Project[]) : null
  } catch {
    return null // missing or corrupt — recoverRegistry() decides what to do
  }
}

function load(): Project[] {
  if (cache) return cache
  const f = file()
  const { rows, preserveCorruptMain } = recoverRegistry(readJson(f), existsSync(f), readJson(`${f}.bak`))
  // A corrupt main file is moved aside (never silently overwritten) so it stays
  // recoverable and the next persist() can't make the data loss permanent.
  if (preserveCorruptMain) {
    try {
      renameSync(f, `${f}.corrupt-${Date.now()}`)
    } catch {
      /* best-effort */
    }
  }
  cache = rows
  return cache
}

export function allProjects(): Project[] {
  return load()
}

export function persist(rows: Project[]): void {
  cache = rows
  const f = file()
  mkdirSync(dirname(f), { recursive: true })
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8')
  // Keep the last good copy as .bak, then atomically replace (MoveFileEx on Windows).
  try {
    if (existsSync(f)) copyFileSync(f, `${f}.bak`)
  } catch {
    /* best-effort backup */
  }
  renameSync(tmp, f)
  for (const listener of persistListeners) {
    try {
      listener(rows)
    } catch {
      /* a listener must never break a save */
    }
  }
}
