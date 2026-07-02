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

/** Shell-agnostic (cmd + sh) command: pipe the hook's stdin JSON to the Hub.
 *  --noproxy: never route loopback through a corporate/AV proxy (which would add
 *  latency to every Claude turn and leak proxy error pages into hook stdout).
 *  --connect-timeout 0.3: Winsock retries a refused connect for ~1s — cap it so
 *  a closed Hub costs ~0.3s per hook, not 1-2s. -m 2 caps the whole request. */
export function buildHookCommand(): string {
  return `curl -s --noproxy 127.0.0.1 --connect-timeout 0.3 -m 2 -X POST ${HOOK_URL} --data-binary @-`
}

/** Hook events the Hub listens for and the state they imply. PostToolUse flips
 *  waiting → working the moment an approved tool runs (there is no explicit
 *  "permission granted" hook event). */
export const HUB_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PostToolUse',
  'Stop',
  'Notification',
  'SessionEnd'
] as const

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
  for (const event of HUB_HOOK_EVENTS) {
    const entries = hooks[event] ?? []
    let present = false
    for (const entry of entries) {
      for (const h of entry?.hooks ?? []) {
        if (typeof h?.command === 'string' && h.command.includes(HOOK_URL)) {
          present = true
          if (h.command !== command) {
            h.command = command // hub-owned entry from an older Hub version — upgrade
            changed = true
          }
        }
      }
    }
    if (!present) {
      entries.push({ hooks: [{ type: 'command', command }] })
      hooks[event] = entries
      changed = true
    }
  }

  if (!changed) return { next: settingsJson, changed: false }
  settings.hooks = hooks
  return { next: JSON.stringify(settings, null, 2) + '\n', changed: true }
}

/** Map a hook event name to the session state it implies (null = ignore). */
export function stateForHookEvent(event: string): 'working' | 'waiting' | 'done' | 'ended' | null {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PostToolUse': // an approved tool ran — no longer waiting
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
  for (const p of projects) {
    const root = norm(p.path)
    if (c === root || c.startsWith(root + '\\')) return { project: p, label: p.name }
    const wtRoot = root + WORKTREE_DIR_SUFFIX
    if (c.startsWith(wtRoot + '\\')) {
      const task = c.slice(wtRoot.length + 1).split('\\')[0]
      return { project: p, task, label: `${p.name} · ${task}` }
    }
  }
  // Unknown folder (external session) — show the last path segment.
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return { label: parts[parts.length - 1] || cwd }
}
