// Cross-terminal session board — PURE reducer over Claude Code hook payloads.
//
// One SessionRecord per Claude `session_id` (NOT per cwd — two sessions can
// share a folder). Everything is derived from hook payloads + the registry;
// no transcript is ever read. This is the "shared coordination board": what
// each terminal is doing, which files it touched, its last test verdict, its
// model/effort, and the router's recommendation — never its conversation.
//
// No node/electron imports. Every function returns NEW objects (the main
// process keeps the board in memory and broadcasts snapshots).

import type {
  CommandKind,
  CommandOutcome,
  CommandRecord,
  EditConflict,
  Project,
  SessionRecord
} from './types'
import { CLAUDE_MODELS } from './types'
import { normPath, resolveSessionProject } from './sessionLogic'
import {
  emptySignals,
  signalsAfterCommand,
  signalsAfterPrompt,
  signalsAfterTurn,
  signalsWithCounts
} from './router'
import { SEARCH_TOOLS, detectTaskBoundary, isApproval, normalizeLedger, recapLanguage } from './switchingCost'

/** The subset of a hook payload the board reads. All fields optional and
 *  untrusted — validate types before use. */
export interface HookInput {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  transcript_path?: string
  /** SessionStart: startup | resume | clear | compact | fork */
  source?: string
  /** SessionStart (sometimes) */
  model?: string
  /** UserPromptSubmit */
  prompt?: string
  /** Pre/PostToolUse */
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
  /** Pre/PostToolUse: { level } */
  effort?: { level?: string }
  /** Stop */
  last_assistant_message?: string
  /** Notification */
  message?: string
  /** Pre/PostModelSwitch */
  from_model?: string
  to_model?: string
  /** PreCompact: manual | auto */
  trigger?: string
  permission_mode?: string
}

export type Board = Record<string, SessionRecord>

export const BOARD_LIMITS = {
  /** commands kept per session */
  commands: 30,
  /** recaps kept per session */
  recaps: 4,
  /** chars kept of a recap / last assistant message */
  recapChars: 1200,
  /** chars kept of a prompt */
  promptChars: 4000,
  /** how long an 'ended' session stays on the board (ms) */
  endedTtlMs: 30 * 60 * 1000,
  /** drop anything silent for this long (ms) */
  staleMs: 12 * 60 * 60 * 1000,
  /** window in which another session's edit counts as a conflict (ms) */
  conflictWindowMs: 15 * 60 * 1000
} as const

/** chars kept of a shell command in a CommandRecord (a heredoc-sized Bash
 *  command must not bloat every board broadcast) */
export const COMMAND_CHARS = 200

/** chars of a shell command that classifyCommand inspects. The heredoc/quote
 *  scanners are linear on this window, so a 256 KB Bash payload (any local
 *  process can POST one) costs microseconds, not a main-thread stall. */
export const CLASSIFY_CHARS = 4000

/** distinct files remembered per session in filesEdited / filesRead — the
 *  oldest entries fall off once a long exploratory session passes this. */
export const FILE_MAP_LIMIT = 500

/** longest path recorded as a file-map key (Windows long paths are well under
 *  this; anything bigger is a malformed or hostile payload, not a file) */
export const FILE_KEY_CHARS = 1024

/** "Other terminals on this project" only names sessions that reported within
 *  this window: an external terminal killed without a SessionEnd never ends its
 *  record on its own, and a new session should not be told a corpse is working. */
export const OTHER_SESSION_WINDOW_MS = 60 * 60 * 1000

/** `map` plus one entry, dropping the oldest timestamps past FILE_MAP_LIMIT.
 *  An over-long key is ignored rather than truncated (a cut path is a wrong path). */
function boundedFileMap(map: Record<string, number>, key: string, at: number): Record<string, number> {
  if (key.length > FILE_KEY_CHARS) return map
  const next = { ...map, [key]: at }
  const keys = Object.keys(next)
  if (keys.length <= FILE_MAP_LIMIT) return next
  keys.sort((a, b) => next[a] - next[b])
  for (const k of keys.slice(0, keys.length - FILE_MAP_LIMIT)) delete next[k]
  return next
}

/** chars of a command / prompt / recap shown in `lastAction` */
const ACTION_CHARS = 60

export interface ApplyContext {
  projects: Project[]
  now: number
  /** normPath(cwd) of Claude PTYs the Hub spawned (marks `embedded` — fallback) */
  embeddedCwds?: Set<string>
  /** Claude session ids the Hub launched with --session-id (marks `embedded` — precise) */
  embeddedSessionIds?: Set<string>
}

