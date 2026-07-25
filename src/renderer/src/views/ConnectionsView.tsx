import { useCallback, useEffect, useState } from 'react'
import type {
  ClaudeEffort,
  ClaudeModel,
  ClaudePermissionMode,
  HubSettings,
  McpCatalogEntry,
  McpLiveServer,
  McpScope,
  McpStatus,
  McpTransport,
  SessionConfig,
  SessionProfileId
} from '@shared/types'
import { CLAUDE_EFFORTS, CLAUDE_MODELS, CLAUDE_PERMISSION_MODES, SESSION_PROFILES } from '@shared/types'
import { PERMISSION_MODE_META, PROFILE_META } from '@shared/claudeLaunch'
import { MCP_CATALOG, catalogInstalled, isClaudeAiConnector } from '@shared/mcpLogic'
import { hub } from '@/lib/api'

const STATUS_PILL: Record<McpStatus, { cls: string; label: string }> = {
  connected: { cls: 'bg-emerald-500/15 text-emerald-300', label: 'connected' },
  'needs-auth': { cls: 'bg-amber-500/15 text-amber-300', label: 'needs sign-in' },
  degraded: { cls: 'bg-yellow-500/15 text-yellow-200', label: 'degraded' },
  failed: { cls: 'bg-rose-500/15 text-rose-300', label: 'failed' },
  pending: { cls: 'bg-slate-500/15 text-slate-300', label: 'pending' },
  unknown: { cls: 'bg-slate-500/15 text-slate-400', label: 'unknown' }
}

const btn =
  'shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10 disabled:opacity-40'
const primaryBtn = `${btn} !bg-indigo-500/80 !text-white hover:!bg-indigo-400`

