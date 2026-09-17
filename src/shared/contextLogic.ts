// Persistent project context + task handoff — PURE (no node/electron), tested.
//
// The Hub owns a model-independent state per project (ProjectContext, stored in
// context.json by main/contextStore.ts). This module normalizes it, merges the
// deterministic project scan into it, judges freshness, builds the compact
// task packet, and renders the markdown Claude reads. Design rules:
//   - summaries orient, source files are truth: nothing here ever dumps file
//     contents; injections point at paths to read on demand;
//   - everything is bounded (recentWork ≤ 8, keyFiles ≤ 12, packet ≤ ~2.5k chars);
//   - a fingerprint mismatch marks context STALE and the injection says so.

import { TYPE_META } from './types'
import type {
  CapabilityMatch,
  CommandRecord,
  ContextFingerprint,
  ContextFreshness,
  HandoffPacket,
  Project,
  ProjectContext,
  ProjectContextPatch,
  SessionRecord,
  TypeMeta,
  WorkEntry
} from './types'
import { WORKTREE_DIR_SUFFIX, normPath } from './sessionLogic'

export const CONTEXT_LIMITS = {
  recentWork: 8,
  keyFiles: 12,
  decisions: 30,
  tasks: 30,
  bugs: 30,
  services: 24,
  commands: 24,
  /** hard cap for the SessionStart injection (chars) */
  injectionChars: 2600,
  /** each recap line inside the injection */
  recapChars: 300
} as const

/** Creator Stack ids a project can reference (no CONTEXT_LIMITS key — kept private). */
const SHARED_TOOLS_LIMIT = 30
/** files in a handoff packet */
const FILES_CHANGED_LIMIT = 20
/** last failure + known bugs in a handoff packet */
const UNRESOLVED_LIMIT = 5
/** README-derived purpose */
const PURPOSE_CHARS = 400
/** name / stack in the injection's first line (never dropped, so keep it short) */
const HEADER_FIELD_CHARS = 80
/** scripts that go first in `commands`, in this order; the rest follow alphabetically */
const WELL_KNOWN_COMMANDS: readonly string[] = [
  'dev',
  'start',
  'build',
  'test',
  'typecheck',
  'lint',
  'format'
]
/** a recap sentence that names the next step */
const NEXT_SENTENCE = /^(?:next|remaining|todo|left to do)\b/i
/** a plausible env var NAME — anything else is dropped so a value can never leak */
const ENV_NAME = /^[A-Za-z_][\w.-]*$/

// ---------- small tolerant helpers ----------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Whitespace (newlines included) squashed to single spaces — one physical line. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Dedupe key for a relative file path: case- and separator-insensitive (Windows). */
const fileKey = (s: string): string => s.toLowerCase().replace(/\\/g, '/')

const COMMAND_OUTCOMES: ReadonlySet<string> = new Set(['pass', 'fail', 'unknown'])

/** Cut to `max` chars, ending with an ellipsis when cut. */
function capText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/** yyyy-mm-dd (UTC) for a ms timestamp; 'unknown' for anything unusable. */
function isoDate(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return 'unknown'
  return new Date(ms).toISOString().slice(0, 10)
}

function typeLabel(type: string): string {
  return (TYPE_META as Record<string, TypeMeta | undefined>)[type]?.label ?? (type || 'Other')
}

/** 'unknown' means two different things: never indexed (do a Reindex) or the
 *  live probe failed (git timed out / missing) — say which. */
function freshnessWord(status: ContextFreshness['status'] | undefined, reasons?: string[]): string {
  if (status === 'stale') return 'STALE'
  if (status === 'fresh') return 'fresh'
  if (status === 'unknown' && reasons?.some((r) => /probe failed/i.test(r)))
    return 'unknown (git probe failed)'
  return 'not indexed'
}

/** Trim, drop non-strings/empties, de-duplicate (by `key`; exact text by default), bound. */
function cleanStrings(v: unknown, limit: number, key: (s: string) => string = (s) => s): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    if (out.length >= limit) break
    const s = str(item)
    if (!s) continue
    const k = key(s)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

/** name → command, both trimmed and non-empty; insertion order kept; bounded.
 *  Own-property checks only: a script named `constructor` or `toString` is a
 *  legitimate script, and `__proto__` is never a script. */
function cleanCommands(v: unknown, limit = Infinity): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObj(v)) return out
  let n = 0
  for (const [k, val] of Object.entries(v)) {
    if (n >= limit) break
    const name = k.trim()
    const cmd = str(val)
    if (!name || !cmd || name === '__proto__' || hasOwn(out, name)) continue
    out[name] = cmd
    n++
  }
  return out
}

/** Well-known scripts first (dev, start, build, test, typecheck, lint, format), then the rest A→Z. */
function orderCommands(scripts: Record<string, string>, limit: number): Record<string, string> {
  const names = Object.keys(scripts)
  const known = WELL_KNOWN_COMMANDS.filter((n) => names.includes(n))
  const rest = names.filter((n) => !WELL_KNOWN_COMMANDS.includes(n)).sort(byCodeUnit)
  const out: Record<string, string> = {}
  for (const n of [...known, ...rest].slice(0, limit)) out[n] = scripts[n]
  return out
}

