import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// canonStore only needs electron for the home path; the root comes from the env here.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { canonPaths, loadDecisions, readVision, saveDecisions, freshDecisionId } from './canonStore'
import { applyDecisionRequest } from '../shared/decisions'
import type { Project } from '../shared/types'

const project = { id: 'proj-1', name: 'Open Claw', path: 'C:/x', type: 'other' } as unknown as Project
const other = { id: 'proj-2', name: 'Open Claw', path: 'C:/y', type: 'other' } as unknown as Project
let root = ''
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'canon-'))
  process.env.BUILDER_HUB_CANON_ROOT = root
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(root, 'unrelated.txt'), 'staged work of another session')
  git('add', 'unrelated.txt')
})

afterAll(() => {
  delete process.env.BUILDER_HUB_CANON_ROOT
  rmSync(root, { recursive: true, force: true })
})

describe('canonStore', () => {
  it('writes jsonl + markdown + index and commits ONLY those files', async () => {
    const now = Date.now()
    const r = applyDecisionRequest(
      [],
      { action: 'propose', topic: 'canon', statement: 'Central repo' },
      {
        projectId: project.id,
        now,
        by: 'hub-ui',
        newId: () => freshDecisionId(now),
        founderInputs: []
      }
    )
    const saved = await saveDecisions(project, r.decisions, 'decision: test')
    expect(saved.ok).toBe(true)
    expect(saved.committed).toBe(true)
    expect(saved.paths.folder).toBe('open-claw')
    const committed = git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()
    expect(committed).toEqual([
      'knowledge/index.json',
      'knowledge/open-claw/DECISIONS.md',
      'knowledge/open-claw/decisions.jsonl'
    ])
    // the other session's staged file is still staged, not swept into our commit
    expect(git('diff', '--cached', '--name-only')).toBe('unrelated.txt')
    expect(loadDecisions(project)).toHaveLength(1)
    expect(readFileSync(saved.paths.decisionsMd, 'utf8')).toContain('Central repo')
  })

  it('gives a second project with the same name its own folder', async () => {
    const saved = await saveDecisions(other, [], 'decision: empty')
    expect(saved.paths.folder).toBe('open-claw-2')
    expect(canonPaths(project).folder).toBe('open-claw')
    const index = JSON.parse(readFileSync(join(root, 'knowledge', 'index.json'), 'utf8'))
    expect(Object.keys(index.projects).sort()).toEqual(['proj-1', 'proj-2'])
  })

  it('reads VISION.md without headings', () => {
    expect(readVision(project)).toBeUndefined()
    writeFileSync(canonPaths(project).vision, '# Vision\n_note_\nMake films people love.\nKeep it warm.\n')
    expect(readVision(project)).toBe('Make films people love. Keep it warm.')
  })

  it('reports (not throws) when the root is not a git repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'canon-plain-'))
    process.env.BUILDER_HUB_CANON_ROOT = plain
    try {
      const saved = await saveDecisions(project, [], 'decision: x')
      expect(saved.ok).toBe(true)
      expect(saved.committed).toBe(false)
      expect(saved.error).toMatch(/not a git repo/)
      expect(existsSync(join(plain, 'knowledge', 'open-claw', 'decisions.jsonl'))).toBe(true)
    } finally {
      process.env.BUILDER_HUB_CANON_ROOT = root
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