export interface ApplyResult {
  board: Board
  /** the record the event applied to (absent when ignored) */
  record?: SessionRecord
  changed: boolean
  /** Stop: the trimmed recap that was recorded */
  recap?: string
  /** PostToolUse edit tools: the file that was edited (normPath) */
  editedFile?: string
  /** PostToolUse Bash: the command record */
  command?: CommandRecord
  /** SessionEnd: which session ended */
  endedSessionId?: string
  /** UserPromptSubmit: the prompt (trimmed) */
  prompt?: string
  /** UserPromptSubmit: a STRONG task boundary — the previous objective it closed (v1.1) */
  boundary?: { reason: string; previousObjective?: string }
}

/** Hook events the reducer understands; anything else is ignored unchanged. */
export const BOARD_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'PreCompact',
  'PostModelSwitch',
  'SessionEnd',
  // v1.1: subagent concurrency (counts only)
  'SubagentStart',
  'SubagentStop'
] as const

const KNOWN_EVENTS: ReadonlySet<string> = new Set(BOARD_EVENTS)
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])
/** kinds whose outcome is a verdict on the code (feed testStatus + router signals) */
const VERDICT_KINDS: ReadonlySet<CommandKind> = new Set<CommandKind>(['test', 'build', 'lint', 'typecheck'])

// ---------- small untrusted-input helpers ----------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A non-empty string, else undefined (hook fields are untrusted JSON). */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** A non-blank string with surrounding whitespace removed, else undefined. */
const pathStr = (v: unknown): string | undefined => {
  const s = str(v)?.trim()
  return s ? s : undefined
}

