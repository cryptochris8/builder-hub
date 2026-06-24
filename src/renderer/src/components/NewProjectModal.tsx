import { useEffect, useState } from 'react'
import type { Project, ProjectType } from '@shared/types'
import { PROJECT_TYPES, TYPE_META } from '@shared/types'
import { sanitizeFolder } from '@shared/projectLogic'
import { hub } from '@/lib/api'

export function NewProjectModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (project: Project, openClaude: boolean) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ProjectType>('web-app')
  const [parentDir, setParentDir] = useState('')
  const [stack, setStack] = useState('')
  const [initGit, setInitGit] = useState(true)
  const [openClaude, setOpenClaude] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    hub.system.homeDir().then((h) => setParentDir((cur) => cur || h))
  }, [])

  const folder = sanitizeFolder(name)
  const preview = name.trim() && parentDir ? `${parentDir}\\${folder}` : ''
  const canCreate = !!name.trim() && !!parentDir && !busy

  const browse = async (): Promise<void> => {
    const d = await hub.system.pickDirectory()
    if (d) setParentDir(d)
  }

  const create = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    const res = await hub.projects.create({
      name: name.trim(),
      type,
      parentDir,
      stack: stack.trim() || undefined,
      initGit
    })
    setBusy(false)
    if (!res.ok || !res.project) {
      setError(res.error ?? 'Could not create project')
      return
    }
    onCreated(res.project, openClaude)
  }

  const field =
    'mt-1 w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-400'
  const label = 'text-[11px] font-medium uppercase tracking-wide text-slate-500'

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="max-h-full w-[560px] overflow-y-auto rounded-2xl border border-white/10 bg-[#0d1320] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-semibold text-white">New project</h2>

        <div className="space-y-4">
          <div>
            <div className={label}>Name</div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Game"
              className={field}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canCreate) create()
              }}
            />
          </div>

          <div>
            <div className={label}>Type</div>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {PROJECT_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                    type === t
                      ? 'border-indigo-400 bg-indigo-500/10 text-white'
                      : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${TYPE_META[t].dot}`} />
                  {TYPE_META[t].label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className={label}>Location</div>
            <div className="mt-1 flex gap-2">
              <input
                value={parentDir}
                onChange={(e) => setParentDir(e.target.value)}
                className={`${field} mt-0 flex-1`}
              />
              <button
                onClick={browse}
                className="rounded-md border border-white/10 px-3 text-sm text-slate-300 hover:bg-white/5"
              >
                Browse…
              </button>
            </div>
            {preview && (
              <p className="mt-1 truncate text-[11px] text-slate-500">
                Creates <code className="text-slate-400">{preview}</code>
              </p>
            )}
          </div>

          <div>
            <div className={label}>Stack (optional)</div>
            <input
              value={stack}
              onChange={(e) => setStack(e.target.value)}
              placeholder={`e.g. ${TYPE_META[type].label} starter`}
              className={field}
            />
          </div>

          <div className="flex flex-wrap gap-4 text-sm text-slate-300">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
              Initialize git repo
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={openClaude}
                onChange={(e) => setOpenClaude(e.target.checked)}
              />
              Open Claude when created
            </label>
          </div>

          <p className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[11px] text-slate-500">
            Seeds <span className="text-slate-300">CLAUDE.md</span> from the{' '}
            <span className="text-slate-300">{TYPE_META[type].label}</span> profile, plus{' '}
            <span className="text-slate-300">.env.example</span>, README and .gitignore — so Claude
            starts stack-aware.
          </p>

          {error && (
            <div className="whitespace-pre-wrap rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!canCreate}
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}
