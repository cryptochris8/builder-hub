import { app, ipcMain } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { allProjects } from './db'
import type { McpServerInfo } from '../shared/types'

interface RawServer {
  type?: string
  url?: string
  command?: string
}

// Note: we only read non-secret fields (name/type/url/command) — never headers/env,
// which can hold tokens.
function summarize(
  name: string,
  cfg: RawServer,
  scope: 'user' | 'project',
  project?: string
): McpServerInfo {
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
  // User-global servers configured for Claude Code
  out.push(...serversFrom(join(home, '.claude.json'), 'user'))
  out.push(...serversFrom(join(home, '.claude', '.mcp.json'), 'user'))
  // Project-scoped servers (.mcp.json committed in each known project)
  for (const p of allProjects()) {
    out.push(...serversFrom(join(p.path, '.mcp.json'), 'project', p.name))
  }
  // De-dupe by scope+project+name
  const seen = new Set<string>()
  return out.filter((s) => {
    const k = `${s.scope}:${s.project ?? ''}:${s.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:list', () => listMcp())
}
