import { useState } from 'react'
import type { ContextFreshness, Project, RoutingMode, SessionRecord, SwitchingRisk } from '@shared/types'
import { formatRecommendation, modelAlias } from '@shared/router'
import { isSessionIdle, sessionLabel } from '@shared/sessionBoard'
import { describeSwitching } from '@shared/switchingCost'
import { freshnessLabel } from '@/lib/freshness'

// The compact per-terminal status/control strip above an embedded Claude tab:
// project · task · model · effort · state · context · cache · freshness · the
// router's recommendation and — v1.1 — its switching risk, with an expandable
// breakdown (task complexity, context utilization / value, continuity, capture)
// and the actions Apply · At launch · Stay · Handoff & switch · Reassess · Lock.
// One row, calm; details only on demand.

const btn =
  'shrink-0 rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-slate-300 transition hover:bg-white/10 disabled:opacity-40'
const primary = `${btn} !bg-indigo-500/80 !text-white hover:!bg-indigo-400`

const STATE_DOT: Record<string, string> = {
  working: 'bg-sky-400 animate-pulse',
  waiting: 'bg-amber-400 animate-pulse',
  done: 'bg-emerald-400',
  ended: 'bg-slate-600'
}

const FRESH_CLS: Record<string, string> = {
  fresh: 'text-emerald-300/90',
  stale: 'text-amber-300',
  unknown: 'text-slate-500'
}

const RISK_CLS: Record<SwitchingRisk, string> = {
  low: 'bg-emerald-500/15 text-emerald-300',
  moderate: 'bg-amber-500/15 text-amber-300',
  high: 'bg-rose-500/15 text-rose-300'
}

/** "ctx 91%" (exact), "ctx ~91%" / "ctx ~779k" (estimated), or nothing. */
function contextLabel(record: SessionRecord): { text: string; title: string } | undefined {
  const u = record.contextUsage
  if (u && u.source !== 'unknown') {
    const exact = u.source === 'statusline'
    const title = exact
      ? 'Context window used (Claude Code status line — exact)'
      : 'Context estimated from the transcript’s usage metadata (status line not reporting)'
    if (typeof u.pct === 'number') return { text: `ctx ${exact ? '' : '~'}${Math.round(u.pct)}%`, title }
    if (typeof u.tokens === 'number')
      return { text: `ctx ~${Math.round(u.tokens / 1000)}k`, title: `${title}; window unknown` }
  }
  if (record.contextPct !== undefined) {
    return { text: `ctx ${Math.round(record.contextPct)}%`, title: 'Context window used (status line)' }
  }
  return undefined
}

