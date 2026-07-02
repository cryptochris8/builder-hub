import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { parseGitStatusV2, parseLastCommit } from '../shared/projectLogic'
import type { GitStatus } from '../shared/types'

// Live per-project git status for the triage dashboard. Runs the real `git` CLI
// (no native dep), parses its porcelain output via the pure helpers in
// projectLogic, and caches briefly so re-renders / focus refreshes don't thrash
// dozens of git processes. Everything degrades gracefully: a missing git, a
// non-repo folder, or an empty repo just yields a quieter badge — never an error.

const TTL_MS = 15_000
const RUN_TIMEOUT_MS = 5_000
const CONCURRENCY = 6

const cache = new Map<string, { at: number; status: GitStatus }>()

function run(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

async function computeStatus(path: string): Promise<GitStatus> {
  // `.git` can be a directory (normal repo) or a file (worktree/submodule) — both exist().
  if (!existsSync(join(path, '.git'))) return { isRepo: false }

  const statusOut = await run(path, ['status', '--porcelain=v2', '--branch'])
  if (statusOut === null) return { isRepo: true } // git missing or errored; still a repo folder

  const ws = parseGitStatusV2(statusOut)
  const logOut = await run(path, ['log', '-1', '--format=%s%x1f%cr'])
  const last = logOut === null ? null : parseLastCommit(logOut)

  return {
    isRepo: true,
    branch: ws.branch,
    ahead: ws.hasUpstream ? ws.ahead : undefined,
    behind: ws.hasUpstream ? ws.behind : undefined,
    dirty: ws.dirty,
    lastCommit: last ?? undefined
  }
}

async function statuses(items: { id: string; path: string }[]): Promise<Record<string, GitStatus>> {
  const result: Record<string, GitStatus> = {}
  const queue = [...items]

  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const cached = cache.get(item.path)
      if (cached && Date.now() - cached.at < TTL_MS) {
        result[item.id] = cached.status
        continue
      }
      const status = await computeStatus(item.path)
      cache.set(item.path, { at: Date.now(), status })
      result[item.id] = status
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return result
}

export function registerGitIpc(): void {
  ipcMain.handle('git:statuses', (_e, items: { id: string; path: string }[]) => statuses(items))
}
