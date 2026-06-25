import { useEffect, useRef, useState } from 'react'
import type { LaunchKind, Project, ProjectType } from '@shared/types'
import { hub } from '@/lib/api'
import { Dashboard } from '@/views/Dashboard'
import { Projects } from '@/views/Projects'
import { WorkspaceView, type WorkspaceTab } from '@/views/WorkspaceView'
import { ConnectionsView } from '@/views/ConnectionsView'
import { ProjectDetail } from '@/components/ProjectDetail'
import { NewProjectModal } from '@/components/NewProjectModal'

type View = 'dashboard' | 'projects' | 'workspace' | 'connections'
const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '◧' },
  { id: 'projects', label: 'Projects', icon: '▦' },
  { id: 'workspace', label: 'Workspace', icon: '▣' },
  { id: 'connections', label: 'Connections', icon: '🔌' }
]

// Where a project's embedded Viewer tab points by default (editable in the viewer's URL bar).
function defaultViewerUrl(type: ProjectType): string {
  switch (type) {
    case 'roblox':
      return 'https://create.roblox.com/dashboard/creations'
    case 'hytopia':
      return 'https://play.hytopia.com'
    case 'web-app':
    case 'crypto-web3':
      return 'http://localhost:5173'
    case 'static-site':
      return 'http://localhost:3000'
    default:
      return 'https://www.google.com'
  }
}

