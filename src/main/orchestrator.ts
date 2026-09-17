import { BrowserWindow, ipcMain } from 'electron'
import { app } from 'electron'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { allProjects, onPersist } from './db'
import { getSettings } from './settings'
import { updateProject } from './projects'
import { registryFilePath } from './hubContext'
import {
  applyRecommendationToPty,
  claudePtyBindings,
  embeddedClaudeSessionIds,
  onClaudePtyExit,
  rebindClaudePty
} from './pty'
import { readJsonFile, writeAtomic } from './fsAtomic'
import {
  contextFilePath,
  getContext,
  getOrCreateContext,
  patchContext,
  renderContextFile,
  saveContext
} from './contextStore'
import { probeFingerprint, scanProject } from './projectIndex'
import {
  creatorStackFilePath,
  findForPrompt,
  getStack,
  initCreatorStack,
  reindexStack,
  removeStackEntry,
  upsertStackEntry
} from './creatorStack'
import {
  applyHookEvent,
  editedFileOf,
  findEditConflicts,
  isSessionIdle,
  newSessionRecord,
  otherSessionsSummary,
  pruneBoard,
  staleAfterRead
} from '../shared/sessionBoard'
import type { Board, HookInput } from '../shared/sessionBoard'
import { AUTO_APPLY_CONFIDENCE, emptySignals, recommend, slashCommandsFor } from '../shared/router'
import {
  buildHandoffPacket,
  buildPromptContext,
  buildSessionStartContext,
  computeFreshness,
  mergeScan,
  recordWork,
  renderHandoffMarkdown
} from '../shared/contextLogic'
import { normalizeStack, renderCapabilityCard } from '../shared/creatorStack'
import { resolveRoutingMode } from '../shared/claudeLaunch'
import {
  applySwitchingPolicy,
  assessSwitching,
  ledgerAfterDecisionsRecorded,
  ledgerAfterHandoff,
  mergeContextUsage,
  normalizeLedger
} from '../shared/switchingCost'
import { readTranscriptUsage } from './contextUsage'
import { applyTargetError, normPath, unclaimedPtyCwds, unclaimedPtyIn } from '../shared/sessionLogic'
import type {
  ContextFreshness,
  CreatorStackEntry,
  HandoffPacket,
  HandoffSaveResult,
  Project,
  ProjectContext,
  ProjectContextPatch,
  RouterRecommendation,
  SessionRecord
} from '../shared/types'

// The orchestration layer: owns the in-memory session board, feeds it from hook
// payloads, decides what (little) to hand back to Claude through the hook
// reply, keeps the persistent project context current, and exposes all of it
// to the renderer over typed IPC. Pure decisions live in src/shared; this file
// is glue + file/process side effects only.

let board: Board = {}
/** last freshness verdict per project (from SessionStart probes / Refresh) */
const freshnessCache = new Map<string, ContextFreshness>()

/** Hard ceiling on records kept in memory/on disk — any local process can POST
 *  a fresh session_id, so the board must be bounded even if pruning by age lags. */
const BOARD_MAX_RECORDS = 300
/** The most recent substantial session per project is kept this long even after
 *  it ends, so a "last session" packet survives a Hub restart (the spec's Test C). */
const PACKET_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** conflict warning bounds (labels come from untrusted cwd/session data) */
const CONFLICT_MAX = 3
const CONFLICT_LABEL_CHARS = 60
/** session ids are Claude UUIDs; anything else (including prototype keys) is ignored */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{3,127}$/
/** a cwd is a filesystem path; a multi-KB one is a local process padding the board */
const CWD_MAX_CHARS = 1024

const projectById = (id: string | undefined): Project | undefined =>
  id ? allProjects().find((p) => p.id === id) : undefined

const substantial = (r: SessionRecord): boolean =>
  !!r.objective || r.recaps.length > 0 || r.commands.length > 0

// ---------- board persistence (so "last session" packets survive a Hub restart) ----------

function boardFile(): string {
  return join(app.getPath('userData'), 'board.json')
}

/** Fill every container a persisted/hand-edited record might lack, so the renderer never sees undefined arrays. */
function normalizeRecord(r: Partial<SessionRecord>): SessionRecord | undefined {
  if (typeof r?.sessionId !== 'string' || typeof r.cwd !== 'string' || typeof r.updatedAt !== 'number') {
    return undefined
  }
  if (!SESSION_ID_RE.test(r.sessionId)) return undefined
  const state = r.state === 'working' || r.state === 'waiting' || r.state === 'done' ? r.state : 'ended'
  return {
    ...r,
    sessionId: r.sessionId,
    cwd: r.cwd,
    state,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : r.updatedAt,
    updatedAt: r.updatedAt,
    filesEdited: r.filesEdited && typeof r.filesEdited === 'object' ? r.filesEdited : {},
    filesRead: r.filesRead && typeof r.filesRead === 'object' ? r.filesRead : {},
    commands: Array.isArray(r.commands) ? r.commands : [],
    recaps: Array.isArray(r.recaps) ? r.recaps.filter((x) => typeof x === 'string') : [],
    otherProjectsTouched: Array.isArray(r.otherProjectsTouched) ? r.otherProjectsTouched : [],
    sharedToolsUsed: Array.isArray(r.sharedToolsUsed) ? r.sharedToolsUsed : [],
    signals:
      r.signals && typeof r.signals === 'object' ? { ...emptySignals(), ...r.signals } : emptySignals(),
    locked: r.locked === true
  }
}

