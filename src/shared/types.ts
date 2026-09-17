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

// Product lifecycle (harvested from FounderOS, trimmed). Distinct from `status`,
// which is the *registry* lifecycle (shown/archived). Optional everywhere so
// existing projects.json files need no migration.
export const PROJECT_STAGES = [
  'idea',
  'planning',
  'ready-for-build',
  'building',
  'testing',
  'launch-prep',
  'live',
  'paused'
] as const

export type ProjectStage = (typeof PROJECT_STAGES)[number]

export const STAGE_LABELS: Record<ProjectStage, string> = {
  idea: 'Idea',
  planning: 'Planning',
  'ready-for-build': 'Ready for build',
  building: 'Building',
  testing: 'Testing',
  'launch-prep': 'Launch prep',
  live: 'Live',
  paused: 'Paused'
}

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

  // --- Focus & health (FounderOS harvest) — all optional, 0-10 scores ---
  stage?: ProjectStage
  /** how directly this makes money */
  revenueScore?: number
  /** long-term strategic importance */
  strategicScore?: number
  /** how excited you are to work on it */
  excitementScore?: number
  /** how close to launch/shippable */
  readinessScore?: number
  /** remaining effort (high = lots left, lowers the score) */
  effortScore?: number
  /** what's blocking progress — empty/absent = unblocked */
  blockers?: string[]
  /** the single next concrete action */
  nextAction?: string
  /** what this project is currently about */
  currentFocus?: string

  // --- Brief (feeds the handoff/spec generators) ---
  shortDescription?: string
  problemSolved?: string
  targetAudience?: string
  monetizationModel?: string
  mvpDefinition?: string

  // --- Claude session routing (model + effort) — optional, no migration needed ---
  /** how Claude launches for this project; absent = the global default */
  sessionProfile?: SessionConfig
  /** per-project permission mode override; absent = inherit settings.claudePermissionMode.
   *  Lets a project opt out of the (bypass-by-default) global. Re-validated at launch by
   *  resolvePermissionMode — a garbage value stored here can never reach argv. */
  claudePermissionMode?: ClaudePermissionMode
  /** per-task overrides for worktree sessions, keyed by task name. Kept when a
   *  task is removed so re-creating the same task keeps its profile. */
  taskProfiles?: Record<string, SessionConfig>
  /** per-project routing mode override; absent = inherit settings.routingMode.
   *  Re-validated on read (isRoutingMode) like every other stored enum. */
  routingMode?: RoutingMode
}

/** A `projects:update` payload. `undefined` (or absent) leaves a field alone;
 *  `null` explicitly CLEARS it. Without the null sentinel an optional field
 *  like `stage` could be set but never unset — the renderer's "clear" sent
 *  `undefined`, which is indistinguishable from "not in this patch". */
export type ProjectPatch = { [K in keyof Project]?: Project[K] | null }

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
  'folder' | 'editor' | 'terminal' | 'claude' | 'viewer' | 'files' | 'shell' | 'studio' | 'play' | 'context'

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
  // NOTE: no permission mode here. The renderer must never hand argv to pty:create —
  // main reads the mode from settings.json (see src/main/settings.ts).
}

// How much Claude Code is allowed to do without asking, per launched session.
// 'default' means "pass no flag" — Claude asks as usual (its own built-in behavior).
// The other two map to real CLI flags; see claudeArgs() in src/shared/claudeLaunch.ts.
export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number]

// Model aliases + effort levels the Hub may pass to `claude` — closed allowlists,
// verified against the installed CLI (2.1.210): fable/opus/sonnet appear in
// `claude --help` for --model; haiku was confirmed from the installed binary's
// model picker ("haiku → claude-haiku-4-5"). --effort levels are from --help.
// Nothing outside these arrays can ever reach argv (see sessionArgs()).
export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const
export type ClaudeModel = (typeof CLAUDE_MODELS)[number]

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

// Session profiles: route heavy work to a strong model at high effort and chores
// to a cheap model at low effort, so Max-plan usage goes to the work that needs it.
export const SESSION_PROFILES = ['deep', 'standard', 'light', 'custom'] as const
export type SessionProfileId = (typeof SESSION_PROFILES)[number]

/** How a Claude session launches. `model`/`effort` are read ONLY when
 *  profile === 'custom'; the named presets carry their own mapping
 *  (PROFILE_PRESETS in claudeLaunch.ts). 'standard' passes no flags at all. */
export interface SessionConfig {
  profile: SessionProfileId
  model?: ClaudeModel
  effort?: ClaudeEffort
}

