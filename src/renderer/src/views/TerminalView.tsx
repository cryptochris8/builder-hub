import type { Project } from '@shared/types'
import { TYPE_META } from '@shared/types'
import { TerminalPane } from '@/components/TerminalPane'

export interface TermSession {
  key: string
  project: Project
}

export function TerminalView({
  sessions,
  activeKey,
  visible,
  onActivate,
  onClose
}: {
  sessions: TermSession[]
  activeKey: string | null
  /** whether the terminal view itself is the active tab (vs. hidden behind another view) */
  visible: boolean
  onActivate: (key: string) => void
  onClose: (key: string) => void
}) {
  if (sessions.length === 0) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-xl border border-white/5 bg-white/[0.02] px-6 py-8 text-center">
        <h2 className="mb-2 text-sm font-semibold text-white">No Claude sessions yet</h2>
        <p className="text-sm text-slate-500">
          Hit <span className="text-slate-300">▸ Claude</span> on any project and a real Claude Code
          session opens right here — your Max plan, all your tools, one window.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 pb-2">
        {sessions.map((s) => {
          const isActive = s.key === activeKey
          return (
            <div
              key={s.key}
              onClick={() => onActivate(s.key)}
              className={`flex cursor-pointer items-center gap-2 rounded-t-lg border-b-2 px-3 py-1.5 text-xs transition ${
                isActive
                  ? 'border-indigo-400 bg-white/10 text-white'
                  : 'border-transparent bg-white/[0.03] text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${TYPE_META[s.project.type].dot}`} />
              <span className="max-w-[160px] truncate">{s.project.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(s.key)
                }}
                className="text-slate-500 hover:text-rose-300"
                title="Close session"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-white/10 bg-[#0b0f17] p-2">
        {sessions.map((s) => (
          <div key={s.key} className={s.key === activeKey ? 'absolute inset-2' : 'hidden'}>
            <TerminalPane cwd={s.project.path} active={visible && s.key === activeKey} />
          </div>
        ))}
      </div>
    </div>
  )
}
