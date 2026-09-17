import { useCallback, useEffect, useState } from 'react'
import type { CapabilityMatch, CreatorStack, CreatorStackEntry, CreatorStackKind } from '@shared/types'
import { CREATOR_STACK_KINDS } from '@shared/types'
import { slugId } from '@shared/creatorStack'
import { hub } from '@/lib/api'

// Connections → Creator Stack: the registry of reusable tools & related
// projects Claude is pointed at (rendered to ~/.claude/builder-hub/creator-stack.md).
// Reindex re-verifies every path; "Try a phrase" shows exactly what a prompt
// would get injected; entries can be added by hand.

const btn =
  'shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10 disabled:opacity-40'
const primary = `${btn} !bg-indigo-500/80 !text-white hover:!bg-indigo-400`
const field =
  'w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-indigo-400'

export function CreatorStackPanel({ notify }: { notify: (msg: string, err?: boolean) => void }) {
  const [stack, setStack] = useState<CreatorStack | null>(null)
  const [filePath, setFilePath] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<CapabilityMatch[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({
    name: '',
    path: '',
    aliases: '',
    purpose: '',
    kind: 'shared-tool' as CreatorStackKind
  })

  const load = useCallback(async (): Promise<void> => {
    const res = await hub.creatorStack.list()
    setStack(res.stack)
    setFilePath(res.filePath)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const reindex = async (): Promise<void> => {
    setBusy(true)
    setStack(await hub.creatorStack.reindex())
    setBusy(false)
    notify('Creator Stack reindexed')
  }
  const tryPhrase = async (): Promise<void> => {
    setMatches(await hub.creatorStack.find(query))
  }
  const remove = async (e: CreatorStackEntry): Promise<void> => {
    if (!confirm(`Remove "${e.name}" from the Creator Stack?\n\nNothing on disk is touched.`)) return
    setStack(await hub.creatorStack.remove(e.id))
  }
  const add = async (): Promise<void> => {
    const name = draft.name.trim()
    const path = draft.path.trim()
    if (!name || !path) return
    // A new entry never silently replaces an existing one (e.g. a seed) whose slug matches.
    const taken = new Set((stack?.entries ?? []).map((e) => e.id))
    let id = slugId(name)
    if (taken.has(id)) {
      let n = 2
      while (taken.has(`${id}-${n}`)) n++
      id = `${id}-${n}`
    }
    const entry: CreatorStackEntry = {
      id,
      name,
      aliases: draft.aliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      path,
      kind: draft.kind,
      capabilities: draft.purpose.trim()
        ? [
            {
              id,
              name,
              aliases: draft.aliases
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean),
              purpose: draft.purpose.trim(),
              entrypoints: [],
              docs: ['README.md']
            }
          ]
        : [],
      docs: ['README.md'],
      exists: true,
      source: 'user'
    }
    const res = await hub.creatorStack.upsert(entry)
    if (res) {
      setStack(res)
      setAdding(false)
      setDraft({ name: '', path: '', aliases: '', purpose: '', kind: 'shared-tool' })
      notify(`Added ${name} to the Creator Stack`)
    } else notify('Could not add that entry (name, path and kind are required)', true)
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Creator Stack — shared tools
        </h2>
        <span className="ml-auto flex gap-1">
          {filePath && (
            <button onClick={() => void hub.launch.folder(filePath)} className={btn} title={filePath}>
              Open .md ↗
            </button>
          )}
          <button
            onClick={() => void reindex()}
            disabled={busy}
            className={btn}
            title="Re-verify every path and re-link entries to registered projects"
          >
            {busy ? 'Reindexing…' : '⟳ Reindex'}
          </button>
          <button onClick={() => setAdding((a) => !a)} className={btn}>
            {adding ? '▾ Add entry' : '＋ Add entry'}
          </button>
        </span>
      </div>
      <p className="mb-2 text-xs text-slate-500">
        What Claude is told you already have — each entry names the docs to read first and how to use it. A
        prompt that mentions one of these (e.g. &ldquo;make a trailer with our trailer kit&rdquo;) gets its
        card injected so the established tool is used, not rebuilt.
      </p>

      {adding && (
        <div className="mb-3 grid grid-cols-2 gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="name"
            className={field}
          />
          <input
            value={draft.path}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
            placeholder="absolute path (folder or file)"
            className={field}
          />
          <input
            value={draft.aliases}
            onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
            placeholder="aliases, comma-separated"
            className={field}
          />
          <select
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as CreatorStackKind })}
            className={field}
          >
            {CREATOR_STACK_KINDS.map((k) => (
              <option key={k} value={k} className="bg-[#0d1320]">
                {k}
              </option>
            ))}
          </select>
          <input
            value={draft.purpose}
            onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
            placeholder="purpose — one sentence"
            className={`${field} col-span-2`}
          />
          <div className="col-span-2">
            <button
              onClick={() => void add()}
              disabled={!draft.name.trim() || !draft.path.trim()}
              className={primary}
            >
              ＋ Add
            </button>
          </div>
        </div>
      )}

      <div className="mb-3 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void tryPhrase()
          }}
          placeholder="Try a phrase — e.g. create a trailer using our trailer kit"
          className={field}
        />
        <button onClick={() => void tryPhrase()} className={btn}>
          What would Claude get?
        </button>
      </div>
      {matches && (
        <div className="mb-3 rounded-xl border border-indigo-400/20 bg-indigo-400/[0.03] px-3 py-2 text-xs">
          {matches.length === 0 ? (
            <span className="text-slate-500">No Creator Stack match — nothing would be injected.</span>
          ) : (
            matches.map((m) => (
              <div key={`${m.entry.id}:${m.capability?.id ?? ''}`} className="text-slate-300">
                <span className="text-indigo-200">{m.capability?.name ?? m.entry.name}</span>{' '}
                <span className="text-slate-500">
                  ({m.entry.name} · matched &ldquo;{m.matched}&rdquo;)
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {stack === null ? (
        <div className="text-xs text-slate-500">Loading…</div>
      ) : stack.entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-slate-500">
          Nothing registered — Reindex seeds the verified defaults (Income Kit tools, playbooks, profiles).
        </div>
      ) : (
        <div className="space-y-1.5">
          {stack.entries.map((e) => (
            <details key={e.id} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
              <summary className="flex cursor-pointer items-center gap-2 text-sm">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${e.exists ? 'bg-emerald-400' : 'bg-rose-400'}`}
                  title={e.exists ? 'on disk' : 'missing on disk'}
                />
                <span className="text-slate-200">{e.name}</span>
                <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">
                  {e.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-500" title={e.path}>
                  {e.path}
                </span>
                <span className="text-[10px] text-slate-600">
                  {e.capabilities.length} capabilit{e.capabilities.length === 1 ? 'y' : 'ies'}
                </span>
              </summary>
              <div className="mt-2 space-y-2 text-xs text-slate-400">
                {e.aliases.length > 0 && <div>Aliases: {e.aliases.join(', ')}</div>}
                {e.capabilities.map((c) => (
                  <div key={c.id} className="rounded-md bg-black/20 p-2">
                    <div className="text-slate-200">
                      {c.name} <span className="text-slate-600">({c.id})</span>
                    </div>
                    <div>{c.purpose}</div>
                    {c.docs.length > 0 && (
                      <div className="text-slate-500">Read first: {c.docs.join(' · ')}</div>
                    )}
                    {c.aliases.length > 0 && (
                      <div className="text-slate-600">say: {c.aliases.join(', ')}</div>
                    )}
                  </div>
                ))}
                <div className="flex gap-1">
                  <button onClick={() => void hub.launch.folder(e.path)} className={btn} disabled={!e.exists}>
                    Open ↗
                  </button>
                  <button onClick={() => void hub.clipboard.writeText(e.path)} className={btn}>
                    Copy path
                  </button>
                  <button
                    onClick={() => void remove(e)}
                    className={`${btn} hover:!bg-rose-500/60 hover:!text-white`}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}