export function ConnectionsView({
  settings,
  onSettings,
  notify
}: {
  settings: HubSettings
  onSettings: (s: HubSettings) => void
  notify: (msg: string, err?: boolean) => void
}) {
  const [live, setLive] = useState<McpLiveServer[] | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // name being acted on
  const [hooks, setHooks] = useState<{
    listening: boolean
    port: number
    error?: string
    installError?: string
  } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLive(null)
    setLiveError(null)
    const res = await hub.mcp.live()
    if (res.ok) setLive(res.servers)
    else setLiveError(res.error ?? 'Could not read MCP servers')
  }, [])

  useEffect(() => {
    void refresh()
    hub.claude.hooksInfo().then(setHooks)
  }, [refresh])

  const act = async (
    name: string,
    fn: () => Promise<{ ok: boolean; output?: string; error?: string }>,
    okMsg: string
  ): Promise<void> => {
    setBusy(name)
    const res = await fn()
    setBusy(null)
    if (res.ok) {
      notify(res.output || okMsg)
      void refresh()
    } else {
      notify(res.error ?? 'Action failed', true)
    }
  }

  const login = (name: string): void => {
    void hub.mcp.login(name).then((r) => {
      if (r.ok) notify(`Opened a terminal to sign in to ${name} — authorize in your browser, then Refresh.`)
      else notify(r.error ?? 'Could not start sign-in', true)
    })
  }
  const logout = (name: string): Promise<void> =>
    act(name, () => hub.mcp.logout(name), `Signed out of ${name}`)
  const remove = (name: string): void => {
    if (!confirm(`Remove MCP server "${name}"?\n\nThis unregisters it from Claude Code (config only).`))
      return
    void act(name, () => hub.mcp.remove(name), `Removed ${name}`)
  }

  const installedNames = new Set((live ?? []).map((s) => s.name.toLowerCase()))
  const catalogUrlSet = new Set(MCP_CATALOG.map((c) => c.url.toLowerCase().replace(/\/$/, '')))
  // A live server belongs under a catalog card only if it's a LOCAL server (not a
  // claude.ai-synced connector) matching a catalog entry by name or URL. claude.ai
  // connectors always live in "Other", even when their URL matches a catalog entry
  // (e.g. "claude.ai Vercel" shares Vercel's URL).
  const isCatalogLocal = (s: McpLiveServer): boolean =>
    !isClaudeAiConnector(s.name) &&
    (MCP_CATALOG.some((c) => c.name.toLowerCase() === s.name.toLowerCase()) ||
      catalogUrlSet.has(s.target.toLowerCase().replace(/\/$/, '')))
  const otherLive = (live ?? []).filter((s) => !isCatalogLocal(s))

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <p className="text-sm text-slate-400">
        Claude Code — and this Hub's embedded sessions — connect to tools via{' '}
        <b className="text-slate-200">MCP</b>, the same tech as claude.ai Connectors. Anything connected here
        is available in every project you open.
      </p>

      {/* Claude permission mode — what embedded sessions may do without asking */}
      <PermissionMode settings={settings} onSettings={onSettings} notify={notify} />

      {/* Default session profile — which model + effort new sessions launch with */}
      <SessionProfileDefault settings={settings} onSettings={onSettings} notify={notify} />

      {/* Session status hooks (Tier 2) */}
      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">
          Session status hooks
        </h2>
        <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 text-sm">
          {hooks === null ? (
            <span className="text-slate-500">Checking…</span>
          ) : hooks.listening && !hooks.installError ? (
            <>
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
              <span className="text-slate-300">
                Live — Claude Code reports working / waiting / done to the Hub on port {hooks.port} (status
                dots, Dashboard rail, desktop alerts).
              </span>
            </>
          ) : (
            <>
              <span className="h-2 w-2 shrink-0 rounded-full bg-rose-400" />
              <span className="min-w-0 text-slate-300">
                Status board is offline —{' '}
                <span className="text-rose-300">{hooks.installError ?? hooks.error ?? 'unknown reason'}</span>
                {hooks.installError ? ' (fix ~/.claude/settings.json and restart the Hub)' : ''}
              </span>
            </>
          )}
        </div>
      </section>

      {/* Catalog — one-click add */}
      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">
          Add a tool (one-click)
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MCP_CATALOG.map((entry) => (
            <CatalogCard
              key={entry.name}
              entry={entry}
              installed={live ? catalogInstalled(entry, live) : undefined}
              busy={busy === entry.name}
              onLoginName={(name) => login(name)}
              onAdd={(token) =>
                act(
                  entry.name,
                  () =>
                    hub.mcp.add({
                      name: entry.name,
                      url: entry.url,
                      transport: entry.transport,
                      scope: 'user',
                      headerName: entry.auth === 'header' ? entry.headerName : undefined,
                      token
                    }),
                  entry.auth === 'oauth'
                    ? `Added ${entry.label} — click Sign in to authorize`
                    : `Added ${entry.label}`
                )
              }
            />
          ))}
        </div>
      </section>

      {/* Live servers */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">Configured servers</h2>
          <button
            onClick={() => void refresh()}
            className={`${btn} ml-auto`}
            disabled={live === null && !liveError}
          >
            ⟳ Refresh
          </button>
        </div>
        {live === null && !liveError ? (
          <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-6 text-center text-sm text-slate-500">
            Health-checking servers…
          </div>
        ) : liveError ? (
          <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
            {liveError}
          </div>
        ) : (live ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
            No MCP servers configured yet. Add one above.
          </div>
        ) : (
          <div className="space-y-3">
            <ServerList
              rows={(live ?? []).filter(isCatalogLocal)}
              title="From the catalog"
              busy={busy}
              onLogin={login}
              onLogout={logout}
              onRemove={remove}
            />
            {otherLive.length > 0 && (
              <ServerList
                rows={otherLive}
                title="Other servers (claude.ai connectors, project & custom)"
                busy={busy}
                onLogin={login}
                onLogout={logout}
                onRemove={remove}
              />
            )}
          </div>
        )}
        {installedNames.size > 0 && (
          <p className="mt-2 text-[11px] text-slate-600">
            <b className="text-amber-300/80">Write access is real</b> — sending email, editing Drive/Notion,
            pushing to repos, hitting Stripe. Claude prompts before each tool action; grant write scopes
            deliberately.
          </p>
        )}
      </section>

      {/* Custom add + claude.ai note */}
      <CustomAdd busy={busy !== null} notify={notify} onAdded={refresh} setBusy={setBusy} />

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">
          claude.ai connectors
        </h2>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 text-sm text-slate-300">
          Connectors you add on <span className="text-slate-100">claude.ai → Settings → Connectors</span>{' '}
          (Gmail, Drive, Calendar…) <b>sync automatically</b> into Claude Code on the same account, so they
          appear above and work in embedded sessions. Google/Microsoft ones must be authorized on claude.ai
          first.
        </div>
      </section>
    </div>
  )
}

