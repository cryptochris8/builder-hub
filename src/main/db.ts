import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Project } from '../shared/types'

// Local-first storage: a single JSON file in the app's userData dir.
// (Deliberately dependency-free — no native module to compile. If the registry
// ever outgrows this, swap in SQLite behind the same allProjects()/persist() API.)

let cache: Project[] | null = null

function file(): string {
  return join(app.getPath('userData'), 'projects.json')
}

function load(): Project[] {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(file(), 'utf8')) as Project[]
    } catch {
      cache = []
    }
  }
  return cache
}

export function allProjects(): Project[] {
  return load()
}

export function persist(rows: Project[]): void {
  cache = rows
  const f = file()
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(rows, null, 2), 'utf8')
}
