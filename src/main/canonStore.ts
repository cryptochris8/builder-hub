import { app } from 'electron'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { writeAtomic, readJsonFile } from './fsAtomic'
import {
  canonFolderSlug,
  parseDecisionsJsonl,
  renderDecisionsMarkdown,
  serializeDecisionsJsonl,
  newDecisionId
} from '../shared/decisions'
import type { Decision } from '../shared/decisions'
import type { Project } from '../shared/types'

// The canon repo: founder decisions (and later VISION/CURRENT_STATE) for every
// project, in ONE git repo, one folder per project (Chris, 2026-11-04: "One
// central git repo"; project repos are never touched).
//
//   <root>/knowledge/index.json                 projectId -> folder
//   <root>/knowledge/<folder>/decisions.jsonl   the source of truth
//   <root>/knowledge/<folder>/DECISIONS.md      rendered view
//   <root>/knowledge/<folder>/VISION.md         founder-written (optional; read only here)
//
// Every write is atomic and is committed BY FILE NAME (never `git add -A`), so
// other work in the same repo is never swept into a decision commit. The root
// defaults to ~/studio-memory (GitHub: cryptochris8/studio-memory, private);
// BUILDER_HUB_CANON_ROOT overrides it.

const GIT_TIMEOUT_MS = 10_000

export function canonRoot(): string {
  const env = (process.env.BUILDER_HUB_CANON_ROOT ?? '').trim()
  return env || join(app.getPath('home'), 'studio-memory')
}

function knowledgeDir(): string {
  return join(canonRoot(), 'knowledge')
}

function indexFile(): string {
  return join(knowledgeDir(), 'index.json')
}

interface CanonIndex {
  version: 1
  projects: Record<string, { folder: string; name: string }>
}

function loadIndex(): CanonIndex {
  const raw = readJsonFile(indexFile())
  const out: CanonIndex = { version: 1, projects: {} }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const p = (raw as { projects?: unknown }).projects
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const [id, v] of Object.entries(p as Record<string, unknown>)) {
        const folder = v && typeof v === 'object' ? (v as { folder?: unknown }).folder : undefined
        const name = v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined
        if (typeof folder === 'string' && /^[a-z0-9-]{1,80}$/.test(folder)) {
          out.projects[id] = { folder, name: typeof name === 'string' ? name : folder }
        }
      }
    }
  }
  return out
}

/** The project's folder name, allocating (and recording) one on first use. */
function folderFor(project: Project, index: CanonIndex): { folder: string; isNew: boolean } {
  const known = index.projects[project.id]
  if (known) return { folder: known.folder, isNew: false }
  const taken = new Set(Object.values(index.projects).map((p) => p.folder))
  const base = canonFolderSlug(project.name)
  let folder = base
  for (let i = 2; taken.has(folder); i++) folder = `${base}-${i}`
  return { folder, isNew: true }
}

export interface CanonPaths {
  root: string
  folder: string
  decisionsJsonl: string
  decisionsMd: string
  vision: string
}

export function canonPaths(project: Project): CanonPaths {
  const { folder } = folderFor(project, loadIndex())
  const dir = join(knowledgeDir(), folder)
  return {
    root: canonRoot(),
    folder,
    decisionsJsonl: join(dir, 'decisions.jsonl'),
    decisionsMd: join(dir, 'DECISIONS.md'),
    vision: join(dir, 'VISION.md')
  }
}

export function loadDecisions(project: Project): Decision[] {
  const { decisionsJsonl } = canonPaths(project)
  if (!existsSync(decisionsJsonl)) return []
  try {
    return parseDecisionsJsonl(readFileSync(decisionsJsonl, 'utf8'), project.id)
  } catch {
    return []
  }
}

/** First ~1,500 chars of VISION.md (founder-written), or undefined. */
export function readVision(project: Project): string | undefined {
  const { vision } = canonPaths(project)
  if (!existsSync(vision)) return undefined
  try {
    const text = readFileSync(vision, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !l.startsWith('#') && !l.startsWith('_'))
      .join(' ')
      .trim()
    return text ? text.slice(0, 1500) : undefined
  } catch {
    return undefined
  }
}

export function freshDecisionId(now: number): string {
  return newDecisionId(now, randomBytes(2).toString('hex'))
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(err ? stderr || err.message : stdout).trim() })
    )
  })
}

// Commits are serialized: two decisions recorded at once must not race on the index.
let commitChain: Promise<unknown> = Promise.resolve()

async function commitFiles(files: string[], message: string): Promise<{ ok: boolean; error?: string }> {
  const root = canonRoot()
  if (!existsSync(join(root, '.git')))
    return { ok: false, error: `${root} is not a git repo; files written but not committed` }
  const rel = files.map((f) => relative(root, f).replace(/\\/g, '/'))
  const add = await git(root, ['add', '--', ...rel])
  if (!add.ok) return { ok: false, error: `git add failed: ${add.out}` }
  // `commit -- <paths>` commits ONLY these paths, whatever else is staged.
  const commit = await git(root, ['commit', '-m', message, '--', ...rel])
  if (!commit.ok && !/nothing (added )?to commit|no changes added/i.test(commit.out)) {
    return { ok: false, error: `git commit failed: ${commit.out}` }
  }
  return { ok: true }
}

/**
 * Write decisions.jsonl + DECISIONS.md (+ index.json on a project's first write)
 * and commit them by name. The file write is the durable part; a failed commit is
 * reported, not thrown.
 */
export async function saveDecisions(
  project: Project,
  decisions: Decision[],
  message: string
): Promise<{ ok: boolean; committed: boolean; error?: string; paths: CanonPaths }> {
  const index = loadIndex()
  const { folder, isNew } = folderFor(project, index)
  const paths = canonPaths(project)
  const dir = join(knowledgeDir(), folder)
  const files = [join(dir, 'decisions.jsonl'), join(dir, 'DECISIONS.md')]
  try {
    writeAtomic(files[0], serializeDecisionsJsonl(decisions))
    writeAtomic(files[1], renderDecisionsMarkdown(project.name, decisions))
    if (isNew || index.projects[project.id]?.name !== project.name) {
      index.projects[project.id] = { folder, name: project.name }
      writeAtomic(indexFile(), JSON.stringify(index, null, 2) + '\n')
      files.push(indexFile())
    }
  } catch (e) {
    return { ok: false, committed: false, error: e instanceof Error ? e.message : String(e), paths }
  }
  const result = (commitChain = commitChain.then(
    () => commitFiles(files, message),
    () => commitFiles(files, message)
  )) as Promise<{ ok: boolean; error?: string }>
  const c = await result
  return { ok: true, committed: c.ok, error: c.error, paths: { ...paths, folder } }
}
