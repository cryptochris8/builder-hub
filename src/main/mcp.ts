import { app, ipcMain } from 'electron'
import { execFile, execSync, spawn } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { allProjects } from './db'
import { parseMcpList } from '../shared/mcpLogic'
import type { McpActionResult, McpListLive, McpScope, McpServerInfo, McpTransport } from '../shared/types'

// Connections panel: a one-click MCP manager wrapping the real `claude mcp`
// CLI. Live health comes from `claude mcp list`; add/remove/logout run
// non-interactively; login opens a visible terminal for the OAuth browser flow.
//
// All CLI calls go through execFile with an ARGUMENT ARRAY (never a shell
// string), so a server name/url/token can't inject a shell command.

interface RawServer {
  type?: string
  url?: string
  command?: string
}

// ---------- static file read (kept as a fallback / for project-scope info) ----------

function summarize(name: string, cfg: RawServer, scope: 'user' | 'project', project?: string): McpServerInfo {
  const transport = cfg.type ?? (cfg.command ? 'stdio' : cfg.url ? 'http' : 'unknown')
  const target = cfg.url ?? cfg.command ?? ''
  return { name, transport, target, scope, project }
}

function serversFrom(file: string, scope: 'user' | 'project', project?: string): McpServerInfo[] {
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, RawServer> }
    return Object.entries(cfg.mcpServers ?? {}).map(([name, c]) => summarize(name, c, scope, project))
  } catch {
    return []
  }
}

