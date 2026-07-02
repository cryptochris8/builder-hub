import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { basename, dirname, join } from 'path'
import { allProjects } from './db'
import { killPtysUnder } from './pty'
import { isPathInside } from '../shared/hubLogic'
import {
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_DIR_SUFFIX,
  hubWorktrees,
  normPath,
  parseWorktreeList,
  sanitizeBranch
} from '../shared/sessionLogic'
import type { GitActionResult, WorktreeCreateResult, WorktreeDiffResult, WorktreeInfo } from '../shared/types'

// Tier-2 cockpit, part (c): per-task git worktrees. Each task gets its own
// branch (hub/<task>) checked out in <project>.worktrees/<task>, so a Claude
// session can work in isolation while the main checkout stays untouched. The
// diff tab reviews the worktree against its merge-base with the main branch;
// merge-back happens in the MAIN checkout via a normal git merge.
//
// All paths leaving this module are backslash-normalized: git porcelain emits
// forward slashes on Windows, but hook cwds and path.join() emit backslashes,
// and the renderer keys sessions by cwd.

const RUN_TIMEOUT_MS = 15_000
const DIFF_CAP = 1024 * 1024 // 1 MB of diff text is plenty for review

const toWin = (p: string): string => p.replace(/\//g, '\\')

interface RunResult {
  ok: boolean
  out: string
  err: string
}

function run(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ ok: !error, out: stdout ?? '', err: (stderr || error?.message) ?? '' })
    )
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Renderer input is untrusted — only operate on registered project roots, and
// only on worktrees that git itself reports for that project (mirrors the
// files.ts isAllowedPath defense-in-depth).
function isRegisteredProject(projectPath: string): boolean {
  return allProjects().some((p) => isPathInside(projectPath, p.path) && isPathInside(p.path, projectPath))
}

async function isKnownWorktree(projectPath: string, worktreePath: string): Promise<boolean> {
  const tasks = await list(projectPath)
  return tasks.some((w) => normPath(w.path) === normPath(worktreePath))
}

function worktreeDirFor(projectPath: string, task: string): string {
  return join(dirname(projectPath), basename(projectPath) + WORKTREE_DIR_SUFFIX, task)
}

async function list(projectPath: string): Promise<WorktreeInfo[]> {
  if (!isRegisteredProject(projectPath)) return []
  const res = await run(projectPath, ['worktree', 'list', '--porcelain'])
  if (!res.ok) return []
  // slice(1): the first porcelain entry is always the MAIN worktree — even if
  // someone checked out hub/<task> there, it must never be listed as a task.
  return hubWorktrees(parseWorktreeList(res.out).slice(1)).map((w) => ({ ...w, path: toWin(w.path) }))
}

async function create(projectPath: string, taskInput: string): Promise<WorktreeCreateResult> {
  if (!isRegisteredProject(projectPath)) return { ok: false, error: 'Not a registered project' }
  const task = sanitizeBranch(taskInput)
  const branch = WORKTREE_BRANCH_PREFIX + task
  const dir = worktreeDirFor(projectPath, task)
  try {
    mkdirSync(dirname(dir), { recursive: true })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const res = await run(projectPath, ['worktree', 'add', '-b', branch, dir])
  if (!res.ok) {
    const msg = res.err.includes('already exists')
      ? `Task "${task}" already exists — pick a different name, or remove the old one first.`
      : res.err.trim() || 'git worktree add failed'
    return { ok: false, error: msg }
  }
  // The Hub-seeded CLAUDE.md is usually uncommitted, so a fresh worktree (which
  // only has committed files) would start its Claude session without stack
  // context. Copy it over (best-effort; shows as untracked in the diff tab).
  try {
    const src = join(projectPath, 'CLAUDE.md')
    const dst = join(dir, 'CLAUDE.md')
    if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst)
  } catch {
    /* non-fatal */
  }
  return { ok: true, path: dir, branch }
}

// The branch checked out in the MAIN checkout — what a task diff/merge should
// target. null when detached (rebase/bisect/checked-out tag) or on the task
// branch itself; callers surface a clear error instead of guessing.
async function mainBranch(projectPath: string): Promise<string | null> {
  const res = await run(projectPath, ['symbolic-ref', '--short', 'HEAD'])
  const branch = res.ok ? res.out.trim() : ''
  return branch || null
}

const DETACHED_MSG =
  "The project's main checkout isn't on a branch (detached HEAD — rebase/bisect/tag?). Check out a branch there first."

