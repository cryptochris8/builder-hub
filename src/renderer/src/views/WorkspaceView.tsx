import type { Project } from '@shared/types'
import { TYPE_META } from '@shared/types'
import { TerminalPane } from '@/components/TerminalPane'
import { ViewerPane } from '@/components/ViewerPane'

export interface WorkspaceTab {
  key: string
  kind: 'claude' | 'viewer'
  project: Project
  /** initial URL for viewer tabs */
  url?: string
}

export function WorkspaceView({
  tabs,
  activeKey,
  visible,
  onActivate,
  onClose
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  visible: boolean
  onActivate: (key: string) => void
  onClose: (key: string) => void
}) {
  if (tabs.length === 0) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-xl border border-white/5 bg-white/[0.02] px-6 py-8 text-center">
        <h2 className="mb-2 text-sm font-semibold text-white">Your workspace is empty</h2>
        <p className="text-sm text-slate-500">
          On any project, hit <span className="text-slate-300">▸ Claude</span> for a Claude Code session
          or <span className="text-slate-300">🌐 Viewer</span> for an embedded browser — they open here as
          tabs, side by side.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 pb-2">
        {tabs.map((t) => {
          const isActive = t.key === activeKey
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
              <span className="text-slate-400">{t.kind === 'claude' ? '▸' : '🌐'}</span>
              <span className={`h-2 w-2 rounded-full ${TYPE_META[t.project.type].dot}`} />
              <span className="max-w-[160px] truncate">{t.project.name}</span>
              <span className="text-[10px] text-slate-500">{t.kind === 'claude' ? 'Claude' : 'Viewer'}</span>
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
        {tabs.map((t) => (
          <div key={t.key} className={t.key === activeKey ? 'absolute inset-0' : 'hidden'}>
            {t.kind === 'claude' ? (
              <TerminalPane cwd={t.project.path} active={visible && t.key === activeKey} />
            ) : (
              <ViewerPane url={t.url ?? 'about:blank'} active={visible && t.key === activeKey} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
