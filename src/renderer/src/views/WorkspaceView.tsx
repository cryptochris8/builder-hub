import { useState } from 'react'
import type {
  ClaudePermissionMode,
  ClaudeStatusEvent,
  ContextFreshness,
  HubSettings,
  Project,
  SessionConfig,
  SessionRecord
} from '@shared/types'
import { TYPE_META } from '@shared/types'
import { PROFILE_META, resolveRoutingMode } from '@shared/claudeLaunch'
import { WORKTREE_BRANCH_PREFIX, normPath } from '@shared/sessionLogic'
import { TerminalPane } from '@/components/TerminalPane'
import { ViewerPane } from '@/components/ViewerPane'
import { FilesPane } from '@/components/FilesPane'
import { DiffPane } from '@/components/DiffPane'
import { ContextPane } from '@/components/ContextPane'
import { SessionBar } from '@/components/SessionBar'

export type WorkspaceTabKind = 'claude' | 'shell' | 'viewer' | 'files' | 'diff' | 'context'

export interface WorkspaceTab {
  key: string
  kind: WorkspaceTabKind
  project: Project
  /** initial URL for viewer tabs */
  url?: string
  /** cwd override for task-worktree sessions & diff tabs (defaults to project.path) */
  cwd?: string
  /** task name for worktree sessions & diff tabs (branch = hub/<task>) */
  task?: string
  /** Permission mode this Claude session was LAUNCHED with — a label only (main
   *  resolves the real one from settings.json when it spawns the PTY). Changing the
   *  setting later doesn't change a running session, so the chip must not either. */
  mode?: ClaudePermissionMode
  /** Session profile (model/effort) this Claude session was LAUNCHED with — same
   *  label-only caveat as `mode`. */
  profile?: SessionConfig
}

/** Chip text + style for a non-standard session profile; null = no chip. */
function profileChip(p?: SessionConfig): { text: string; cls: string; title: string } | null {
  if (!p || p.profile === 'standard') return null
  if (p.profile === 'custom') {
    const text = [p.model, p.effort].filter(Boolean).join(' · ') || 'custom'
    return { text, cls: 'bg-slate-500/15 text-slate-300', title: PROFILE_META.custom.blurb }
  }
  return {
    text: PROFILE_META[p.profile].label.toLowerCase(),
    cls: p.profile === 'deep' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-teal-500/15 text-teal-300',
    title: PROFILE_META[p.profile].blurb
  }
}

export const tabCwd = (t: WorkspaceTab): string => t.cwd ?? t.project.path

const KIND_META: Record<WorkspaceTabKind, { icon: string; label: string }> = {
  claude: { icon: '▸', label: 'Claude' },
  shell: { icon: '❯', label: 'Shell' },
  viewer: { icon: '🌐', label: 'Viewer' },
  files: { icon: '🗀', label: 'Files' },
  diff: { icon: '⇄', label: 'Diff' },
  context: { icon: '☰', label: 'Context' }
}

// Calm session-state dot: only rendered for Claude tabs that have reported state.
const STATE_DOT: Record<string, { cls: string; title: string }> = {
  working: { cls: 'bg-sky-400 animate-pulse', title: 'Claude is working' },
  waiting: { cls: 'bg-amber-400 animate-pulse', title: 'Claude is waiting for you' },
  done: { cls: 'bg-emerald-400', title: 'Claude finished — review the result' }
}

/** The board record for a Claude tab: same cwd, live, and EMBEDDED — main binds
 *  `embedded` to the session a Hub terminal actually runs (by --session-id), so
 *  an external `claude` in the same folder is never shown, or acted on, as this
 *  tab's session. Until the tab's own first hook arrives there is no record. */
function recordForTab(board: SessionRecord[], t: WorkspaceTab): SessionRecord | undefined {
  const key = normPath(tabCwd(t))
  return board.find((r) => r.embedded && r.state !== 'ended' && normPath(r.cwd) === key)
}

