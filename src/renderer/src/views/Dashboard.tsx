import type { ClaudeStatusEvent, GitStatus, LaunchKind, Project } from '@shared/types'
import { PROJECT_TYPES, TYPE_META } from '@shared/types'
import { calculateFocusScore, calculateHealth, rankByFocus } from '@shared/scoring'
import { resolveSessionProject } from '@shared/sessionLogic'
import { GitBadge } from '@/components/GitBadge'

const HEALTH_DOT: Record<string, string> = {
  green: 'bg-emerald-400',
  yellow: 'bg-amber-400',
  red: 'bg-rose-400'
}

const STATE_META: Record<string, { dot: string; label: string; text: string }> = {
  working: { dot: 'bg-sky-400 animate-pulse', label: 'working', text: 'text-sky-300' },
  waiting: { dot: 'bg-amber-400 animate-pulse', label: 'waiting for you', text: 'text-amber-300' },
  done: { dot: 'bg-emerald-400', label: 'done', text: 'text-emerald-300' }
}

function relTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export function Dashboard({
  projects,
  git,
  statuses,
  onOpen,
  onLaunch,
  onFocusSession,
  onDismissStatus
}: {
  projects: Project[]
  git: Record<string, GitStatus>
  statuses: Record<string, ClaudeStatusEvent>
  onOpen: (p: Project) => void
  onLaunch: (kind: LaunchKind, p: Project) => void
  onFocusSession: (cwd: string) => void
  onDismissStatus: (cwd: string) => void
}) {
  const counts = PROJECT_TYPES.map((t) => ({ t, n: projects.filter((p) => p.type === t).length })).filter(
    (x) => x.n > 0
  )
  const favorites = projects.filter((p) => p.favorite)
  const recent = [...projects]
    .filter((p) => p.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt as number) - (a.lastOpenedAt as number))
    .slice(0, 6)
  // Projects with uncommitted work — the most actionable triage signal.
  const dirty = projects.filter((p) => (git[p.id]?.dirty ?? 0) > 0)
  // Today's Focus — active projects ranked by focus score (FounderOS harvest).
  const focus = rankByFocus(projects).slice(0, 5)
  const blocked = projects.filter((p) => p.status === 'active' && (p.blockers?.length ?? 0) > 0)
  // Live Claude sessions (hooks-fed), waiting first, then working, then done.
  const order: Record<string, number> = { waiting: 0, working: 1, done: 2 }
  const sessions = Object.values(statuses)
    .filter((s) => s.state !== 'ended')
    .sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || b.at - a.at)

  const Row = ({ p }: { p: Project }) => (
    <div
      onClick={() => onOpen(p)}
      className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-white/5"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-slate-200">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TYPE_META[p.type].dot}`} />
        <span className="truncate">{p.name}</span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <GitBadge status={git[p.id]} />
        <button
          onClick={(e) => {
            e.stopPropagation()
            onLaunch('claude', p)
          }}
          className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-slate-300 hover:bg-indigo-500/80 hover:text-white"
        >
          ▸ Claude
        </button>
      </span>
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Projects" value={projects.length} />
        <Stat label="Favorites" value={favorites.length} />
        <Stat label="Types" value={counts.length} />
        <Stat label="Recently opened" value={recent.length} />
        <Stat label="Uncommitted" value={dirty.length} accent={dirty.length > 0} />
        <Stat label="Blocked" value={blocked.length} accent={blocked.length > 0} />
      </div>

      {focus.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">
            Today&apos;s focus
          </h2>
          <div className="rounded-xl border border-indigo-400/20 bg-indigo-400/[0.03] p-1">
            {focus.map((p, i) => {
              const health = calculateHealth(p)
              return (
                <div
                  key={p.id}
                  onClick={() => onOpen(p)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/5"
                >
                  <span className="w-4 shrink-0 text-right text-[11px] text-slate-600">{i + 1}</span>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${TYPE_META[p.type].dot}`} />
                  <span className="min-w-0 truncate text-sm text-slate-200">{p.name}</span>
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${HEALTH_DOT[health.status]}`}
                    title={health.reasons.join(' · ')}
                  />
                  {p.nextAction && (
                    <span className="min-w-0 truncate text-xs text-slate-500" title={p.nextAction}>
                      → {p.nextAction}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-xs font-semibold text-indigo-300">
                    {calculateFocusScore(p).toFixed(1)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onLaunch('claude', p)
                    }}
                    className="shrink-0 rounded-md bg-white/5 px-2 py-1 text-[11px] text-slate-300 hover:bg-indigo-500/80 hover:text-white"
                  >
                    ▸ Claude
                  </button>
                </div>
              )
            })}
          </div>
          <p className="mt-1 text-[10px] text-slate-600">
            Ranked by focus score — set stage, scores &amp; blockers in each project&apos;s detail panel.
          </p>
        </div>
      )}

      {sessions.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">Claude sessions</h2>
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-1">
            {sessions.map((s) => {
              const meta = STATE_META[s.state] ?? STATE_META.done
              const { label } = resolveSessionProject(s.cwd, projects)
              return (
                <div
                  key={s.cwd.toLowerCase()}
                  onClick={() => onFocusSession(s.cwd)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/5"
                  title={s.cwd}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                  <span className="min-w-0 truncate text-sm text-slate-200">{label}</span>
                  <span className={`shrink-0 text-xs ${meta.text}`}>{meta.label}</span>
                  {s.message && s.state === 'waiting' && (
                    <span className="min-w-0 truncate text-xs text-slate-500">{s.message}</span>
                  )}
                  <span className="ml-auto shrink-0 text-[11px] text-slate-600">{relTime(s.at)}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDismissStatus(s.cwd)
                    }}
                    className="shrink-0 text-slate-600 hover:text-slate-300"
                    title="Dismiss"
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {dirty.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">
            Uncommitted work
          </h2>
          <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.03] p-1">
            {dirty.map((p) => (
              <Row key={p.id} p={p} />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {counts.map(({ t, n }) => (
          <span
            key={t}
            className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-1.5 text-xs text-slate-300"
          >
            <span className={`h-2 w-2 rounded-full ${TYPE_META[t].dot}`} />
            {TYPE_META[t].label}
            <span className="text-slate-500">{n}</span>
          </span>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">Recent</h2>
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-1">
            {recent.length ? (
              recent.map((p) => <Row key={p.id} p={p} />)
            ) : (
              <Empty text="Open a project to see it here." />
            )}
          </div>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">Favorites</h2>
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-1">
            {favorites.length ? (
              favorites.map((p) => <Row key={p.id} p={p} />)
            ) : (
              <Empty text="Star a project to pin it here." />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        accent ? 'border-amber-400/30 bg-amber-400/[0.04]' : 'border-white/5 bg-white/[0.02]'
      }`}
    >
      <div className={`text-2xl font-semibold ${accent ? 'text-amber-300' : 'text-white'}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-6 text-center text-xs text-slate-600">{text}</div>
}
