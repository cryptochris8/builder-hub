import { useEffect, useRef, useState } from 'react'
import type {
  ClaudeStatusEvent,
  GitStatus,
  HubSettings,
  LaunchKind,
  Project,
  ProjectPatch,
  ProjectType,
  WorktreeInfo
} from '@shared/types'
import { DEFAULT_SETTINGS, resolveSessionConfig } from '@shared/claudeLaunch'
import { normPath } from '@shared/sessionLogic'
import { hub } from '@/lib/api'
import { sendToClaudeTerminal } from '@/lib/terminalBus'
import { tabCwd } from '@/views/WorkspaceView'
import type { WorkspaceTabKind } from '@/views/WorkspaceView'
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
  const [git, setGit] = useState<Record<string, GitStatus>>({})
  const [selected, setSelected] = useState<Project | null>(null)
  const [tabs, setTabs] = useState<WorkspaceTab[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [loading, setLoading] = useState(true)
  // Bumped whenever a task worktree is removed → ProjectDetail refetches its list.
  const [worktreesVersion, setWorktreesVersion] = useState(0)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  // Tabs whose terminal session ended/failed — openClaude replaces these instead
  // of focusing them. A ref (not state): only consulted inside handlers, and refs
  // can't go stale across awaits the way a captured state value can.
  const deadTabs = useRef<Set<string>>(new Set())
  // Live Claude session states (fed by Claude Code hooks via main), keyed by
  // lowercased session cwd. Powers tab dots, the sidebar badge, and the rail.
  const [claudeStatus, setClaudeStatus] = useState<Record<string, ClaudeStatusEvent>>({})
  // App preferences (currently just the Claude permission mode). Main owns the file
  // and re-validates every write; this is the UI's mirror of it.
  const [settings, setSettings] = useState<HubSettings>(DEFAULT_SETTINGS)

  useEffect(() => {
    hub.settings.get().then(setSettings)
  }, [])

  useEffect(() => {
    return hub.claude.onStatus((e) => {
      const key = normPath(e.cwd)
      setClaudeStatus((prev) => {
        const cur = prev[key]
        // Session-id guards: two sessions can share a cwd (embedded tab + an
        // external terminal). Don't let one session's ended/done clobber the
        // other's live working/waiting state.
        if (e.state === 'ended' && cur && cur.sessionId && e.sessionId && cur.sessionId !== e.sessionId) {
          return prev
        }
        if (
          e.state === 'done' &&
          cur &&
          (cur.state === 'working' || cur.state === 'waiting') &&
          cur.sessionId &&
          e.sessionId &&
          cur.sessionId !== e.sessionId
        ) {
          return prev
        }
        const next = { ...prev }
        if (e.state === 'ended') delete next[key]
        else next[key] = e
        // Trim anything ancient so the map can't grow unboundedly.
        const cutoff = Date.now() - 12 * 60 * 60 * 1000
        for (const k of Object.keys(next)) if (next[k].at < cutoff) delete next[k]
        return next
      })
    })
  }, [])

  // Sweep stale entries periodically too — a killed external session never sends
  // SessionEnd, and the in-handler trim only runs when new events arrive.
  useEffect(() => {
    const id = window.setInterval(
      () => {
        const cutoff = Date.now() - 12 * 60 * 60 * 1000
        setClaudeStatus((prev) => {
          const stale = Object.keys(prev).filter((k) => prev[k].at < cutoff)
          if (!stale.length) return prev
          const next = { ...prev }
          for (const k of stale) delete next[k]
          return next
        })
      },
      15 * 60 * 1000
    )
    return () => window.clearInterval(id)
  }, [])

  const clearStatusFor = (cwd: string): void => {
    const key = normPath(cwd)
    setClaudeStatus((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const notify = (msg: string, err = false): void => {
    setToast({ msg, err })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), 2800)
  }

  // Pull live git status for every project (cheap, cached in main). Non-blocking:
  // the registry renders immediately and badges fill in when this resolves.
  const refreshGit = async (list: Project[]): Promise<void> => {
    if (!list.length) return
    try {
      setGit(await hub.git.statuses(list.map((p) => ({ id: p.id, path: p.path }))))
    } catch {
      /* git unavailable — badges just stay empty */
    }
  }

  const refresh = async (): Promise<void> => {
    const list = await hub.projects.list()
    setProjects(list)
    setSelected((cur) => (cur ? (list.find((p) => p.id === cur.id) ?? null) : null))
    void refreshGit(list)
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [])

  // Re-check git when the window regains focus — you've likely been committing
  // in a terminal/editor since you last looked at the Hub.
  useEffect(() => {
    const onFocus = (): void => void refreshGit(projects)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projects])

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
  const onUpdate = async (id: string, patch: ProjectPatch): Promise<void> => {
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

  // Open (or focus) an embedded Claude Code session for a project — optionally in
  // a task worktree (cwd/task set). The dedup runs inside the functional updater so
  // rapid double-triggers (or Send-to-Claude racing a click) can't slip past a stale
  // `tabs` closure and spawn two PTYs. A tab whose session ended is replaced with a
  // fresh one (new key → clean remount).
  const openClaude = async (p: Project, opts?: { cwd: string; task: string }): Promise<void> => {
    const ctx = await hub.projects.ensureContext(p.id) // seed CLAUDE.md BEFORE the PTY spawns
    if (ctx.seeded) notify('Seeded CLAUDE.md so Claude knows your stack')
    // Read the mode straight from main (not our mirror) so the chip can't disagree
    // with the argv main is about to build. It's a LABEL — it is never sent back.
    const live = await hub.settings.get()
    setSettings(live)
    const cwd = normPath(opts?.cwd ?? p.path)
    // Key hoisted OUT of the updater: StrictMode double-invokes updaters, and two
    // Date.now() calls straddling a ms tick would desync activeKey from the tab.
    const key = `claude:${p.id}:${opts?.task ?? 'main'}:${Date.now()}`
    setTabs((prev) => {
      const existing = prev.find((t) => t.kind === 'claude' && normPath(tabCwd(t)) === cwd)
      if (existing && !deadTabs.current.has(existing.key)) {
        setActiveKey(existing.key)
        return prev
      }
      if (existing) deadTabs.current.delete(existing.key)
      setActiveKey(key)
      const rest = existing ? prev.filter((t) => t.key !== existing.key) : prev
      return [
        ...rest,
        {
          key,
          kind: 'claude',
          project: p,
          cwd: opts?.cwd,
          task: opts?.task,
          mode: live.claudePermissionMode,
          // Same resolution chain main runs at spawn (task → project → global) —
          // a LABEL for the chip; the renderer never sends it anywhere.
          profile: resolveSessionConfig(p, opts?.task, live)
        }
      ]
    })
    setView('workspace')
    await hub.projects.touch(p.id) // mark recently-opened → surfaces in Dashboard "Recent"
    await refresh()
  }

  // Open (or focus) the diff-review tab for a task worktree.
  const openDiff = (p: Project, wt: WorktreeInfo): void => {
    const key = `diff:${p.id}:${wt.task}`
    setTabs((prev) => {
      if (prev.some((t) => t.key === key)) {
        setActiveKey(key)
        return prev
      }
      setActiveKey(key)
      return [...prev, { key, kind: 'diff', project: p, cwd: wt.path, task: wt.task }]
    })
    setView('workspace')
  }

  // A task worktree was merged/discarded — close every tab that pointed at it,
  // and let ProjectDetail know its task list is stale.
  const onTaskRemoved = (worktreePath: string): void => {
    const gone = normPath(worktreePath)
    clearStatusFor(worktreePath)
    setWorktreesVersion((v) => v + 1)
    setTabs((prev) => {
      const next = prev.filter((t) => normPath(tabCwd(t)) !== gone)
      setActiveKey((cur) =>
        cur && next.some((t) => t.key === cur) ? cur : (next[next.length - 1]?.key ?? null)
      )
      return next
    })
  }

  // From the Dashboard session rail: jump to the tab running that session.
  const focusSession = (cwd: string): void => {
    const target = tabs.find((t) => t.kind === 'claude' && normPath(tabCwd(t)) === normPath(cwd))
    if (target) {
      setActiveKey(target.key)
      setView('workspace')
    } else {
      notify('That session runs outside the Hub (no tab here)')
    }
  }

  // Open an embedded browser tab for a project.
  const openViewer = (p: Project): void => {
    const key = `viewer:${p.id}:${Date.now()}`
    setTabs((prev) => [...prev, { key, kind: 'viewer', project: p, url: p.url || defaultViewerUrl(p.type) }])
    setActiveKey(key)
    setView('workspace')
  }

  // Open (or focus) the in-app file browser for a project (dedup in the updater).
  const openFiles = (p: Project): void => {
    const key = `files:${p.id}:${Date.now()}` // hoisted — see openClaude
    setTabs((prev) => {
      const existing = prev.find((t) => t.kind === 'files' && t.project.path === p.path)
      if (existing) {
        setActiveKey(existing.key)
        return prev
      }
      setActiveKey(key)
      return [...prev, { key, kind: 'files', project: p }]
    })
    setView('workspace')
  }

  // Open a plain embedded shell (no Claude) — dev servers, scripts, git… Multiple allowed.
  const openShell = (p: Project): void => {
    const key = `shell:${p.id}:${Date.now()}`
    setTabs((prev) => [...prev, { key, kind: 'shell', project: p }])
    setActiveKey(key)
    setView('workspace')
  }

  // From the Files pane: paste text (a quoted file path) into a Claude session
  // for this project. Prefer a session that's already open (the active tab first,
  // then a lone open one — including task sessions) over spawning the main one.
  const sendToClaude = (p: Project, text: string): void => {
    const live = tabs.filter(
      (t) => t.kind === 'claude' && t.project.id === p.id && !deadTabs.current.has(t.key)
    )
    const target = live.find((t) => t.key === activeKey) ?? (live.length === 1 ? live[0] : undefined)
    if (target) {
      setActiveKey(target.key)
      setView('workspace')
      sendToClaudeTerminal(tabCwd(target), text)
      return
    }
    void openClaude(p)
    sendToClaudeTerminal(p.path, text)
  }

  const closeTab = (key: string): void => {
    deadTabs.current.delete(key)
    // Closing a Claude tab kills its PTY — drop its (now stale) status entry.
    const tab = tabs.find((t) => t.key === key)
    if (tab && tab.kind === 'claude') clearStatusFor(tabCwd(tab))
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key)
      setActiveKey((cur) => (cur === key ? (next[next.length - 1]?.key ?? null) : cur))
      return next
    })
  }

  // Only a CLAUDE tab's death clears status — a shell exiting in the same cwd
  // must not wipe the live Claude session's dot.
  const markTabDead = (key: string, cwd: string, kind: WorkspaceTabKind): void => {
    deadTabs.current.add(key)
    if (kind === 'claude') clearStatusFor(cwd)
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
    if (kind === 'files') return void openFiles(p)
    if (kind === 'shell') return void openShell(p)
    const labels: Record<LaunchKind, string> = {
      folder: 'Opening folder',
      editor: 'Opening editor',
      terminal: 'Opening terminal',
      claude: 'Launching Claude',
      viewer: 'Opening viewer',
      files: 'Opening files',
      shell: 'Opening shell',
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

  // Sidebar badge only pulses for sessions that actually have a Hub tab —
  // external sessions still show on the Dashboard rail, but a badge on
  // "Workspace" must point at something in the workspace.
  const openClaudeCwds = new Set(tabs.filter((t) => t.kind === 'claude').map((t) => normPath(tabCwd(t))))
  const anyWaiting = Object.entries(claudeStatus).some(
    ([k, s]) => s.state === 'waiting' && openClaudeCwds.has(k)
  )

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
                view === n.id
                  ? 'bg-white/10 text-white'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
              }`}
            >
              <span className="w-4 text-center text-slate-400">{n.icon}</span>
              {n.label}
              {n.id === 'workspace' && tabs.length > 0 && (
                <span
                  className={`ml-auto rounded-full px-1.5 text-[10px] font-medium text-white ${
                    anyWaiting ? 'animate-pulse bg-amber-500/90' : 'bg-indigo-500/80'
                  }`}
                  title={anyWaiting ? 'A Claude session is waiting for you' : undefined}
                >
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
              statuses={claudeStatus}
              onActivate={setActiveKey}
              onClose={closeTab}
              onSendToClaude={sendToClaude}
              onSessionEnd={markTabDead}
              onTaskRemoved={onTaskRemoved}
              notify={notify}
            />
          </div>

          {view !== 'workspace' && (
            <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
              {loading ? (
                <div className="text-sm text-slate-500">Loading projects…</div>
              ) : view === 'dashboard' ? (
                <Dashboard
                  projects={projects}
                  git={git}
                  statuses={claudeStatus}
                  onOpen={setSelected}
                  onLaunch={onLaunch}
                  onFocusSession={focusSession}
                  onDismissStatus={clearStatusFor}
                />
              ) : view === 'projects' ? (
                <Projects
                  projects={projects}
                  git={git}
                  onOpen={setSelected}
                  onToggleFav={onToggleFav}
                  onLaunch={onLaunch}
                  onAdd={addProject}
                  onRescan={rescan}
                />
              ) : (
                <ConnectionsView settings={settings} onSettings={setSettings} notify={notify} />
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
          onOpenTask={(p, wt) => void openClaude(p, { cwd: wt.path, task: wt.task })}
          onOpenDiff={openDiff}
          worktreesVersion={worktreesVersion}
          notify={notify}
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
