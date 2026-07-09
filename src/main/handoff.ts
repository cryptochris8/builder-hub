import { ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { allProjects } from './db'
import { defaultHandoffFilename, generateHandoff } from '../shared/handoff'
import type { HandoffInput, HandoffSaveResult } from '../shared/types'

// Save a generated Claude Code handoff into the project folder. The renderer
// only sends a project *id* — the path is resolved from the registry here, so
// the renderer can never write outside a registered project.

export function registerHandoffIpc(): void {
  ipcMain.handle('handoff:save', (_e, projectId: string, input: HandoffInput): HandoffSaveResult => {
    const project = allProjects().find((p) => p.id === projectId)
    if (!project) return { ok: false, error: 'Project not found in the registry' }
    try {
      const dir = join(project.path, 'handoffs')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, defaultHandoffFilename(input.taskTitle))
      writeFileSync(file, generateHandoff(project, input), 'utf8')
      return { ok: true, path: file }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
