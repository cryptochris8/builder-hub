import type { Project, WorktreeInfo } from './types'

// Pure logic for the Tier-2 cockpit: Claude Code hook wiring, worktree parsing,
// diff parsing, and session→project resolution. NO node imports — this file is
// shared by main AND the renderer (and unit-tested).

// ---------- Claude Code hooks → Hub ----------

/** Fixed localhost port the Hub's hook listener binds. Hardcoded so the hook
 *  command in ~/.claude/settings.json needs no env expansion (shell-agnostic);
 *  when the Hub isn't running, curl fails instantly and the hook is a no-op. */
export const HUB_HOOK_PORT = 44711

/** Marker used to recognize our hook entries inside settings.json. */
export const HOOK_URL = `http://127.0.0.1:${HUB_HOOK_PORT}/hook`

/** Status-line endpoint (opt-in telemetry): Claude pipes its status JSON here and
 *  displays whatever the Hub answers. */
export const STATUSLINE_URL = `http://127.0.0.1:${HUB_HOOK_PORT}/statusline`

/** Trailing no-op that makes the command exit 0 when the Hub is closed (curl fails
 *  with 7). Claude Code runs command hooks under Git Bash on Windows (verified
 *  2.1.273: $0 = /usr/bin/bash), and `cd .` is also a silent success in cmd.exe —
 *  so the hook is a true no-op offline instead of a "non-blocking error" notice. */
const SILENT_OK = '|| cd .'

/** Command that pipes the hook's stdin JSON to the Hub and prints the Hub's reply
 *  (curl echoes the response body to stdout, which Claude Code parses as hook
 *  output — that is how SessionStart context and PreToolUse warnings get back in).
 *  --noproxy: never route loopback through a corporate/AV proxy (which would add
 *  latency to every Claude turn and leak proxy error pages into hook stdout).
 *  --connect-timeout 0.3: Winsock retries a refused connect for ~1s — cap it so
 *  a closed Hub costs ~0.3s per hook, not 1-2s. -m 2 caps the whole request. */
export function buildHookCommand(): string {
  return `curl -s --noproxy 127.0.0.1 --connect-timeout 0.3 -m 2 -X POST ${HOOK_URL} --data-binary @- ${SILENT_OK}`
}

/** The opt-in status line command: same shape, different endpoint. The Hub's
 *  reply is the text Claude shows in its status bar (model · effort · context% ·
 *  cache · the router's suggestion). Offline → prints nothing. */
export function buildStatusLineCommand(): string {
  return `curl -s --noproxy 127.0.0.1 --connect-timeout 0.3 -m 2 -X POST ${STATUSLINE_URL} --data-binary @- ${SILENT_OK}`
}

/** Every hook event the Hub wires, with the matcher it needs. PreToolUse is
 *  narrowed to edit tools (conflict warnings) so the per-tool curl cost stays
 *  bounded; everything else fires unfiltered. Order is the settings.json order. */
export const HUB_HOOK_SPECS: readonly { event: string; matcher?: string }[] = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  { event: 'PostToolUse' },
  { event: 'Stop' },
  { event: 'Notification' },
  { event: 'PreCompact' },
  { event: 'PostModelSwitch' },
  { event: 'SessionEnd' },
  // v1.1: subagent concurrency counts for the session board
  { event: 'SubagentStart' },
  { event: 'SubagentStop' }
]

/** Hook events the Hub listens for. PostToolUse flips waiting → working the
 *  moment an approved tool runs (there is no explicit "permission granted"
 *  hook event). */
export const HUB_HOOK_EVENTS: readonly string[] = HUB_HOOK_SPECS.map((s) => s.event)

interface HookEntry {
  matcher?: string
  hooks?: { type?: string; command?: string }[]
}

interface SettingsShape {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

/**
 * Idempotently add (or upgrade) the Hub's hook command in a Claude Code
 * settings.json string for every event in HUB_HOOK_EVENTS. Any hook whose
 * command contains HOOK_URL is treated as hub-owned and rewritten in place when
 * the command changes between Hub versions. Preserves all other content and any
 * user-defined hooks. Returns the original string unchanged when everything is
 * already wired, or when anything about the file has an unexpected shape (never
 * clobber what we don't understand).
 */
export function ensureHubHooks(settingsJson: string): { next: string; changed: boolean; error?: string } {
  let settings: SettingsShape
  try {
    const trimmed = settingsJson.trim()
    settings = trimmed ? (JSON.parse(trimmed) as SettingsShape) : {}
  } catch {
    return { next: settingsJson, changed: false, error: 'settings.json is not valid JSON' }
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { next: settingsJson, changed: false, error: 'settings.json is not an object' }
  }
  if (
    'hooks' in settings &&
    (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))
  ) {
    return { next: settingsJson, changed: false, error: 'settings.hooks is not an object' }
  }
  const hooks: Record<string, HookEntry[]> = (settings.hooks as Record<string, HookEntry[]>) ?? {}
  for (const event of HUB_HOOK_EVENTS) {
    if (event in hooks && !Array.isArray(hooks[event])) {
      return { next: settingsJson, changed: false, error: `settings.hooks.${event} is not an array` }
    }
  }