function PermissionMode({
  settings,
  onSettings,
  notify
}: {
  settings: HubSettings
  onSettings: (s: HubSettings) => void
  notify: (msg: string, err?: boolean) => void
}) {
  const [saving, setSaving] = useState(false)
  // A write that didn't reach disk still governs THIS run — but it reverts on restart,
  // and for a Bypass→Ask downgrade that silently rearms bypass. Say so, don't hide it.
  const [unsaved, setUnsaved] = useState(false)
  const current = settings.claudePermissionMode
  const meta = PERMISSION_MODE_META[current]

  const choose = async (mode: ClaudePermissionMode): Promise<void> => {
    if (mode === current || saving) return
    setSaving(true)
    try {
      const res = await hub.settings.set({ claudePermissionMode: mode })
      onSettings(res.settings) // the effective mode, persisted or not
      setUnsaved(!res.ok)
      if (res.ok) notify(`Claude sessions: ${PERMISSION_MODE_META[mode].label}`)
      else notify("Applied for this run, but couldn't be saved — see Connections", true)
    } catch {
      notify('Could not save the permission mode', true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">Claude sessions</h2>
      <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
        <div className="mb-1 text-sm font-medium text-white">Default permission mode</div>
        <p className="mb-3 text-xs text-slate-500">
          How much an embedded Claude session may do before it stops to ask you. This is the default every
          project inherits — override it per project in its detail panel.
        </p>

        <div className="flex flex-wrap gap-1.5">
          {CLAUDE_PERMISSION_MODES.map((mode) => {
            const m = PERMISSION_MODE_META[mode]
            const on = mode === current
            const cls = on
              ? m.danger
                ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                : 'border-indigo-400/60 bg-indigo-500/20 text-white'
              : 'border-white/5 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
            return (
              <button
                key={mode}
                onClick={() => void choose(mode)}
                disabled={saving}
                title={m.blurb}
                className={`rounded-md border px-3 py-1.5 text-xs transition disabled:opacity-40 ${cls}`}
              >
                {m.danger && '⚠ '}
                {m.label}
              </button>
            )
          })}
        </div>

        <p className="mt-3 text-xs text-slate-400">{meta.blurb}</p>

        {meta.danger && (
          <p className="mt-2 rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-300/90">
            ⚠ <b>Unguarded.</b> Claude will edit files and run shell commands with no confirmation — including
            ones it gets wrong, and anything a web page or a file it reads talks it into. Use it only on
            projects you trust and can revert (commit first). The first bypass session on a machine opens
            Claude&apos;s own one-time disclaimer in the terminal — answer it once and it stops asking.
          </p>
        )}

        {unsaved && (
          <p className="mt-2 rounded border border-rose-500/25 bg-rose-500/5 px-2 py-1.5 text-[11px] text-rose-300/90">
            Couldn&apos;t write <code>settings.json</code>. This mode applies to sessions you open now, but it
            will <b>revert on restart</b> — so the Hub could come back up in a mode you thought you&apos;d
            left.
          </p>
        )}

        <p className="mt-2 text-[11px] text-slate-600">
          Applies to newly opened Claude tabs — existing sessions keep the mode they started with.
        </p>
      </div>
    </section>
  )
}

function SessionProfileDefault({
  settings,
  onSettings,
  notify
}: {
  settings: HubSettings
  onSettings: (s: HubSettings) => void
  notify: (msg: string, err?: boolean) => void
}) {
  const [saving, setSaving] = useState(false)
  const current: SessionConfig = settings.defaultSessionProfile ?? { profile: 'standard' }

  const save = async (cfg: SessionConfig): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const res = await hub.settings.set({ defaultSessionProfile: cfg })
      onSettings(res.settings)
      if (res.ok) notify(`Default session profile: ${PROFILE_META[cfg.profile].label}`)
      else notify("Applied for this run, but couldn't be saved", true)
    } catch {
      notify('Could not save the session profile', true)
    } finally {
      setSaving(false)
    }
  }

  const choose = (profile: SessionProfileId): void => {
    if (profile === current.profile) return
    // Switching to custom keeps whatever model/effort was last picked.
    void save(profile === 'custom' ? { profile, model: current.model, effort: current.effort } : { profile })
  }

  const sel =
    'rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-100 outline-none focus:border-indigo-400'

  return (
    <section>
      <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
        <div className="mb-1 text-sm font-medium text-white">Session profile — model &amp; effort</div>
        <p className="mb-3 text-xs text-slate-500">
          Route deep work to a strong model at high effort and chores to a cheap one at low effort, so
          Max-plan usage goes where it matters. This is the default — projects and tasks can override it.
        </p>

        <div className="flex flex-wrap gap-1.5">
          {SESSION_PROFILES.map((p) => {
            const on = p === current.profile
            return (
              <button
                key={p}
                onClick={() => choose(p)}
                disabled={saving}
                title={PROFILE_META[p].blurb}
                className={`rounded-md border px-3 py-1.5 text-xs transition disabled:opacity-40 ${
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

        {current.profile === 'custom' && (
          <div className="mt-2 flex items-center gap-2">
            <select
              value={current.model ?? ''}
              disabled={saving}
              onChange={(e) =>
                void save({ ...current, model: (e.target.value || undefined) as ClaudeModel | undefined })
              }
              className={sel}
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
              value={current.effort ?? ''}
              disabled={saving}
              onChange={(e) =>
                void save({ ...current, effort: (e.target.value || undefined) as ClaudeEffort | undefined })
              }
              className={sel}
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

        <p className="mt-3 text-xs text-slate-400">{PROFILE_META[current.profile].blurb}</p>
        <p className="mt-2 text-[11px] text-slate-600">
          Applies to newly opened Claude sessions — running ones keep what they launched with. Set a
          per-project profile in the project&apos;s detail panel; tasks can pick their own when created.
        </p>
      </div>
    </section>
  )
}

function CatalogCard({
  entry,
  installed,
  busy,
  onAdd,
  onLoginName
}: {
  entry: McpCatalogEntry
  installed?: McpLiveServer
  busy: boolean
  onAdd: (token?: string) => void
  /** sign in to the actual matched server (its name may differ from entry.name) */
  onLoginName: (name: string) => void
}) {
  const [token, setToken] = useState('')
  const pill = installed ? STATUS_PILL[installed.status] : null
  const synced = installed ? isClaudeAiConnector(installed.name) : false

  return (
    <div className="flex flex-col rounded-xl border border-white/5 bg-white/[0.02] p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium text-white">{entry.label}</span>
        {pill && <span className={`rounded px-1.5 py-0.5 text-[10px] ${pill.cls}`}>{pill.label}</span>}
        {!installed && (
          <span className="ml-auto rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">
            {entry.transport}
          </span>
        )}
      </div>
      <p className="mb-2 text-xs text-slate-400">{entry.blurb}</p>
      {entry.warn && (
        <p className="mb-2 rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-300/90">
          ⚠ {entry.warn}
        </p>
      )}
      {installed ? (
        synced ? (
          <span className="mt-auto text-[11px] text-slate-600">Synced via claude.ai · manage there</span>
        ) : installed.status === 'needs-auth' || installed.status === 'failed' ? (
          <button onClick={() => onLoginName(installed.name)} className={`${primaryBtn} mt-auto self-start`}>
            Sign in
          </button>
        ) : (
          <span className="mt-auto text-[11px] text-slate-600">Installed · manage below</span>
        )
      ) : (
        <div className="mt-auto flex flex-col gap-1.5">
          {entry.auth === 'header' && (
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={entry.tokenHint ?? 'API token (optional)'}
              type="password"
              className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-100 outline-none focus:border-indigo-400"
            />
          )}
          <button
            onClick={() => onAdd(token.trim() || undefined)}
            disabled={busy}
            className={`${primaryBtn} self-start`}
          >
            {busy ? 'Adding…' : '＋ Add'}
          </button>
        </div>
      )}
    </div>
  )
}

function ServerList({
  rows,
  title,
  busy,
  onLogin,
  onLogout,
  onRemove
}: {
  rows: McpLiveServer[]
  title: string
  busy: string | null
  onLogin: (name: string) => void
  onLogout: (name: string) => void
  onRemove: (name: string) => void
}) {
  if (rows.length === 0) return null
  return (
    <div>
      <div className="mb-1 text-xs text-slate-500">{title}</div>
      <div className="overflow-hidden rounded-xl border border-white/5">
        {rows.map((s) => {
          const pill = STATUS_PILL[s.status]
          const isRemote = /^https?:\/\//i.test(s.target)
          const isClaudeAi = s.name.toLowerCase().startsWith('claude.ai ')
          const isBusy = busy === s.name
          return (
            <div
              key={s.name}
              className="flex items-center gap-3 border-b border-white/5 bg-white/[0.02] px-4 py-2 last:border-b-0"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${pill.cls.split(' ')[0].replace('/15', '')}`}
              />
              <span className="w-40 shrink-0 truncate text-sm text-slate-200" title={s.name}>
                {s.name}
              </span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${pill.cls}`} title={s.statusText}>
                {pill.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-500" title={s.target}>
                {s.target}
              </span>
              {/* `claude mcp login` supports claude.ai connectors (Slack needs it),
                  so Sign in stays available. Sign out clears LOCAL creds — offer it
                  only for locally-added servers, not claude.ai-synced ones. */}
              {(s.status === 'needs-auth' || s.status === 'failed') && isRemote && (
                <button onClick={() => onLogin(s.name)} className={primaryBtn} disabled={isBusy}>
                  Sign in
                </button>
              )}
              {!isClaudeAi && isRemote && (s.status === 'connected' || s.status === 'degraded') && (
                <button onClick={() => onLogout(s.name)} className={btn} disabled={isBusy}>
                  Sign out
                </button>
              )}
              {!isClaudeAi && (
                <button
                  onClick={() => onRemove(s.name)}
                  className={`${btn} hover:!bg-rose-500/60 hover:!text-white`}
                  disabled={isBusy}
                >
                  Remove
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CustomAdd({
  busy,
  notify,
  onAdded,
  setBusy
}: {
  busy: boolean
  notify: (msg: string, err?: boolean) => void
  onAdded: () => Promise<void>
  setBusy: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [transport, setTransport] = useState<McpTransport>('http')
  const [scope, setScope] = useState<McpScope>('user')
  const [headerName, setHeaderName] = useState('')
  const [token, setToken] = useState('')

  const field =
    'rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-indigo-400'

  const submit = async (): Promise<void> => {
    setBusy('__custom__')
    const res = await hub.mcp.add({
      name: name.trim(),
      url: url.trim(),
      transport,
      scope,
      headerName: headerName.trim() || undefined,
      token: token.trim() || undefined
    })
    setBusy(null)
    if (res.ok) {
      notify(res.output || `Added ${name.trim()}`)
      setName('')
      setUrl('')
      setHeaderName('')
      setToken('')
      setOpen(false)
      await onAdded()
    } else {
      notify(res.error ?? 'Could not add server', true)
    }
  }

  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium uppercase tracking-wide text-slate-500 hover:text-slate-300"
      >
        {open ? '▾' : '▸'} Add a custom server (by URL)
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (e.g. supabase)"
              className={field}
            />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/mcp"
              className={field}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpTransport)}
              className={field}
            >
              <option value="http" className="bg-[#0d1320]">
                http
              </option>
              <option value="sse" className="bg-[#0d1320]">
                sse
              </option>
            </select>
            <select value={scope} onChange={(e) => setScope(e.target.value as McpScope)} className={field}>
              <option value="user" className="bg-[#0d1320]">
                user (all projects)
              </option>
              <option value="local" className="bg-[#0d1320]">
                local (this machine)
              </option>
              <option value="project" className="bg-[#0d1320]">
                project
              </option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={headerName}
              onChange={(e) => setHeaderName(e.target.value)}
              placeholder="auth header name (optional)"
              className={field}
            />
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder="token (optional)"
              className={field}
            />
          </div>
          <p className="text-[11px] text-slate-500">
            For OAuth servers, leave the token blank and use <span className="text-slate-300">Sign in</span>{' '}
            after adding. For token servers, set the header (e.g. <code>Authorization</code>) + token.
            stdio/local servers: add with <code>claude mcp add &lt;name&gt; -- &lt;command&gt;</code> in a
            terminal.
          </p>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim() || !url.trim()}
            className={`${primaryBtn}`}
          >
            ＋ Add server
          </button>
        </div>
      )}
    </section>
  )
}