function cleanFingerprint(v: unknown): ContextFingerprint | undefined {
  if (!isObj(v)) return undefined
  const fp: ContextFingerprint = { computedAt: num(v.computedAt) ?? 0 }
  const head = str(v.head)
  if (head) fp.head = head
  const branch = str(v.branch)
  if (branch) fp.branch = branch
  const dirty = num(v.dirty)
  if (dirty !== undefined) fp.dirty = dirty
  const claudeMdMtime = num(v.claudeMdMtime)
  if (claudeMdMtime !== undefined) fp.claudeMdMtime = claudeMdMtime
  const manifestMtime = num(v.manifestMtime)
  if (manifestMtime !== undefined) fp.manifestMtime = manifestMtime
  return fp
}

/** Entries need a numeric `at` and a non-empty `summary`; newest last, so the TAIL is kept. */
function cleanWork(v: unknown, limit: number): WorkEntry[] {
  if (!Array.isArray(v)) return []
  const out: WorkEntry[] = []
  for (const item of v) {
    if (!isObj(item)) continue
    const at = num(item.at)
    const summary = str(item.summary)
    if (at === undefined || !summary) continue
    const entry: WorkEntry = { at, summary }
    const sessionId = str(item.sessionId)
    if (sessionId) entry.sessionId = sessionId
    out.push(entry)
  }
  return out.slice(-limit)
}

/** Fresh object with fresh arrays — callers never mutate their input. */
function cloneContext(ctx: ProjectContext): ProjectContext {
  const next: ProjectContext = {
    ...ctx,
    commands: { ...(ctx.commands ?? {}) },
    services: [...(ctx.services ?? [])],
    sharedTools: [...(ctx.sharedTools ?? [])],
    decisions: [...(ctx.decisions ?? [])],
    currentTasks: [...(ctx.currentTasks ?? [])],
    knownBugs: [...(ctx.knownBugs ?? [])],
    recentWork: (ctx.recentWork ?? []).map((w) => ({ ...w })),
    keyFiles: [...(ctx.keyFiles ?? [])]
  }
  if (ctx.fingerprint) next.fingerprint = { ...ctx.fingerprint }
  return next
}

/** Path of `file` relative to `projectPath` with forward slashes, or undefined when it is
 *  not inside the project. Windows-safe: either separator, case-insensitive prefix; the
 *  original spelling of the relative part is kept. A file inside one of the project's
 *  task worktrees (`<project>.worktrees\<task>\…`, the layout resolveSessionProject
 *  recognizes) maps to the same relative path — it is the same source tree. A `..`
 *  segment escapes the project, so it is never "inside". */