  const command = buildHookCommand()
  let changed = false
  for (const spec of HUB_HOOK_SPECS) {
    const event = spec.event
    const entries = hooks[event] ?? []
    let present = false
    for (const entry of entries) {
      let owned = false
      for (const h of entry?.hooks ?? []) {
        if (typeof h?.command === 'string' && h.command.includes(HOOK_URL)) {
          owned = true
          present = true
          if (h.command !== command) {
            h.command = command // hub-owned entry from an older Hub version — upgrade
            changed = true
          }
        }
      }
      // Hub-owned entries also carry the Hub's matcher (or none): an older Hub
      // wired PreToolUse without one, and a wrong matcher would silently drop
      // the events the board relies on.
      if (owned && entry && (entry.matcher ?? undefined) !== spec.matcher) {
        if (spec.matcher) entry.matcher = spec.matcher
        else delete entry.matcher
        changed = true
      }
    }
    if (!present) {
      entries.push(
        spec.matcher
          ? { matcher: spec.matcher, hooks: [{ type: 'command', command }] }
          : { hooks: [{ type: 'command', command }] }
      )
      hooks[event] = entries
      changed = true
    }
  }

  if (!changed) return { next: settingsJson, changed: false }
  settings.hooks = hooks
  return { next: JSON.stringify(settings, null, 2) + '\n', changed: true }
}

/**
 * Install or remove the Hub's status line in a Claude Code settings.json string.
 * Never touches a status line the Hub does not own (`foreign`), never creates
 * one when `install` is false, and returns the input unchanged on any unexpected
 * shape. Pure; the caller writes the file.
 */
export function ensureHubStatusLine(
  settingsJson: string,
  install: boolean
): { next: string; changed: boolean; foreign: boolean; installed: boolean; error?: string } {
  let settings: SettingsShape
  try {
    const trimmed = settingsJson.trim()
    settings = trimmed ? (JSON.parse(trimmed) as SettingsShape) : {}
  } catch {
    return {
      next: settingsJson,
      changed: false,
      foreign: false,
      installed: false,
      error: 'settings.json is not valid JSON'
    }
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return {
      next: settingsJson,
      changed: false,
      foreign: false,
      installed: false,
      error: 'settings.json is not an object'
    }
  }
  const current = settings.statusLine as { type?: unknown; command?: unknown } | undefined
  const hasCurrent = current !== undefined && current !== null
  const ours = hasCurrent && typeof current.command === 'string' && current.command.includes(STATUSLINE_URL)
  const foreign = hasCurrent && !ours
  const command = buildStatusLineCommand()
  if (install) {
    if (foreign) return { next: settingsJson, changed: false, foreign: true, installed: false }
    if (ours && current.command === command && current.type === 'command') {
      return { next: settingsJson, changed: false, foreign: false, installed: true }
    }
    settings.statusLine = { type: 'command', command }
    return { next: JSON.stringify(settings, null, 2) + '\n', changed: true, foreign: false, installed: true }
  }
  if (!ours) return { next: settingsJson, changed: false, foreign, installed: false }
  delete settings.statusLine
  return { next: JSON.stringify(settings, null, 2) + '\n', changed: true, foreign: false, installed: false }
}

/** Map a hook event name to the session state it implies (null = ignore). */
export function stateForHookEvent(event: string): 'working' | 'waiting' | 'done' | 'ended' | null {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PostToolUse': // an approved tool ran — no longer waiting
    case 'PreToolUse':
      return 'working'
    case 'Notification':
      return 'waiting'
    case 'Stop':
      return 'done'
    case 'SessionEnd':
      return 'ended'
    default:
      return null
  }
}

// ---------- worktree task sessions ----------

export const WORKTREE_BRANCH_PREFIX = 'hub/'
export const WORKTREE_DIR_SUFFIX = '.worktrees'

