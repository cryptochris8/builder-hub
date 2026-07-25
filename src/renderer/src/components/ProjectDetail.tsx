import { useEffect, useState } from 'react'
import type {
  ClaudeEffort,
  ClaudeModel,
  LaunchKind,
  Project,
  ProjectPatch,
  ProjectStage,
  ProjectStatus,
  ProjectType,
  SessionConfig,
  SessionProfileId,
  WorktreeInfo
} from '@shared/types'
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CLAUDE_PERMISSION_MODES,
  PROJECT_STAGES,
  PROJECT_TYPES,
  SESSION_PROFILES,
  STAGE_LABELS,
  TYPE_META
} from '@shared/types'
import { PERMISSION_MODE_META, PROFILE_META, suggestProfile } from '@shared/claudeLaunch'
import { calculateFocusScore, calculateHealth } from '@shared/scoring'
import { sanitizeBranch } from '@shared/sessionLogic'
import { HandoffModal } from '@/components/HandoffModal'
import { hub } from '@/lib/api'

const HEALTH_DOT: Record<string, string> = {
  green: 'bg-emerald-400',
  yellow: 'bg-amber-400',
  red: 'bg-rose-400'
}

const SCORE_FIELDS = [
  ['revenueScore', 'Rev', 'How directly this makes money'],
  ['strategicScore', 'Strat', 'Long-term strategic importance'],
  ['excitementScore', 'Excite', 'How excited you are to work on it'],
  ['readinessScore', 'Ready', 'How close to launch/shippable'],
  ['effortScore', 'Effort', 'Remaining effort — high lowers the score']
] as const

type ScoreKey = (typeof SCORE_FIELDS)[number][0]

const STATUSES: ProjectStatus[] = ['active', 'idea', 'archived']
const ACTIONS: { kind: LaunchKind; label: string; title?: string }[] = [
  { kind: 'claude', label: '▸ Claude', title: 'Embedded Claude Code session' },
  { kind: 'files', label: '🗀 Files', title: 'Browse & preview files in-app' },
  { kind: 'shell', label: '❯ Shell', title: 'Embedded terminal (no Claude)' },
  { kind: 'viewer', label: '🌐 Viewer', title: 'Embedded browser' },
  { kind: 'editor', label: '⌨ Editor', title: 'Open in Cursor / VS Code' },
  { kind: 'terminal', label: '❯ Terminal ↗', title: 'External Windows Terminal' },
  { kind: 'folder', label: '🗁 Folder', title: 'Open in Explorer' }
]