export default function App() {
  const [view, setView] = useState<View>('projects')
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<Project | null>(null)
  const [tabs, setTabs] = useState<WorkspaceTab[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const notify = (msg: string, err = false): void => {
    setToast({ msg, err })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), 2800)
  }

  const refresh = async (): Promise<void> => {
    const list = await hub.projects.list()
    setProjects(list)
    setSelected((cur) => (cur ? (list.find((p) => p.id === cur.id) ?? null) : null))
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [])

  const addProject = async (): Promise<void> => {
    const p = await hub.projects.add()
    if (p) {
      await refresh()
      notify(`Added ${p.name}`)
    }
  }
  const rescan = async (): Promise<void> => {
    const r = await hub.projects.rescan()
    await refresh()
    notify(`Scanned ${r.scanned} · added ${r.added} new`)
  }
  const onUpdate = async (id: string, patch: Partial<Project>): Promise<void> => {
    await hub.projects.update(id, patch)
    await refresh()
  }
  const onRemove = async (id: string): Promise<void> => {
    await hub.projects.remove(id)
    setSelected(null)
    await refresh()
    notify('Removed from registry (folder untouched)')
  }
  const onToggleFav = (p: Project): void => {
    void onUpdate(p.id, { favorite: !p.favorite })
  }

  // Open (or focus) an embedded Claude Code session for a project.
  const openClaude = async (p: Project): Promise<void> => {
    const ctx = await hub.projects.ensureContext(p.id)
    if (ctx.seeded) notify('Seeded CLAUDE.md so Claude knows your stack')
    const existing = tabs.find((t) => t.kind === 'claude' && t.project.path === p.path)
    if (existing) {
      setActiveKey(existing.key)
    } else {
      const key = `claude:${p.id}:${Date.now()}`
      setTabs((prev) => [...prev, { key, kind: 'claude', project: p }])
      setActiveKey(key)
    }
    setView('workspace')
    await hub.projects.touch(p.id) // mark recently-opened → surfaces in Dashboard "Recent"
    await refresh()
  }

  // Open an embedded browser tab for a project.
  const openViewer = (p: Project): void => {
    const key = `viewer:${p.id}:${Date.now()}`
    setTabs((prev) => [...prev, { key, kind: 'viewer', project: p, url: p.url || defaultViewerUrl(p.type) }])
    setActiveKey(key)
    setView('workspace')
  }

  const closeTab = (key: string): void => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key)
      setActiveKey((cur) => (cur === key ? (next[next.length - 1]?.key ?? null) : cur))
      return next
    })
  }

  const onCreated = async (project: Project, withClaude: boolean): Promise<void> => {
    setShowNew(false)
    await refresh()
    notify(`Created ${project.name}`)
    if (withClaude) await openClaude(project)
  }

  const onLaunch = async (kind: LaunchKind, p: Project): Promise<void> => {
    if (kind === 'claude') return void openClaude(p)
    if (kind === 'viewer') return void openViewer(p)
    const labels: Record<LaunchKind, string> = {
      folder: 'Opening folder',
      editor: 'Opening editor',
      terminal: 'Opening terminal',
      claude: 'Launching Claude',
      viewer: 'Opening viewer',
      studio: 'Launching Roblox Studio',
      play: 'Launching in Roblox'
    }
    notify(`${labels[kind]} — ${p.name}…`)
    const res =
      kind === 'editor'
        ? await hub.launch.editor(p.path)
        : kind === 'folder'
          ? await hub.launch.folder(p.path)
          : kind === 'terminal'
            ? await hub.launch.terminal(p.path)
            : kind === 'studio'
              ? await hub.launch.studio()
              : await hub.launch.roblox(p.url ?? '')
    if (!res.ok) notify(res.error ?? "Couldn't launch", true)
    else void refresh()
  }

  return (
    <div className="flex h-full bg-[#0b0f17] text-slate-200">
      {/* Sidebar */}
      <aside className="flex w-60 flex-col border-r border-white/5 bg-[#0d1320] px-3 py-4">
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-sm font-bold text-white">
            B
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-white">Builder Hub</div>
            <div className="text-[11px] text-slate-500">{projects.length} projects</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                view === n.id ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
              }`}
            >
              <span className="w-4 text-center text-slate-400">{n.icon}</span>
              {n.label}
              {n.id === 'workspace' && tabs.length > 0 && (
                <span className="ml-auto rounded-full bg-indigo-500/80 px-1.5 text-[10px] font-medium text-white">
                  {tabs.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto px-2 text-[11px] text-slate-600">Local-first · JSON</div>
      </aside>

      {/* Main */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-white/5 px-8 py-4">
          <div>
            <h1 className="text-lg font-semibold text-white">
              {view === 'dashboard' ? 'Good to build, Chris 👋' : NAV.find((n) => n.id === view)?.label}
            </h1>
            <p className="text-sm text-slate-500">
              Open a project and drop into Claude — all your tools, one window.
            </p>
          </div>
          <button
            onClick={() => setShowNew(true)}
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400"
          >
            ＋ New Project
          </button>
        </header>

        <section className="flex min-h-0 flex-1 flex-col">
          {/* Workspace stays MOUNTED across view changes so terminals/viewers never restart. */}
          <div className={view === 'workspace' ? 'flex min-h-0 flex-1 flex-col px-6 pb-5 pt-3' : 'hidden'}>
            <WorkspaceView
              tabs={tabs}
              activeKey={activeKey}
              visible={view === 'workspace'}
              onActivate={setActiveKey}
              onClose={closeTab}
            />
          </div>

          {view !== 'workspace' && (
            <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
              {loading ? (
                <div className="text-sm text-slate-500">Loading projects…</div>
              ) : view === 'dashboard' ? (
                <Dashboard projects={projects} onOpen={setSelected} onLaunch={onLaunch} />
              ) : view === 'projects' ? (
                <Projects
                  projects={projects}
                  onOpen={setSelected}
                  onToggleFav={onToggleFav}
                  onLaunch={onLaunch}
                  onAdd={addProject}
                  onRescan={rescan}
                />
              ) : (
                <ConnectionsView />
              )}
            </div>
          )}
        </section>
      </main>

      {selected && (
        <ProjectDetail
          key={selected.id}
          project={selected}
          onClose={() => setSelected(null)}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onLaunch={onLaunch}
        />
      )}

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreated={onCreated} />}

      {toast && (
        <div
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg px-4 py-2 text-sm shadow-lg ${
            toast.err ? 'bg-rose-500/90 text-white' : 'border border-white/10 bg-slate-800 text-slate-100'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}