/** Turn a task label into a safe git branch segment (kebab, no weird chars). */
export function sanitizeBranch(task: string): string {
  return (
    task
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.@]+$/g, '')
      .replace(/(\.lock)+$/, '') || 'task'
  )
}

/**
 * Parse `git worktree list --porcelain` output into entries. The first entry is
 * the main worktree. Detached worktrees have no branch and are skipped.
 */
export function parseWorktreeList(porcelain: string): { path: string; branch: string }[] {
  const out: { path: string; branch: string }[] = []
  let path = ''
  let branch = ''
  const flush = (): void => {
    if (path && branch) out.push({ path, branch })
    path = ''
    branch = ''
  }
  for (const raw of porcelain.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') {
      flush()
    } else if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  flush()
  return out
}

/** Keep only the Hub's task worktrees (branch hub/<task>), tagging the task name. */
export function hubWorktrees(all: { path: string; branch: string }[]): WorktreeInfo[] {
  return all
    .filter((w) => w.branch.startsWith(WORKTREE_BRANCH_PREFIX))
    .map((w) => ({ path: w.path, branch: w.branch, task: w.branch.slice(WORKTREE_BRANCH_PREFIX.length) }))
}

// ---------- unified diff parsing (for the in-app diff tab) ----------

export type DiffLineType = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

export interface DiffLine {
  t: DiffLineType
  text: string
}

export interface DiffFile {
  /** display path (new path, or old path for deletions) */
  path: string
  /** true when the file was deleted */
  deleted: boolean
  /** true for binary changes (no text lines) */
  binary: boolean
  lines: DiffLine[]
  adds: number
  dels: number
}

/** Parse a unified diff (git diff output) into per-file structures. Tolerant —
 *  anything unrecognized becomes a 'meta' line so nothing is silently dropped. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  // '---'/'+++' are file headers only BEFORE the first hunk; inside a hunk a
  // deleted "-- lua comment" arrives as '---…' and must count as a del line.
  let inHunk = false
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) {
      // "diff --git a/src/x.ts b/src/x.ts" — take the b/ path (quoted when it has spaces)
      const m = line.match(/ b\/(.+)$/) ?? line.match(/ "b\/(.+)"$/)
      cur = {
        path: (m?.[1] ?? line.slice('diff --git '.length)).replace(/^"|"$/g, ''),
        deleted: false,
        binary: false,
        lines: [],
        adds: 0,
        dels: 0
      }
      files.push(cur)
      inHunk = false
      continue
    }
    if (!cur) continue
    if (line.startsWith('@@')) {
      inHunk = true
      cur.lines.push({ t: 'hunk', text: line })
    } else if (!inHunk && line.startsWith('deleted file mode')) {
      cur.deleted = true
      cur.lines.push({ t: 'meta', text: line })
    } else if (!inHunk && (line.startsWith('Binary files ') || line === 'GIT binary patch')) {
      cur.binary = true
      cur.lines.push({ t: 'meta', text: line })
    } else if (line.startsWith('+') && (inHunk || !line.startsWith('+++'))) {
      cur.adds++
      cur.lines.push({ t: 'add', text: line })
    } else if (line.startsWith('-') && (inHunk || !line.startsWith('---'))) {
      cur.dels++
      cur.lines.push({ t: 'del', text: line })
    } else if (line.startsWith(' ')) {
      cur.lines.push({ t: 'ctx', text: line })
    } else {
      cur.lines.push({ t: 'meta', text: line })
    }
  }
  return files
}

// ---------- session → project resolution (status rail) ----------

/** Canonical cwd key: backslashes, no trailing separator, lowercased. Use this
 *  EVERYWHERE a session cwd is keyed or compared — git porcelain emits forward
 *  slashes on Windows while path.join()/hook payloads emit backslashes. */
export const normPath = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase()

const norm = normPath

/**
 * Resolve a Claude session cwd to a registered project, recognizing task
 * worktrees (…\<folder>.worktrees\<task>\…). Pure string logic — no fs.
 */