/**
 * Age-prune (pure pruneBoard), then keep the newest substantial ended session per
 * project for PACKET_TTL_MS regardless (that is the record a restarted Hub hands
 * to the next session), then enforce the hard record ceiling (oldest ended first).
 */
function prune(b: Board, now: number): Board {
  const kept = pruneBoard(b, now)
  const out: Board = { ...kept }
  const newestPerProject = new Map<string, SessionRecord>()
  for (const r of Object.values(b)) {
    if (!r.projectId || !substantial(r) || now - r.updatedAt > PACKET_TTL_MS) continue
    const cur = newestPerProject.get(r.projectId)
    if (!cur || r.updatedAt > cur.updatedAt) newestPerProject.set(r.projectId, r)
  }
  for (const r of newestPerProject.values()) if (!out[r.sessionId]) out[r.sessionId] = r
  const rows = Object.values(out)
  if (rows.length > BOARD_MAX_RECORDS) {
    const byAge = (a: SessionRecord, b: SessionRecord): number => a.updatedAt - b.updatedAt
    // Ended first; then the oldest live records no Hub terminal owns — a flood of
    // fresh ids from a local process never ends them, so 'ended' alone is no ceiling.
    const victims = [
      ...rows.filter((r) => r.state === 'ended').sort(byAge),
      ...rows.filter((r) => r.state !== 'ended' && !r.embedded).sort(byAge)
    ].slice(0, rows.length - BOARD_MAX_RECORDS)
    for (const v of victims) delete out[v.sessionId]
  }
  return out
}

function loadBoard(): void {
  const raw = readJsonFile(boardFile()) as { sessions?: unknown } | null
  const sessions = raw?.sessions
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return
  const next: Board = {}
  for (const value of Object.values(sessions as Record<string, unknown>)) {
    const r = normalizeRecord(value as Partial<SessionRecord>)
    // Everything that was live when the Hub last ran is over by now.
    if (r) next[r.sessionId] = { ...r, state: 'ended' }
  }
  board = prune(next, Date.now())
}

let saveTimer: NodeJS.Timeout | null = null
function saveBoardSoon(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeAtomic(boardFile(), JSON.stringify({ version: 1, sessions: board }, null, 2), false)
    } catch (e) {
      console.error('[builder-hub] could not save board.json:', e)
    }
  }, 1000)
}

// ---------- broadcast ----------

let broadcastTimer: NodeJS.Timeout | null = null
function broadcastSoon(): void {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    const rows = getBoard()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send('hub:board', rows)
    }
  }, 100)
}

export function getBoard(): SessionRecord[] {
  return Object.values(board).sort((a, b) => b.updatedAt - a.updatedAt)
}

let lastPruneAt = 0
function setRecord(next: SessionRecord): void {
  board = { ...board, [next.sessionId]: next }
  const now = Date.now()
  if (now - lastPruneAt > 60_000) {
    lastPruneAt = now
    board = prune(board, now)
  }
  broadcastSoon()
  saveBoardSoon()
}

const stateOf = (sessionId: string): string | undefined =>
  Object.hasOwn(board, sessionId) ? board[sessionId].state : undefined

/** What the reducer needs to mark `embedded`: the session ids bound to Hub
 *  terminals (exact) and the folders whose Hub terminal is FREE to adopt a new
 *  session (fallback). A folder whose tab is bound to a live session is never
 *  offered, so an external `claude` started there is not mistaken for the tab. */
function ptyContext(now: number): { embeddedSessionIds: Set<string>; embeddedCwds: Set<string> } {
  const bindings = claudePtyBindings()
  const embeddedSessionIds = new Set<string>()
  for (const b of bindings) if (b.claudeSessionId) embeddedSessionIds.add(b.claudeSessionId)
  return { embeddedSessionIds, embeddedCwds: unclaimedPtyCwds(bindings, stateOf, now) }
}

const applyCtx = (
  now: number
): { projects: Project[]; now: number; embeddedCwds: Set<string>; embeddedSessionIds: Set<string> } => ({
  projects: allProjects(),
  now,
  ...ptyContext(now)
})

/** A session first seen in the folder of a Hub terminal whose own session is
 *  over adopts that terminal: a /clear ends the old session id and starts a new
 *  one in the SAME PTY, so re-binding keeps `embedded` and Apply/Auto exact. */
