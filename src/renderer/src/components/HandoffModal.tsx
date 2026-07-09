import { useMemo, useState } from 'react'
import type { HandoffInput, HandoffTaskType, Project } from '@shared/types'
import { HANDOFF_TASK_TYPES } from '@shared/types'
import { generateHandoff } from '@shared/handoff'
import { hub } from '@/lib/api'

/** Build a ready-to-paste Claude Code handoff for this project (FounderOS
 *  harvest). Preview updates live; save writes <project>/handoffs/<date>-<slug>.md. */
export function HandoffModal({
  project,
  onClose,
  notify
}: {
  project: Project
  onClose: () => void
  notify: (msg: string, err?: boolean) => void
}) {
  const [taskTitle, setTaskTitle] = useState('')
  const [taskType, setTaskType] = useState<HandoffTaskType | ''>('')
  const [objective, setObjective] = useState('')
  const [importantFiles, setImportantFiles] = useState('')
  const [constraints, setConstraints] = useState('')
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('')
  const [includeProjectContext, setIncludeProjectContext] = useState(true)
  const [showPreview, setShowPreview] = useState(false)
  const [busy, setBusy] = useState(false)

  const input: HandoffInput = useMemo(
    () => ({
      taskTitle,
      taskType,
      objective,
      importantFiles,
      constraints,
      acceptanceCriteria,
      includeProjectContext
    }),
    [taskTitle, taskType, objective, importantFiles, constraints, acceptanceCriteria, includeProjectContext]
  )
  const markdown = useMemo(() => generateHandoff(project, input), [project, input])
  const canExport = !!taskTitle.trim() && !busy

  const copy = async (): Promise<void> => {
    await hub.clipboard.writeText(markdown)
    notify('Handoff copied to clipboard')
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const res = await hub.handoff.save(project.id, input)
    setBusy(false)
    if (res.ok && res.path) {
      notify(`Saved ${res.path}`)
      onClose()
    } else {
      notify(res.error ?? 'Could not save the handoff', true)
    }
  }

  const field =
    'mt-1 w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-400'
  const label = 'text-[11px] font-medium uppercase tracking-wide text-slate-500'

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="max-h-full w-[640px] overflow-y-auto rounded-2xl border border-white/10 bg-[#0d1320] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold text-white">Claude Code handoff</h2>
        <p className="mb-4 text-xs text-slate-500">
          A ready-to-paste task brief for <span className="text-slate-300">{project.name}</span> — saved into
          the project so the next Claude session starts with full context.
        </p>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={label}>Task title</div>
              <input
                autoFocus
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="Fix mobile login"
                className={field}
              />
            </div>
            <div>
              <div className={label}>Task type</div>
              <select
                value={taskType}
                onChange={(e) => setTaskType(e.target.value as HandoffTaskType | '')}
                className={field}
              >
                <option value="" className="bg-[#0d1320]">
                  (none)
                </option>
                {HANDOFF_TASK_TYPES.map((t) => (
                  <option key={t} value={t} className="bg-[#0d1320]">
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className={label}>Objective</div>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={3}
              placeholder="What should Claude accomplish, and why?"
              className={`${field} resize-none`}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={label}>Important files (one per line)</div>
              <textarea
                value={importantFiles}
                onChange={(e) => setImportantFiles(e.target.value)}
                rows={3}
                placeholder={'src/login.ts\nsrc/auth/'}
                className={`${field} resize-none`}
              />
            </div>
            <div>
              <div className={label}>Extra constraints (one per line)</div>
              <textarea
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                rows={3}
                placeholder="No new dependencies"
                className={`${field} resize-none`}
              />
            </div>
          </div>

          <div>
            <div className={label}>Acceptance criteria (one per line)</div>
            <textarea
              value={acceptanceCriteria}
              onChange={(e) => setAcceptanceCriteria(e.target.value)}
              rows={3}
              placeholder="Login works on mobile Safari"
              className={`${field} resize-none`}
            />
          </div>

          <div className="flex flex-wrap gap-4 text-sm text-slate-300">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={includeProjectContext}
                onChange={(e) => setIncludeProjectContext(e.target.checked)}
              />
              Include project context (brief, focus, blockers, notes)
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={showPreview}
                onChange={(e) => setShowPreview(e.target.checked)}
              />
              Preview
            </label>
          </div>

          {showPreview && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-white/5 bg-black/30 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
              {markdown}
            </pre>
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
            onClick={() => void copy()}
            disabled={!canExport}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Copy
          </button>
          <button
            onClick={() => void save()}
            disabled={!canExport}
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
            title={`Saves to ${project.path}\\handoffs\\`}
          >
            {busy ? 'Saving…' : 'Save to project'}
          </button>
        </div>
      </div>
    </div>
  )
}
