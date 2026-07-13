import { ipcMain } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { allProjects } from './db'
import { defaultHandoffFilename, generateHandoff } from '../shared/handoff'
import type { HandoffInput, HandoffSaveResult } from '../shared/types'

// Save a generated Claude Code handoff into the project folder. The renderer
// only sends a project *id* — the path is resolved from the registry here, so
// the renderer can never write outside a registered project.

/** The handoff filename is only date + slug, so a second handoff on the same
 *  day for a slug-equivalent title ("Fix login!" vs "fix login") would land on
 *  the same path. Suffix -2, -3 … rather than silently clobbering the first. */
function uniquePath(dir: string, filename: string): string {
  const base = filename.replace(/\.md$/, '')
  let candidate = join(dir, filename)
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${base}-${n}.md`)
  return candidate
}

export function registerHandoffIpc(): void {
  ipcMain.handle('handoff:save', (_e, projectId: string, input: HandoffInput): HandoffSaveResult => {
    const project = allProjects().find((p) => p.id === projectId)
    if (!project) return { ok: false, error: 'Project not found in the registry' }
    // Without this, mkdirSync(recursive) would happily re-create a project
    // folder the user had deleted on disk and leave a lone handoffs/ behind.
    if (!existsSync(project.path))
      return { ok: false, error: `Project folder no longer exists: ${project.path}` }
    try {
      const dir = join(project.path, 'handoffs')
      mkdirSync(dir, { recursive: true })
      const file = uniquePath(dir, defaultHandoffFilename(input.taskTitle))
      writeFileSync(file, generateHandoff(project, input), 'utf8')
      return { ok: true, path: file }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