const basename = (p: string): string => {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

const isAbsolutePath = (p: string): boolean =>
  /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\') || p.startsWith('/')

/** Hook payloads carry absolute paths; a relative one (rare) is anchored to the
 *  session cwd so it keys the same way as its absolute twin. */
const anchorPath = (file: string, cwd: string): string =>
  isAbsolutePath(file) ? file : `${cwd.replace(/[\\/]+$/, '')}\\${file.replace(/^\.[\\/]+/, '')}`

/** Fresh record for a session first seen in `cwd`. Resolves project/task via
 *  resolveSessionProject (longest-prefix). */
export function newSessionRecord(sessionId: string, cwd: string, ctx: ApplyContext): SessionRecord {
  const resolved = resolveSessionProject(cwd, ctx.projects)
  return {
    sessionId,
    cwd,
    projectId: resolved.project?.id,
    projectName: resolved.project?.name,
    task: resolved.task,
    state: 'done',
    embedded:
      ctx.embeddedSessionIds?.has(sessionId) === true || ctx.embeddedCwds?.has(normPath(cwd)) === true,
    startedAt: ctx.now,
    updatedAt: ctx.now,
    filesEdited: {},
    filesRead: {},
    commands: [],
    recaps: [],
    otherProjectsTouched: [],
    sharedToolsUsed: [],
    signals: emptySignals(),
    locked: false
  }
}

// ---------- command classification ----------

/** Chain separators: `a && b`, `a || b`, `a; b`, `a | b`, newlines. */
const CHAIN_SPLIT = /\s*(?:&&|\|\|?|;|\r?\n)\s*/
/** A heredoc from `<<EOF` (or `<<'EOF'` / `<<-EOF`) through its terminator line. */
const HEREDOC = /<<-?\s*(['"]?)([a-z_]\w*)\1[^\n]*\n(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\r?\n|$)/g

/** Shell DATA must not be read as commands: a heredoc body (Claude Code's own
 *  commit convention is `git commit -m "$(cat <<'EOF' … EOF)"`) or a quoted
 *  string can carry "npm test" or a `;` without running anything. Heredoc bodies
 *  are removed and chain separators inside quotes are blanked before splitting. */
function stripShellData(text: string): string {
  const src = text.replace(HEREDOC, '')
  let out = ''
  let quote: string | undefined
  for (const ch of src) {
    if (quote === undefined) {
      if (ch === '"' || ch === "'") quote = ch
      out += ch
    } else if (ch === quote) {
      quote = undefined
      out += ch
    } else {
      out += /[;|&\r\n]/.test(ch) ? ' ' : ch
    }
  }
  return out
}
/** `FOO=bar cmd` prefixes */
const ENV_PREFIX = /^(?:[a-z_][a-z0-9_]*=\S*\s+)+/
/** launchers that just run the next token: `npx vitest`, `bunx tsc`, `python -m pytest`, … */
const RUNNER_PREFIX =
  /^(?:sudo\s+|npx\s+(?:-y\s+|--yes\s+)?|bunx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+(?:exec|dlx)\s+|bun\s+x\s+|python3?\s+-m\s+|py\s+-m\s+)+/

/** Most telling first — see classifyCommand for why a chain is ranked, not scanned. */
const KIND_PRIORITY: readonly CommandKind[] = [
  'test',
  'build',
  'typecheck',
  'lint',
  'install',
  'git',
  'other'
]

/** npm/pnpm/yarn/bun script names → kind (`test:unit`, `build:win`, `lint:fix`, `typecheck`). */
function scriptKind(name: string): CommandKind | undefined {
  if (!name) return undefined
  if (name.startsWith('test')) return 'test'
  if (name.startsWith('build')) return 'build'
  if (name.startsWith('lint')) return 'lint'
  if (/^(typecheck|type-check|types|check-types|tsc)/.test(name)) return 'typecheck'
  return undefined
}

function classifyPackageManager(pm: string, args: string[]): CommandKind {
  const positional = args.filter((a) => !a.startsWith('-'))
  const [sub = '', next = ''] = positional
  // bare `yarn` (or `yarn --frozen-lockfile`) installs
  if (!sub) return pm === 'yarn' ? 'install' : 'other'
  if (sub === 'run' || sub === 'run-script') return scriptKind(next) ?? 'other'
  if (sub === 'test' || sub === 't' || sub === 'tst') return 'test'
  if (sub === 'install' || sub === 'i' || sub === 'ci' || sub === 'add') return 'install'
  // pnpm / yarn / bun run scripts without `run`; npm does not
  if (pm !== 'npm') return scriptKind(sub) ?? 'other'
  return 'other'
}

/** One (un-chained) command → kind. */
function classifySegment(raw: string): CommandKind {
  const s = raw
    .trim()
    .replace(ENV_PREFIX, '')
    .replace(RUNNER_PREFIX, '')
    .replace(/^\.[\\/]/, '')
    .replace(/^node_modules[\\/]\.bin[\\/]/, '')
  const tokens = s.split(/\s+/).filter(Boolean)
  const [t0 = '', t1 = ''] = tokens
  if (!t0) return 'other'
  if (t0 === 'git') return 'git'
  if (t0 === 'npm' || t0 === 'pnpm' || t0 === 'yarn' || t0 === 'bun') {
    return classifyPackageManager(t0, tokens.slice(1))
  }
  switch (t0) {
    case 'vitest':
    case 'jest':
    case 'pytest':
    case 'mocha':
      return 'test'
    case 'eslint':
    case 'ruff':
    case 'flake8':
      return 'lint'
    case 'mypy':
    case 'pyright':
      return 'typecheck'
    case 'tsc':
      // `tsc -b` emits a project build; every other tsc invocation (`tsc`,
      // `npx tsc`, `tsc --noEmit`, `tsc -p x`) is read as a type check.
      return tokens.includes('-b') || tokens.includes('--build') ? 'build' : 'typecheck'
    case 'prettier':
      return tokens.includes('--check') ? 'lint' : 'other'
    case 'playwright':
      return t1 === 'test' ? 'test' : 'other'
    case 'pip':
    case 'pip3':
      return t1 === 'install' ? 'install' : 'other'
    case 'go':
    case 'cargo':
    case 'flutter':
    case 'dotnet':
      if (t1 === 'test') return 'test'
      if (t1 === 'build') return 'build'
      if (t0 === 'cargo' && t1 === 'check') return 'typecheck'
      if (
        (t0 === 'cargo' && t1 === 'clippy') ||
        (t0 === 'flutter' && t1 === 'analyze') ||
        (t0 === 'go' && t1 === 'vet')
      ) {
        return 'lint'
      }
      return 'other'
    case 'vite':
    case 'electron-vite':
    case 'next':
      return t1 === 'build' ? 'build' : 'other'
    default:
      if (/^gradlew?(\.bat)?$/.test(t0)) return t1 === 'test' ? 'test' : 'build'
      return 'other'
  }
}

/** Bash command → kind. `npm test`/`vitest`/`pytest`/`jest`/`go test`/`cargo test` → test;
 *  `npm run build`/`tsc -b`/`vite build`/`electron-vite build`/`flutter build` → build;
 *  `eslint`/`npm run lint`/`prettier --check` → lint; `tsc`/`tsc --noEmit`/`npx tsc`/`npm run typecheck` → typecheck;
 *  `git …` → git; `npm i|install|ci`/`bun install`/`pip install` → install; else other. */
export function classifyCommand(command: string): CommandKind {
  if (typeof command !== 'string') return 'other'
  // Cap BEFORE the scanners: they are the expensive part, not the slice after.
  const text = stripShellData(command.trim().slice(0, CLASSIFY_CHARS).toLowerCase()).slice(0, 200)
  if (!text.trim()) return 'other'
  // A chain ("cd x && npm run typecheck && npm test") is classified by its most
  // telling segment, not its first: verdict kinds win in the order
  // test > build > typecheck > lint (the test run says more about the turn than
  // the typecheck that preceded it), then install, then git — so a `git pull &&
  // npm ci` is an install, `npm ci && npm test` is a test (a verdict kind beats
  // an install even when the install comes first: testStatus must not lose the
  // run), and a `cd x && …` prefix never masks the real command. A lone `git …`
  // (or `git add && git commit`) stays git.
  let best = KIND_PRIORITY.length - 1
  for (const segment of text.split(CHAIN_SPLIT)) {
    const idx = KIND_PRIORITY.indexOf(classifySegment(segment))
    if (idx < best) best = idx
  }
  return KIND_PRIORITY[best]
}

// ---------- outcome detection ----------

/** Any of these → fail, even when a pass pattern also matches (a run with both
 *  "10 passed" and "3 failed" failed). */
const HARD_FAIL: readonly RegExp[] = [
  /\b[1-9]\d* (failed|failing)\b/i,
  /\bFAIL\b/,
  /error TS\d+/,
  /\bnpm ERR!/,
  /✗|✖/,
  // [1-9]: a "Tests: 0 failed" summary is a pass, not a failure
  /Tests?:\s+[1-9]\d* failed/i,
  /\bexit code [1-9]/i,
  /Command failed/i,
  /Traceback \(most recent call last\)/
]
/** Generic — counts only when nothing said pass (a passing run may still log "Error:" lines). */
const SOFT_FAIL = /Error:/
const PASS: readonly RegExp[] = [
  /\b\d+ passed\b/i,
  /✓/,
  /\bpassing\b/,
  // \b: "Found 10 errors." must not read as "0 errors"
  /\b0 errors\b/i,
  /Tests?:\s+\d+ passed/i,
  /All checks passed/i,
  /Build succeeded|built in \d/i,
  /Successfully|success\b/i
]

const EXIT_CODE_KEYS = ['exit_code', 'exitCode', 'code'] as const
const TEXT_KEYS = ['stdout', 'stderr', 'output', 'content', 'text'] as const

function exitCodeOf(response: unknown): number | undefined {
  if (!isRecord(response)) return undefined
  for (const key of EXIT_CODE_KEYS) {
    const v = response[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/** Gather the text of a tool_response: a plain string, or the stdout / stderr /
 *  output / content (string, array of blocks, or nested object) of an object. */
function responseText(response: unknown, depth = 0): string {
  if (typeof response === 'string') return response
  if (depth > 3) return ''
  if (Array.isArray(response)) {
    return response
      .map((v) => responseText(v, depth + 1))
      .filter(Boolean)
      .join('\n')
  }
  if (!isRecord(response)) return ''
  const parts: string[] = []
  for (const key of TEXT_KEYS) {
    const v = response[key]
    if (v === undefined || v === null) continue
    const text = responseText(v, depth + 1)
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

/** Pass/fail for a Bash tool_response. Prefers an explicit exit code field
 *  (`exit_code` / `exitCode` / `code`) when present; otherwise pattern-matches
 *  stdout/stderr text (failed counts, "error TS", "npm ERR!", ✗/✖, "FAIL" vs
 *  "passed", ✓, "0 errors"). Non-test kinds still get an outcome when obvious. */
export function detectOutcome(kind: CommandKind, response: unknown): CommandOutcome {
  // Every kind gets the same detection: a verdict on `git`/`install`/`other` is
  // harmless (the reducer only promotes VERDICT_KINDS to testStatus/signals).
  void kind
  const code = exitCodeOf(response)
  if (code !== undefined) return code === 0 ? 'pass' : 'fail'
  const text = responseText(response)
  if (!text) return 'unknown'
  if (HARD_FAIL.some((re) => re.test(text))) return 'fail'
  if (PASS.some((re) => re.test(text))) return 'pass'
  if (SOFT_FAIL.test(text)) return 'fail'
  return 'unknown'
}

// ---------- tool payload accessors ----------

/** The file an edit tool touched (Edit/Write/MultiEdit → file_path; NotebookEdit → notebook_path). */
export function editedFileOf(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): string | undefined {
  if (!toolName || !EDIT_TOOLS.has(toolName) || !isRecord(toolInput)) return undefined
  if (toolName === 'NotebookEdit') return pathStr(toolInput.notebook_path) ?? pathStr(toolInput.file_path)
  return pathStr(toolInput.file_path)
}

/** The file a Read tool read (file_path). */
export function readFileOf(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): string | undefined {
  if (toolName !== 'Read' || !isRecord(toolInput)) return undefined
  return pathStr(toolInput.file_path)
}

// ---------- the reducer ----------

/** Distinct registered projects that own at least one edited file. */
function projectsTouchedCount(filesEdited: Record<string, number>, projects: Project[]): number {
  const ids = new Set<string>()
  for (const key of Object.keys(filesEdited)) {
    const owner = resolveSessionProject(key, projects).project
    if (owner) ids.add(owner.id)
  }
  return ids.size
}

/** PostToolUse: edits, reads and shell commands. `rec` is already a fresh copy. */
function applyToolUse(rec: SessionRecord, input: HookInput, ctx: ApplyContext, result: ApplyResult): void {
  const now = ctx.now
  rec.state = 'working'
  const toolName = str(input.tool_name)
  const toolInput = isRecord(input.tool_input) ? input.tool_input : undefined

  const edited = editedFileOf(toolName, toolInput)
  if (edited) {
    const key = normPath(anchorPath(edited, rec.cwd))
    rec.filesEdited = boundedFileMap(rec.filesEdited, key, now)
    // filesEdited holds each file's LAST edit, so "edited at/after the prompt"
    // is exactly the set of distinct files touched this turn.
    const since = rec.lastPromptAt ?? rec.startedAt
    rec.turnEdits = Object.values(rec.filesEdited).filter((t) => t >= since).length
    const owner = resolveSessionProject(key, ctx.projects).project
    if (owner && owner.id !== rec.projectId && !rec.otherProjectsTouched.includes(owner.id)) {
      rec.otherProjectsTouched = [...rec.otherProjectsTouched, owner.id]
    }
    rec.signals = signalsWithCounts(rec.signals, {
      filesEdited: Object.keys(rec.filesEdited).length,
      projectsTouched: projectsTouchedCount(rec.filesEdited, ctx.projects)
    })
    rec.lastAction = `edited ${basename(edited)}`
    result.editedFile = key
    const ledger = rec.ledger
    if (ledger) {
      ledger.lastEditAt = now
      ledger.editsSinceCapture++
      ledger.editsSinceHandoff++
      ledger.editsSincePass++
    }
    return
  }

  if (toolName && SEARCH_TOOLS.has(toolName) && rec.ledger) {
    rec.ledger.searchCalls++
    rec.ledger.turnSearches++
  }
  const read = readFileOf(toolName, toolInput)
  if (read) {
    rec.filesRead = boundedFileMap(rec.filesRead, normPath(anchorPath(read, rec.cwd)), now)
    return
  }

  const command = toolName && SHELL_TOOLS.has(toolName) ? str(toolInput?.command)?.trim() : undefined
  if (!command) return
  const kind = classifyCommand(command)
  const outcome = detectOutcome(kind, input.tool_response)
  const record: CommandRecord = { command: trimText(command, COMMAND_CHARS), kind, outcome, at: now }
  rec.commands = [...rec.commands, record].slice(-BOARD_LIMITS.commands)
  if (VERDICT_KINDS.has(kind)) {
    rec.testStatus = record
    if (outcome === 'fail') rec.turnFailures = (rec.turnFailures ?? 0) + 1
    if (outcome === 'pass' && rec.ledger && rec.ledger.editsSincePass > 0) {
      rec.ledger.passesAfterEdit++
      rec.ledger.editsSincePass = 0
    }
    rec.signals = signalsAfterCommand(rec.signals, kind, outcome)
  }
  rec.lastAction = `ran ${trimText(command, ACTION_CHARS)} → ${outcome}`
  result.command = record
}

/** `/clear`, `/model opus`, `/plugin:skill args` — never the working objective. */
const SLASH_COMMAND = /^\/[\w:-]+(\s|$)/

/** The record's containers, each replaced by an empty one when a record that
 *  came off disk lost it — a missing `recaps` must not make every later Stop
 *  throw and freeze that session on the board. */
function containersOf(
  r: SessionRecord
): Pick<
  SessionRecord,
  'filesEdited' | 'filesRead' | 'commands' | 'recaps' | 'otherProjectsTouched' | 'sharedToolsUsed' | 'signals'
> {
  return {
    filesEdited: isRecord(r.filesEdited) ? r.filesEdited : {},
    filesRead: isRecord(r.filesRead) ? r.filesRead : {},
    commands: Array.isArray(r.commands) ? r.commands : [],
    recaps: Array.isArray(r.recaps) ? r.recaps : [],
    otherProjectsTouched: Array.isArray(r.otherProjectsTouched) ? r.otherProjectsTouched : [],
    sharedToolsUsed: Array.isArray(r.sharedToolsUsed) ? r.sharedToolsUsed : [],
    signals: isRecord(r.signals) ? r.signals : emptySignals()
  }
}

/** Own-property timestamp lookup: a file literally named `__proto__` or
 *  `constructor` must read as "never seen", not as Object.prototype. */
const stampOf = (stamps: Record<string, number>, key: string): number | undefined =>
  Object.hasOwn(stamps, key) && typeof stamps[key] === 'number' ? stamps[key] : undefined

/**
 * The reducer. Handles SessionStart, UserPromptSubmit, PreToolUse (records
 * `effort`, nothing else), PostToolUse (files read/edited, commands + outcome,
 * state → working), Stop (recap, state → done, turn signals), Notification
 * (state → waiting), PreCompact (notes the trigger in `lastAction`), PostModelSwitch
 * (model), SessionEnd (state → ended). Unknown events / missing session_id or
 * cwd → `{ board, changed: false }`. Edits outside the session's own project
 * (resolved against `ctx.projects`) land in `otherProjectsTouched`.
 */
export function applyHookEvent(board: Board, input: HookInput, ctx: ApplyContext): ApplyResult {
  if (!isRecord(input)) return { board, changed: false }
  const event = str(input.hook_event_name)
  const sessionId = str(input.session_id)
  const cwd = str(input.cwd)
  if (!event || !sessionId || !cwd || !KNOWN_EVENTS.has(event)) return { board, changed: false }

  const now = ctx.now
  const prev = Object.hasOwn(board, sessionId) ? board[sessionId] : newSessionRecord(sessionId, cwd, ctx)
  const rec: SessionRecord = { ...prev, ...containersOf(prev), updatedAt: now, lastEvent: event }
  // v1.1: a fresh copy of the value/capture ledger (normalized: old records have none)
  rec.ledger = normalizeLedger(prev.ledger)
  const ledger = rec.ledger
  const result: ApplyResult = { board, record: rec, changed: true }

  // An event from an 'ended' session means it is alive again (the Hub reloads
  // its board with every session marked ended; `claude --resume` keeps the id).
  if (rec.state === 'ended' && event !== 'SessionEnd') rec.state = 'done'
  // a session only ever becomes embedded (its Hub tab may close before it ends)
  if (!rec.embedded && (ctx.embeddedSessionIds?.has(sessionId) || ctx.embeddedCwds?.has(normPath(cwd)))) {
    rec.embedded = true
  }
  const transcript = str(input.transcript_path)
  if (transcript) rec.transcriptPath = transcript
  const effort = isRecord(input.effort) ? str(input.effort.level) : undefined
  if (effort) rec.effort = effort

  switch (event) {
    case 'SessionStart': {
      const model = str(input.model)
      if (model) rec.model = model
      const source = str(input.source)
      rec.lastAction = source ? `session ${source}` : 'session'
      break
    }
    case 'UserPromptSubmit': {
      const prompt = trimText(str(input.prompt), BOARD_LIMITS.promptChars)
      rec.lastPrompt = prompt
      // v1.1: a prompt that starts a different task closes the old objective. Judged
      // BEFORE the objective is touched, against what the session was doing.
      if (prompt && !SLASH_COMMAND.test(prompt) && rec.objective !== undefined) {
        const boundary = detectTaskBoundary({
          prompt,
          objective: rec.objective,
          recaps: rec.recaps,
          filesEdited: Object.keys(rec.filesEdited),
          testStatus: rec.testStatus,
          sessionProjectId: rec.projectId,
          projects: ctx.projects
        })
        if (boundary.strength !== 'none') {
          ledger.boundary = { at: now, strength: boundary.strength, reason: boundary.reason }
        }
        if (boundary.strength === 'strong') {
          result.boundary = { reason: boundary.reason, previousObjective: rec.objective }
          rec.objective = prompt
        }
      }
      if (isApproval(prompt)) ledger.approvalHits++
      ledger.turnSearches = 0
      if (rec.objective === undefined && prompt && !SLASH_COMMAND.test(prompt)) rec.objective = prompt
      rec.lastPromptAt = now
      rec.turnEdits = 0
      rec.turnFailures = 0
      rec.state = 'working'
      rec.signals = signalsAfterPrompt(rec.signals, prompt)
      rec.lastAction = prompt ? `prompt: ${trimText(prompt, ACTION_CHARS)}` : 'prompt'
      result.prompt = prompt
      break
    }
    case 'PreToolUse':
      break
    case 'PostToolUse':
      applyToolUse(rec, input, ctx, result)
      break
    case 'Stop': {
      rec.state = 'done'
      const recap = trimText(str(input.last_assistant_message), BOARD_LIMITS.recapChars)
      if (recap) {
        rec.lastAssistantMessage = recap
        if (rec.recaps[rec.recaps.length - 1] !== recap) {
          rec.recaps = [...rec.recaps, recap].slice(-BOARD_LIMITS.recaps)
        }
        result.recap = recap
      }
      // v1.1 ledger: what this turn contributed, and whether it was captured.
      ledger.turns++
      const edited = (rec.turnEdits ?? 0) > 0
      if (edited) ledger.editTurns++
      else if (ledger.turnSearches > 0) ledger.readOnlyTurns++
      const lang = recapLanguage(recap)
      if (lang.decision) ledger.decisionHits++
      if (lang.rootCause) ledger.rootCauseHits++
      if (lang.constraint) ledger.constraintHits++
      const findings = Number(lang.decision) + Number(lang.rootCause) + Number(lang.constraint)
      ledger.decisionsSinceHandoff += findings
      if (edited || findings > 0) {
        ledger.lastSubstantiveAt = now
        ledger.substantiveTurnsSinceHandoff++
      }
      // The orchestrator records a recap into project context only for a registered project.
      if (recap && rec.projectId) {
        ledger.lastCaptureAt = now
        ledger.editsSinceCapture = 0
      }
      ledger.turnSearches = 0
      rec.signals = signalsAfterTurn(rec.signals, {
        promptLength: (rec.lastPrompt ?? '').length,
        editsThisTurn: rec.turnEdits ?? 0,
        failuresThisTurn: rec.turnFailures ?? 0
      })
      rec.lastAction = recap ? `recap: ${trimText(recap, ACTION_CHARS)}` : 'stopped'
      break
    }
    case 'Notification': {
      rec.state = 'waiting'
      const message = trimText(str(input.message), 80)
      if (message) rec.lastAction = message
      break
    }
    case 'PreCompact': {
      const trigger = str(input.trigger)
      rec.lastAction = trigger ? `compacting (${trigger})` : 'compacting'
      ledger.compactions++
      break
    }
    case 'PostModelSwitch': {
      const to = str(input.to_model)
      if (to) {
        rec.model = to
        rec.lastAction = `model → ${to}`
      }
      break
    }
    case 'SubagentStart':
      ledger.agentsActive++
      ledger.agentsTotal++
      ledger.agentsPeak = Math.max(ledger.agentsPeak, ledger.agentsActive)
      break
    case 'SubagentStop':
      ledger.agentsActive = Math.max(0, ledger.agentsActive - 1)
      break
    case 'SessionEnd':
      rec.state = 'ended'
      ledger.agentsActive = 0
      result.endedSessionId = sessionId
      break
  }

  result.board = { ...board, [sessionId]: rec }
  return result
}

// ---------- queries over the board ----------

/** Other LIVE sessions (not ended, not this one) that edited `file` within the
 *  conflict window, newest first. `file` is echoed as given (display-friendly);
 *  matching is by normPath. */
export function findEditConflicts(
  board: Board,
  sessionId: string,
  file: string,
  now: number
): EditConflict[] {
  const key = normPath(file)
  const oldest = now - BOARD_LIMITS.conflictWindowMs
  const out: EditConflict[] = []
  for (const other of Object.values(board)) {
    if (other.sessionId === sessionId || other.state === 'ended') continue
    const at = stampOf(other.filesEdited, key)
    if (at === undefined || at < oldest) continue
    out.push({ file, otherSessionId: other.sessionId, otherLabel: sessionLabel(other), at, kind: 'edited' })
  }
  return out.sort((a, b) => b.at - a.at)
}

/** True when `file` changed on disk (mtime) after this session last read it and
 *  this session has not edited it since that read. Unknown file → false. */
export function staleAfterRead(record: SessionRecord, file: string, mtimeMs: number): boolean {
  const key = normPath(file)
  const read = stampOf(record.filesRead, key)
  if (read === undefined || !(mtimeMs > read)) return false
  const edited = stampOf(record.filesEdited, key)
  return !(edited !== undefined && edited >= read)
}

/** Drop ended sessions past their TTL and anything silent for BOARD_LIMITS.staleMs. */
export function pruneBoard(board: Board, now: number): Board {
  // fromEntries (not `out[id] = r`) so a '__proto__' session id stays an own key
  return Object.fromEntries(
    Object.entries(board).filter(
      ([, r]) =>
        !(r.updatedAt < now - BOARD_LIMITS.staleMs) &&
        !(r.state === 'ended' && r.updatedAt < now - BOARD_LIMITS.endedTtlMs)
    )
  )
}

/** 'claude-opus-5' → 'opus'; an id with no known alias in it is shown as-is. */
function shortModel(model: string): string {
  const lower = model.toLowerCase()
  return CLAUDE_MODELS.find((alias) => lower.includes(alias)) ?? model
}

const OUTCOME_MARK: Record<CommandOutcome, string> = { pass: '✓', fail: '✗', unknown: '?' }

/** "Income Kit · trailer — working · opus/high · 3 files · npm test ✓" */
export function boardSummaryLine(record: SessionRecord): string {
  const pieces: string[] = [record.state]
  const model = record.model ? shortModel(record.model) : undefined
  if (model && record.effort) pieces.push(`${model}/${record.effort}`)
  else if (model) pieces.push(model)
  else if (record.effort) pieces.push(`effort ${record.effort}`)
  const files = Object.keys(record.filesEdited).length
  if (files > 0) pieces.push(`${files} ${files === 1 ? 'file' : 'files'}`)
  const verdict = record.testStatus
  if (verdict) pieces.push(`${trimText(verdict.command, 40)} ${OUTCOME_MARK[verdict.outcome]}`)
  return `${sessionLabel(record)} — ${pieces.join(' · ')}`
}

/** One line per OTHER live session on the same project (for context injection
 *  and the "what are other terminals doing" query). Empty when alone. Most
 *  recently active first. Without a projectId (unregistered folder) "same
 *  project" means the same cwd. */
export function otherSessionsSummary(
  board: Board,
  sessionId: string,
  projectId: string | undefined,
  /** when given, sessions silent for longer than OTHER_SESSION_WINDOW_MS are left out */
  now?: number
): string[] {
  const self = Object.hasOwn(board, sessionId) ? board[sessionId] : undefined
  const cwdKey = projectId === undefined && self ? normPath(self.cwd) : undefined
  const sameProject = (r: SessionRecord): boolean =>
    projectId !== undefined ? r.projectId === projectId : cwdKey !== undefined && normPath(r.cwd) === cwdKey
  const recent = (r: SessionRecord): boolean =>
    now === undefined || now - r.updatedAt <= OTHER_SESSION_WINDOW_MS
  return Object.values(board)
    .filter((r) => r.sessionId !== sessionId && r.state !== 'ended' && sameProject(r) && recent(r))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((r) => boardSummaryLine(r) + (r.lastAction ? ` · ${r.lastAction}` : ''))
}

/** Idle enough to accept a typed slash command: the turn is over ('done'), or
 *  Claude is 'waiting' only because of the idle-prompt notification (sent ~60 s
 *  after a turn) — never while a permission prompt is on screen. */
export function isSessionIdle(record: SessionRecord): boolean {
  if (record.state === 'done') return true
  if (record.state !== 'waiting') return false
  const action = (record.lastAction ?? '').toLowerCase()
  return !/permission|approve|allow|needs your (permission|approval)/.test(action)
}

/** Display label: "Project · task" or the cwd's last segment. */
export function sessionLabel(record: SessionRecord): string {
  if (record.projectName) return record.task ? `${record.projectName} · ${record.task}` : record.projectName
  return basename(record.cwd ?? '') || record.cwd || record.sessionId
}

/** Trim + squash whitespace to `max` chars with an ellipsis. */
export function trimText(text: string | undefined, max: number): string {
  const squashed = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim()
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 1
  if (squashed.length <= limit) return squashed
  // never cut between the halves of a surrogate pair (an emoji at the boundary)
  return (
    squashed
      .slice(0, limit - 1)
      .replace(/[\uD800-\uDBFF]$/, '')
      .trimEnd() + '…'
  )
}