async function diff(projectPath: string, worktreePath: string): Promise<WorktreeDiffResult> {
  if (!isRegisteredProject(projectPath)) return { ok: false, error: 'Not a registered project' }
  if (!(await isKnownWorktree(projectPath, worktreePath)))
    return { ok: false, error: 'Unknown task worktree' }
  const base = await mainBranch(projectPath)
  if (!base) return { ok: false, error: DETACHED_MSG }
  if (base.startsWith(WORKTREE_BRANCH_PREFIX)) {
    return { ok: false, error: `The main checkout is on ${base} — switch it back to your main branch first.` }
  }
  const mb = await run(worktreePath, ['merge-base', 'HEAD', base])
  if (!mb.ok) return { ok: false, error: mb.err.trim() || 'merge-base failed' }
  const mergeBase = mb.out.trim()
  // Diff against the branch point, INCLUDING uncommitted changes in the worktree.
  const d = await run(worktreePath, ['diff', '--no-color', mergeBase])
  // An >8MB diff overflows execFile's maxBuffer — Node still delivers the
  // partial stdout, so treat it as truncation, not failure.
  const overflowed = !d.ok && d.err.includes('maxBuffer') && d.out.length > 0
  if (!d.ok && !overflowed) return { ok: false, error: d.err.trim() || 'git diff failed' }
  // Untracked via ls-files -z: raw NUL-separated paths (porcelain C-quotes
  // names with spaces/non-ASCII).
  const ls = await run(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])
  const untracked = ls.ok ? ls.out.split('\0').filter(Boolean) : []
  return {
    ok: true,
    diff: d.out.slice(0, DIFF_CAP),
    untracked,
    baseBranch: base,
    truncated: overflowed || d.out.length > DIFF_CAP
  }
}

// Merge the task branch back — runs in the MAIN checkout. Only commits merge;
// uncommitted work in the worktree stays behind (the UI says so).
async function merge(projectPath: string, branch: string): Promise<GitActionResult> {
  if (!isRegisteredProject(projectPath)) return { ok: false, error: 'Not a registered project' }
  if (!branch.startsWith(WORKTREE_BRANCH_PREFIX)) return { ok: false, error: 'Not a hub task branch' }
  const base = await mainBranch(projectPath)
  if (!base) return { ok: false, error: DETACHED_MSG }
  if (base.startsWith(WORKTREE_BRANCH_PREFIX)) {
    return { ok: false, error: `The main checkout is on ${base} — switch it back to your main branch first.` }
  }
  // Never touch a merge the USER already has in progress — aborting it would
  // throw away their conflict-resolution work.
  const inMerge = await run(projectPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  if (inMerge.ok) {
    return {
      ok: false,
      error: 'The main checkout has an unfinished merge in progress — finish or abort it first.'
    }
  }
  const res = await run(projectPath, ['merge', '--no-ff', branch, '-m', `Merge task ${branch}`])
  if (!res.ok) {
    // Abort only OUR merge attempt (we verified no merge was in progress above)
    // so the main checkout stays clean; surface the conflict text instead.
    await run(projectPath, ['merge', '--abort'])
    return { ok: false, error: res.out.trim() || res.err.trim() || 'merge failed', output: res.out }
  }
  return { ok: true, output: res.out.trim() }
}

async function remove(
  projectPath: string,
  worktreePath: string,
  branch: string,
  force: boolean
): Promise<GitActionResult> {
  if (!isRegisteredProject(projectPath)) return { ok: false, error: 'Not a registered project' }
  if (!branch.startsWith(WORKTREE_BRANCH_PREFIX)) return { ok: false, error: 'Not a hub task branch' }
  if (!(await isKnownWorktree(projectPath, worktreePath)))
    return { ok: false, error: 'Unknown task worktree' }

  // Windows can't delete a process's cwd — evict the task's terminal sessions
  // first, then retry briefly while ConPTY teardown releases the handle.
  killPtysUnder(worktreePath)
  const args = force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath]
  let res = await run(projectPath, args)
  for (let attempt = 0; !res.ok && attempt < 4; attempt++) {
    const retryable = /Permission denied|failed to delete|Directory not empty/i.test(res.err)
    if (!retryable) break
    await sleep(300)
    res = await run(projectPath, args)
  }
  if (!res.ok) {
    const msg = res.err.trim()
    return {
      ok: false,
      error: msg.includes('contains modified or untracked files')
        ? 'The worktree has uncommitted work — commit it in its Claude session, or use Discard to delete it anyway.'
        : msg || 'git worktree remove failed'
    }
  }
  // Branch cleanup: -d after a merge (safe), -D when discarding unmerged work.
  const del = await run(projectPath, ['branch', force ? '-D' : '-d', branch])
  if (!del.ok) {
    return {
      ok: true,
      output: force
        ? `Worktree removed, but branch ${branch} couldn't be deleted: ${del.err.trim()}`
        : `Worktree removed. Branch ${branch} kept (not fully merged) — merge it or discard it later.`
    }
  }
  return { ok: true, output: `Removed ${branch}` }
}

export function registerWorktreeIpc(): void {
  ipcMain.handle('worktree:list', (_e, projectPath: string) => list(projectPath))
  ipcMain.handle('worktree:create', (_e, projectPath: string, task: string) => create(projectPath, task))
  ipcMain.handle('worktree:diff', (_e, projectPath: string, worktreePath: string) =>
    diff(projectPath, worktreePath)
  )
  ipcMain.handle('worktree:merge', (_e, projectPath: string, branch: string) => merge(projectPath, branch))
  ipcMain.handle(
    'worktree:remove',
    (_e, projectPath: string, worktreePath: string, branch: string, force: boolean) =>
      remove(projectPath, worktreePath, branch, force)
  )
}
