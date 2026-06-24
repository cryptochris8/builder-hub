import type { LaunchKind, Project } from '@shared/types'
import { PROJECT_TYPES, TYPE_META } from '@shared/types'

export function Dashboard({
  projects,
  onOpen,
  onLaunch
}: {
  projects: Project[]
  onOpen: (p: Project) => void
  onLaunch: (kind: LaunchKind, p: Project) => void
}) {
  const counts = PROJECT_TYPES.map((t) => ({ t, n: projects.filter((p) => p.type === t).length })).filter(
    (x) => x.n > 0
  )
  const favorites = projects.filter((p) => p.favorite)
  const recent = [...projects]
    .filter((p) => p.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt as number) - (a.lastOpenedAt as number))
    .slice(0, 6)

  const Row = ({ p }: { p: Project }) => (
    <div
      onClick={() => onOpen(p)}
      className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 hover:bg-white/5"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-slate-200">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TYPE_META[p.type].dot}`} />
        <span className="truncate">{p.name}</span>
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

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Projects" value={projects.length} />
        <Stat label="Favorites" value={favorites.length} />
        <Stat label="Types" value={counts.length} />
        <Stat label="Recently opened" value={recent.length} />
      </div>

      <div className="flex flex-wrap gap-2">
        {counts.map(({ t, n }) => (
          <span key={t} className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-1.5 text-xs text-slate-300">
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
            {recent.length ? recent.map((p) => <Row key={p.id} p={p} />) : <Empty text="Open a project to see it here." />}
          </div>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">Favorites</h2>
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-1">
            {favorites.length ? favorites.map((p) => <Row key={p.id} p={p} />) : <Empty text="Star a project to pin it here." />}
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-6 text-center text-xs text-slate-600">{text}</div>
}