function claimPtyFor(sessionId: string, cwd: string, now: number): void {
  const bindings = claudePtyBindings()
  if (bindings.some((b) => b.claudeSessionId === sessionId)) return
  const free = unclaimedPtyIn(cwd, bindings, stateOf, now)
  if (free) rebindClaudePty(free.id, sessionId)
}

/** Refuse to type into a terminal the record does not own outright (see applyTargetError). */
const applyGuard = (record: SessionRecord): string | undefined =>
  applyTargetError(record, Object.values(board), embeddedClaudeSessionIds())

/** A Hub PTY ended (tab closed, worktree removed, process exit): end its record
 *  now instead of letting it look live for hours. By session id when known,
 *  else the embedded record(s) in that cwd. */
function endEmbeddedSession(info: { cwd: string; claudeSessionId?: string }): void {
  const now = Date.now()
  const key = normPath(info.cwd)
  for (const r of Object.values(board)) {
    if (r.state === 'ended') continue
    const match = info.claudeSessionId
      ? r.sessionId === info.claudeSessionId
      : r.embedded && normPath(r.cwd) === key
    if (match) setRecord({ ...r, state: 'ended', updatedAt: now, lastAction: 'terminal closed' })
  }
}

// ---------- routing ----------

function routingAllowed(record: SessionRecord): boolean {
  if (record.locked) return false
  const mode = resolveRoutingMode(projectById(record.projectId), getSettings())
  return mode === 'suggest' || mode === 'auto'
}

/** v1.1: the task requirement (router) folded with what switching would lose
 *  right now (switching cost). Only downgrades are affected; see applySwitchingPolicy. */
function computeRecommendation(record: SessionRecord, now: number): RouterRecommendation | undefined {
  if (!routingAllowed(record)) return undefined
  const projects = allProjects()
  const current = { model: record.model, effort: record.effort }
  const rec = recommend({ prompt: record.lastPrompt, signals: record.signals, current, projects, now })
  const assessment = assessSwitching({ record, prompt: record.lastPrompt, projects, now })
  return applySwitchingPolicy(rec, assessment, current, {
    unresolvedFailure: record.testStatus?.outcome === 'fail'
  })
}

function withRecommendation(record: SessionRecord, now: number): SessionRecord {
  const recommendation = computeRecommendation(record, now)
  if (!recommendation) return { ...record, recommendation: undefined }
  // A fresh recommendation for the same target keeps a dismissal; a different one clears it.
  const same =
    record.recommendation &&
    record.recommendation.target.model === recommendation.target.model &&
    record.recommendation.target.effort === recommendation.target.effort
  return { ...record, recommendation, dismissedAt: same ? record.dismissedAt : undefined }
}

/** After typing /model + /effort, assume they took: PostModelSwitch confirms the
 *  model and the next tool call's effort.level confirms the effort. Without this
 *  the same recommendation would be re-typed on every Stop until learned. */
function assumeApplied(record: SessionRecord, note: string): SessionRecord {
  const rec = record.recommendation
  if (!rec) return record
  // The target IS the current model/effort now: the suggestion (and its Apply
  // button) must not linger until the next recompute.
  return {
    ...record,
    model: rec.target.model,
    effort: rec.target.effort,
    lastAction: note,
    recommendation: { ...rec, changes: false, direction: 'hold' }
  }
}

/** Auto mode: apply a confident, changing, non-dismissed recommendation to an idle embedded session. */
function maybeAutoApply(record: SessionRecord): void {
  const rec = record.recommendation
  if (!rec || !rec.changes || rec.confidence < AUTO_APPLY_CONFIDENCE || record.locked || record.dismissedAt) {
    return
  }
  // v1.1: switching cost (high/moderate risk, poor capture of valuable context,
  // unresolved failure, low confidence) forbids unattended downgrades.
  if (rec.autoAllowed === false) return
  if (!record.embedded || !isSessionIdle(record) || applyGuard(record)) return
  const mode = resolveRoutingMode(projectById(record.projectId), getSettings())
  if (mode !== 'auto') return
  // Unattended: only a box untouched since the prompt that started this turn.
  const res = applyRecommendationToPty(
    { sessionId: record.sessionId, cwd: record.cwd },
    slashCommandsFor(rec.target),
    { noInputSince: record.lastPromptAt ?? 0 }
  )
  if (res.ok) setRecord(assumeApplied(record, `auto-routed → ${rec.target.model}/${rec.target.effort}`))
}

// ---------- context helpers ----------

async function freshnessFor(project: Project, now: number): Promise<ContextFreshness> {
  const fresh = computeFreshness(getContext(project.id), await probeFingerprint(project.path, now), now)
  rememberFreshness(project.id, fresh)
  return fresh
}

/** Cache a verdict and push it to the renderer: SessionStart re-probes (a /clear
 *  after edits, a pull between sessions) would otherwise leave the SessionBar
 *  showing the verdict from when the tab opened. */
