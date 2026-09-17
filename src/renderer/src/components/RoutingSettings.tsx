import { useEffect, useState } from 'react'
import type { HubSettings, StatusLineInfo } from '@shared/types'
import { ROUTING_MODES } from '@shared/types'
import { ROUTING_MODE_META } from '@shared/claudeLaunch'
import { hub } from '@/lib/api'

// Connections → Routing & context: how the Hub treats the router's
// recommendations (manual / suggest / auto / lock), the two context toggles
// (SessionStart injection, cross-terminal conflict warnings) and the opt-in
// status line that reports model / effort / context % / cache back to the Hub.

const btn =
  'shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10 disabled:opacity-40'

function Toggle({
  on,
  label,
  blurb,
  saving,
  onChange
}: {
  on: boolean
  label: string
  blurb: string
  saving: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-xs">
      <input
        type="checkbox"
        checked={on}
        disabled={saving}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-indigo-500"
      />
      <span>
        <span className="text-slate-200">{label}</span>
        <span className="block text-[11px] text-slate-500">{blurb}</span>
      </span>
    </label>
  )
}

export function RoutingSettings({
  settings,
  onSettings,
  notify
}: {
  settings: HubSettings
  onSettings: (s: HubSettings) => void
  notify: (msg: string, err?: boolean) => void
}) {
  const [saving, setSaving] = useState(false)
  const [sl, setSl] = useState<StatusLineInfo | null>(null)

  useEffect(() => {
    hub.statusLine.info().then(setSl)
  }, [])

  const save = async (patch: Partial<HubSettings>, okMsg: string): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const res = await hub.settings.set(patch)
      onSettings(res.settings)
      if (res.ok) notify(okMsg)
      else notify("Applied for this run, but couldn't be saved", true)
    } catch {
      notify('Could not save the setting', true)
    } finally {
      setSaving(false)
    }
  }

  const toggleStatusLine = async (install: boolean): Promise<void> => {
    setSaving(true)
    try {
      const res = await hub.statusLine.set(install)
      setSl(res)
      if (res.error) {
        notify(res.error, true)
        return
      }
      const r = await hub.settings.set({ statusLineTelemetry: res.installed })
      onSettings(r.settings)
      if (!r.ok) {
        // The status line changed but the preference did not persist: on the next
        // launch the Hub would reinstall (or not) against the user's choice. Say so.
        notify(
          res.installed
            ? "Status line installed, but the preference couldn't be saved"
            : "Status line removed, but the opt-out couldn't be saved — it will come back on the next launch",
          true
        )
        return
      }
      notify(
        res.installed
          ? 'Status line installed — new Claude sessions report model / context / cache'
          : 'Status line removed'
      )
    } finally {
      setSaving(false)
    }
  }

  const mode = settings.routingMode

  return (
    <section>
      <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
        <div className="mb-1 text-sm font-medium text-white">Model &amp; effort routing</div>
        <p className="mb-3 text-xs text-slate-500">
          The Hub classifies each prompt (keywords, length, risk) and watches the session (failing tests,
          edits, cross-project reach) to recommend the cheapest model / effort that can do the job. Zero
          tokens are spent deciding. Projects can override the mode in their detail panel.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ROUTING_MODES.map((m) => {
            const meta = ROUTING_MODE_META[m]
            const on = m === mode
            return (
              <button
                key={m}
                onClick={() => {
                  if (!on) void save({ routingMode: m }, `Routing: ${meta.label}`)
                }}
                disabled={saving}
                title={meta.blurb}
                className={`rounded-md border px-3 py-1.5 text-xs transition disabled:opacity-40 ${
                  on
                    ? m === 'auto'
                      ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                      : 'border-indigo-400/60 bg-indigo-500/20 text-white'
                    : 'border-white/5 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
                }`}
              >
                {meta.label}
              </button>
            )
          })}
        </div>
        <p className="mt-3 text-xs text-slate-400">{ROUTING_MODE_META[mode].blurb}</p>
        {mode === 'auto' && (
          <p className="mt-2 rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-300/90">
            Auto types <code>/model</code> and <code>/effort</code> into an embedded session only when it is
            idle, you have not typed for 2 s, and the recommendation is confident (≥ 0.75). It never changes
            anything mid-turn, never touches a locked session, and external terminals are never touched.
            Claude Code has no API for switching a running session's model — this is the best supported
            approximation.
          </p>
        )}

        <div className="mt-4 space-y-2">
          <Toggle
            saving={saving}
            on={settings.contextInjection}
            label="Inject the project + task packet at session start"
            blurb="SessionStart hook reply: a compact packet (objective, files changed, tests, next step, freshness) for startup / clear / compact — a resumed session only gets the freshness note. Never file contents."
            onChange={(v) =>
              void save({ contextInjection: v }, v ? 'Context injection on' : 'Context injection off')
            }
          />
          <Toggle
            saving={saving}
            on={settings.conflictWarnings}
            label="Warn a session when another terminal edited the same file"
            blurb="PreToolUse on edit tools: if another live session touched the file in the last 15 min, or it changed on disk after this session read it, Claude gets a one-line warning (never blocked)."
            onChange={(v) =>
              void save({ conflictWarnings: v }, v ? 'Conflict warnings on' : 'Conflict warnings off')
            }
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-slate-200">Status line telemetry (on by default)</div>
            <div className="text-[11px] text-slate-500">
              A Hub-owned <code>statusLine</code> in ~/.claude/settings.json: Claude shows{' '}
              <span className="text-slate-400">model · effort · ctx % · cache · Hub suggestion</span> in its
              own status bar, and the Hub learns the exact context-window figure that context-aware switching
              relies on. Without it, context size is estimated from the transcript&apos;s usage metadata (or
              shown as unknown). Removing it here keeps it removed.
              {sl?.foreign && (
                <span className="text-amber-300">
                  {' '}
                  You already have your own status line — the Hub will not replace it.
                </span>
              )}
              {sl?.error && <span className="text-rose-300"> {sl.error}</span>}
            </div>
          </div>
          {sl && !sl.foreign && (
            <button onClick={() => void toggleStatusLine(!sl.installed)} disabled={saving} className={btn}>
              {sl.installed ? 'Remove status line' : 'Install status line'}
            </button>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-slate-200">Agent concurrency ceiling</div>
            <div className="text-[11px] text-slate-500">
              Subagents running at once in one session before its SessionBar flags it (warning only — the Hub
              does not block agents yet; see CONTEXT_AND_ROUTING.md for the v1.2 governance proposal).
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={64}
            defaultValue={settings.agentCeiling}
            key={settings.agentCeiling}
            disabled={saving}
            onBlur={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n !== settings.agentCeiling) {
                void save({ agentCeiling: n }, `Agent ceiling: ${Math.round(n)}`)
              }
            }}
            className="w-16 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-center text-xs text-slate-100 outline-none focus:border-indigo-400"
          />
        </div>
      </div>
    </section>
  )
}
