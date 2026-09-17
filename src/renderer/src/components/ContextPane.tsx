import { useCallback, useEffect, useState } from 'react'
import type {
  ContextFreshness,
  HandoffPacket,
  Project,
  ProjectContext,
  ProjectContextPatch
} from '@shared/types'
import { hub } from '@/lib/api'
import { freshnessLabel } from '@/lib/freshness'

// The "Open project context" tab: the Hub's durable, model-independent state
// for one project. Auto fields (commands, services, recent work, key files,
// fingerprint) come from Reindex — a deterministic scan, zero tokens. Notes
// (purpose, architecture, decisions, tasks, known bugs) are yours. The task
// packet at the bottom is exactly what a new/cleared session gets injected.

const btn =
  'shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10 disabled:opacity-40'
const primary = `${btn} !bg-indigo-500/80 !text-white hover:!bg-indigo-400`
const field =
  'mt-1 w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-indigo-400'
const label = 'text-[11px] font-medium uppercase tracking-wide text-slate-500'

function lines(list: string[] | undefined): string {
  return (list ?? []).join('\n')
}
function parseLines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}
function when(ms: number): string {
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'unknown'
}

export function ContextPane({
  project,
  active,
  notify,
  onSendToClaude,
  onFreshness
}: {
  project: Project
  active: boolean
  notify: (msg: string, err?: boolean) => void
  onSendToClaude: (text: string) => void
  /** freshness verdicts flow back to App so the SessionBar agrees with this tab */
  onFreshness?: (f: ContextFreshness | null) => void
}) {
  const [ctx, setCtx] = useState<ProjectContext | null | undefined>(undefined)
  const [freshness, setFreshness] = useState<ContextFreshness | null>(null)
  const [filePath, setFilePath] = useState('')
  const [packet, setPacket] = useState<{ packet: HandoffPacket; markdown: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const res = await hub.context.get(project.id)
    setCtx(res?.context ?? null)
    setFreshness(res?.freshness ?? null)
    setFilePath(res?.filePath ?? '')
    setPacket(await hub.context.packet(project.id))
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])
  // Re-pull when the tab becomes visible — sessions keep appending recent work.
  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const patch = async (p: ProjectContextPatch): Promise<void> => {
    const next = await hub.context.update(project.id, p)
    if (next) setCtx(next)
  }
  const reindex = async (): Promise<void> => {
    setBusy(true)
    const res = await hub.context.reindex(project.id)
    setBusy(false)
    if (res) {
      setCtx(res.context)
      setFreshness(res.freshness)
      onFreshness?.(res.freshness)
      setFilePath(res.filePath)
      notify('Project context reindexed')
    } else notify('Could not reindex — project not found', true)
  }
  const refresh = async (): Promise<void> => {
    const f = await hub.context.refresh(project.id)
    if (f) {
      setFreshness(f)
      onFreshness?.(f)
    }
  }
  const publish = async (): Promise<void> => {
    const res = await hub.context.publishHandoff(project.id)
    if (res.ok) {
      notify(`Handoff saved → ${res.path}`)
      void load()
    } else notify(res.error ?? 'Could not publish the handoff', true)
  }

  if (ctx === undefined) return <div className="p-4 text-xs text-slate-600">Loading context…</div>

  const commands = Object.entries(ctx?.commands ?? {})
  const fp = ctx?.fingerprint

  return (
    <div className="h-full overflow-y-auto rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-white">{project.name} — project context</h2>
        {freshness && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              freshness.status === 'stale'
                ? 'bg-amber-500/15 text-amber-300'
                : freshness.status === 'fresh'
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-slate-500/15 text-slate-400'
            }`}
            title={freshness.reasons.join(' · ') || 'fingerprint matches the source'}
          >
            {freshness.status === 'stale' ? 'STALE — source moved' : freshnessLabel(freshness)}
          </span>
        )}
        <span className="ml-auto flex gap-1">
          <button
            onClick={() => void refresh()}
            className={btn}
            title="Re-probe git HEAD / branch / dirty files and manifest mtimes"
          >
            Check freshness
          </button>
          <button
            onClick={() => void reindex()}
            disabled={busy}
            className={primary}
            title="Deterministic rescan: manifest scripts, deps, README, env key names, git"
          >
            {busy ? 'Reindexing…' : '⟳ Reindex'}
          </button>
          {filePath && (
            <>
              <button onClick={() => void hub.clipboard.writeText(filePath)} className={btn} title={filePath}>
                Copy path
              </button>
              <button
                onClick={() => void hub.launch.folder(filePath)}
                className={btn}
                title="Open the rendered context file"
              >
                Open .md ↗
              </button>
              <button
                onClick={() => onSendToClaude(`"${filePath}" `)}
                className={btn}
                title="Paste the context file path into this project's Claude session"
              >
                ▸ Send to Claude
              </button>
            </>
          )}
        </span>
      </div>

      {!ctx ? (
        <div className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
          No context yet. Reindex to scan the project (zero tokens), or just open a Claude session — the Hub
          starts recording recaps and key files from the first turn.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div>
              <div className={label}>Purpose</div>
              <textarea
                key={`purpose:${ctx.indexedAt ?? 0}`}
                defaultValue={ctx.purpose ?? ''}
                rows={2}
                placeholder="What this project is (README first paragraph on reindex, or write your own)"
                onBlur={(e) => {
                  if (e.target.value !== (ctx.purpose ?? '')) void patch({ purpose: e.target.value || null })
                }}
                className={`${field} resize-none`}
              />
            </div>
            <div>
              <div className={label}>Architecture notes</div>
              <textarea
                key="arch"
                defaultValue={ctx.architecture ?? ''}
                rows={4}
                placeholder="Important architecture — where things live, invariants, how data flows"
                onBlur={(e) => {
                  if (e.target.value !== (ctx.architecture ?? ''))
                    void patch({ architecture: e.target.value || null })
                }}
                className={`${field} resize-none`}
              />
            </div>
            {(
              [
                ['decisions', 'Decisions already made', 'one per line'],
                ['currentTasks', 'Current tasks', 'one per line'],
                ['knownBugs', 'Known bugs', 'one per line']
              ] as const
            ).map(([key, title, hint]) => (
              <div key={key}>
                <div className={label}>{title}</div>
                <textarea
                  key={`${key}:field`}
                  defaultValue={lines(ctx[key])}
                  rows={3}
                  placeholder={hint}
                  onBlur={(e) => {
                    const next = parseLines(e.target.value)
                    if (next.join('\n') !== lines(ctx[key]))
                      void patch({ [key]: next } as ProjectContextPatch)
                  }}
                  className={`${field} resize-none`}
                />
              </div>
            ))}
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <div className={label}>Commands (auto)</div>
              {commands.length ? (
                <ul className="mt-1 space-y-0.5">
                  {commands.map(([name, cmd]) => (
                    <li key={name} className="flex gap-2 text-slate-400">
                      <span className="w-24 shrink-0 truncate text-slate-200">{name}</span>
                      <code className="min-w-0 truncate" title={cmd}>
                        {cmd}
                      </code>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-1 text-slate-600">— reindex to detect scripts</div>
              )}
            </div>
            <div>
              <div className={label}>Services &amp; dependencies (auto)</div>
              <div className="mt-1 text-slate-400">
                {ctx.services.length ? ctx.services.join(' · ') : '—'}
              </div>
            </div>
            <div>
              <div className={label}>Shared tools used (Creator Stack)</div>
              <div className="mt-1 text-slate-400">
                {ctx.sharedTools.length ? ctx.sharedTools.join(' · ') : '—'}
              </div>
            </div>
            <div>
              <div className={label}>Recent work (from session recaps)</div>
              {ctx.recentWork.length ? (
                <ul className="mt-1 space-y-1">
                  {[...ctx.recentWork].reverse().map((w, i) => (
                    <li key={`${w.at}:${i}`} className="text-slate-400">
                      <span className="text-slate-600">{when(w.at)}</span> — {w.summary}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-1 text-slate-600">— nothing recorded yet</div>
              )}
            </div>
            <div>
              <div className={label}>Key files (most recently edited)</div>
              <div className="mt-1 break-all text-slate-400">
                {ctx.keyFiles.length ? ctx.keyFiles.join(' · ') : '—'}
              </div>
            </div>
            {fp && (
              <div className="text-[11px] text-slate-600">
                Fingerprint: {fp.branch ? `${fp.branch} @ ` : ''}
                {fp.head ?? '—'}
                {fp.dirty !== undefined ? ` · ${fp.dirty} uncommitted` : ''} · indexed{' '}
                {ctx.indexedAt ? when(ctx.indexedAt) : 'never'}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-5">
        <div className="mb-1 flex items-center gap-2">
          <div className={label}>Task packet — what a new / cleared session receives</div>
          <button
            onClick={() => void publish()}
            className={`${btn} ml-auto`}
            title="Write this packet to <project>/handoffs/<date>-handoff.md"
          >
            ⇥ Publish handoff
          </button>
          {packet && (
            <button onClick={() => void hub.clipboard.writeText(packet.markdown)} className={btn}>
              Copy
            </button>
          )}
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
          {packet?.markdown ?? '—'}
        </pre>
        <p className="mt-1 text-[10px] text-slate-600">
          Built from the live/last session on this project (objective, recaps, files changed, last test
          verdict) plus your notes above. Injected at SessionStart for startup / clear / compact; a resumed
          session only gets the freshness note.
        </p>
      </div>
    </div>
  )
}
