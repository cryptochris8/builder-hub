import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { readJsonFile, writeAtomic } from './fsAtomic'
import {
  applyContextPatch,
  emptyProjectContext,
  normalizeProjectContext,
  renderProjectContextMarkdown
} from '../shared/contextLogic'
import type { ContextFreshness, Project, ProjectContext, ProjectContextPatch } from '../shared/types'

// Persistent, model-independent project context — context.json in userData
// (atomic writes, .bak), plus a human-readable render per project under
// ~/.claude/builder-hub/context/<projectId>.md that any Claude session can read
// on demand. Rebuildable: deleting either only loses accumulated notes; the
// auto fields come back on the next Reindex.

interface ContextFile {
  version: 1
  projects: Record<string, ProjectContext>
}

let cache: Record<string, ProjectContext> | null = null

function file(): string {
  return join(app.getPath('userData'), 'context.json')
}

/** Where the per-project markdown renders live (Claude reads these). */
export function contextDir(): string {
  return join(app.getPath('home'), '.claude', 'builder-hub', 'context')
}

export function contextFilePath(projectId: string): string {
  return join(contextDir(), `${projectId}.md`)
}

function load(): Record<string, ProjectContext> {
  if (cache) return cache
  const f = file()
  let raw = readJsonFile(f)
  if (!raw && existsSync(f)) raw = readJsonFile(`${f}.bak`) // corrupt main → last good copy
  const out: Record<string, ProjectContext> = {}
  const projects = (raw as Partial<ContextFile> | null)?.projects
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const [id, value] of Object.entries(projects)) {
      const ctx = normalizeProjectContext(value, id)
      if (ctx) out[id] = ctx
    }
  }
  cache = out
  return cache
}

function persist(): { ok: boolean; error?: string } {
  const data: ContextFile = { version: 1, projects: load() }
  try {
    writeAtomic(file(), JSON.stringify(data, null, 2), true)
    return { ok: true }
  } catch (e) {
    console.error('[builder-hub] could not save context.json:', e)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function getContext(projectId: string): ProjectContext | undefined {
  return load()[projectId]
}

export function getOrCreateContext(projectId: string, now = Date.now()): ProjectContext {
  const all = load()
  if (!all[projectId]) all[projectId] = emptyProjectContext(projectId, now)
  return all[projectId]
}

/** Replace a project's context and persist. Returns the stored copy. */
export function saveContext(ctx: ProjectContext): { ok: boolean; error?: string; context: ProjectContext } {
  const all = load()
  all[ctx.projectId] = ctx
  const res = persist()
  return { ...res, context: ctx }
}

export function patchContext(
  projectId: string,
  patch: ProjectContextPatch,
  now = Date.now()
): ProjectContext {
  const next = applyContextPatch(getOrCreateContext(projectId, now), patch, now)
  saveContext(next)
  return next
}

export function deleteContext(projectId: string): void {
  const all = load()
  if (projectId in all) {
    delete all[projectId]
    persist()
  }
}

/** Best-effort render of the human-readable context file. Never throws. */
export function renderContextFile(project: Project, ctx: ProjectContext, freshness?: ContextFreshness): void {
  try {
    const today = new Date().toISOString().slice(0, 10)
    writeAtomic(
      contextFilePath(project.id),
      renderProjectContextMarkdown(project, ctx, freshness, today),
      false
    )
  } catch (e) {
    console.error('[builder-hub] could not render context file:', e)
  }
}
