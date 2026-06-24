// Shared domain types — imported by main (relative) and renderer (@shared alias).

export const PROJECT_TYPES = [
  'roblox',
  'hytopia',
  'unreal',
  'web-app',
  'mobile-app',
  'ai-content',
  'crypto-web3',
  'static-site',
  'other'
] as const

export type ProjectType = (typeof PROJECT_TYPES)[number]
export type ProjectStatus = 'active' | 'archived' | 'idea'

export interface Project {
  id: string
  name: string
  path: string
  type: ProjectType
  stack: string
  /** primary URL — a live site, or a Roblox game page / place ID (used by Viewer + Play in Roblox) */
  url?: string
  status: ProjectStatus
  favorite: boolean
  notes: string
  lastOpenedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TypeMeta {
  label: string
  /** Tailwind bg-* class for the colored dot */
  dot: string
  /** matching file in ~/.claude/stack-profiles (used by the Phase 4 wizard) */
  profile: string
}

export const TYPE_META: Record<ProjectType, TypeMeta> = {
  roblox: { label: 'Roblox', dot: 'bg-rose-400', profile: 'roblox.md' },
  hytopia: { label: 'HYTOPIA', dot: 'bg-emerald-400', profile: 'hytopia.md' },
  unreal: { label: 'Unreal', dot: 'bg-indigo-400', profile: 'unreal.md' },
  'web-app': { label: 'Web app', dot: 'bg-violet-400', profile: 'web-app.md' },
  'mobile-app': { label: 'Mobile', dot: 'bg-sky-400', profile: 'mobile-app.md' },
  'ai-content': { label: 'AI content', dot: 'bg-fuchsia-400', profile: 'ai-content.md' },
  'crypto-web3': { label: 'Crypto / Web3', dot: 'bg-amber-400', profile: 'crypto-web3.md' },
  'static-site': { label: 'Static site', dot: 'bg-teal-400', profile: 'static-site.md' },
  other: { label: 'Other', dot: 'bg-slate-400', profile: '' }
}

export interface LaunchResult {
  ok: boolean
  error?: string
}

export interface RescanResult {
  scanned: number
  added: number
}

export type LaunchKind = 'folder' | 'editor' | 'terminal' | 'claude' | 'viewer' | 'studio' | 'play'

// Embedded terminal (Phase 3)
export interface PtyData {
  id: string
  data: string
}
export interface PtyExit {
  id: string
  exitCode: number
}
export interface PtyCreateOptions {
  cwd: string
  cols?: number
  rows?: number
  /** start the Claude Code CLI immediately (Windows: cmd /k claude) */
  runClaude?: boolean
}

// New-project wizard (Phase 4)
export interface CreateProjectOptions {
  name: string
  type: ProjectType
  parentDir: string
  stack?: string
  initGit?: boolean
}
export interface CreateProjectResult {
  ok: boolean
  project?: Project
  error?: string
}

// MCP / connectors overview (Connections panel)
export interface McpServerInfo {
  name: string
  transport: string
  target: string
  scope: 'user' | 'project'
  project?: string
}
