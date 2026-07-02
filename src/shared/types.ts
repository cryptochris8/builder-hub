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

// Live git status for a project folder (Tier 1 triage). Computed in main, cached.
export interface GitStatus {
  /** false when the folder isn't a git repo (no badge shown) */
  isRepo: boolean
  /** current branch, or undefined when detached/unknown */
  branch?: string
  /** commits ahead of upstream — undefined when there's no upstream */
  ahead?: number
  /** commits behind upstream — undefined when there's no upstream */
  behind?: number
  /** changed files (staged + unstaged + untracked); 0 = clean */
  dirty?: number
  /** last commit subject + relative time, when the repo has commits */
  lastCommit?: { subject: string; relative: string }
}

export interface RescanResult {
  scanned: number
  added: number
}

export type LaunchKind =
  'folder' | 'editor' | 'terminal' | 'claude' | 'viewer' | 'files' | 'shell' | 'studio' | 'play'

// Files pane (in-app file browser + preview)
export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other'

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  /** bytes; 0 for dirs */
  size: number
  /** classification for the preview pane; 'other' for dirs too */
  kind: FileKind
}

export interface ListDirResult {
  ok: boolean
  entries: FileEntry[]
  /** true when the listing was cut off at the cap */
  truncated?: boolean
  error?: string
}

export interface ReadTextResult {
  ok: boolean
  content?: string
  /** true when only the first chunk of a large file was read */
  truncated?: boolean
  error?: string
}

/** What the clipboard held when pasting into a terminal. An image is saved to a
 *  temp PNG so its path can be handed to Claude (vision input). */
export interface PasteResult {
  kind: 'text' | 'image' | 'empty'
  text?: string
  /** temp PNG path when kind === 'image' */
  path?: string
}

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

// Claude session status (Tier 2 cockpit) — fed by Claude Code hooks POSTing to
// the Hub's localhost listener. Keyed by session cwd.
export type SessionState = 'working' | 'waiting' | 'done'

export interface ClaudeStatusEvent {
  /** the session's working directory (project folder or task worktree) */
  cwd: string
  state: SessionState | 'ended'
  /** notification text when state === 'waiting' (permission prompt / idle) */
  message?: string
  /** Claude Code session id — guards against two sessions in one cwd clobbering each other */
  sessionId?: string
  at: number
}

// Git worktree task sessions (Tier 2 cockpit)
export interface WorktreeInfo {
  path: string
  /** short branch name, e.g. hub/fix-login */
  branch: string
  /** task name derived from the branch (hub/ prefix stripped) */
  task: string
}

export interface WorktreeCreateResult {
  ok: boolean
  path?: string
  branch?: string
  error?: string
}

export interface WorktreeDiffResult {
  ok: boolean
  /** unified diff of the worktree (incl. uncommitted) against its base */
  diff?: string
  /** untracked file paths (not part of the diff) */
  untracked?: string[]
  /** what the diff is measured against, e.g. "main" */
  baseBranch?: string
  truncated?: boolean
  error?: string
}

export interface GitActionResult {
  ok: boolean
  /** stdout/stderr worth showing (e.g. merge summary or conflict text) */
  output?: string
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

// Live MCP status from `claude mcp list` (health-checked).
export type McpStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'degraded' | 'unknown'

export interface McpLiveServer {
  name: string
  /** URL (http/sse) or command (stdio) */
  target: string
  status: McpStatus
  /** raw status text from the CLI, e.g. "Connected · tools fetch failed" */
  statusText: string
}

export interface McpListLive {
  ok: boolean
  servers: McpLiveServer[]
  error?: string
}

export type McpTransport = 'http' | 'sse' | 'stdio'
export type McpScope = 'user' | 'project' | 'local'

// A one-click catalog entry (confirmed remote endpoints only).
export interface McpCatalogEntry {
  name: string
  label: string
  url: string
  transport: McpTransport
  /** short description of what it gives Claude */
  blurb: string
  /** 'oauth' = add then Login; 'header' = optional token via header; 'none' = works as-is */
  auth: 'oauth' | 'header' | 'none'
  /** header name when auth === 'header' (e.g. "Authorization", "CONTEXT7_API_KEY") */
  headerName?: string
  /** how the token is used, for the input hint */
  tokenHint?: string
  /** a caution to surface in the UI (write access, real funds, token cost…) */
  warn?: string
}

export interface McpActionResult {
  ok: boolean
  /** stdout/stderr worth showing */
  output?: string
  error?: string
}
