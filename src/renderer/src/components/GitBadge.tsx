import type { GitStatus } from '@shared/types'

// Compact, glanceable git state for a project card / detail. Renders nothing for
// non-repos so the UI stays calm — only repos that need attention draw the eye.
export function GitBadge({ status }: { status?: GitStatus }) {
  if (!status || !status.isRepo) return null
  const dirty = status.dirty ?? 0
  const ahead = status.ahead ?? 0
  const behind = status.behind ?? 0

  return (
    <div className="flex min-w-0 items-center gap-2 text-[11px] text-slate-500">
      {status.branch && (
        <span className="flex min-w-0 items-center gap-1" title={`On branch ${status.branch}`}>
          <span className="text-slate-600">⎇</span>
          <span className="truncate text-slate-400">{status.branch}</span>
        </span>
      )}
      {dirty > 0 && (
        <span
          className="flex items-center gap-1 text-amber-400/90"
          title={`${dirty} uncommitted change${dirty === 1 ? '' : 's'}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          {dirty}
        </span>
      )}
      {ahead > 0 && (
        <span
          className="text-sky-400/90"
          title={`${ahead} commit${ahead === 1 ? '' : 's'} ahead of upstream`}
        >
          ↑{ahead}
        </span>
      )}
      {behind > 0 && (
        <span
          className="text-sky-400/90"
          title={`${behind} commit${behind === 1 ? '' : 's'} behind upstream`}
        >
          ↓{behind}
        </span>
      )}
      {status.lastCommit?.relative && dirty === 0 && ahead === 0 && behind === 0 && (
        <span className="truncate text-slate-600" title={status.lastCommit.subject}>
          {status.lastCommit.relative}
        </span>
      )}
    </div>
  )
}