function rememberFreshness(projectId: string, freshness: ContextFreshness): void {
  freshnessCache.set(projectId, freshness)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('hub:freshness', { projectId, freshness })
  }
}

/** The record to hand off from: for a compaction, this very session; otherwise
 *  the most recent ENDED substantial session on the same project. A live sibling
 *  terminal is never used as "your" packet — it is listed under other terminals. */
function priorSession(record: SessionRecord, source: string): SessionRecord | undefined {
  if (source === 'compact' && substantial(record)) return record
  return Object.values(board)
    .filter(
      (r) =>
        r.sessionId !== record.sessionId &&
        r.projectId &&
        r.projectId === record.projectId &&
        r.state === 'ended' &&
        substantial(r)
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

function packetFor(project: Project, record: SessionRecord | undefined, now: number): HandoffPacket {
  return buildHandoffPacket(project, getContext(project.id), record, now)
}

const renderTimers = new Map<string, NodeJS.Timeout>()
function renderContextSoon(project: Project): void {
  const t = renderTimers.get(project.id)
  if (t) clearTimeout(t)
  renderTimers.set(
    project.id,
    setTimeout(() => {
      renderTimers.delete(project.id)
      const ctx = getContext(project.id)
      if (ctx) renderContextFile(project, ctx, freshnessCache.get(project.id))
    }, 2000)
  )
}

/** Make sure the file the injection points at exists (render now if missing). */
function ensureContextFile(project: Project, ctx: ProjectContext): string | undefined {
  const file = contextFilePath(project.id)
  if (!existsSync(file)) renderContextFile(project, ctx, freshnessCache.get(project.id))
  return existsSync(file) ? file : undefined
}

// ---------- the hook entry point ----------

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Feed one hook payload through the board; return the (optional) JSON hook
 *  reply. Never throws — a bug here must not become a hook error in Claude. */
export async function handleHook(
  payload: Record<string, unknown>
): Promise<{ response?: Record<string, unknown> }> {
  try {
    return await handleHookInner(payload as HookInput)
  } catch (e) {
    console.error('[builder-hub] orchestrator hook error:', e)
    return {}
  }
}

async function handleHookInner(input: HookInput): Promise<{ response?: Record<string, unknown> }> {
  if (typeof input.session_id !== 'string' || !SESSION_ID_RE.test(input.session_id)) return {}
  if (typeof input.cwd === 'string' && input.cwd.length > CWD_MAX_CHARS) return {}
  const now = Date.now()
  const settings = getSettings()
  // Bind the session to its Hub terminal BEFORE the reducer decides `embedded`.
  if (typeof input.cwd === 'string' && input.hook_event_name !== 'SessionEnd') {
    claimPtyFor(input.session_id, input.cwd, now)
  }
  const result = applyHookEvent(board, input, applyCtx(now))
  if (!result.changed || !result.record) return {}
  board = result.board
  let record = result.record
  const event = input.hook_event_name
  const project = projectById(record.projectId)
  let response: Record<string, unknown> | undefined

  switch (event) {
    case 'SessionStart': {
      if (project) {
        const fresh = await freshnessFor(project, now)
        // Hooks for this session may have landed during the probe — never overwrite them.
        record = own(record.sessionId) ?? record
        if (settings.contextInjection) {
          const source = typeof input.source === 'string' ? input.source : 'startup'
          const prior = priorSession(record, source)
          const ctx = getContext(project.id)
          const hasContext =
            !!ctx && (ctx.currentTasks.length > 0 || ctx.recentWork.length > 0 || !!ctx.purpose)
          const packet = prior
            ? packetFor(project, prior, now)
            : hasContext
              ? packetFor(project, undefined, now)
              : undefined
          const text = buildSessionStartContext({
            project,
            ctx,
            packet,
            freshness: fresh,
            source,
            otherSessions: otherSessionsSummary(board, record.sessionId, project.id, now),
            sharedTools: ctx?.sharedTools ?? [],
            paths: {
              registry: registryFilePath(),
              contextFile: ctx ? ensureContextFile(project, ctx) : undefined,
              creatorStack: creatorStackFilePath()
            }
          })
          if (text.trim()) {
            response = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }
          }
        }
      }
      break
    }
    case 'UserPromptSubmit': {
      const prompt = result.prompt ?? ''
      if (prompt.length >= 8 && !prompt.startsWith('/')) {
        // Once per session per capability: the card is retrieval, not a reminder.
        const matches = findForPrompt(prompt).filter(
          (m) => !record.sharedToolsUsed.includes(m.capability?.id ?? m.entry.id)
        )
        if (matches.length > 0) {
          const text = buildPromptContext(matches, (m) => renderCapabilityCard(m, join))
          const ids = matches.map((m) => m.capability?.id ?? m.entry.id)
          record = { ...record, sharedToolsUsed: Array.from(new Set([...record.sharedToolsUsed, ...ids])) }
          if (project) {
            const ctx = getOrCreateContext(project.id, now)
            const entryIds = matches.map((m) => m.entry.id)
            const merged = Array.from(new Set([...ctx.sharedTools, ...entryIds]))
            if (merged.length !== ctx.sharedTools.length) {
              saveContext({ ...ctx, sharedTools: merged, updatedAt: now })
              renderContextSoon(project)
            }
          }
          if (text.trim()) {
            response = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
          }
        }
      }
      // v1.1: a strong task boundary closes the previous objective — checkpoint it
      // into project context so the knowledge survives a switch, then reassess.
      if (result.boundary && project) {
        const ctx = getOrCreateContext(project.id, now)
        const finished = (result.boundary.previousObjective ?? '').replace(/\s+/g, ' ').slice(0, 200)
        const summary = `Task boundary (${result.boundary.reason})${finished ? ` — closed: ${finished}` : ''}`
        saveContext(
          recordWork(
            ctx,
            { at: now, summary, sessionId: record.sessionId },
            Object.keys(record.filesEdited),
            project.path,
            now
          )
        )
        renderContextSoon(project)
        record = {
          ...record,
          ledger: { ...normalizeLedger(record.ledger), lastCaptureAt: now, editsSinceCapture: 0 }
        }
      }
      record = withRecommendation(record, now)
      break
    }
    case 'PreToolUse': {
      if (settings.conflictWarnings && EDIT_TOOLS.has(input.tool_name ?? '')) {
        const file = editedFileOf(input.tool_name, input.tool_input)
        if (file) {
          const conflicts = findEditConflicts(board, record.sessionId, file, now)
          let stale = false
          try {
            stale = staleAfterRead(record, file, statSync(file).mtimeMs)
          } catch {
            /* new file — nothing to compare */
          }
          const lines: string[] = []
          for (const c of conflicts.slice(0, CONFLICT_MAX)) {
            const mins = Math.max(1, Math.round((now - c.at) / 60000))
            const label = c.otherLabel.replace(/\s+/g, ' ').slice(0, CONFLICT_LABEL_CHARS)
            lines.push(`${label} edited this file ${mins} min ago.`)
          }
          if (conflicts.length > CONFLICT_MAX)
            lines.push(`(+${conflicts.length - CONFLICT_MAX} more terminals)`)
          if (stale) lines.push('This file changed on disk after you last read it.')
          if (lines.length > 0) {
            const short = (file.split(/[\\/]/).pop() ?? file).slice(0, 80)
            const msg = `Builder Hub: another terminal is working on ${short} — ${lines.join(' ')} Re-read it before editing and keep your change minimal.`
            response = {
              systemMessage: `Builder Hub: ${short} — ${lines.join(' ')}`,
              hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg }
            }
          }
        }
      }
      break
    }
    case 'PostToolUse': {
      if (result.command && ['test', 'build', 'lint', 'typecheck'].includes(result.command.kind)) {
        record = withRecommendation(record, now)
      }
      break
    }
    case 'Stop': {
      if (project && result.recap) {
        const ctx = getOrCreateContext(project.id, now)
        const next = recordWork(
          ctx,
          { at: now, summary: result.recap, sessionId: record.sessionId },
          Object.keys(record.filesEdited),
          project.path,
          now
        )
        saveContext(next)
        renderContextSoon(project)
      }
      // v1.1: context size — the status line's exact figure when it is fresh,
      // else the transcript tail's usage metadata (estimated), else unknown.
      const estimate = await readTranscriptUsage(record.transcriptPath, record.model, now)
      // Status-line pings, subagent stops or tool events may have landed during the read.
      record = own(record.sessionId) ?? record
      record = { ...record, contextUsage: mergeContextUsage(record.contextUsage, estimate) }
      record = withRecommendation(record, now)
      break
    }
    default:
      break
  }

  setRecord(record)
  if (event === 'Stop') maybeAutoApply(record)
  return response ? { response } : {}
}