export function SessionBar({
  project,
  task,
  record,
  freshness,
  routingMode,
  agentCeiling,
  onApply,
  onApplyAtLaunch,
  onLock,
  onDismiss,
  onReassess,
  onHandoffAndSwitch,
  onOpenContext,
  onOpenStack,
  onPublishHandoff,
  onReindex
}: {
  project: Project
  task?: string
  record?: SessionRecord
  freshness?: ContextFreshness | null
  routingMode: RoutingMode
  agentCeiling: number
  onApply: (sessionId: string) => void
  onApplyAtLaunch: (sessionId: string) => void
  onLock: (sessionId: string, locked: boolean) => void
  onDismiss: (sessionId: string) => void
  onReassess: (sessionId: string) => void
  onHandoffAndSwitch: (sessionId: string) => void
  onOpenContext: (p: Project) => void
  onOpenStack: () => void
  onPublishHandoff: (p: Project, sessionId?: string) => void
  onReindex: (p: Project) => void
}) {
  const [details, setDetails] = useState(false)
  const model = record?.model ? (modelAlias(record.model) ?? record.model) : undefined
  const rec = record?.recommendation
  const routable =
    !!record &&
    !!rec &&
    !record.locked &&
    !record.dismissedAt &&
    routingMode !== 'manual' &&
    routingMode !== 'lock'
  const showRec = routable && !!rec?.changes
  const showHold = routable && !!rec?.heldForContext && !rec.changes
  const label = record ? sessionLabel(record) : task ? `${project.name} · ${task}` : project.name
  const test = record?.testStatus
  const idle = !!record && isSessionIdle(record)
  const ctx = record ? contextLabel(record) : undefined
  const agents = record?.ledger?.agentsActive ?? 0
  const sw = rec?.switching
  const deferred = rec?.deferredTarget

  const riskChip =
    sw && (showRec || showHold) ? (
      <button
        onClick={() => setDetails((d) => !d)}
        className={`rounded px-1.5 py-0.5 text-[10px] ${RISK_CLS[sw.risk]}`}
        title={`Switching risk ${sw.risk} — click for the breakdown`}
      >
        switch risk {sw.risk} {details ? '▴' : '▾'}
      </button>
    ) : null

  return (
    <div className="mb-1.5 rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-slate-400">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[record?.state ?? 'ended'] ?? 'bg-slate-600'}`}
          />
          <span className="font-medium text-slate-200">{label}</span>
          {record?.state && <span className="text-slate-500">{record.state}</span>}
        </span>

        {record ? (
          <>
            <span title={record.model ? `model: ${record.model}` : 'model not reported yet'}>
              <span className="text-slate-200">{model ?? '—'}</span>
              {record.effort && <span> / {record.effort}</span>}
              {record.locked && (
                <span
                  className="ml-1 rounded bg-slate-500/20 px-1 text-[9px] uppercase tracking-wide text-slate-300"
                  title="Pinned — no routing suggestions"
                >
                  locked
                </span>
              )}
            </span>
            {ctx && <span title={ctx.title}>{ctx.text}</span>}
            {record.cacheWarm !== undefined && (
              <span title="Prompt cache (from the status line)">
                cache {record.cacheWarm ? 'warm' : 'cold'}
                {record.cacheHitRatio !== undefined ? ` ${Math.round(record.cacheHitRatio * 100)}%` : ''}
              </span>
            )}
            {test && (
              <span title={test.command}>
                {test.kind} {test.outcome === 'pass' ? '✓' : test.outcome === 'fail' ? '✗' : '?'}
              </span>
            )}
            {Object.keys(record.filesEdited).length > 0 && (
              <span>{Object.keys(record.filesEdited).length} files</span>
            )}
            {agents > 0 && (
              <span
                className={agents > agentCeiling ? 'text-amber-300' : ''}
                title={`Subagents running now (peak ${record.ledger?.agentsPeak ?? agents}, ${record.ledger?.agentsTotal ?? agents} this session). Ceiling ${agentCeiling} — set it in Connections.`}
              >
                {agents > agentCeiling ? '⚠ ' : ''}agents {agents}
              </span>
            )}
            {record.otherProjectsTouched.length > 0 && (
              <span
                className="text-amber-300"
                title="This session edited files in another registered project"
              >
                ⚠ cross-project
              </span>
            )}
          </>
        ) : (
          <span className="text-slate-600">waiting for the session's first hook event…</span>
        )}

        {freshness && (
          <span
            className={FRESH_CLS[freshness.status]}
            title={freshness.reasons.join(' · ') || 'context matches the source'}
          >
            context {freshnessLabel(freshness)}
          </span>
        )}

        {showRec && rec && record && (
          <span className="flex flex-wrap items-center gap-1.5 rounded bg-indigo-500/10 px-2 py-0.5 text-indigo-200">
            <span title={rec.signals.join(' · ')}>💡 {formatRecommendation(rec)}</span>
            {riskChip}
            <button
              onClick={() => onApply(record.sessionId)}
              disabled={!record.embedded || !idle}
              className={primary}
              title={
                !record.embedded
                  ? 'This session runs outside the Hub — type /model and /effort there'
                  : idle
                    ? 'Type /model + /effort into this idle session now'
                    : 'Wait until the session is idle'
              }
            >
              Apply
            </button>
            {rec.offerHandoff && (
              <button
                onClick={() => onHandoffAndSwitch(record.sessionId)}
                className={btn}
                title="Publish a handoff first (objective, decisions, files, tests, next step), then switch"
              >
                Handoff &amp; switch
              </button>
            )}
            <button
              onClick={() => onApplyAtLaunch(record.sessionId)}
              className={btn}
              title="Save as this project's/task's session profile for the next launch"
            >
              At launch
            </button>
            <button
              onClick={() => onLock(record.sessionId, true)}
              className={btn}
              title="Pin this session — no more suggestions"
            >
              Lock
            </button>
            <button
              onClick={() => onDismiss(record.sessionId)}
              className={btn}
              title="Dismiss this suggestion"
            >
              ✕
            </button>
          </span>
        )}

        {showHold && rec && record && (
          <span className="flex flex-wrap items-center gap-1.5 rounded bg-rose-500/10 px-2 py-0.5 text-rose-100">
            <span title={rec.signals.join(' · ')}>
              🛡 Stay on {model ?? 'the current model'}
              {deferred ? ` (task alone: ${deferred.model} / ${deferred.effort})` : ''} — valuable context
            </span>
            {riskChip}
            <button
              onClick={() => onDismiss(record.sessionId)}
              className={primary}
              title="Keep the current model; reassess at the next task boundary"
            >
              Stay
            </button>
            <button
              onClick={() => onHandoffAndSwitch(record.sessionId)}
              className={btn}
              title={`Publish a handoff, then switch to ${deferred ? `${deferred.model} / ${deferred.effort}` : 'the cheaper model'}`}
            >
              Handoff &amp; switch
            </button>
            <button
              onClick={() => onReassess(record.sessionId)}
              className={btn}
              title="Re-read the context size and recompute"
            >
              Reassess
            </button>
            <button
              onClick={() => onLock(record.sessionId, true)}
              className={btn}
              title="Pin this session — no more suggestions"
            >
              Lock
            </button>
          </span>
        )}

        {record?.locked && (
          <button
            onClick={() => onLock(record.sessionId, false)}
            className={btn}
            title="Unpin — allow suggestions again"
          >
            Unlock
          </button>
        )}

        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={() => onOpenContext(project)}
            className={btn}
            title="Project context, task packet & handoff"
          >
            ☰ Context
          </button>
          <button
            onClick={onOpenStack}
            className={btn}
            title="Creator Stack — shared tools registry (Connections)"
          >
            ⚒ Stack
          </button>
          <button
            onClick={() => onPublishHandoff(project, record?.sessionId)}
            className={btn}
            title="Publish the current task packet to <project>/handoffs/"
          >
            ⇥ Handoff
          </button>
          <button
            onClick={() => onReindex(project)}
            className={btn}
            title="Deterministic rescan of the project (zero tokens)"
          >
            ⟳ Reindex
          </button>
        </span>
      </div>

      {details && sw && rec && record && (showRec || showHold) && (
        <div className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-0.5 border-t border-white/5 pt-1.5 sm:grid-cols-2">
          <div className="space-y-0.5">
            {describeSwitching(sw, rec.taskTier).map((row) => (
              <div key={row.label} className="flex gap-2">
                <span className="w-36 shrink-0 text-slate-500">{row.label}</span>
                <span className="text-slate-200">{row.value}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-slate-500">Why</div>
            <ul className="list-disc pl-4 text-slate-300">
              {sw.reasons.slice(0, 6).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <div className="mt-1 flex gap-1">
              <button onClick={() => onReassess(record.sessionId)} className={btn}>
                Reassess
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