/** App-wide preferences, persisted in userData/settings.json. */
export interface HubSettings {
  claudePermissionMode: ClaudePermissionMode
  /** session profile used when a project doesn't set its own */
  defaultSessionProfile: SessionConfig
  /** how router recommendations are treated (manual | suggest | auto | lock) */
  routingMode: RoutingMode
  /** inject the project/task handoff packet at SessionStart (startup / clear / compact / resume) */
  contextInjection: boolean
  /** warn a session when another terminal edited the same file (PreToolUse additionalContext) */
  conflictWarnings: boolean
  /** opt-in: a Hub-owned status line so sessions report model / effort / context / cache */
  statusLineTelemetry: boolean
  /** v1.1: subagents running at once in one session before the Hub flags it (warning only) */
  agentCeiling: number
}

/** Result of a settings write. `settings` is the EFFECTIVE value — it applies to this
 *  run even when the disk write failed — while `ok` says whether it actually persisted.
 *  The two are separate on purpose: this file gates `--dangerously-skip-permissions`, so
 *  a silently-lost *downgrade* would bring the app back up in bypass while the UI had
 *  said "Ask". A failed write is never reported as saved. */
export interface SettingsSaveResult {
  ok: boolean
  settings: HubSettings
  error?: string
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

// Claude Code handoff generator (FounderOS harvest)
export const HANDOFF_TASK_TYPES = [
  'New feature',
  'Bug fix',
  'UI improvement',
  'App Store/TestFlight update',
  'Website/Netlify deployment',
  'Firebase/Firestore update',
  'Asset organization',
  'Marketing video pipeline',
  'Social content plan',
  'Game mechanic implementation',
  'Refactor/cleanup',
  'Documentation'
] as const

export type HandoffTaskType = (typeof HANDOFF_TASK_TYPES)[number]

export interface HandoffInput {
  taskTitle: string
  taskType: HandoffTaskType | ''
  objective: string
  /** newline-separated list */
  importantFiles: string
  /** newline-separated extra constraints (added to the defaults) */
  constraints: string
  /** newline-separated list */
  acceptanceCriteria: string
  includeProjectContext: boolean
}

export interface HandoffSaveResult {
  ok: boolean
  /** absolute path of the saved file */
  path?: string
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

// =====================================================================
// Efficiency / context-continuity / routing upgrade (2026-09-16)
// Everything below is optional on disk (no migration) and validated on read.
// =====================================================================

// ---------- Routing: model + effort recommendation ----------

/** How the Hub treats router recommendations.
 *  manual  - never recommend, never change anything.
 *  suggest - (default) show a recommendation; the user applies it.
 *  auto    - apply a confident recommendation to an IDLE session by typing the
 *            documented `/model` + `/effort` slash commands (best supported
 *            approximation; see CONTEXT_AND_ROUTING.md limitations).
 *  lock    - pin: never recommend or change (per project/session). */
export const ROUTING_MODES = ['manual', 'suggest', 'auto', 'lock'] as const
export type RoutingMode = (typeof ROUTING_MODES)[number]

/** Cost/capability tiers the router reasons in. Each maps to a model+effort
 *  pair (ROUTER_TIER_TARGETS in router.ts). */
export const ROUTER_TIERS = ['light', 'standard', 'deep', 'max'] as const
export type RouterTier = (typeof ROUTER_TIERS)[number]

export interface ModelEffort {
  model: ClaudeModel
  effort: ClaudeEffort
}

/** Session-derived signals the router weighs (all counters, all deterministic -
 *  fed by hook events, zero tokens spent). */
export interface RouterSignals {
  /** consecutive test/build/lint commands that failed (reset on a pass) */
  consecutiveFailures: number
  /** total failed test/build/lint commands this session */
  failures: number
  /** total passed test/build/lint commands this session */
  passes: number
  /** distinct files edited this session */
  filesEdited: number
  /** distinct registered projects whose files this session edited (>1 = cross-project) */
  projectsTouched: number
  /** consecutive turns that looked mechanical (short prompt, <=2 edits, no failures) */
  mechanicalStreak: number
  /** prompts carrying uncertainty/retry language ("still failing", "not sure", "try again") */
  uncertaintyHits: number
  /** the user explicitly asked for maximum quality / care */
  maxQualityRequested: boolean
  /** prompts carrying risk words (delete, migration, auth, payment, secret, prod) */
  riskHits: number
}

export interface RouterRecommendation {
  tier: RouterTier
  target: ModelEffort
  /** one short sentence, shown verbatim: "Suggested: sonnet / low because ..." */
  reason: string
  /** 0..1 - auto mode only acts at >= 0.75 */
  confidence: number
  /** relative to the session's CURRENT model/effort (when known) */
  direction: 'escalate' | 'deescalate' | 'hold'
  /** true when target differs from the current model/effort (false when unknown or equal) */
  changes: boolean
  /** human-readable signal labels that drove the decision */
  signals: string[]
  at: number
  /** v1.1: the tier the TASK needs, before the switching-cost policy (for display) */
  taskTier?: RouterTier
  /** v1.1: what switching would lose right now (absent when not assessed) */
  switching?: SwitchingAssessment
  /** v1.1: a downgrade the task allowed but switching cost held back */
  heldForContext?: boolean
  /** v1.1: the downgrade target that was held (what "Prepare handoff & switch" applies) */
  deferredTarget?: ModelEffort
  /** v1.1: whether auto mode may apply this recommendation unattended */
  autoAllowed?: boolean
  /** v1.1: suggest capturing a handoff before switching */
  offerHandoff?: boolean
}

// ---------- Cross-terminal session board ----------

export type CommandKind = 'test' | 'build' | 'lint' | 'typecheck' | 'git' | 'install' | 'other'
export type CommandOutcome = 'pass' | 'fail' | 'unknown'

export interface CommandRecord {
  command: string
  kind: CommandKind
  outcome: CommandOutcome
  at: number
}

/** One live (or recently ended) Claude Code session as the Hub sees it -
 *  the "shared coordination board" entry. Keyed by Claude's session_id, so two
 *  sessions in one cwd never clobber each other. Everything here is derived
 *  from hook payloads, the optional status line, and the registry - never
 *  from reading another terminal's transcript. */
export interface SessionRecord {
  sessionId: string
  cwd: string
  projectId?: string
  projectName?: string
  task?: string
  /** 'ended' entries are kept briefly so a handoff can still be published */
  state: SessionState | 'ended'
  /** true when this session runs inside a Hub tab (vs. an external terminal) */
  embedded?: boolean
  startedAt: number
  updatedAt: number
  /** first prompt of the session (trimmed) - the working objective */
  objective?: string
  /** most recent prompt (trimmed) */
  lastPrompt?: string
  /** canonical model id (from the status line / PostModelSwitch / SessionStart) */
  model?: string
  /** effort level (from hook payloads' `effort.level` or the status line) */
  effort?: string
  /** normPath(file) -> last edit timestamp */
  filesEdited: Record<string, number>
  /** normPath(file) -> last read timestamp (Read tool) */
  filesRead: Record<string, number>
  /** bounded, most recent last */
  commands: CommandRecord[]
  /** last test/build/lint verdict */
  testStatus?: CommandRecord
  /** the final assistant message of the last turn (trimmed) */
  lastAssistantMessage?: string
  /** last few turn recaps, most recent last (bounded) */
  recaps: string[]
  /** ids of other registered projects whose files this session edited */
  otherProjectsTouched: string[]
  /** creator-stack capability ids this session was pointed at */
  sharedToolsUsed: string[]
  signals: RouterSignals
  recommendation?: RouterRecommendation
  /** user pinned this session's model/effort - no recommendations shown or applied */
  locked: boolean
  /** the user dismissed the current recommendation (cleared on the next one) */
  dismissedAt?: number
  /** status-line telemetry (only when the opt-in status line is installed) */
  contextPct?: number
  cacheWarm?: boolean
  cacheHitRatio?: number
  costUsd?: number
  rateLimit5hPct?: number
  transcriptPath?: string
  /** last hook event name seen (debug/UX) */
  lastEvent?: string
  /** most recent notable action, one line ("edited src/x.ts", "ran npm test -> fail") */
  lastAction?: string
  /** when the current turn's prompt arrived (turn bookkeeping for the router) */
  lastPromptAt?: number
  /** distinct files edited since lastPromptAt */
  turnEdits?: number
  /** failed test/build/lint commands since lastPromptAt */
  turnFailures?: number
  /** v1.1: incremental value/capture counters (see ContinuityLedger) */
  ledger?: ContinuityLedger
  /** v1.1: context-window usage with its source (status line exact, transcript estimated) */
  contextUsage?: ContextUsage
}

/** A warning that two sessions are working the same file. */
export interface EditConflict {
  file: string
  /** the other session */
  otherSessionId: string
  otherLabel: string
  /** when the other session last touched it */
  at: number
  /** 'edited' = the other session edited it; 'stale' = file changed on disk after this session last read it */
  kind: 'edited' | 'stale'
}

// ---------- Persistent context: project state + task handoff ----------

/** Cheap freshness fingerprint of a project folder - recomputed at session
 *  start and on demand so a stale summary can never pass for current source. */
export interface ContextFingerprint {
  /** git HEAD sha (short), when a repo */
  head?: string
  /** git branch */
  branch?: string
  /** count of changed files (git porcelain), when a repo */
  dirty?: number
  /** mtime of CLAUDE.md (ms) */
  claudeMdMtime?: number
  /** mtime of the manifest (package.json / pubspec.yaml / *.uproject / default.project.json) */
  manifestMtime?: number
  computedAt: number
}

export interface WorkEntry {
  at: number
  summary: string
  sessionId?: string
}

/** Durable, model-independent project state owned by the Hub (context.json).
 *  Auto-* fields are refreshed by "Reindex" (deterministic scan, zero tokens);
 *  the rest is user-edited or accumulated from session recaps. Rebuildable:
 *  deleting the file only loses the accumulated notes. */
export interface ProjectContext {
  projectId: string
  /** one-paragraph purpose (README first paragraph, or user-edited) */
  purpose?: string
  /** free-form architecture notes (user-edited) */
  architecture?: string
  /** script name -> command (auto: package.json scripts, pubspec, rojo, etc.) */
  commands: Record<string, string>
  /** notable dependencies / services (auto: package deps of note + env var NAMES from .env.example) */
  services: string[]
  /** creator-stack entry/capability ids this project uses */
  sharedTools: string[]
  decisions: string[]
  currentTasks: string[]
  knownBugs: string[]
  /** last few session recaps (auto, bounded) */
  recentWork: WorkEntry[]
  /** files edited most often across sessions (auto, bounded) */
  keyFiles: string[]
  fingerprint?: ContextFingerprint
  /** last deterministic reindex */
  indexedAt?: number
  updatedAt: number
}

/** A `context:update` payload - same null-clears / undefined-leaves semantics as ProjectPatch. */
export type ProjectContextPatch = {
  [K in keyof Omit<ProjectContext, 'projectId'>]?: ProjectContext[K] | null
}

/** The compact current-task packet handed to the next model / session. */
export interface HandoffPacket {
  projectId: string
  projectName: string
  sessionId?: string
  objective: string
  attempted: string[]
  filesChanged: string[]
  decisions: string[]
  testStatus?: string
  unresolved: string[]
  nextAction?: string
  model?: string
  effort?: string
  createdAt: number
}

export interface ContextFreshness {
  /** 'fresh' = fingerprint matches; 'stale' = source moved since the context was indexed; 'unknown' = never indexed */
  status: 'fresh' | 'stale' | 'unknown'
  reasons: string[]
  checkedAt: number
}

// ---------- Creator Stack: shared tools & related projects registry ----------

export const CREATOR_STACK_KINDS = [
  'shared-tool',
  'playbook',
  'agent-pack',
  'reference',
  'catalog',
  'profile'
] as const
export type CreatorStackKind = (typeof CREATOR_STACK_KINDS)[number]

export interface CreatorCapability {
  id: string
  name: string
  /** natural-language names Claude/the user might use ("trailer kit", "video creator") */
  aliases: string[]
  purpose: string
  /** relative (to the entry path) or absolute entrypoints - scripts, commands */
  entrypoints: string[]
  /** relative or absolute doc paths to read FIRST (minimum needed) */
  docs: string[]
  /** safe-usage notes (what to change per project, what NOT to do) */
  usageNotes?: string
  /** project types this fits (absent = any) */
  worksFor?: ProjectType[]
  tags?: string[]
}

export interface CreatorStackEntry {
  id: string
  name: string
  aliases: string[]
  /** absolute path (folder or file) */
  path: string
  /** registry project id when the path is (inside) a registered project */
  projectId?: string
  kind: CreatorStackKind
  capabilities: CreatorCapability[]
  /** top-level docs (relative or absolute) */
  docs: string[]
  dependencies?: string[]
  tags?: string[]
  /** false when the path no longer exists on disk (kept so the user can fix it) */
  exists: boolean
  indexedAt?: number
  source: 'seed' | 'user' | 'discovered'
}

export interface CreatorStack {
  version: 1
  entries: CreatorStackEntry[]
  /** seed ids the user removed — Reindex must not re-append them */
  removed?: string[]
  updatedAt: number
}

/** A capability match for a free-text query ("make a trailer with our trailer kit"). */
export interface CapabilityMatch {
  entry: CreatorStackEntry
  capability?: CreatorCapability
  /** which alias/name matched */
  matched: string
  score: number
}

// ---------- v1.1: context-aware switching cost ----------
// The router answers "how capable a model does the NEXT task need?". These types
// answer "what would switching lose right now?" — see src/shared/switchingCost.ts.

export type ContextSizeClass = 'low' | 'moderate' | 'high' | 'very-high' | 'unknown'
/** `unknown`: context is high but the ledger holds too little history to judge its value */
export type ContextValueClass = 'low' | 'moderate' | 'high' | 'critical' | 'unknown'
export type ContinuityClass = 'very-low' | 'low' | 'moderate' | 'high'
export type CaptureClass = 'poor' | 'partial' | 'good' | 'excellent'
/** `unknown` follows an unknown context value — treated like high (hold, never auto-downgrade) */
export type SwitchingRisk = 'low' | 'moderate' | 'high' | 'unknown'
export type BoundaryStrength = 'none' | 'weak' | 'strong'

/** Where the context-size number came from. `statusline` is Claude Code's own
 *  figure (exact); `transcript` is summed from the last assistant turn's usage
 *  metadata (estimated); `unknown` means neither was available. */
export type ContextUsageSource = 'statusline' | 'transcript' | 'unknown'

export interface ContextUsage {
  /** tokens currently in the context window, when known */
  tokens?: number
  /** the model's context window, when known (status line, or inferred safely) */
  windowSize?: number
  /** 0-100; exact from the status line, derived only when the window is known */
  pct?: number
  source: ContextUsageSource
  at: number
}

/** Per-session counters the board reducer accumulates incrementally from hooks —
 *  the deterministic proxies behind context VALUE and CAPTURE adequacy. No
 *  transcript content is ever read to build these. */
export interface ContinuityLedger {
  /** completed turns (Stop events) */
  turns: number
  /** turns that edited at least one file */
  editTurns: number
  /** turns that only read/searched (no edits) */
  readOnlyTurns: number
  /** Read/Grep/Glob/LS/WebSearch/WebFetch calls this session */
  searchCalls: number
  /** search calls in the current turn */
  turnSearches: number
  /** passing test/build/lint/typecheck runs that followed an edit */
  passesAfterEdit: number
  /** edits since the last passing verdict (feeds passesAfterEdit) */
  editsSincePass: number
  /** recaps that recorded a design/implementation decision */
  decisionHits: number
  /** recaps that named a bug's root cause */
  rootCauseHits: number
  /** recaps that established a constraint or negative finding (valuable research) */
  constraintHits: number
  /** prompts that approved an implementation choice ("go ahead", "yes, do it") */
  approvalHits: number
  /** PreCompact events — compacted context is already summarized */
  compactions: number
  lastEditAt?: number
  /** last turn that produced edits, decisions, root causes or constraints */
  lastSubstantiveAt?: number
  /** last time the Hub persisted this session's state (a Stop recap into project context, a boundary checkpoint) */
  lastCaptureAt?: number
  /** last published handoff for this session */
  lastHandoffAt?: number
  /** file edits not yet followed by a capture */
  editsSinceCapture: number
  /** file edits since the last handoff */
  editsSinceHandoff: number
  /** substantive turns since the last handoff (the packet only carries the last few recaps) */
  substantiveTurnsSinceHandoff: number
  /** decision / root-cause / constraint recaps since the last handoff or recorded decision */
  decisionsSinceHandoff: number
  /** the most recent task boundary detected on a prompt */
  boundary?: { at: number; strength: Exclude<BoundaryStrength, 'none'>; reason: string }
  /** subagents currently running / most at once / started this session (SubagentStart/Stop) */
  agentsActive: number
  agentsPeak: number
  agentsTotal: number
}

export interface SwitchingAssessment {
  size: ContextSizeClass
  /** exact = status line; estimated = transcript usage; unknown = no data */
  sizeSource: 'exact' | 'estimated' | 'unknown'
  sizePct?: number
  sizeTokens?: number
  value: ContextValueClass
  /** 0-100 deterministic value score */
  valueScore: number
  continuity: ContinuityClass
  capture: CaptureClass
  risk: SwitchingRisk
  /** 0-1 normalized product of the four factors */
  riskScore: number
  boundary: BoundaryStrength
  /** false when size is unknown or continuity rests on too little evidence — auto never downgrades then */
  confident: boolean
  /** short human-readable evidence, most important first */
  reasons: string[]
}

// ---------- Status line telemetry (opt-in) ----------
export interface StatusLineInfo {
  /** true when ~/.claude/settings.json has a Hub-owned statusLine */
  installed: boolean
  /** true when a NON-Hub status line exists (we never replace it) */
  foreign: boolean
  error?: string
}
