import type { LaunchKind, Project, ProjectStatus, ProjectType } from '@shared/types'
import { PROJECT_TYPES, TYPE_META } from '@shared/types'

const STATUSES: ProjectStatus[] = ['active', 'idea', 'archived']
const ACTIONS: { kind: LaunchKind; label: string }[] = [
  { kind: 'claude', label: '▸ Claude' },
  { kind: 'viewer', label: '🌐 Viewer' },
  { kind: 'editor', label: '⌨ Editor' },
  { kind: 'terminal', label: '❯ Terminal' },
  { kind: 'folder', label: '🗁 Folder' }
]

export function ProjectDetail({
  project,
  onClose,
  onUpdate,
  onRemove,
  onLaunch
}: {
  project: Project
  onClose: () => void
  onUpdate: (id: string, patch: Partial<Project>) => void
  onRemove: (id: string) => void
  onLaunch: (kind: LaunchKind, p: Project) => void
}) {
  const meta = TYPE_META[project.type]
  const field = 'mt-1 w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-indigo-400'
  const label = 'text-[11px] font-medium uppercase tracking-wide text-slate-500'

  return (
    <div className="fixed inset-y-0 right-0 z-20 flex w-[384px] flex-col border-l border-white/10 bg-[#0d1320] shadow-2xl">
      <div className="flex items-start justify-between border-b border-white/5 px-5 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`} />
          <h2 className="truncate text-base font-semibold text-white">{project.name}</h2>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200" title="Close">
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map((a) => (
            <button
              key={a.kind}
              onClick={() => onLaunch(a.kind, project)}
              className="rounded-md bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 transition hover:bg-indigo-500/80 hover:text-white"
            >
              {a.label}
            </button>
          ))}
          {project.type === 'roblox' && (
            <>
              <button
                onClick={() => onLaunch('studio', project)}
                className="rounded-md bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 transition hover:bg-indigo-500/80 hover:text-white"
              >
                ⬡ Studio
              </button>
              <button
                onClick={() => onLaunch('play', project)}
                className="rounded-md bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 transition hover:bg-indigo-500/80 hover:text-white"
              >
                ▶ Play in Roblox
              </button>
            </>
          )}
          <button
            onClick={() => onUpdate(project.id, { favorite: !project.favorite })}
            className={`rounded-md px-2.5 py-1.5 text-xs transition ${project.favorite ? 'bg-amber-400/20 text-amber-300' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}
          >
            {project.favorite ? '★ Favorited' : '☆ Favorite'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className={label}>Type</div>
            <select
              defaultValue={project.type}
              onChange={(e) => onUpdate(project.id, { type: e.target.value as ProjectType })}
              className={field}
            >
              {PROJECT_TYPES.map((t) => (
                <option key={t} value={t} className="bg-[#0d1320]">
                  {TYPE_META[t].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className={label}>Status</div>
            <select
              defaultValue={project.status}
              onChange={(e) => onUpdate(project.id, { status: e.target.value as ProjectStatus })}
              className={field}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} className="bg-[#0d1320]">
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <div className={label}>Stack</div>
          <input
            defaultValue={project.stack}
            placeholder="e.g. Rojo · Luau · Meshy"
            onBlur={(e) => {
              if (e.target.value !== project.stack) onUpdate(project.id, { stack: e.target.value })
            }}
            className={field}
          />
        </div>

        <div>
          <div className={label}>
            URL {project.type === 'roblox' ? '(Roblox game page or place ID)' : '(live site)'}
          </div>
          <input
            defaultValue={project.url ?? ''}
            placeholder={project.type === 'roblox' ? 'https://www.roblox.com/games/…' : 'https://…'}
            onBlur={(e) => {
              if (e.target.value !== (project.url ?? '')) onUpdate(project.id, { url: e.target.value })
            }}
            className={field}
          />
        </div>

        <div>
          <div className={label}>Notes</div>
          <textarea
            defaultValue={project.notes}
            rows={4}
            placeholder="Anything you want Claude / future-you to know…"
            onBlur={(e) => {
              if (e.target.value !== project.notes) onUpdate(project.id, { notes: e.target.value })
            }}
            className={`${field} resize-none`}
          />
        </div>

        <div>
          <div className={label}>Folder</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-black/30 px-2 py-1.5 text-xs text-slate-400">
              {project.path}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(project.path)}
              className="rounded-md bg-white/5 px-2 py-1.5 text-xs text-slate-300 hover:bg-white/10"
              title="Copy path"
            >
              Copy
            </button>
          </div>
        </div>

        <p className="text-[11px] text-slate-500">
          Opening Claude here loads your full tool catalog (TOOL-STACK.md)
          {meta.profile ? (
            <>
              {' + the '}
              <span className="text-slate-300">{meta.profile}</span> stack profile
            </>
          ) : null}
          .
        </p>
      </div>

      <div className="border-t border-white/5 px-5 py-3">
        <button
          onClick={() => {
            if (confirm(`Remove "${project.name}" from the registry?\n\nThe folder on disk is NOT deleted.`))
              onRemove(project.id)
          }}
          className="text-xs text-rose-400/80 hover:text-rose-300"
        >
          Remove from registry
        </button>
      </div>
    </div>
  )
}
