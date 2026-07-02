import type { Project } from '@shared/types'
import { TYPE_META } from '@shared/types'
import { TerminalPane } from '@/components/TerminalPane'
import { ViewerPane } from '@/components/ViewerPane'
import { FilesPane } from '@/components/FilesPane'

export type WorkspaceTabKind = 'claude' | 'shell' | 'viewer' | 'files'

export interface WorkspaceTab {
  key: string
  kind: WorkspaceTabKind
  project: Project
  /** initial URL for viewer tabs */
  url?: string
}

const KIND_META: Record<WorkspaceTabKind, { icon: string; label: string }> = {
  claude: { icon: '▸', label: 'Claude' },
  shell: { icon: '❯', label: 'Shell' },
  viewer: { icon: '🌐', label: 'Viewer' },
  files: { icon: '🗀', label: 'Files' }
}

export function WorkspaceView({
  tabs,
  activeKey,
  visible,
  onActivate,
  onClose,
  onSendToClaude,
  onSessionEnd
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  visible: boolean
  onActivate: (key: string) => void
  onClose: (key: string) => void
  onSendToClaude: (project: Project, text: string) => void
  onSessionEnd: (key: string) => void
}) {
  if (tabs.length === 0) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-xl border border-white/5 bg-white/[0.02] px-6 py-8 text-center">
        <h2 className="mb-2 text-sm font-semibold text-white">Your workspace is empty</h2>
        <p className="text-sm text-slate-500">
          On any project, hit <span className="text-slate-300">▸ Claude</span> for a Claude Code session,{' '}
          <span className="text-slate-300">🗀 Files</span> to browse and preview its files,{' '}
          <span className="text-slate-300">❯ Shell</span> for a plain terminal, or{' '}
          <span className="text-slate-300">🌐 Viewer</span> for an embedded browser — they open here as tabs.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 pb-2">
        {tabs.map((t) => {
          const isActive = t.key === activeKey
          const meta = KIND_META[t.kind]
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
              <span className="max-w-[160px] truncate">{t.project.name}</span>
              <span className="text-[10px] text-slate-500">{meta.label}</span>
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
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => {
          const isActive = visible && t.key === activeKey
          return (
            <div key={t.key} className={t.key === activeKey ? 'absolute inset-0' : 'hidden'}>
              {t.kind === 'claude' ? (
                <TerminalPane
                  cwd={t.project.path}
                  active={isActive}
                  runClaude
                  onSessionEnd={() => onSessionEnd(t.key)}
                />
              ) : t.kind === 'shell' ? (
                <TerminalPane
                  cwd={t.project.path}
                  active={isActive}
                  runClaude={false}
                  onSessionEnd={() => onSessionEnd(t.key)}
                />
              ) : t.kind === 'files' ? (
                <FilesPane
                  root={t.project.path}
                  active={isActive}
                  onSendToClaude={(text) => onSendToClaude(t.project, text)}
                />
              ) : (
                <ViewerPane url={t.url ?? 'about:blank'} active={isActive} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