export interface WorkspaceActions {
  onApply: (sessionId: string) => void
  onApplyAtLaunch: (sessionId: string) => void
  onLock: (sessionId: string, locked: boolean) => void
  onDismiss: (sessionId: string) => void
  /** v1.1: refresh context size + recompute */
  onReassess: (sessionId: string) => void
  /** v1.1: publish a handoff, then switch */
  onHandoffAndSwitch: (sessionId: string) => void
  onOpenContext: (p: Project) => void
  onOpenStack: () => void
  onPublishHandoff: (p: Project, sessionId?: string) => void
  onReindex: (p: Project) => void
  onOpenUrl: (p: Project, url: string) => void
}

export function WorkspaceView({
  tabs,
  activeKey,
  visible,
  statuses,
  board,
  freshness,
  settings,
  projects,
  closedTabs,
  onReopen,
  onFreshness,
  onActivate,
  onClose,
  onSendToClaude,
  onSessionEnd,
  onTaskRemoved,
  actions,
  notify
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  visible: boolean
  statuses: Record<string, ClaudeStatusEvent>
  board: SessionRecord[]
  /** per-project freshness verdicts (from context:get / reindex) */
  freshness: Record<string, ContextFreshness | null>
  settings: HubSettings
  /** the live registry — tabs hold a Project snapshot from when they opened */
  projects: Project[]
  closedTabs: WorkspaceTab[]
  onReopen: (t: WorkspaceTab) => void
  onFreshness: (projectId: string, f: ContextFreshness | null) => void
  onActivate: (key: string) => void
  onClose: (key: string) => void
  onSendToClaude: (project: Project, text: string) => void
  onSessionEnd: (key: string, cwd: string, kind: WorkspaceTabKind) => void
  onTaskRemoved: (worktreePath: string) => void
  actions: WorkspaceActions
  notify: (msg: string, err?: boolean) => void
}) {
  const [showClosed, setShowClosed] = useState(false)

  if (tabs.length === 0) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-xl border border-white/5 bg-white/[0.02] px-6 py-8 text-center">
        <h2 className="mb-2 text-sm font-semibold text-white">Your workspace is empty</h2>
        <p className="text-sm text-slate-500">
          On any project, hit <span className="text-slate-300">▸ Claude</span> for a Claude Code session,{' '}
          <span className="text-slate-300">🗀 Files</span> to browse and preview its files,{' '}
          <span className="text-slate-300">❯ Shell</span> for a plain terminal,{' '}
          <span className="text-slate-300">🌐 Viewer</span> for an embedded browser, or{' '}
          <span className="text-slate-300">☰ Context</span> for the Hub's durable project state — they open
          here as tabs. Task sessions (isolated git worktrees) live in a project's detail panel.
        </p>
        {closedTabs.length > 0 && (
          <button
            onClick={() => onReopen(closedTabs[0])}
            className="mt-4 rounded-md bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10"
          >
            ↶ Reopen {KIND_META[closedTabs[0].kind].label} · {closedTabs[0].project.name}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 pb-2">
        {tabs.map((t) => {
          const isActive = t.key === activeKey
          const meta = KIND_META[t.kind]
          const status = t.kind === 'claude' ? statuses[normPath(tabCwd(t))] : undefined
          const dot = status && status.state !== 'ended' ? STATE_DOT[status.state] : undefined
          const chip = t.kind === 'claude' ? profileChip(t.profile) : null
          return (
            <div
              key={t.key}
              onClick={() => onActivate(t.key)}
              className={`flex cursor-pointer items-center gap-2 rounded-t-lg border-b-2 px-3 py-1.5 text-xs transition ${
                isActive
                  ? 'border-indigo-400 bg-white/10 text-white'
                  : 'border-transparent bg-white/[0.03] text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className="text-slate-400">{meta.icon}</span>
              <span className={`h-2 w-2 rounded-full ${TYPE_META[t.project.type].dot}`} />
              <span className="max-w-[160px] truncate">
                {t.project.name}
                {t.task && <span className="text-slate-500"> · {t.task}</span>}
              </span>
              <span className="text-[10px] text-slate-500">{meta.label}</span>
              {t.kind === 'claude' && t.mode === 'bypassPermissions' && (
                <span
                  className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-300"
                  title="Bypass — this session edits files and runs commands without asking"
                >
                  ⚠ bypass
                </span>
              )}
              {chip && (
                <span
                  className={`rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide ${chip.cls}`}
                  title={chip.title}
                >
                  {chip.text}
                </span>
              )}
              {dot && <span className={`h-2 w-2 rounded-full ${dot.cls}`} title={dot.title} />}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.key)
                }}
                className="text-slate-500 hover:text-rose-300"
                title="Close tab"
              >
                ✕
              </button>
            </div>
          )
        })}
        {closedTabs.length > 0 && (
          <div className="relative ml-auto">
            <button
              onClick={() => setShowClosed((s) => !s)}
              className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-white/5 hover:text-slate-300"
              title="Recently closed tabs"
            >
              ↶ {closedTabs.length}
            </button>
            {showClosed && (
              <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg border border-white/10 bg-[#0d1320] p-1 shadow-xl">
                {closedTabs.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => {
                      setShowClosed(false)
                      onReopen(t)
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-slate-300 hover:bg-white/5"
                  >
                    <span className="text-slate-500">{KIND_META[t.kind].icon}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {t.project.name}
                      {t.task ? ` · ${t.task}` : ''}
                      {t.kind === 'viewer' && t.url ? ` · ${t.url}` : ''}
                    </span>
                    <span className="text-[10px] text-slate-600">{KIND_META[t.kind].label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => {
          const isActive = visible && t.key === activeKey
          // Per-project routing mode / profile may have changed since the tab opened.
          const live = projects.find((p) => p.id === t.project.id) ?? t.project
          return (
            <div key={t.key} className={t.key === activeKey ? 'absolute inset-0 flex flex-col' : 'hidden'}>
              {t.kind === 'claude' && (
                <SessionBar
                  project={live}
                  task={t.task}
                  record={recordForTab(board, t)}
                  freshness={freshness[t.project.id]}
                  routingMode={resolveRoutingMode(live, settings)}
                  agentCeiling={settings.agentCeiling}
                  onReassess={actions.onReassess}
                  onHandoffAndSwitch={actions.onHandoffAndSwitch}
                  onApply={actions.onApply}
                  onApplyAtLaunch={actions.onApplyAtLaunch}
                  onLock={actions.onLock}
                  onDismiss={actions.onDismiss}
                  onOpenContext={actions.onOpenContext}
                  onOpenStack={actions.onOpenStack}
                  onPublishHandoff={actions.onPublishHandoff}
                  onReindex={actions.onReindex}
                />
              )}
              <div className="min-h-0 flex-1">
                {t.kind === 'claude' || t.kind === 'shell' ? (
                  <TerminalPane
                    cwd={tabCwd(t)}
                    active={isActive}
                    runClaude={t.kind === 'claude'}
                    onSessionEnd={() => onSessionEnd(t.key, tabCwd(t), t.kind)}
                    onOpenUrl={(url) => actions.onOpenUrl(t.project, url)}
                  />
                ) : t.kind === 'files' ? (
                  <FilesPane
                    root={t.project.path}
                    active={isActive}
                    onSendToClaude={(text) => onSendToClaude(t.project, text)}
                    onOpenInViewer={(url) => actions.onOpenUrl(t.project, url)}
                  />
                ) : t.kind === 'diff' ? (
                  <DiffPane
                    projectPath={t.project.path}
                    worktreePath={tabCwd(t)}
                    branch={WORKTREE_BRANCH_PREFIX + (t.task ?? '')}
                    active={isActive}
                    onTaskRemoved={() => onTaskRemoved(tabCwd(t))}
                    notify={notify}
                  />
                ) : t.kind === 'context' ? (
                  <ContextPane
                    project={t.project}
                    active={isActive}
                    notify={notify}
                    onSendToClaude={(text) => onSendToClaude(t.project, text)}
                    onFreshness={(f) => onFreshness(t.project.id, f)}
                  />
                ) : (
                  <ViewerPane url={t.url ?? 'about:blank'} active={isActive} notify={notify} />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
