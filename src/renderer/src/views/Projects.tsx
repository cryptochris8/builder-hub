import { useMemo, useState } from 'react'
import type { GitStatus, LaunchKind, Project, ProjectType } from '@shared/types'
import { PROJECT_TYPES, TYPE_META } from '@shared/types'
import { ProjectCard } from '@/components/ProjectCard'

export function Projects({
  projects,
  git,
  onOpen,
  onToggleFav,
  onLaunch,
  onAdd,
  onRescan
}: {
  projects: Project[]
  git: Record<string, GitStatus>
  onOpen: (p: Project) => void
  onToggleFav: (p: Project) => void
  onLaunch: (kind: LaunchKind, p: Project) => void
  onAdd: () => void
  onRescan: () => void
}) {
  const [filter, setFilter] = useState<ProjectType | 'all'>('all')
  const [q, setQ] = useState('')

  const typesPresent = PROJECT_TYPES.filter((t) => projects.some((p) => p.type === t))
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return projects.filter(
      (p) =>
        (filter === 'all' || p.type === filter) &&
        (needle === '' || `${p.name} ${p.stack}`.toLowerCase().includes(needle))
    )
  }, [projects, filter, q])

  const chip = (active: boolean): string =>
    `rounded-full px-3 py-1 text-xs transition ${active ? 'bg-white/15 text-white' : 'bg-white/5 text-slate-400 hover:text-slate-200'}`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects…"
          className="w-56 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-indigo-400"
        />
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setFilter('all')} className={chip(filter === 'all')}>
            All
          </button>
          {typesPresent.map((t) => (
            <button key={t} onClick={() => setFilter(t)} className={chip(filter === t)}>
              {TYPE_META[t].label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={onAdd}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
            title="Add an existing folder to the registry"
          >
            ＋ Add existing
          </button>
          <button
            onClick={onRescan}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
            title="Scan C:\\Users\\chris for new project folders"
          >
            ⟳ Rescan home
          </button>
        </div>
      </div>

      {visible.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              git={git[p.id]}
              onOpen={onOpen}
              onToggleFav={onToggleFav}
              onLaunch={onLaunch}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-white/10 px-6 py-16 text-center text-sm text-slate-500">
          No projects match. Use <span className="text-slate-300">＋ New Project</span>,{' '}
          <span className="text-slate-300">＋ Add existing</span> or{' '}
          <span className="text-slate-300">⟳ Rescan home</span>.
        </div>
      )}
    </div>
  )
}
