import { useCallback, useEffect, useState } from 'react'
import { parseUnifiedDiff } from '@shared/sessionLogic'
import type { DiffFile } from '@shared/sessionLogic'
import { hub } from '@/lib/api'

// In-app review of a task worktree: what changed vs the branch point (committed
// AND uncommitted), plus merge-back / discard actions. Kept deliberately simple —
// read the diff, then merge in one click; conflicts surface as text.

const btn =
  'shrink-0 rounded-md bg-white/5 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-white/10 disabled:opacity-40'

const LINE_CLASS: Record<string, string> = {
  add: 'bg-emerald-500/10 text-emerald-300',
  del: 'bg-rose-500/10 text-rose-300',
  hunk: 'bg-sky-500/10 text-sky-300',
  ctx: 'text-slate-400',
  meta: 'text-slate-600'
}

export function DiffPane({
  projectPath,
  worktreePath,
  branch,
  active,
  onTaskRemoved,
  notify
}: {
  projectPath: string
  worktreePath: string
  branch: string
  active: boolean
  /** the worktree+branch are gone — close related tabs */
  onTaskRemoved: () => void
  notify: (msg: string, err?: boolean) => void
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null)
  const [untracked, setUntracked] = useState<string[]>([])
  const [base, setBase] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setError(null)
    const res = await hub.worktrees.diff(projectPath, worktreePath)
    if (!res.ok) {
      setError(res.error ?? 'Could not compute the diff')
      setFiles(null)
      return
    }
    setFiles(parseUnifiedDiff(res.diff ?? ''))
    setUntracked(res.untracked ?? [])
    setBase(res.baseBranch ?? '')
    setTruncated(res.truncated ?? false)
  }, [projectPath, worktreePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Re-check when the tab becomes visible — the Claude session likely worked since.
  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  const mergeBack = async (): Promise<void> => {
    if (untracked.length > 0 || files === null) {
      /* still allow — the confirm explains what merges */
    }
    if (
      !confirm(
        `Merge ${branch} into ${base}?\n\nOnly COMMITTED work merges — uncommitted/untracked files in the worktree stay behind. Ask Claude to commit first if needed.`
      )
    )
      return
    setBusy(true)
    const res = await hub.worktrees.merge(projectPath, branch)
    setBusy(false)
    if (!res.ok) {
      notify(res.error ?? 'Merge failed', true)
      return
    }
    notify(`Merged ${branch} into ${base}`)
    if (confirm('Merged. Remove the worktree and its branch now?')) {
      setBusy(true)
      const rm = await hub.worktrees.remove(projectPath, worktreePath, branch, false)
      setBusy(false)
      if (rm.ok) {
        notify(rm.output ?? 'Task cleaned up')
        onTaskRemoved()
      } else {
        notify(rm.error ?? 'Could not remove the worktree', true)
      }
    } else {
      void refresh()
    }
  }

  const discard = async (): Promise<void> => {
    if (
      !confirm(
        `Discard task ${branch}?\n\nThis force-removes the worktree AND deletes the branch — any unmerged or uncommitted work in it is gone for good.`
      )
    )
      return
    setBusy(true)
    const res = await hub.worktrees.remove(projectPath, worktreePath, branch, true)
    setBusy(false)
    if (res.ok) {
      notify(`Discarded ${branch}`)
      onTaskRemoved()
    } else {
      notify(res.error ?? 'Could not discard the task', true)
    }
  }

  const totalAdds = (files ?? []).reduce((n, f) => n + f.adds, 0)
  const totalDels = (files ?? []).reduce((n, f) => n + f.dels, 0)

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.02]">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
        <span className="min-w-0 truncate text-xs text-slate-300" title={worktreePath}>
          <span className="text-slate-500">⇄</span> {branch}{' '}
          <span className="text-slate-600">vs {base || '…'}</span>
        </span>
        {files && (
          <span className="text-[11px]">
            <span className="text-emerald-400">+{totalAdds}</span>{' '}
            <span className="text-rose-400">−{totalDels}</span>
            <span className="text-slate-600">
              {' '}
              in {files.length} file{files.length === 1 ? '' : 's'}
            </span>
          </span>
        )}
        <span className="ml-auto flex gap-1.5">
          <button onClick={() => void refresh()} className={btn} disabled={busy} title="Re-read the diff">
            ⟳ Refresh
          </button>
          <button
            onClick={() => void mergeBack()}
            className={`${btn} !bg-emerald-600/70 !text-white hover:!bg-emerald-500`}
            disabled={busy}
            title={`git merge --no-ff ${branch} (runs in the main checkout)`}
          >
            ⇤ Merge back
          </button>
          <button
            onClick={() => void discard()}
            className={`${btn} hover:!bg-rose-500/70 hover:!text-white`}
            disabled={busy}
            title="Force-remove the worktree and delete the branch"
          >
            🗑 Discard
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error ? (
          <div className="text-xs text-rose-400/90">{error}</div>
        ) : files === null ? (
          <div className="text-xs text-slate-600">Reading diff…</div>
        ) : (
          <>
            {truncated && (
              <div className="mb-2 rounded border border-amber-400/20 bg-amber-400/5 px-2 py-1 text-[11px] text-amber-300/90">
                Huge diff — showing the first 1 MB.
              </div>
            )}
            {untracked.length > 0 && (
              <div className="mb-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Untracked (not in the diff — commit to include)
                </div>
                {untracked.map((f) => (
                  <div key={f} className="font-mono text-[11px] text-slate-400">
                    ? {f}
                  </div>
                ))}
              </div>
            )}
            {files.length === 0 && untracked.length === 0 && (
              <div className="py-10 text-center text-xs text-slate-600">
                No changes yet — this task matches {base || 'its base'}. Put its Claude session to work.
              </div>
            )}
            {files.map((f) => (
              <div key={f.path} className="mb-3 overflow-hidden rounded-lg border border-white/10">
                <div className="flex items-center gap-2 bg-white/[0.05] px-3 py-1.5 font-mono text-[11px] text-slate-200">
                  <span className="truncate">{f.path}</span>
                  {f.deleted && <span className="text-rose-400">deleted</span>}
                  {f.binary && <span className="text-slate-500">binary</span>}
                  <span className="ml-auto shrink-0">
                    <span className="text-emerald-400">+{f.adds}</span>{' '}
                    <span className="text-rose-400">−{f.dels}</span>
                  </span>
                </div>
                {!f.binary && (
                  <pre className="overflow-x-auto whitespace-pre bg-black/20 py-1 font-mono text-[11px] leading-[1.4]">
                    {f.lines.map((l, i) => (
                      <div key={i} className={`px-3 ${LINE_CLASS[l.t]}`}>
                        {l.text || ' '}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
