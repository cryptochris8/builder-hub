import type { LaunchKind, Project } from '@shared/types'
import { TYPE_META } from '@shared/types'

const ACTIONS: { kind: LaunchKind; label: string; icon: string }[] = [
  { kind: 'claude', label: 'Claude', icon: '▸' },
  { kind: 'viewer', label: 'Viewer', icon: '🌐' },
  { kind: 'editor', label: 'Editor', icon: '⌨' },
  { kind: 'folder', label: 'Folder', icon: '🗁' }
]

export function ProjectCard({
  project,
  onOpen,
  onToggleFav,
  onLaunch
}: {
  project: Project
  onOpen: (p: Project) => void
  onToggleFav: (p: Project) => void
  onLaunch: (kind: LaunchKind, p: Project) => void
}) {
  const meta = TYPE_META[project.type]
  return (
    <article
      onClick={() => onOpen(project)}
      className="group flex cursor-pointer flex-col rounded-xl border border-white/5 bg-white/[0.02] p-4 transition hover:border-white/10 hover:bg-white/[0.04]"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-white">
          <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
          <span className="truncate">{project.name}</span>
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleFav(project)
          }}
          title={project.favorite ? 'Unfavorite' : 'Favorite'}
          className={`shrink-0 text-base leading-none ${project.favorite ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'}`}
        >
          {project.favorite ? '★' : '☆'}
        </button>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-slate-400">{meta.label}</span>
        <span className="truncate text-xs text-slate-500">{project.stack || project.path}</span>
      </div>

      <div className="mt-auto flex flex-wrap gap-1.5">
        {ACTIONS.map((a) => (
          <button
            key={a.kind}
            onClick={(e) => {
              e.stopPropagation()
              onLaunch(a.kind, project)
            }}
            className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-slate-300 transition hover:bg-indigo-500/80 hover:text-white"
          >
            <span className="mr-1">{a.icon}</span>
            {a.label}
          </button>
        ))}
      </div>
    </article>
  )
}