export function resolveSessionProject(
  cwd: string,
  projects: Project[]
): { project?: Project; task?: string; label: string } {
  const c = norm(cwd)
  // LONGEST-prefix match, not first-match: the registry nests projects
  // (Fable-5-1-week vs Fable-5-1-week\projects\leaguecast, App-store vs
  // App-store\slice-game) and is ordered by favorite/recency, so a first-match
  // resolver labelled nested sessions with their parent and — worse — launched
  // them with the parent's session profile / permission mode.
  let best: { project: Project; task?: string; depth: number } | undefined
  for (const p of projects) {
    const root = norm(p.path)
    if (c === root || c.startsWith(root + '\\')) {
      if (!best || root.length > best.depth) best = { project: p, depth: root.length }
      continue
    }
    const wtRoot = root + WORKTREE_DIR_SUFFIX
    if (c.startsWith(wtRoot + '\\')) {
      const task = c.slice(wtRoot.length + 1).split('\\')[0]
      if (!best || wtRoot.length > best.depth) best = { project: p, task, depth: wtRoot.length }
    }
  }
  if (best) {
    return best.task
      ? { project: best.project, task: best.task, label: `${best.project.name} · ${best.task}` }
      : { project: best.project, label: best.project.name }
  }
  // Unknown folder (external session) — show the last path segment.
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return { label: parts[parts.length - 1] || cwd }
}

// ---------- embedded PTY ownership (which terminal a session runs in) ----------
//
// `embedded` must be decided per SESSION, not per folder: an external `claude`
// started in a folder that also has a Hub tab must never be typed into, nor have
// its recommendation typed into the tab. Every Hub Claude PTY is launched with a
// minted --session-id, so the exact binding is known up front; the folder is only
// consulted to let the SAME terminal adopt a new id (a /clear ends the old session
// and starts a new one in the same PTY).

/** What main knows about one live Hub Claude PTY. */
export interface ClaudePtyBinding {
  /** the Hub's internal PTY id */
  id: string
  cwd: string
  /** the Claude session id the PTY is bound to (minted at spawn, re-bound after a /clear) */
  claudeSessionId?: string
  /** when the PTY was spawned (ms) */
  createdAt: number
}

/** How long a freshly spawned PTY's minted session id gets to report its first
 *  hook before the PTY counts as free: a `claude` that ignored --session-id is
 *  still adopted by its own session, while an external terminal that starts in
 *  the same folder during the tab's first seconds cannot steal a booting tab. */
export const PTY_CLAIM_GRACE_MS = 15_000

/** Board state of a session id (undefined = never seen on the board). */
export type SessionStateOf = (sessionId: string) => string | undefined

/** A PTY is free (unclaimed) when the session it is bound to is over — ended on
 *  the board — or when its minted id never reported in within the grace period.
 *  A PTY bound to a live session is owned: nothing else may be matched to it. */
export function isUnclaimedPty(b: ClaudePtyBinding, stateOf: SessionStateOf, now: number): boolean {
  if (!b.claudeSessionId) return true
  const state = stateOf(b.claudeSessionId)
  if (state === undefined) return now - b.createdAt > PTY_CLAIM_GRACE_MS
  return state === 'ended'
}

/** The single free Hub PTY in `cwd` — the one a session first seen there may
 *  adopt. Undefined when there is none, or more than one (ambiguous: adopt nothing). */
export function unclaimedPtyIn(
  cwd: string,
  bindings: readonly ClaudePtyBinding[],
  stateOf: SessionStateOf,
  now: number
): ClaudePtyBinding | undefined {
  const key = normPath(cwd)
  const free = bindings.filter((b) => normPath(b.cwd) === key && isUnclaimedPty(b, stateOf, now))
  return free.length === 1 ? free[0] : undefined
}

/** normPath(cwd) of every free Hub PTY — the board's folder fallback for
 *  `embedded`. A folder whose Hub terminal is bound to a live session is NOT
 *  offered, so an external `claude` started there is never marked embedded. */
export function unclaimedPtyCwds(
  bindings: readonly ClaudePtyBinding[],
  stateOf: SessionStateOf,
  now: number
): Set<string> {
  const out = new Set<string>()
  for (const b of bindings) if (isUnclaimedPty(b, stateOf, now)) out.add(normPath(b.cwd))
  return out
}

/** Why typing slash commands for `record` is unsafe right now, or undefined when
 *  it is safe. A session bound to a Hub PTY by id owns that PTY outright. One
 *  matched only by folder (the fallback) may be typed into only while NO other
 *  live session shares the folder — otherwise the keystrokes could land in, or
 *  be decided by, a different session (possibly mid-turn). */
export function applyTargetError(
  record: { sessionId: string; cwd: string },
  records: readonly { sessionId: string; cwd: string; state: string }[],
  boundSessionIds: ReadonlySet<string>
): string | undefined {
  if (boundSessionIds.has(record.sessionId)) return undefined
  const key = normPath(record.cwd)
  const others = records.filter(
    (r) => r.sessionId !== record.sessionId && r.state !== 'ended' && normPath(r.cwd) === key
  )
  if (others.length === 0) return undefined
  return 'Another live session shares this folder — apply from that terminal, or type /model there'
}