function listMcp(): McpServerInfo[] {
  const home = app.getPath('home')
  const out: McpServerInfo[] = []
  out.push(...serversFrom(join(home, '.claude.json'), 'user'))
  out.push(...serversFrom(join(home, '.claude', '.mcp.json'), 'user'))
  for (const p of allProjects()) {
    out.push(...serversFrom(join(p.path, '.mcp.json'), 'project', p.name))
  }
  const seen = new Set<string>()
  return out.filter((s) => {
    const k = `${s.scope}:${s.project ?? ''}:${s.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---------- live CLI ----------

const CLAUDE_TIMEOUT_MS = 30_000

// Resolve the real `claude` binary once. Preferring the native .exe lets us
// execFile it with shell:FALSE — args pass as separate argv entries, so a token
// or a server name with spaces is handled correctly and there is NO shell to
// inject into. (A .cmd/.bat shim would need shell:true; we fall back to that
// only if no .exe is found, where inputs are already validated.)
let claudePath: string | null | undefined
function resolveClaude(): string | null {
  if (claudePath !== undefined) return claudePath
  try {
    const lines = execSync('where claude', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    claudePath = lines.find((l) => l.toLowerCase().endsWith('.exe')) ?? lines[0] ?? null
  } catch {
    claudePath = null
  }
  return claudePath
}

function runClaude(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const bin = resolveClaude()
    if (!bin) {
      resolve({ ok: false, out: '', err: 'Claude CLI not found on PATH' })
      return
    }
    // shell is NEVER true here: with shell:true Node concatenates the args array
    // into one command line WITHOUT quoting (DEP0190) — a token with a space or
    // metachar would split or inject. A native .exe runs directly; a .cmd/.bat
    // shim (which Node refuses to spawn without a shell since CVE-2024-27980) is
    // run through cmd.exe as an argv, so Node quotes each element itself.
    const [file, argv] = bin.toLowerCase().endsWith('.exe')
      ? [bin, args]
      : [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', bin, ...args]]
    execFile(
      file,
      argv,
      { timeout: CLAUDE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ ok: !error, out: stdout ?? '', err: (stderr || error?.message) ?? '' })
    )
  })
}

async function liveList(): Promise<McpListLive> {
  const res = await runClaude(['mcp', 'list'])
  // `claude mcp list` prints servers even when some fail their health check, so
  // parse whatever came back; only treat a hard spawn failure as an error.
  const servers = parseMcpList(res.out || res.err)
  if (!res.ok && servers.length === 0) {
    return { ok: false, servers: [], error: res.err.trim() || 'Could not run `claude mcp list`' }
  }
  return { ok: true, servers }
}

const VALID_SCOPE: McpScope[] = ['user', 'project', 'local']
const VALID_TRANSPORT: McpTransport[] = ['http', 'sse', 'stdio']

interface AddOptions {
  name: string
  url: string
  transport?: McpTransport
  scope?: McpScope
  headerName?: string
  token?: string
}

async function addServer(opts: AddOptions): Promise<McpActionResult> {
  const name = (opts.name ?? '').trim()
  const url = (opts.url ?? '').trim()
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return { ok: false, error: 'Server name must be letters, numbers, dot, dash or underscore.' }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Enter a valid http(s) server URL.' }
  }
  const transport: McpTransport = VALID_TRANSPORT.includes(opts.transport as McpTransport)
    ? (opts.transport as McpTransport)
    : 'http'
  const scope: McpScope = VALID_SCOPE.includes(opts.scope as McpScope) ? (opts.scope as McpScope) : 'user'

  const args = ['mcp', 'add', '--transport', transport, '--scope', scope]
  const token = (opts.token ?? '').trim()
  if (token && opts.headerName) {
    // The header value is one argv element — no shell parsing, so a token with
    // spaces/special chars is safe.
    const headerVal = /^authorization$/i.test(opts.headerName)
      ? `Authorization: Bearer ${token}`
      : `${opts.headerName}: ${token}`
    args.push('--header', headerVal)
  }
  args.push(name, url)

  const res = await runClaude(args)
  if (!res.ok) return { ok: false, error: res.err.trim() || res.out.trim() || 'claude mcp add failed' }
  return { ok: true, output: res.out.trim() || `Added ${name}` }
}

async function removeServer(name: string, scope?: McpScope): Promise<McpActionResult> {
  if (!/^[\w.@ -]+$/.test(name ?? '')) return { ok: false, error: 'Invalid server name' }
  const args = ['mcp', 'remove', name]
  if (scope && VALID_SCOPE.includes(scope)) args.push('--scope', scope)
  const res = await runClaude(args)
  if (!res.ok) return { ok: false, error: res.err.trim() || res.out.trim() || 'claude mcp remove failed' }
  return { ok: true, output: res.out.trim() || `Removed ${name}` }
}

async function logoutServer(name: string): Promise<McpActionResult> {
  if (!/^[\w.@ -]+$/.test(name ?? '')) return { ok: false, error: 'Invalid server name' }
  const res = await runClaude(['mcp', 'logout', name])
  if (!res.ok) return { ok: false, error: res.err.trim() || res.out.trim() || 'claude mcp logout failed' }
  return { ok: true, output: res.out.trim() || `Signed out of ${name}` }
}

// `claude mcp login` opens a browser OAuth flow and waits for the callback, so
// it can't be a silent execFile — run it in a visible terminal the user drives.
let memoWt: boolean | undefined
function hasWt(): boolean {
  if (memoWt !== undefined) return memoWt
  try {
    execSync('where wt', { stdio: 'ignore' })
    return (memoWt = true)
  } catch {
    return (memoWt = false)
  }
}

function loginServer(name: string): McpActionResult {
  if (!/^[\w.@ -]+$/.test(name ?? '')) return { ok: false, error: 'Invalid server name' }
  const quoted = `"${name.replace(/"/g, '')}"`
  // cmd /k keeps the window open so the user sees the "Login successful" line.
  const cmd = hasWt() ? `wt cmd /k claude mcp login ${quoted}` : `start "" cmd /k claude mcp login ${quoted}`
  try {
    const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:list', () => listMcp())
  ipcMain.handle('mcp:live', () => liveList())
  ipcMain.handle('mcp:add', (_e, opts: AddOptions) => addServer(opts))
  ipcMain.handle('mcp:remove', (_e, name: string, scope?: McpScope) => removeServer(name, scope))
  ipcMain.handle('mcp:login', (_e, name: string) => loginServer(name))
  ipcMain.handle('mcp:logout', (_e, name: string) => logoutServer(name))
}