// ---------- status line (opt-in telemetry) ----------

interface StatusLinePayload {
  session_id?: string
  cwd?: string
  model?: { id?: string; display_name?: string }
  effort?: { level?: string }
  context_window?: {
    used_percentage?: number | null
    context_window_size?: number
    current_usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    } | null
  }
  prompt_cache?: { warm?: boolean; hit_ratio?: number }
  cost?: { total_cost_usd?: number }
  rate_limits?: { five_hour?: { used_percentage?: number } }
  transcript_path?: string
}

/** Record the telemetry and return the one-line text Claude shows. Never throws. */
export function handleStatusLine(payload: Record<string, unknown>): string {
  try {
    const p = payload as StatusLinePayload
    const sid =
      typeof p.session_id === 'string' && SESSION_ID_RE.test(p.session_id) ? p.session_id : undefined
    const cwd = typeof p.cwd === 'string' && p.cwd.length <= CWD_MAX_CHARS ? p.cwd : undefined
    if (!sid || !cwd) return ''
    const now = Date.now()
    const base = Object.hasOwn(board, sid) ? board[sid] : newSessionRecord(sid, cwd, applyCtx(now))
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined
    const record: SessionRecord = {
      ...base,
      updatedAt: now,
      model: typeof p.model?.id === 'string' ? p.model.id.slice(0, 80) : base.model,
      effort: typeof p.effort?.level === 'string' ? p.effort.level.slice(0, 20) : base.effort,
      contextPct: num(p.context_window?.used_percentage) ?? base.contextPct,
      cacheWarm: typeof p.prompt_cache?.warm === 'boolean' ? p.prompt_cache.warm : base.cacheWarm,
      cacheHitRatio: num(p.prompt_cache?.hit_ratio) ?? base.cacheHitRatio,
      costUsd: num(p.cost?.total_cost_usd) ?? base.costUsd,
      rateLimit5hPct: num(p.rate_limits?.five_hour?.used_percentage) ?? base.rateLimit5hPct,
      transcriptPath: typeof p.transcript_path === 'string' ? p.transcript_path : base.transcriptPath
    }
    // v1.1: Claude Code's own context figure is the exact source for switching cost.
    const pct = num(p.context_window?.used_percentage)
    if (pct !== undefined) {
      const u = p.context_window?.current_usage
      const tokens = u
        ? (num(u.input_tokens) ?? 0) +
          (num(u.cache_creation_input_tokens) ?? 0) +
          (num(u.cache_read_input_tokens) ?? 0) +
          (num(u.output_tokens) ?? 0)
        : undefined
      record.contextUsage = mergeContextUsage(base.contextUsage, {
        pct,
        windowSize: num(p.context_window?.context_window_size),
        tokens: tokens && tokens > 0 ? tokens : undefined,
        source: 'statusline',
        at: now
      })
    }
    setRecord(record)
    const parts: string[] = []
    parts.push(
      typeof p.model?.display_name === 'string'
        ? p.model.display_name.slice(0, 40)
        : (record.model ?? 'Claude')
    )
    if (record.effort) parts.push(record.effort)
    if (record.contextPct !== undefined) parts.push(`ctx ${Math.round(record.contextPct)}%`)
    if (record.cacheWarm !== undefined) {
      const hit = record.cacheHitRatio !== undefined ? ` ${Math.round(record.cacheHitRatio * 100)}%` : ''
      parts.push(`cache ${record.cacheWarm ? 'warm' : 'cold'}${hit}`)
    }
    if (record.rateLimit5hPct !== undefined) parts.push(`5h ${Math.round(record.rateLimit5hPct)}%`)
    const rec = record.recommendation
    if (rec && rec.changes && !record.locked && !record.dismissedAt && routingAllowed(record)) {
      parts.push(`Hub suggests ${rec.target.model}/${rec.target.effort}`)
    } else if (rec?.heldForContext && !record.locked && !record.dismissedAt && routingAllowed(record)) {
      parts.push('Hub: stay (valuable context)')
    }
    return parts.join(' · ')
  } catch (e) {
    console.error('[builder-hub] status line error:', e)
    return ''
  }
}

