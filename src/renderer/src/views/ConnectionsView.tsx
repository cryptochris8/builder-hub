import { useEffect, useState } from 'react'
import type { McpServerInfo } from '@shared/types'
import { hub } from '@/lib/api'

const GITHUB_CMD =
  'claude mcp add --transport http github https://api.githubcopilot.com/mcp/ --header "Authorization: Bearer YOUR_GITHUB_PAT"'

export function ConnectionsView() {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    hub.mcp.list().then(setServers)
  }, [])

  const copy = (): void => {
    navigator.clipboard.writeText(GITHUB_CMD)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const user = servers?.filter((s) => s.scope === 'user') ?? []
  const project = servers?.filter((s) => s.scope === 'project') ?? []

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <p className="text-sm text-slate-400">
        Claude Code — and this Hub's embedded sessions — connect to tools via{' '}
        <b className="text-slate-200">MCP</b>, the same tech as claude.ai Connectors. Anything connected
        in Claude Code is available in every project you open here.
      </p>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">
          Claude.ai connectors
        </h2>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 text-sm text-slate-300">
          Connectors you add on <span className="text-slate-100">claude.ai → Settings → Connectors</span>{' '}
          (Gmail, Google Drive, Calendar, etc.) <b>sync automatically</b> into Claude Code when you're
          signed in with the same account — so they work in the embedded terminal too. The Google /
          Microsoft ones must be authenticated on claude.ai first (their sign-in can't run from the CLI).
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">
          MCP servers in your config
        </h2>
        {servers === null ? (
          <div className="text-sm text-slate-500">Reading config…</div>
        ) : servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
            None found in <code>~/.claude.json</code> or your projects' <code>.mcp.json</code> files.
          </div>
        ) : (
          <div className="space-y-4">
            {user.length > 0 && <ServerGroup title="User · all projects" rows={user} />}
            {project.length > 0 && <ServerGroup title="Project-scoped" rows={project} />}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">Add a connector</h2>
        <div className="space-y-3 rounded-xl border border-white/5 bg-white/[0.02] p-4 text-sm text-slate-300">
          <div className="font-medium text-slate-200">GitHub — PRs, issues, code review (read/write)</div>
          <p className="text-slate-400">
            Create a fine-grained PAT (github.com → Settings → Developer settings → Personal access
            tokens), then run this in a terminal (keep the token out of shared chats):
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-black/40 px-2 py-1.5 text-[11px] text-slate-300">
              {GITHUB_CMD}
            </code>
            <button
              onClick={copy}
              className="shrink-0 rounded-md bg-white/5 px-2 py-1.5 text-xs text-slate-300 hover:bg-white/10"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            Other servers: <code>claude mcp add --transport http &lt;name&gt; &lt;url&gt;</code> (remote/OAuth) or{' '}
            <code>claude mcp add &lt;name&gt; -- &lt;command&gt;</code> (local). Scope with{' '}
            <code>--scope user|project|local</code>; manage/auth with <code>/mcp</code> in a session.
          </p>
        </div>
      </section>

      <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300/90">
        Write access is real (sending email, editing Drive, pushing to repos). Claude prompts before each
        tool action — grant write scopes deliberately.
      </p>
    </div>
  )
}

function ServerGroup({ title, rows }: { title: string; rows: McpServerInfo[] }) {
  return (
    <div>
      <div className="mb-1 text-xs text-slate-500">{title}</div>
      <div className="overflow-hidden rounded-xl border border-white/5">
        {rows.map((s, i) => (
          <div
            key={`${s.scope}-${s.project ?? ''}-${s.name}-${i}`}
            className="flex items-center gap-3 border-b border-white/5 bg-white/[0.02] px-4 py-2 last:border-b-0"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span className="w-44 shrink-0 truncate text-sm text-slate-200">{s.name}</span>
            <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
              {s.transport}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
              {s.target || (s.project ? `in ${s.project}` : '')}
            </span>
            {s.project && <span className="shrink-0 text-[10px] text-slate-600">{s.project}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