export function ProjectDetail({
  project,
  onClose,
  onUpdate,
  onRemove,
  onLaunch,
  onOpenTask,
  onOpenDiff,
  worktreesVersion,
  notify
}: {
  project: Project
  onClose: () => void
  onUpdate: (id: string, patch: ProjectPatch) => void
  onRemove: (id: string) => void
  onLaunch: (kind: LaunchKind, p: Project) => void
  onOpenTask: (p: Project, wt: WorktreeInfo) => void
  onOpenDiff: (p: Project, wt: WorktreeInfo) => void
  /** bumped by App when a task is merged/discarded elsewhere (DiffPane) */
  worktreesVersion: number
  notify: (msg: string, err?: boolean) => void
}) {
  const meta = TYPE_META[project.type]
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null)
  const [newTask, setNewTask] = useState('')
  const [taskBusy, setTaskBusy] = useState(false)
  /** Session profile for the task being created. 'auto' follows suggestProfile(newTask). */
  const [taskProfilePick, setTaskProfilePick] = useState<SessionProfileId | 'auto'>('auto')
  const [showHandoff, setShowHandoff] = useState(false)
  /** What you've typed into a score box but not committed yet. A box with no
   *  draft shows the stored value, so dropping the draft on blur makes the
   *  field snap to what was actually saved — typing 99 shows the clamped 10,
   *  and an emptied box shows empty because the score really was cleared. */
  const [scoreDrafts, setScoreDrafts] = useState<Partial<Record<ScoreKey, string>>>({})

  const focusScore = calculateFocusScore(project)
  const health = calculateHealth(project)

  const commitScore = (key: ScoreKey, raw: string): void => {
    setScoreDrafts((drafts) => {
      const next = { ...drafts }
      delete next[key]
      return next
    })
    const v = raw.trim()
    if (v === '') {
      if (project[key] !== undefined) onUpdate(project.id, { [key]: null } as ProjectPatch)
      return
    }
    const n = Number(v)
    if (!Number.isFinite(n)) return
    const clamped = Math.max(0, Math.min(10, Math.round(n)))
    if (clamped !== project[key]) onUpdate(project.id, { [key]: clamped } as ProjectPatch)
  }

  const refreshTasks = (): void => {
    hub.worktrees.list(project.path).then(setWorktrees)
  }
  useEffect(refreshTasks, [project.path, worktreesVersion])

  const createTask = async (): Promise<void> => {
    const task = newTask.trim()
    if (!task || taskBusy) return
    setTaskBusy(true)
    const res = await hub.worktrees.create(project.path, task)
    setTaskBusy(false)
    if (!res.ok || !res.path || !res.branch) {
      notify(res.error ?? 'Could not create the task worktree', true)
      return
    }
    // Store the task's session profile BEFORE opening Claude — main resolves the
    // registry at PTY-spawn time. An 'auto' pick that suggests standard stores
    // nothing, so the task still inherits the project/global profile.
    const taskKey = sanitizeBranch(task)
    const picked = taskProfilePick === 'auto' ? suggestProfile(task) : taskProfilePick
    let launchProject = project
    if (taskProfilePick !== 'auto' || picked !== 'standard') {
      const taskProfiles = { ...(project.taskProfiles ?? {}), [taskKey]: { profile: picked } }
      await hub.projects.update(project.id, { taskProfiles })
      launchProject = { ...project, taskProfiles } // fresh copy so the tab chip matches
    }
    setNewTask('')
    setTaskProfilePick('auto')
    refreshTasks()
    onOpenTask(launchProject, { path: res.path, branch: res.branch, task: taskKey })
  }

  const removeTask = async (wt: WorktreeInfo): Promise<void> => {
    if (!confirm(`Remove task "${wt.task}"?\n\nSafe remove — fails if it has uncommitted work.`)) return
    setTaskBusy(true)
    const res = await hub.worktrees.remove(project.path, wt.path, wt.branch, false)
    setTaskBusy(false)
    if (res.ok) {
      notify(res.output ?? `Removed ${wt.branch}`)
      refreshTasks()
    } else {
      notify(res.error ?? 'Could not remove — use the Diff tab to review or discard it', true)
    }
  }
  const field =
    'mt-1 w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-indigo-400'
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
              title={a.title}
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
          <button
            onClick={() => setShowHandoff(true)}
            title="Generate a ready-to-paste Claude Code task brief"
            className="rounded-md bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 transition hover:bg-indigo-500/80 hover:text-white"
          >
            ⇥ Handoff
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
          <div className="flex items-center justify-between">
            <div className={label}>Focus &amp; health</div>
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${HEALTH_DOT[health.status]}`}
                title={health.reasons.join(' · ')}
              />
              <span className="text-xs font-semibold text-indigo-300" title="Focus score (0-10)">
                {focusScore.toFixed(1)}
              </span>
            </span>
          </div>
          <div className="mt-1 space-y-2">
            <select
              value={project.stage ?? ''}
              onChange={(e) =>
                onUpdate(project.id, { stage: (e.target.value || null) as ProjectStage | null })
              }
              className={field}
              title="Product stage — ready-for-build and launch-prep boost the focus score"
            >
              <option value="" className="bg-[#0d1320]">
                (no stage)
              </option>
              {PROJECT_STAGES.map((s) => (
                <option key={s} value={s} className="bg-[#0d1320]">
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-5 gap-1.5">
              {SCORE_FIELDS.map(([key, short, tip]) => (
                <div key={key} title={`${tip} (0-10)`}>
                  <div className="text-center text-[10px] text-slate-500">{short}</div>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={scoreDrafts[key] ?? String(project[key] ?? '')}
                    placeholder="5"
                    onChange={(e) => setScoreDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    onBlur={(e) => commitScore(key, e.target.value)}
                    className="w-full rounded-md border border-white/10 bg-white/5 px-1 py-1 text-center text-xs text-slate-100 outline-none focus:border-indigo-400"
                  />
                </div>
              ))}
            </div>
            <input
              defaultValue={project.nextAction ?? ''}
              placeholder="Next action — the single next concrete step"
              onBlur={(e) => {
                if (e.target.value !== (project.nextAction ?? ''))
                  onUpdate(project.id, { nextAction: e.target.value })
              }}
              className={field}
            />
            <textarea
              defaultValue={(project.blockers ?? []).join('\n')}
              rows={2}
              placeholder="Blockers — one per line (empty = unblocked)"
              onBlur={(e) => {
                const next = e.target.value
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean)
                if (next.join('\n') !== (project.blockers ?? []).join('\n'))
                  onUpdate(project.id, { blockers: next })
              }}
              className={`${field} resize-none`}
            />
          </div>
        </div>

        <details>
          <summary className={`${label} cursor-pointer select-none`}>
            Brief — feeds handoffs &amp; specs
          </summary>
          <div className="mt-2 space-y-2">
            <textarea
              defaultValue={project.shortDescription ?? ''}
              rows={2}
              placeholder="Short description — what is this?"
              onBlur={(e) => {
                if (e.target.value !== (project.shortDescription ?? ''))
                  onUpdate(project.id, { shortDescription: e.target.value })
              }}
              className={`${field} resize-none`}
            />
            <input
              defaultValue={project.problemSolved ?? ''}
              placeholder="Problem solved"
              onBlur={(e) => {
                if (e.target.value !== (project.problemSolved ?? ''))
                  onUpdate(project.id, { problemSolved: e.target.value })
              }}
              className={field}
            />
            <input
              defaultValue={project.targetAudience ?? ''}
              placeholder="Target audience"
              onBlur={(e) => {
                if (e.target.value !== (project.targetAudience ?? ''))
                  onUpdate(project.id, { targetAudience: e.target.value })
              }}
              className={field}
            />
            <input
              defaultValue={project.monetizationModel ?? ''}
              placeholder="Monetization model"
              onBlur={(e) => {
                if (e.target.value !== (project.monetizationModel ?? ''))
                  onUpdate(project.id, { monetizationModel: e.target.value })
              }}
              className={field}
            />
            <textarea
              defaultValue={project.mvpDefinition ?? ''}
              rows={3}
              placeholder="MVP definition — the smallest shippable version"
              onBlur={(e) => {
                if (e.target.value !== (project.mvpDefinition ?? ''))
                  onUpdate(project.id, { mvpDefinition: e.target.value })
              }}
              className={`${field} resize-none`}
            />
          </div>
        </details>

        <div>
          <div className={label}>Claude session profile — model &amp; effort</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                if (project.sessionProfile) onUpdate(project.id, { sessionProfile: null })
              }}
              title="Use the global default (Connections)"
              className={`rounded-md border px-2.5 py-1 text-xs transition ${
                !project.sessionProfile
                  ? 'border-indigo-400/60 bg-indigo-500/20 text-white'
                  : 'border-white/5 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
              }`}
            >
              Global
            </button>
            {SESSION_PROFILES.map((p) => {
              const on = project.sessionProfile?.profile === p
              return (
                <button
                  key={p}
                  onClick={() => {
                    if (!on)
                      onUpdate(project.id, {
                        sessionProfile:
                          p === 'custom'
                            ? {
                                profile: p,
                                model: project.sessionProfile?.model,
                                effort: project.sessionProfile?.effort
                              }
                            : { profile: p }
                      })
                  }}
                  title={PROFILE_META[p].blurb}
                  className={`rounded-md border px-2.5 py-1 text-xs transition ${
                    on
                      ? 'border-indigo-400/60 bg-indigo-500/20 text-white'
                      : 'border-white/5 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
                  }`}
                >
                  {PROFILE_META[p].label}
                </button>
              )
            })}
          </div>
          {project.sessionProfile?.profile === 'custom' && (
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <select
                value={project.sessionProfile.model ?? ''}
                onChange={(e) =>
                  onUpdate(project.id, {
                    sessionProfile: {
                      ...(project.sessionProfile as SessionConfig),
                      model: (e.target.value || undefined) as ClaudeModel | undefined
                    }
                  })
                }
                className={field}
                title="Model alias passed as --model"
              >
                <option value="" className="bg-[#0d1320]">
                  model: default
                </option>
                {CLAUDE_MODELS.map((m) => (
                  <option key={m} value={m} className="bg-[#0d1320]">
                    {m}
                  </option>
                ))}
              </select>
              <select
                value={project.sessionProfile.effort ?? ''}
                onChange={(e) =>
                  onUpdate(project.id, {
                    sessionProfile: {
                      ...(project.sessionProfile as SessionConfig),
                      effort: (e.target.value || undefined) as ClaudeEffort | undefined
                    }
                  })
                }
                className={field}
                title="Effort level passed as --effort"
              >
                <option value="" className="bg-[#0d1320]">
                  effort: default
                </option>
                {CLAUDE_EFFORTS.map((ef) => (
                  <option key={ef} value={ef} className="bg-[#0d1320]">
                    {ef}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
            {project.sessionProfile
              ? PROFILE_META[project.sessionProfile.profile].blurb
              : 'Uses the global default (Connections). '}
            {' Applies to newly opened sessions for this project.'}
          </p>
        </div>

        <div>
          <div className={label}>Claude permission mode</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                if (project.claudePermissionMode) onUpdate(project.id, { claudePermissionMode: null })
              }}
              title="Use the global default (Connections)"
              className={`rounded-md border px-2.5 py-1 text-xs transition ${
                !project.claudePermissionMode
                  ? 'border-indigo-400/60 bg-indigo-500/20 text-white'
                  : 'border-white/5 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
              }`}
            >
              Global
            </button>
            {CLAUDE_PERMISSION_MODES.map((mode) => {
              const on = project.claudePermissionMode === mode
              const m = PERMISSION_MODE_META[mode]
              const cls = on
                ? m.danger
                  ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                  : 'border-indigo-400/60 bg-indigo-500/20 text-white'
                : 'border-white/5 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
              return (
                <button
                  key={mode}
                  onClick={() => {
                    if (!on) onUpdate(project.id, { claudePermissionMode: mode })
                  }}
                  title={m.blurb}
                  className={`rounded-md border px-2.5 py-1 text-xs transition ${cls}`}
                >
                  {m.danger && '⚠ '}
                  {m.label}
                </button>
              )
            })}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
            {project.claudePermissionMode
              ? PERMISSION_MODE_META[project.claudePermissionMode].blurb
              : 'Uses the global default (Connections). '}
            {' Applies to newly opened sessions for this project.'}
          </p>
        </div>

        <div>
          <div className={label}>Task sessions — isolated git worktrees</div>
          <div className="mt-1 space-y-1.5">
            {worktrees === null ? (
              <div className="text-xs text-slate-600">Checking worktrees…</div>
            ) : (
              worktrees.map((wt) => (
                <div
                  key={wt.path}
                  className="flex items-center gap-2 rounded-md border border-white/5 bg-white/[0.02] px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-200" title={wt.path}>
                    ⌥ {wt.task}
                    {project.taskProfiles?.[wt.task] &&
                      project.taskProfiles[wt.task].profile !== 'standard' && (
                        <span
                          className="ml-1.5 rounded bg-white/5 px-1 py-0.5 text-[9px] uppercase tracking-wide text-slate-400"
                          title={PROFILE_META[project.taskProfiles[wt.task].profile]?.blurb}
                        >
                          {PROFILE_META[project.taskProfiles[wt.task].profile]?.label ?? '?'}
                        </span>
                      )}
                  </span>
                  <button
                    onClick={() => onOpenTask(project, wt)}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-indigo-500/80 hover:text-white"
                    title="Open a Claude session in this task's worktree"
                  >
                    ▸ Claude
                  </button>
                  <button
                    onClick={() => onOpenDiff(project, wt)}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-indigo-500/80 hover:text-white"
                    title="Review this task's changes (and merge back)"
                  >
                    ⇄ Diff
                  </button>
                  <button
                    onClick={() => void removeTask(wt)}
                    disabled={taskBusy}
                    className="rounded px-1 text-[11px] text-slate-600 hover:text-rose-300"
                    title="Remove worktree (safe — keeps uncommitted work protected)"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
            <div className="flex gap-1.5">
              <input
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createTask()
                }}
                placeholder="new task, e.g. fix-login"
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-100 outline-none focus:border-indigo-400"
              />
              <select
                value={taskProfilePick}
                onChange={(e) => setTaskProfilePick(e.target.value as SessionProfileId | 'auto')}
                className="rounded-md border border-white/10 bg-white/5 px-1.5 py-1 text-xs text-slate-300 outline-none focus:border-indigo-400"
                title="Session profile for this task's Claude session. Auto suggests from the task name (keyword heuristic, zero tokens); when nothing matches it inherits the project/global profile."
              >
                <option value="auto" className="bg-[#0d1320]">
                  Auto{newTask.trim() ? `: ${PROFILE_META[suggestProfile(newTask)].label}` : ''}
                </option>
                {SESSION_PROFILES.filter((p) => p !== 'custom').map((p) => (
                  <option key={p} value={p} className="bg-[#0d1320]">
                    {PROFILE_META[p].label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void createTask()}
                disabled={!newTask.trim() || taskBusy}
                className="rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 hover:bg-indigo-500/80 hover:text-white disabled:opacity-40"
                title={`Creates branch hub/${sanitizeBranch(newTask || 'task')} in its own worktree + opens Claude there`}
              >
                ＋ Task
              </button>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-600">
              Each task gets its own branch + folder, so Claude works isolated while your main checkout stays
              clean. Review &amp; merge from the ⇄ Diff tab.
            </p>
          </div>
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

      {showHandoff && (
        <HandoffModal project={project} onClose={() => setShowHandoff(false)} notify={notify} />
      )}
    </div>
  )
}