// ---------- IPC ----------

function uniquePath(dir: string, filename: string): string {
  const base = filename.replace(/\.md$/, '')
  let candidate = join(dir, filename)
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${base}-${n}.md`)
  return candidate
}

/** Live sessions first (newest), then ended (newest). */
function latestSessionFor(projectId: string): SessionRecord | undefined {
  return Object.values(board)
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => {
      const la = a.state !== 'ended' ? 1 : 0
      const lb = b.state !== 'ended' ? 1 : 0
      return lb - la || b.updatedAt - a.updatedAt
    })[0]
}

/** Write <project>/handoffs/<date>-handoff.md from the live/last session, add its
 *  next action to the project's tasks, and mark that session's ledger captured
 *  (v1.1: a published handoff is what makes valuable context cheap to leave). */
function publishHandoffFor(
  projectId: string,
  overrides?: Partial<HandoffPacket>,
  /** the session the handoff is FOR; without it, the project's latest session */
  sessionId?: string
): HandoffSaveResult {
  const project = projectById(projectId)
  if (!project) return { ok: false, error: 'Project not found in the registry' }
  if (!existsSync(project.path)) {
    return { ok: false, error: `Project folder no longer exists: ${project.path}` }
  }
  try {
    const now = Date.now()
    const exact = sessionId ? own(sessionId) : undefined
    const session = exact && exact.projectId === projectId ? exact : latestSessionFor(projectId)
    const packet: HandoffPacket = {
      ...packetFor(project, session, now),
      ...(overrides ?? {}),
      projectId,
      projectName: project.name,
      createdAt: now
    }
    const dir = join(project.path, 'handoffs')
    mkdirSync(dir, { recursive: true })
    const file = uniquePath(dir, `${new Date(now).toISOString().slice(0, 10)}-handoff.md`)
    writeFileSync(file, renderHandoffMarkdown(packet), 'utf8')
    const ctx = getOrCreateContext(projectId, now)
    const tasks =
      packet.nextAction && !ctx.currentTasks.includes(packet.nextAction)
        ? [...ctx.currentTasks, packet.nextAction]
        : ctx.currentTasks
    saveContext({ ...ctx, currentTasks: tasks.slice(-30), updatedAt: now })
    renderContextSoon(project)
    if (session)
      setRecord(withRecommendation({ ...session, ledger: ledgerAfterHandoff(session.ledger, now) }, now))
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const own = (sessionId: unknown): SessionRecord | undefined =>
  typeof sessionId === 'string' && Object.hasOwn(board, sessionId) ? board[sessionId] : undefined

export function registerOrchestrator(): void {
  loadBoard()
  initCreatorStack()
  onClaudePtyExit(endEmbeddedSession)
  // Registry changes can re-link Creator Stack entries to projects.
  let stackTimer: NodeJS.Timeout | null = null
  onPersist(() => {
    if (stackTimer) clearTimeout(stackTimer)
    stackTimer = setTimeout(() => {
      stackTimer = null
      try {
        reindexStack()
      } catch {
        /* best-effort */
      }
    }, 1500)
  })

  ipcMain.handle('board:list', () => getBoard())
  ipcMain.handle('board:lock', (_e, sessionId: string, locked: boolean) => {
    const r = own(sessionId)
    if (!r) return null
    const next: SessionRecord = {
      ...r,
      locked: !!locked,
      recommendation: locked ? undefined : r.recommendation
    }
    setRecord(next)
    return next
  })
  ipcMain.handle('board:dismiss', (_e, sessionId: string) => {
    const r = own(sessionId)
    if (!r) return null
    const next: SessionRecord = { ...r, dismissedAt: Date.now() }
    setRecord(next)
    return next
  })
  ipcMain.handle('board:recommend', (_e, sessionId: string) => {
    const r = own(sessionId)
    if (!r) return null
    const next = withRecommendation(r, Date.now())
    setRecord(next)
    return next
  })
  // Apply now = type the documented slash commands into the session's PTY, only
  // when it is idle (turn over / idle prompt) and nobody typed for a moment. Never mid-turn.
  ipcMain.handle('board:apply', (_e, sessionId: string): { ok: boolean; error?: string } => {
    const r = own(sessionId)
    if (!r?.recommendation) return { ok: false, error: 'No recommendation for that session' }
    if (!r.embedded)
      return { ok: false, error: 'That session runs outside the Hub — type /model and /effort there' }
    if (!isSessionIdle(r)) return { ok: false, error: 'Session is busy — apply when it is idle' }
    const unsafe = applyGuard(r)
    if (unsafe) return { ok: false, error: unsafe }
    const res = applyRecommendationToPty(
      { sessionId: r.sessionId, cwd: r.cwd },
      slashCommandsFor(r.recommendation.target)
    )
    if (res.ok) {
      setRecord(
        assumeApplied(r, `applied ${r.recommendation.target.model}/${r.recommendation.target.effort}`)
      )
    }
    return res
  })
  // v1.1 Reassess = refresh the context-size estimate, clear a dismissal, recompute.
  ipcMain.handle('board:reassess', async (_e, sessionId: string) => {
    const r = own(sessionId)
    if (!r) return null
    const now = Date.now()
    const estimate = await readTranscriptUsage(r.transcriptPath, r.model, now)
    const next = withRecommendation(
      { ...r, dismissedAt: undefined, contextUsage: mergeContextUsage(r.contextUsage, estimate) },
      now
    )
    setRecord(next)
    return next
  })
  // v1.1 Prepare handoff & switch = capture first (publish the handoff, which also
  // marks the ledger captured), then switch to the deferred downgrade target: typed
  // into the idle embedded session when that is safe, otherwise saved for the next launch.
  ipcMain.handle(
    'board:handoffAndSwitch',
    (
      _e,
      sessionId: string
    ): { ok: boolean; error?: string; path?: string; switched?: 'now' | 'launch' | 'none' } => {
      const r = own(sessionId)
      const project = projectById(r?.projectId)
      if (!r || !project) return { ok: false, error: 'That session is not in a registered project' }
      const target = r.recommendation?.deferredTarget ?? r.recommendation?.target
      const saved = publishHandoffFor(project.id, undefined, r.sessionId)
      if (!saved.ok) return { ok: false, error: saved.error }
      if (!target) return { ok: true, path: saved.path, switched: 'none' }
      const fresh = own(sessionId) ?? r
      const canType = fresh.embedded && isSessionIdle(fresh) && !applyGuard(fresh)
      if (canType) {
        const res = applyRecommendationToPty(
          { sessionId: fresh.sessionId, cwd: fresh.cwd },
          slashCommandsFor(target)
        )
        if (res.ok) {
          setRecord({
            ...fresh,
            model: target.model,
            effort: target.effort,
            lastAction: `handoff published · switched to ${target.model}/${target.effort}`,
            recommendation: fresh.recommendation
              ? { ...fresh.recommendation, target, changes: false, direction: 'hold', heldForContext: false }
              : undefined
          })
          return { ok: true, path: saved.path, switched: 'now' }
        }
      }
      const cfg = { profile: 'custom' as const, model: target.model, effort: target.effort }
      if (fresh.task) {
        updateProject(project.id, { taskProfiles: { ...(project.taskProfiles ?? {}), [fresh.task]: cfg } })
      } else {
        updateProject(project.id, { sessionProfile: cfg })
      }
      return { ok: true, path: saved.path, switched: 'launch' }
    }
  )
  // Apply at next launch = persist as the project's (or task's) custom session profile.
  ipcMain.handle('board:applyAtLaunch', (_e, sessionId: string): { ok: boolean; error?: string } => {
    const r = own(sessionId)
    const project = projectById(r?.projectId)
    if (!r?.recommendation || !project)
      return { ok: false, error: 'No project/recommendation for that session' }
    const cfg = {
      profile: 'custom' as const,
      model: r.recommendation.target.model,
      effort: r.recommendation.target.effort
    }
    if (r.task) {
      updateProject(project.id, { taskProfiles: { ...(project.taskProfiles ?? {}), [r.task]: cfg } })
    } else {
      updateProject(project.id, { sessionProfile: cfg })
    }
    return { ok: true }
  })

  ipcMain.handle('context:get', async (_e, projectId: string) => {
    const project = projectById(projectId)
    if (!project) return null
    const context = getContext(projectId) ?? null
    const freshness =
      freshnessCache.get(projectId) ?? (context ? await freshnessFor(project, Date.now()) : undefined)
    return { context, freshness: freshness ?? null, filePath: contextFilePath(projectId) }
  })
  ipcMain.handle(
    'context:update',
    (_e, projectId: string, patch: ProjectContextPatch): ProjectContext | null => {
      const project = projectById(projectId)
      if (!project) return null
      const next = patchContext(projectId, patch)
      renderContextSoon(project)
      // v1.1: decisions the user recorded are no longer "only in recaps".
      if (patch && Array.isArray(patch.decisions) && patch.decisions.length > 0) {
        const now = Date.now()
        for (const r of Object.values(board)) {
          if (r.projectId === projectId && r.state !== 'ended') {
            setRecord(withRecommendation({ ...r, ledger: ledgerAfterDecisionsRecorded(r.ledger) }, now))
          }
        }
      }
      return next
    }
  )
  ipcMain.handle('context:reindex', async (_e, projectId: string) => {
    const project = projectById(projectId)
    if (!project) return null
    const scan = await scanProject(project.path)
    // Read the context AFTER the await: a Stop hook may have recorded a recap meanwhile.
    const now = Date.now()
    const next = mergeScan(getOrCreateContext(projectId, now), scan, now)
    saveContext(next)
    const freshness = computeFreshness(next, next.fingerprint ?? { computedAt: now }, now)
    rememberFreshness(projectId, freshness)
    renderContextFile(project, next, freshness)
    return { context: next, freshness, filePath: contextFilePath(projectId) }
  })
  ipcMain.handle('context:refresh', async (_e, projectId: string) => {
    const project = projectById(projectId)
    if (!project) return null
    return freshnessFor(project, Date.now())
  })
  ipcMain.handle('context:packet', (_e, projectId: string) => {
    const project = projectById(projectId)
    if (!project) return null
    const packet = packetFor(project, latestSessionFor(projectId), Date.now())
    return { packet, markdown: renderHandoffMarkdown(packet) }
  })
  ipcMain.handle(
    'context:publishHandoff',
    (_e, projectId: string, overrides?: Partial<HandoffPacket>, sessionId?: string): HandoffSaveResult =>
      publishHandoffFor(
        String(projectId ?? ''),
        overrides,
        typeof sessionId === 'string' ? sessionId : undefined
      )
  )

  ipcMain.handle('creatorStack:list', () => ({ stack: getStack(), filePath: creatorStackFilePath() }))
  ipcMain.handle('creatorStack:reindex', () => reindexStack())
  ipcMain.handle('creatorStack:upsert', (_e, entry: CreatorStackEntry) => {
    // Re-validate through the same normalizer the disk reader uses — the renderer's shape is untrusted.
    const clean = normalizeStack({ version: 1, entries: [entry], updatedAt: Date.now() }, Date.now())
      .entries[0]
    if (!clean) return null
    return upsertStackEntry({ ...clean, source: clean.source === 'seed' ? 'seed' : 'user' })
  })
  ipcMain.handle('creatorStack:remove', (_e, id: string) => removeStackEntry(String(id ?? '')))
  // Same limit as the hook path, so "What would Claude get?" shows exactly what Claude gets.
  ipcMain.handle('creatorStack:find', (_e, query: string) => findForPrompt(String(query ?? '')))
}