export function relativeToProject(file: string, projectPath: string): string | undefined {
  if (typeof file !== 'string' || typeof projectPath !== 'string') return undefined
  const root = normPath(projectPath)
  if (!root) return undefined
  const f = file
    .trim()
    .replace(/\//g, '\\')
    .replace(/[\\/]+$/, '')
  const lower = f.toLowerCase()
  let rest: string | undefined
  if (lower.startsWith(root + '\\')) {
    rest = f.slice(root.length + 1)
  } else {
    const wt = root + WORKTREE_DIR_SUFFIX + '\\'
    if (lower.startsWith(wt)) {
      const afterTask = f.indexOf('\\', wt.length)
      if (afterTask !== -1) rest = f.slice(afterTask + 1)
    }
  }
  if (rest === undefined) return undefined
  const segments = rest.split(/\\+/).filter((s) => s && s !== '.')
  if (!segments.length || segments.includes('..')) return undefined
  return segments.join('/')
}

export function emptyProjectContext(projectId: string, now: number): ProjectContext {
  return {
    projectId,
    commands: {},
    services: [],
    sharedTools: [],
    decisions: [],
    currentTasks: [],
    knownBugs: [],
    recentWork: [],
    keyFiles: [],
    updatedAt: now
  }
}

/** Tolerant read from disk: wrong shapes → undefined; bad array items dropped;
 *  strings trimmed; arrays bounded. Always a fresh object. */
export function normalizeProjectContext(raw: unknown, projectId: string): ProjectContext | undefined {
  if (!isObj(raw)) return undefined
  const ctx: ProjectContext = {
    projectId,
    commands: cleanCommands(raw.commands, CONTEXT_LIMITS.commands),
    services: cleanStrings(raw.services, CONTEXT_LIMITS.services),
    sharedTools: cleanStrings(raw.sharedTools, SHARED_TOOLS_LIMIT),
    decisions: cleanStrings(raw.decisions, CONTEXT_LIMITS.decisions),
    currentTasks: cleanStrings(raw.currentTasks, CONTEXT_LIMITS.tasks),
    knownBugs: cleanStrings(raw.knownBugs, CONTEXT_LIMITS.bugs),
    recentWork: cleanWork(raw.recentWork, CONTEXT_LIMITS.recentWork),
    keyFiles: cleanStrings(raw.keyFiles, CONTEXT_LIMITS.keyFiles, fileKey),
    updatedAt: num(raw.updatedAt) ?? 0
  }
  const purpose = str(raw.purpose)
  if (purpose) ctx.purpose = purpose
  const architecture = str(raw.architecture)
  if (architecture) ctx.architecture = architecture
  const fingerprint = cleanFingerprint(raw.fingerprint)
  if (fingerprint) ctx.fingerprint = fingerprint
  const indexedAt = num(raw.indexedAt)
  if (indexedAt !== undefined) ctx.indexedAt = indexedAt
  return ctx
}

type ListField = 'services' | 'sharedTools' | 'decisions' | 'currentTasks' | 'knownBugs' | 'keyFiles'
const LIST_LIMITS: Record<ListField, number> = {
  services: CONTEXT_LIMITS.services,
  sharedTools: SHARED_TOOLS_LIMIT,
  decisions: CONTEXT_LIMITS.decisions,
  currentTasks: CONTEXT_LIMITS.tasks,
  knownBugs: CONTEXT_LIMITS.bugs,
  keyFiles: CONTEXT_LIMITS.keyFiles
}

/** `null` clears a field, `undefined` leaves it alone (same rule as ProjectPatch).
 *  `projectId` is never patchable. Arrays are de-duplicated + bounded. A value of
 *  the WRONG type (a string for a list, a number for a string…) is ignored, never
 *  applied as a clear: only an explicit `null` may destroy what is stored. An
 *  empty / whitespace string clears a string field (a blanked textarea). */
export function applyContextPatch(
  ctx: ProjectContext,
  patch: ProjectContextPatch,
  now: number
): ProjectContext {
  const next = cloneContext(ctx)
  const p: Record<string, unknown> = isObj(patch) ? patch : {}
  for (const key of Object.keys(p)) {
    const value = p[key]
    if (value === undefined) continue
    const clear = value === null
    switch (key) {
      case 'purpose':
      case 'architecture': {
        if (!clear && typeof value !== 'string') break
        const s = clear ? '' : str(value)
        if (s) next[key] = s
        else delete next[key]
        break
      }
      case 'commands':
        if (clear) next.commands = {}
        else if (isObj(value)) next.commands = cleanCommands(value, CONTEXT_LIMITS.commands)
        break
      case 'services':
      case 'sharedTools':
      case 'decisions':
      case 'currentTasks':
      case 'knownBugs':
      case 'keyFiles':
        if (clear) next[key] = []
        else if (Array.isArray(value)) {
          next[key] = cleanStrings(value, LIST_LIMITS[key], key === 'keyFiles' ? fileKey : undefined)
        }
        break
      case 'recentWork':
        if (clear) next.recentWork = []
        else if (Array.isArray(value)) next.recentWork = cleanWork(value, CONTEXT_LIMITS.recentWork)
        break
      case 'fingerprint': {
        if (clear) delete next.fingerprint
        else if (isObj(value)) {
          const fp = cleanFingerprint(value)
          if (fp) next.fingerprint = fp
        }
        break
      }
      case 'indexedAt': {
        if (clear) delete next.indexedAt
        else {
          const n = num(value)
          if (n !== undefined) next.indexedAt = n
        }
        break
      }
      default:
        // projectId, updatedAt (always `now`) and unknown keys are ignored.
        break
    }
  }
  next.updatedAt = now
  return next
}

/** What main/projectIndex.ts gathers deterministically (no model). */
export interface ProjectScan {
  manifest?: {
    kind: 'npm' | 'pubspec' | 'rojo' | 'unreal' | 'python' | 'none'
    name?: string
    scripts?: Record<string, string>
    deps?: string[]
  }
  /** README.md first paragraph (plain text, ≤ 400 chars) */
  readmeFirstParagraph?: string
  /** env var NAMES from .env.example (never values) */
  envKeys?: string[]
  /** "## …" headings from CLAUDE.md */
  claudeMdHeadings?: string[]
  /** top-level entries (files + dirs) */
  topLevel?: string[]
  git?: { head?: string; branch?: string; dirty?: number }
  claudeMdMtime?: number
  manifestMtime?: number
}

/** Merge a scan into the context: refresh commands/services/fingerprint/indexedAt;
 *  fill `purpose` from the README only when it is empty (user text wins). */
export function mergeScan(ctx: ProjectContext, scan: ProjectScan, now: number): ProjectContext {
  const next = cloneContext(ctx)
  next.commands = orderCommands(cleanCommands(scan?.manifest?.scripts), CONTEXT_LIMITS.commands)
  next.services = extractServices(scan?.manifest?.deps ?? [], scan?.envKeys ?? []).slice(
    0,
    CONTEXT_LIMITS.services
  )
  if (!str(ctx.purpose)) {
    const readme = str(scan?.readmeFirstParagraph)
    if (readme) next.purpose = capText(readme, PURPOSE_CHARS)
    else delete next.purpose
  }
  next.fingerprint = fingerprintFromScan(scan, now)
  next.indexedAt = now
  next.updatedAt = now
  return next
}

/** Fingerprint from a scan (or from a live probe with the same fields). */
export function fingerprintFromScan(scan: ProjectScan, now: number): ContextFingerprint {
  const fp: ContextFingerprint = { computedAt: now }
  const head = str(scan?.git?.head)
  if (head) fp.head = head
  const branch = str(scan?.git?.branch)
  if (branch) fp.branch = branch
  const dirty = num(scan?.git?.dirty)
  if (dirty !== undefined) fp.dirty = dirty
  const claudeMdMtime = num(scan?.claudeMdMtime)
  if (claudeMdMtime !== undefined) fp.claudeMdMtime = claudeMdMtime
  const manifestMtime = num(scan?.manifestMtime)
  if (manifestMtime !== undefined) fp.manifestMtime = manifestMtime
  return fp
}

const bothDefined = (a: unknown, b: unknown): boolean =>
  a !== undefined && a !== null && b !== undefined && b !== null

/** Compare the stored fingerprint with a fresh one. Reasons name what moved
 *  ("HEAD abc1234 → def5678", "branch main → hub/x", "uncommitted files 3 → 7",
 *  "CLAUDE.md changed", "manifest changed"). A field missing on either side is
 *  not a mismatch — only what both fingerprints know about can move. */
export function computeFreshness(
  ctx: ProjectContext | undefined,
  current: ContextFingerprint,
  now: number
): ContextFreshness {
  const stored = ctx?.fingerprint
  if (!stored) return { status: 'unknown', reasons: ['never indexed'], checkedAt: now }
  const live: Partial<ContextFingerprint> = isObj(current) ? current : {}
  // The stored fingerprint knew git facts but the live probe has none (timeout,
  // git missing, .git gone): we cannot vouch for freshness — say so rather than
  // letting "no mismatch found" pass for "fresh".
  if (stored.head !== undefined && live.head === undefined) {
    return { status: 'unknown', reasons: ['git probe failed — freshness unknown'], checkedAt: now }
  }
  const reasons: string[] = []
  if (bothDefined(stored.head, live.head) && stored.head !== live.head) {
    reasons.push(`HEAD ${stored.head} → ${live.head}`)
  }
  if (bothDefined(stored.branch, live.branch) && stored.branch !== live.branch) {
    reasons.push(`branch ${stored.branch} → ${live.branch}`)
  }
  if (bothDefined(stored.dirty, live.dirty) && stored.dirty !== live.dirty) {
    reasons.push(`uncommitted files ${stored.dirty} → ${live.dirty}`)
  }
  if (bothDefined(stored.claudeMdMtime, live.claudeMdMtime) && stored.claudeMdMtime !== live.claudeMdMtime) {
    reasons.push('CLAUDE.md changed')
  }
  if (bothDefined(stored.manifestMtime, live.manifestMtime) && stored.manifestMtime !== live.manifestMtime) {
    reasons.push('manifest changed')
  }
  return { status: reasons.length ? 'stale' : 'fresh', reasons, checkedAt: now }
}

/** A session's turn recap → recentWork (bounded, newest last, de-duplicated by
 *  text) and keyFiles as an MRU list (relative paths, newly edited files first,
 *  top CONTEXT_LIMITS.keyFiles). Files outside the project are ignored. */
export function recordWork(
  ctx: ProjectContext,
  entry: WorkEntry,
  filesEdited: string[],
  projectPath: string,
  now: number
): ProjectContext {
  const next = cloneContext(ctx)
  const summary = str(entry?.summary)
  if (summary) {
    const last = next.recentWork[next.recentWork.length - 1]
    if (!last || last.summary !== summary) {
      const work: WorkEntry = { at: num(entry.at) ?? now, summary }
      const sessionId = str(entry.sessionId)
      if (sessionId) work.sessionId = sessionId
      next.recentWork = [...next.recentWork, work].slice(-CONTEXT_LIMITS.recentWork)
    }
  }
  const fresh: string[] = []
  const seen = new Set<string>()
  for (const file of Array.isArray(filesEdited) ? filesEdited : []) {
    const rel = relativeToProject(file, projectPath)
    if (!rel) continue
    const key = fileKey(rel)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(rel)
  }
  const kept = next.keyFiles.filter((f) => !seen.has(fileKey(f)))
  next.keyFiles = [...fresh, ...kept].slice(0, CONTEXT_LIMITS.keyFiles)
  next.updatedAt = now
  return next
}

/** Notable deps worth naming as "services" (framework/platform/payment/db/auth). */
export const NOTABLE_DEPS: readonly string[] = [
  'react',
  'next',
  'vite',
  'electron',
  'hytopia',
  '@capacitor/core',
  'firebase',
  'firebase-admin',
  'stripe',
  '@stripe/stripe-js',
  'prisma',
  '@prisma/client',
  '@supabase/supabase-js',
  'ethers',
  '@solana/web3.js',
  'express',
  'fastify',
  'three',
  '@react-three/fiber',
  'colyseus',
  'openai',
  '@anthropic-ai/sdk',
  'elevenlabs',
  'tailwindcss',
  'drizzle-orm',
  '@clerk/nextjs',
  'revenuecat',
  'playwright',
  'vitest',
  'jest'
]

/** An env var NAME from a `.env.example`-style entry: `X=abc` → `X`, `export X` → `X`;
 *  comments and anything that does not look like a name → ''. Values never survive. */
function envName(raw: unknown): string {
  let s = str(raw)
  if (!s || s.startsWith('#')) return ''
  if (s.startsWith('export ')) s = s.slice('export '.length).trim()
  const eq = s.indexOf('=')
  if (eq >= 0) s = s.slice(0, eq).trim()
  return ENV_NAME.test(s) ? s : ''
}

/** deps ∩ NOTABLE_DEPS (in NOTABLE order) + env key names ("env: STRIPE_SECRET_KEY"). */
export function extractServices(deps: string[], envKeys: string[]): string[] {
  const have = new Set((Array.isArray(deps) ? deps : []).map(str).filter(Boolean))
  const out = NOTABLE_DEPS.filter((d) => have.has(d))
  const seen = new Set(out)
  for (const raw of Array.isArray(envKeys) ? envKeys : []) {
    const name = envName(raw)
    if (!name) continue
    const s = `env: ${name}`
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

const isHeading = (line: string): boolean => line.startsWith('#')
/** Lines a README paragraph never starts with: headings, badges, html, rules, blanks. */
const isNoise = (line: string): boolean =>
  line === '' ||
  isHeading(line) ||
  line.startsWith('![') ||
  line.startsWith('[![') ||
  line.startsWith('<') ||
  /^[-=*_]{3,}$/.test(line)

/** A setext heading underline (`====` / `----`) — the line ABOVE it is a heading. */
const isSetextUnderline = (line: string | undefined): boolean => !!line && /^(?:={3,}|-{3,})$/.test(line)
const FENCE = /^(`{3,}|~{3,})/

/** Markdown → plain text: images dropped, links/emphasis/code reduced to their text.
 *  Only tag-shaped `<…>` is stripped, so "a < b and c > d" survives. */
function flattenMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\b_(.+?)_\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** First non-heading, non-badge paragraph of a README, flattened, ≤ 400 chars.
 *  Skipped, never quoted: YAML front matter, fenced code, multi-line HTML comments
 *  (README templates open with one), ATX and setext headings, badges, html, rules. */
export function firstParagraph(readme: string): string {
  if (typeof readme !== 'string' || !readme) return ''
  const lines = readme.split(/\r?\n/).map((l) => l.trim())
  const n = lines.length
  let i = 0
  if (lines[0] === '---') {
    // YAML front matter; an unclosed `---` is just a rule (skipped as noise below)
    const end = lines.indexOf('---', 1)
    if (end !== -1) i = end + 1
  }
  /** index just past the fenced-code / html-comment block opening at `at`, or `at` when none */
  const blockEnd = (at: number): number => {
    const line = lines[at]
    const fence = FENCE.exec(line)?.[1]
    if (fence) {
      let j = at + 1
      while (j < n && !lines[j].startsWith(fence)) j++
      return Math.min(n, j + 1)
    }
    if (line.startsWith('<!--') && !line.includes('-->')) {
      let j = at + 1
      while (j < n && !lines[j].includes('-->')) j++
      return Math.min(n, j + 1)
    }
    return at
  }
  const run: string[] = []
  while (i < n) {
    const line = lines[i]
    const end = blockEnd(i)
    if (end !== i) {
      if (run.length) break
      i = end
      continue
    }
    if (!isNoise(line) && isSetextUnderline(lines[i + 1])) {
      // a setext heading (CommonMark: the paragraph lines above the underline are the heading)
      run.length = 0
      i += 2
      continue
    }
    if (line === '' || isHeading(line)) {
      if (run.length) break
      i++
      continue
    }
    if (!isNoise(line)) run.push(line)
    i++
  }
  return capText(flattenMarkdown(run.join(' ')), PURPOSE_CHARS)
}

/** First sentence of a recap that starts with Next / Remaining / TODO / Left to do.
 *  Recaps are assistant messages, i.e. markdown: list / heading / numbering markers
 *  and emphasis ("**Next:** wire the IPC", "## Next steps") are stripped first. */
function nextFromRecap(recap: string | undefined): string | undefined {
  if (!recap) return undefined
  for (const raw of recap.split(/(?<=[.!?])\s+|\n+|\s\|\s/)) {
    const sentence = flattenMarkdown(raw.replace(/^\s*(?:[-*•]|#{1,6}|\d+[.)])\s+/, ''))
    if (NEXT_SENTENCE.test(sentence)) return sentence
  }
  return undefined
}

/** "<command> → <outcome>" for a CommandRecord-shaped value; undefined without a command. */
function verdictText(c: unknown): string | undefined {
  if (!isObj(c)) return undefined
  const command = str(c.command)
  if (!command) return undefined
  const outcome = typeof c.outcome === 'string' && COMMAND_OUTCOMES.has(c.outcome) ? c.outcome : 'unknown'
  return `${command} → ${outcome}`
}

const isFailure = (c: unknown): c is CommandRecord => isObj(c) && c.outcome === 'fail' && !!str(c.command)

const firstNonEmpty = (...values: unknown[]): string => {
  for (const v of values) {
    const s = str(v)
    if (s) return s
  }
  return ''
}

/** Build the compact task packet from the project context + the live/last session
 *  record (may be absent → packet from context only). `unresolved` carries the last
 *  failing command; `nextAction` prefers the project's nextAction, else the last
 *  recap's trailing sentence that starts with "Next"/"Remaining"/"TODO". */
export function buildHandoffPacket(
  project: Project,
  ctx: ProjectContext | undefined,
  record: SessionRecord | undefined,
  now: number
): HandoffPacket {
  const objective = firstNonEmpty(
    record?.objective,
    ctx?.currentTasks?.[0],
    project.currentFocus,
    project.nextAction
  )
  const recaps = (Array.isArray(record?.recaps) ? record.recaps : []).map(str).filter(Boolean)
  const attempted = recaps.map((r) => capText(r, CONTEXT_LIMITS.recapChars))

  const edits = Object.entries(isObj(record?.filesEdited) ? record.filesEdited : {})
    .map(([file, at]): [string, number] => [file, num(at) ?? 0])
    .filter(([file]) => file)
    .sort(([fa, a], [fb, b]) => b - a || byCodeUnit(fa, fb))
  const filesChanged = edits
    .slice(0, FILES_CHANGED_LIMIT)
    .map(([file]) => relativeToProject(file, project.path) ?? file)

  const decisions = cleanStrings(ctx?.decisions, CONTEXT_LIMITS.decisions)

  const verdict = record?.testStatus
  const testStatus = verdictText(verdict)

  const unresolved: string[] = []
  const commands = Array.isArray(record?.commands) ? record.commands : []
  const lastFail = [...commands].reverse().find(isFailure) ?? (isFailure(verdict) ? verdict : undefined)
  if (lastFail) unresolved.push(`${str(lastFail.command)} → fail`)
  for (const bug of cleanStrings(ctx?.knownBugs, CONTEXT_LIMITS.bugs)) {
    if (unresolved.length >= UNRESOLVED_LIMIT) break
    if (!unresolved.includes(bug)) unresolved.push(bug)
  }

  const nextAction = str(project.nextAction) || nextFromRecap(recaps[recaps.length - 1])

  const packet: HandoffPacket = {
    projectId: project.id,
    projectName: project.name,
    objective,
    attempted,
    filesChanged,
    decisions,
    unresolved,
    createdAt: now
  }
  const sessionId = str(record?.sessionId)
  if (sessionId) packet.sessionId = sessionId
  if (testStatus) packet.testStatus = testStatus
  if (nextAction) packet.nextAction = nextAction
  const model = str(record?.model)
  if (model) packet.model = model
  const effort = str(record?.effort)
  if (effort) packet.effort = effort
  return packet
}

const bulletList = (items: string[] | undefined, empty: string): string => {
  const list = (Array.isArray(items) ? items : []).map(str).filter(Boolean)
  return list.length ? list.map((i) => `- ${i}`).join('\n') : `- ${empty}`
}

/** Markdown for <project>/handoffs/<date>-handoff.md (and for the Publish handoff modal). */
export function renderHandoffMarkdown(p: HandoffPacket): string {
  const sections: string[] = [
    `# Handoff: ${str(p.projectName) || str(p.projectId) || '(unnamed project)'}`,
    `_Published by Builder Hub ${isoDate(p.createdAt)} · model ${str(p.model) || 'unknown'} / effort ${
      str(p.effort) || 'unknown'
    }_`,
    `## Objective\n${str(p.objective) || '(none recorded)'}`,
    `## Attempted\n${bulletList(p.attempted, '(nothing recorded)')}`,
    `## Files changed\n${bulletList(p.filesChanged, '(none)')}`,
    `## Tests / build\n${str(p.testStatus) || 'unknown'}`,
    `## Unresolved\n${bulletList(p.unresolved, '(none known)')}`
  ]
  const decisions = (Array.isArray(p.decisions) ? p.decisions : []).map(str).filter(Boolean)
  if (decisions.length) sections.push(`## Decisions\n${bulletList(decisions, '')}`)
  sections.push(`## Next action\n${str(p.nextAction) || '(decide next action)'}`)
  return sections.join('\n\n') + '\n'
}

/** The human-readable per-project context file (~/.claude/builder-hub/context/<id>.md).
 *  Empty sections are omitted (Purpose always renders, as "(not set)" when empty);
 *  recent work is listed newest first. */
export function renderProjectContextMarkdown(
  project: Project,
  ctx: ProjectContext,
  freshness: ContextFreshness | undefined,
  generatedOn: string
): string {
  const sections: string[] = [
    `# ${str(project.name) || str(project.id) || '(unnamed project)'} — Builder Hub project context`,
    `_Generated ${generatedOn}. Auto-maintained by Builder Hub (Reindex refreshes the auto fields); edit notes in the Hub, not here._`,
    `## Purpose\n${str(ctx.purpose) || '(not set)'}`
  ]
  const architecture = str(ctx.architecture)
  if (architecture) sections.push(`## Architecture\n${architecture}`)

  const stack = [`- Type: ${typeLabel(project.type)}`]
  const stackText = str(project.stack)
  if (stackText) stack.push(`- Stack: ${stackText}`)
  const branch = str(ctx.fingerprint?.branch)
  if (branch) stack.push(`- Branch: ${branch}`)
  sections.push(`## Stack & type\n${stack.join('\n')}`)

  if (freshness) {
    const reasons = (freshness.reasons ?? []).map(str).filter(Boolean)
    sections.push(
      `## Freshness\n${freshnessWord(freshness.status, freshness.reasons)}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`
    )
  }

  const commands = Object.entries(cleanCommands(ctx.commands))
  if (commands.length) {
    sections.push(`## Commands\n${commands.map(([name, cmd]) => `- ${name} — ${cmd}`).join('\n')}`)
  }

  const pushList = (title: string, items: string[] | undefined): void => {
    const list = (Array.isArray(items) ? items : []).map(str).filter(Boolean)
    if (list.length) sections.push(`## ${title}\n${list.map((i) => `- ${i}`).join('\n')}`)
  }
  pushList('Services & dependencies', ctx.services)
  pushList('Shared tools', ctx.sharedTools)
  pushList('Decisions', ctx.decisions)
  pushList('Current tasks', ctx.currentTasks)
  pushList('Known bugs', ctx.knownBugs)

  const work = (Array.isArray(ctx.recentWork) ? ctx.recentWork : []).filter((w) => isObj(w) && str(w.summary))
  if (work.length) {
    const lines = [...work].reverse().map((w) => `- ${isoDate(w.at)} — ${str(w.summary)}`)
    sections.push(`## Recent work\n${lines.join('\n')}`)
  }
  pushList('Key files', ctx.keyFiles)

  return sections.join('\n\n') + '\n'
}

export interface SessionStartInput {
  project: Project
  ctx?: ProjectContext
  /** live/last session packet for this project (absent on a first session) */
  packet?: HandoffPacket
  freshness: ContextFreshness
  /** SessionStart `source`: startup | resume | clear | compact | fork */
  source: string
  /** one line per OTHER live terminal on this project */
  otherSessions: string[]
  /** Creator Stack capabilities this project has used (ids/names) — names only, no cards */
  sharedTools: string[]
  /** absolute paths Claude may read for more */
  paths: { registry: string; contextFile?: string; creatorStack: string }
  /** override CONTEXT_LIMITS.injectionChars (tests) */
  maxChars?: number
}

/** Drop priority for injection lines: 0 = never dropped; higher goes first. Packet
 *  item lines sit above packetHeader so the block shrinks from its END. */
const DROP = { never: 0, stale: 1, run: 2, pointers: 3, tools: 4, others: 5, packetHeader: 10 } as const

export const SESSION_START_RULES =
  "Rules: summaries orient, source is truth — re-verify before architectural or destructive changes. Before modifying another project's source, say so explicitly."

/**
 * The SessionStart `additionalContext` text. Progressive and bounded:
 *  1. one line: project · type · stack · branch, and how to run it (top commands);
 *  2. the task packet (objective / attempted / files / tests / unresolved / next) —
 *     included for startup|clear|compact|fork; for `resume` only the freshness note;
 *  3. freshness: STALE → "source moved since indexed — trust the files, not this summary";
 *  4. other terminals on this project (one line each);
 *  5. pointers: context file, creator stack, registry — "read on demand";
 *  6. the rules line, with the cross-project guardrail (one sentence) — always present.
 * Never includes file contents. Trimmed to maxChars at a line boundary: the packet
 * block shrinks from its end first, then other terminals, shared tools, pointers, the
 * run line and the stale note; the first line and the rules line are never dropped.
 */
export function buildSessionStartContext(input: SessionStartInput): string {
  const { project, ctx, packet, freshness } = input
  const maxChars = num(input.maxChars) ?? CONTEXT_LIMITS.injectionChars
  const recap = CONTEXT_LIMITS.recapChars
  const lines: { text: string; drop: number }[] = []
  // every entry is ONE physical line — an embedded newline in any value (a multi-line
  // task, bug or recap) would break the line-boundary trimming and the template
  const push = (text: string, drop: number): void => {
    lines.push({ text: oneLine(text), drop })
  }

  // 1. header
  const what = [typeLabel(project.type)]
  const stack = str(project.stack)
  if (stack) what.push(capText(stack, HEADER_FIELD_CHARS))
  let header = `[Builder Hub context — ${capText(str(project.name) || project.id, HEADER_FIELD_CHARS)} (${what.join(' · ')})`
  const branch = str(ctx?.fingerprint?.branch)
  if (branch) header += ` · branch ${branch}`
  header += ` · context ${freshnessWord(freshness?.status, freshness?.reasons)}]`
  push(header, DROP.never)

  // 2. stale note
  if (freshness?.status === 'stale') {
    const reasons = (freshness.reasons ?? []).map(str).filter(Boolean)
    const why = reasons.length ? reasons.join('; ') : 'source moved since indexed'
    push(`⚠ STALE: ${why} — trust the files, not this summary.`, DROP.stale)
  }

  // 3. how to run it
  const commands = Object.entries(orderCommands(cleanCommands(ctx?.commands), 4))
  if (commands.length) {
    push(`Run: ${commands.map(([name, cmd]) => `${name}: ${cmd}`).join(' · ')}`, DROP.run)
  }

  // 4. the task packet (not on resume — that session already has its own history)
  if (packet && input.source !== 'resume') {
    const list = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(str).filter(Boolean)
    const items: [string, string][] = [
      ['Objective', capText(str(packet.objective), recap)],
      [
        'Attempted',
        list(packet.attempted)
          .slice(-3)
          .map((a) => capText(a, recap))
          .join(' | ')
      ],
      ['Files changed', list(packet.filesChanged).slice(0, 8).join(', ')],
      ['Tests', capText(str(packet.testStatus), recap)],
      [
        'Unresolved',
        list(packet.unresolved)
          .slice(0, 3)
          .map((u) => capText(u, recap))
          .join(' | ')
      ],
      ['Next', capText(str(packet.nextAction), recap)]
    ]
    const present = items.filter(([, value]) => value)
    if (present.length) {
      const modelEffort = [str(packet.model), str(packet.effort)].filter(Boolean).join('/')
      push(
        `Task packet (${isoDate(packet.createdAt)}${modelEffort ? `, ${modelEffort}` : ''}):`,
        DROP.packetHeader
      )
      present.forEach(([label, value], i) => {
        push(`- ${label}: ${value}`, DROP.packetHeader + 1 + i)
      })
    }
  }

  // 5. other terminals
  const others = (Array.isArray(input.otherSessions) ? input.otherSessions : []).map(str).filter(Boolean)
  if (others.length) push(`Other terminals on this project: ${others.join(' || ')}`, DROP.others)

  // 6. shared tools (names only)
  const tools = (Array.isArray(input.sharedTools) ? input.sharedTools : []).map(str).filter(Boolean)
  if (tools.length) push(`Shared tools used here (Creator Stack): ${tools.join(', ')}`, DROP.tools)

  // 7. pointers — paths to read on demand, never contents (only the ones we have)
  const paths: Partial<SessionStartInput['paths']> = isObj(input.paths) ? input.paths : {}
  const pointers: string[] = []
  const contextFile = str(paths.contextFile)
  if (contextFile) pointers.push(contextFile)
  const creatorStack = str(paths.creatorStack)
  if (creatorStack) pointers.push(`Creator Stack: ${creatorStack}`)
  const registry = str(paths.registry)
  if (registry) pointers.push(`project registry: ${registry}`)
  if (pointers.length) {
    push(`Deeper context, read on demand only what you need: ${pointers.join('; ')}.`, DROP.pointers)
  }

  // 8. rules
  push(SESSION_START_RULES, DROP.never)

  // Trim at line boundaries: highest drop priority first, never the header or the rules.
  const total = (ls: { text: string; drop: number }[]): number =>
    ls.reduce((n, l) => n + l.text.length, 0) + Math.max(0, ls.length - 1)
  let kept = lines
  while (total(kept) > maxChars) {
    let at = -1
    let best = DROP.never as number
    kept.forEach((l, i) => {
      if (l.drop > best) {
        best = l.drop
        at = i
      }
    })
    if (at === -1) break
    kept = kept.filter((_, i) => i !== at)
  }
  // A packet header with every item trimmed away says nothing — drop it too.
  if (!kept.some((l) => l.drop > DROP.packetHeader)) kept = kept.filter((l) => l.drop !== DROP.packetHeader)
  return kept.map((l) => l.text).join('\n')
}

/** Compact card for a Creator Stack match (delegates to creatorStack.renderCapabilityCard;
 *  exists here so contextLogic can assemble the UserPromptSubmit injection). */
export function buildPromptContext(
  matches: CapabilityMatch[],
  render: (m: CapabilityMatch) => string
): string {
  if (!Array.isArray(matches) || !matches.length) return ''
  return matches
    .map((m) => str(render(m)))
    .filter(Boolean)
    .join('\n\n')
}
