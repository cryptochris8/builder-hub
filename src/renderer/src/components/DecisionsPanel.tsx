import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import type { Decision, DecisionRequest } from '@shared/decisions'
import { decisionsByStatus, normalizeTopic } from '@shared/decisions'
import { hub } from '@/lib/api'

// Founder decisions for one project, from the canon repo (studio-memory/knowledge).
// Chris clicking Approve / Reject here IS the evidence; Claude records through the
// `decide` CLI and needs his quoted words. Approved decisions are injected into
// every new session for this project.

const btn =
  'shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10 disabled:opacity-40'
const field =
  'mt-1 w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-indigo-400'
const label = 'text-[11px] font-medium uppercase tracking-wide text-slate-500'

function day(ms: number | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : ''
}

function Item({
  d,
  busy,
  act,
  replaces
}: {
  d: Decision
  busy: boolean
  act?: (req: DecisionRequest) => void
  /** the approved decision this proposal would replace (same topic) */
  replaces?: Decision
}) {
  const chip =
    d.status === 'approved'
      ? 'bg-emerald-500/15 text-emerald-300'
      : d.status === 'rejected'
        ? 'bg-rose-500/15 text-rose-300'
        : d.status === 'proposed'
          ? 'bg-amber-500/15 text-amber-300'
          : 'bg-slate-500/15 text-slate-400'
  return (
    <li className="rounded-md border border-white/5 bg-black/20 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${chip}`}>{d.status}</span>
        <span className="text-[11px] text-slate-500">
          {d.id} · {d.topic}
        </span>
        {act && d.status === 'proposed' && (
          <span className="ml-auto flex gap-1">
            <button
              disabled={busy}
              onClick={() => act({ action: 'approve', id: d.id, supersedes: replaces?.id })}
              className={btn}
              title={replaces ? `Replaces ${replaces.id}: ${replaces.statement}` : 'Approve'}
            >
              ✓ Approve
            </button>
            <button disabled={busy} onClick={() => act({ action: 'reject', id: d.id })} className={btn}>
              ✕ Reject
            </button>
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-slate-200">{d.statement}</div>
      {replaces && d.status === 'proposed' && (
        <div className="mt-0.5 text-[11px] text-amber-300/80">
          Approving replaces {replaces.id}: {replaces.statement}
        </div>
      )}
      {d.rationale && <div className="mt-0.5 text-[11px] text-slate-400">Why: {d.rationale}</div>}
      {d.evidence && (
        <div className="mt-0.5 text-[11px] text-slate-500" title={d.evidence.excerpt ?? ''}>
          {day(d.evidence.at)} · {d.evidence.kind === 'hub-ui' ? 'in Builder Hub' : d.evidence.kind}: “
          {d.evidence.quote}”
        </div>
      )}
      {(d.supersedes || d.supersededBy) && (
        <div className="mt-0.5 text-[11px] text-slate-600">
          {d.supersedes ? `supersedes ${d.supersedes}` : ''}
          {d.supersededBy ? `superseded by ${d.supersededBy}` : ''}
        </div>
      )}
    </li>
  )
}

export function DecisionsPanel({
  project,
  active,
  notify
}: {
  project: Project
  active: boolean
  notify: (msg: string, err?: boolean) => void
}) {
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [file, setFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [topic, setTopic] = useState('')
  const [statement, setStatement] = useState('')
  const [showOld, setShowOld] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const res = await hub.decisions.list(project.id)
    setDecisions(res?.decisions ?? [])
    setFile(res?.file ?? '')
  }, [project.id])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const act = async (req: DecisionRequest): Promise<void> => {
    setBusy(true)
    const res = await hub.decisions.act(project.id, req)
    setBusy(false)
    notify(res?.message ?? (res?.ok ? 'Saved' : 'Not saved'), !res?.ok)
    if (res?.ok) {
      setTopic('')
      setStatement('')
    }
    void load()
  }

  const g = decisionsByStatus(decisions)
  const canAdd = topic.trim().length > 0 && statement.trim().length > 0 && !busy
  // typing a decision on a topic that already has one is an explicit replacement
  const replaces = g.approved.find((a) => a.topic === normalizeTopic(topic))

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className={label}>
          Decisions — {g.approved.length} approved · {g.rejected.length} rejected · {g.proposed.length}{' '}
          proposed
        </div>
        <span className="ml-auto flex gap-1">
          <button onClick={() => void load()} className={btn} title="Reload from the canon repo">
            ⟳
          </button>
          {file && (
            <button onClick={() => void hub.launch.folder(file)} className={btn} title={file}>
              DECISIONS.md ↗
            </button>
          )}
        </span>
      </div>
      <p className="mt-0.5 text-[10px] text-slate-600">
        Approved decisions and rejected approaches are given to every new session on this project. Claude
        records them with your words as proof; proposals wait for you here.
      </p>

      {g.proposed.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {g.proposed.map((d) => (
            <Item
              key={d.id}
              d={d}
              busy={busy}
              act={(r) => void act(r)}
              replaces={g.approved.find((a) => a.topic === d.topic)}
            />
          ))}
        </ul>
      )}
      {g.approved.length + g.rejected.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {[...g.approved, ...g.rejected].map((d) => (
            <Item key={d.id} d={d} busy={busy} />
          ))}
        </ul>
      ) : (
        <div className="mt-2 text-xs text-slate-600">— no approved decisions yet</div>
      )}
      {g.superseded.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setShowOld((v) => !v)} className={btn}>
            {showOld ? 'Hide' : 'Show'} {g.superseded.length} superseded
          </button>
          {showOld && (
            <ul className="mt-1.5 space-y-1.5 opacity-70">
              {g.superseded.map((d) => (
                <Item key={d.id} d={d} busy={busy} />
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3 rounded-md border border-white/5 p-2">
        <div className={label}>Record a decision yourself</div>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="topic (e.g. art-style)"
          className={field}
        />
        <textarea
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          rows={2}
          placeholder="The decision, in one sentence"
          className={`${field} resize-none`}
        />
        {replaces && (
          <div className="mt-1 text-[11px] text-amber-300/80">
            Approving replaces {replaces.id}: {replaces.statement}
          </div>
        )}
        <div className="mt-1 flex gap-1">
          <button
            disabled={!canAdd}
            onClick={() => void act({ action: 'approve', topic, statement, supersedes: replaces?.id })}
            className={btn}
          >
            ✓ Approve
          </button>
          <button
            disabled={!canAdd}
            onClick={() => void act({ action: 'reject', topic, statement })}
            className={btn}
            title="Record an approach you don't want, so no session proposes it again"
          >
            ✕ Reject approach
          </button>
        </div>
      </div>
    </div>
  )
}
