// Model + effort router — PURE (no node/electron imports), unit-tested.
//
// Classifies work by complexity/risk from (a) the prompt text and (b) session
// signals accumulated from hook events (failures, edits, cross-project reach),
// then recommends the cheapest tier that can do the job reliably. Quality wins
// over cost: any escalation signal moves UP, de-escalation needs a clean streak.
// Zero tokens are spent deciding — this is keyword + counter logic.
//
// Tiers → targets (closed allowlists from types.ts, nothing else can reach argv):
//   light    haiku  / low     lookups, renames, text/CSS, running tests, reading logs
//   standard sonnet / medium  ordinary features, clear-failure debugging, moderate refactors
//   deep     opus   / high    architecture, hard bugs, novel systems, multi-project, migrations
//   max      fable  / xhigh   explicit max-quality asks, repeated failures on deep, high-risk changes

import { CLAUDE_EFFORTS, CLAUDE_MODELS } from './types'
import type {
  ClaudeEffort,
  ClaudeModel,
  CommandKind,
  CommandOutcome,
  ModelEffort,
  Project,
  RouterRecommendation,
  RouterSignals,
  RouterTier
} from './types'
import { normPath } from './sessionLogic'

export const ROUTER_TIER_TARGETS: Record<RouterTier, ModelEffort> = {
  light: { model: 'haiku', effort: 'low' },
  standard: { model: 'sonnet', effort: 'medium' },
  deep: { model: 'opus', effort: 'high' },
  max: { model: 'fable', effort: 'xhigh' }
}

/** Cheapest → most capable. */
export const TIER_ORDER: readonly RouterTier[] = ['light', 'standard', 'deep', 'max']

/** Every numeric bound the router uses, in one place (parity with CONTEXT_LIMITS / BOARD_LIMITS). */
export const ROUTER_LIMITS = {
  /** prompts longer than this (chars) are at least 'standard' — a wall of text is never a one-liner */
  longPromptStandard: 1200,
  /** prompts longer than this (chars) are at least 'deep' ("long, multi-part request") */
  longPromptDeep: 2500,
  /** registered project names shorter than this never count as mentions (too many false hits) */
  minProjectNameLength: 4,
  /** consecutive failing test/build/lint commands that lift the tier by one */
  failuresToEscalate: 2,
  /** consecutive failures that go straight to 'max' */
  failuresToMax: 4,
  /** unsure/retry prompts that lift the tier by one */
  uncertaintyToEscalate: 2,
  /** a mechanical streak this long starts earning confidence for a cheap tier */
  mechanicalStreakMin: 3,
  /** a turn is mechanical when its prompt is at most this long… */
  mechanicalPromptChars: 200,
  /** …it edited at most this many files, and nothing failed */
  mechanicalEdits: 2,
  /** confidence with a keyword hit or an escalation signal */
  confidenceKeyword: 0.85,
  /** confidence when only the prompt's length said anything */
  confidenceLength: 0.6,
  /** confidence with nothing to go on */
  confidenceNone: 0.5,
  /** what each mechanical-streak step past the minimum adds */
  confidenceStreakStep: 0.05,
  /** confidence never exceeds this — keyword routing is a heuristic, not a verdict */
  confidenceMax: 0.95,
  /** auto mode only acts at or above this confidence */
  autoApplyConfidence: 0.75
} as const

/** Auto mode only acts at or above this confidence. */
export const AUTO_APPLY_CONFIDENCE: number = ROUTER_LIMITS.autoApplyConfidence

/** Confidence never exceeds this — keyword routing is a heuristic, not a verdict. */
export const MAX_CONFIDENCE: number = ROUTER_LIMITS.confidenceMax

/** Prompts longer than this (chars) are at least 'standard' — a wall of text is never a one-liner. */
export const LONG_PROMPT_STANDARD: number = ROUTER_LIMITS.longPromptStandard

/** Prompts longer than this (chars) are at least 'deep' ("long, multi-part request"). */
export const LONG_PROMPT_DEEP: number = ROUTER_LIMITS.longPromptDeep

/** Registered project names shorter than this never count as mentions (too many false hits). */
export const MIN_PROJECT_NAME_LENGTH: number = ROUTER_LIMITS.minProjectNameLength

/** Only these command kinds feed the failure/pass counters. */
export const COUNTED_COMMAND_KINDS: readonly CommandKind[] = ['test', 'build', 'lint', 'typecheck']

export function emptySignals(): RouterSignals {
  return {
    consecutiveFailures: 0,
    failures: 0,
    passes: 0,
    filesEdited: 0,
    projectsTouched: 0,
    mechanicalStreak: 0,
    uncertaintyHits: 0,
    maxQualityRequested: false,
    riskHits: 0
  }
}

// ---------- keyword classes ----------
// Matching is case-insensitive and whole-word. Inside a phrase, spaces, hyphens
// and underscores are interchangeable ("multi-project" = "multi project"), and
// the last word may carry a simple inflection ("typo" matches "typos", "rename"
// matches "renamed"/"renaming"). Tests import these arrays to prove every entry
// routes where it should.

/** Chores: wording, CSS, lookups, running things. */
export const LIGHT_KEYWORDS: readonly string[] = [
  'rename',
  'typo',
  'bump',
  'docs',
  'documentation',
  'readme',
  'comment',
  'format',
  'formatting',
  'lint',
  'copy',
  'label',
  'wording',
  'tweak',
  'chore',
  'boilerplate',
  'css',
  'color',
  'colour',
  'padding',
  'margin',
  'font',
  'spacing',
  'whitespace',
  'indentation',
  'changelog',
  'text change',
  'move file',
  'move the file',
  'find the',
  'where is',
  'list the',
  'run the tests',
  'run tests',
  'run build',
  'run the build',
  'read the logs',
  'look up',
  'what does',
  'show me'
]

/** Ordinary feature/bug work (also the default when nothing matches). */
export const STANDARD_KEYWORDS: readonly string[] = [
  'implement',
  'implementation',
  'add',
  'feature',
  'fix',
  'bug',
  'integrate',
  'integration',
  'wire',
  'wiring',
  'update',
  'endpoint',
  'component',
  'page',
  'form',
  'modal',
  'unit test',
  'tests for',
  'refactor',
  'debug',
  'crash',
  'handler',
  'validation',
  'dialog'
]

/** Architecture, hard bugs, novel systems, migrations, planning. */
export const DEEP_KEYWORDS: readonly string[] = [
  'architecture',
  'architect',
  'architectural',
  'redesign',
  'migrate',
  'migration',
  // "port" as in "port the game to Unreal"; the network noun ("on port 3000", "port number")
  // is excluded by a sense guard (SENSE_GUARDS) so every dev-server prompt does not go deep
  'port',
  // these survive the guard ("the port of the game", "a port over to HYTOPIA", "the port to Unreal");
  // a bare "port to" would drag "change the port to 8080" along
  'port of',
  'port over',
  'port to unreal',
  'port to hytopia',
  'port to roblox',
  'port to unity',
  'port to godot',
  'port to mobile',
  'port to web',
  'porting',
  'ported',
  'unreal port',
  'mobile port',
  'rewrite',
  'novel',
  'complex',
  'concurrency',
  'concurrent',
  // "race" as in "a race between the two writes"; the game/sport noun ("race track",
  // "start the race", "racing") is excluded by a sense guard (SENSE_GUARDS)
  'race',
  'race condition',
  'data race',
  'deadlock',
  'security',
  'audit',
  'performance',
  'optimize',
  'optimise',
  'hard bug',
  'difficult',
  'flaky',
  'intermittent',
  'across projects',
  'all projects',
  'multi-project',
  'every project',
  'large refactor',
  'big refactor',
  'plan',
  'roadmap',
  'tradeoff',
  'trade-off',
  'data model',
  'schema',
  'scalability',
  'memory leak',
  'root cause',
  'nondeterministic',
  'non-deterministic',
  'threading',
  'distributed',
  'system design',
  'state machine',
  'from scratch'
]

/** An explicit ask for maximum quality / care. */
export const MAX_KEYWORDS: readonly string[] = [
  'max quality',
  'maximum quality',
  'highest quality',
  'best quality',
  'be thorough',
  'ultra',
  'ultrathink',
  'critical',
  'mission critical',
  'do not get this wrong',
  "don't get this wrong",
  'production incident',
  'very careful',
  'extremely careful',
  'no mistakes',
  'take your time',
  'triple check',
  'get this right'
]

/** Destructive or sensitive work — always worth a strong model. */
export const RISK_KEYWORDS: readonly string[] = [
  'delete',
  // "drop" as in "drop the users table"; the UI/media senses ("drag and drop", "drop-down",
  // "dropped frames", "drop me a note") are excluded by a sense guard (SENSE_GUARDS)
  'drop',
  'drop table',
  'drop the table',
  'drop column',
  'drop the column',
  'drop database',
  'drop the database',
  'drop all',
  'drop data',
  'drop the data',
  'drop index',
  'remove all',
  'migration',
  'migrate',
  'auth',
  'authentication',
  'authorization',
  'payment',
  'payments',
  'stripe',
  'secret',
  'secrets',
  'api key',
  'prod',
  'production',
  'deploy',
  'deployment',
  'rm -rf',
  'force push',
  'force-push',
  'wipe',
  'truncate',
  'credentials',
  'credential',
  'password',
  'private key',
  'billing',
  'reset --hard',
  'hard reset',
  'destructive',
  'irreversible',
  'purge',
  '.env'
]

/** Retry / "still broken" language — the current approach isn't landing. */
export const UNCERTAINTY_KEYWORDS: readonly string[] = [
  'still failing',
  'still fails',
  'still broken',
  'still not working',
  'still wrong',
  'still getting',
  'still seeing',
  "didn't work",
  'did not work',
  'not working',
  "doesn't work",
  'does not work',
  "isn't working",
  'try again',
  'no luck',
  'not sure',
  'conflicting',
  'keeps failing',
  'keep failing',
  'same error',
  'again',
  'no idea',
  'confused',
  'stuck',
  'one more time',
  'nothing works',
  'wrong again'
]

/** Phrases that mean "this spans projects" without naming them. */
export const CROSS_PROJECT_PHRASES: readonly string[] = [
  'across projects',
  'across all projects',
  'across my projects',
  'across every project',
  'across the projects',
  'all projects',
  'all my projects',
  'all of my projects',
  'all the projects',
  'every project',
  'each project',
  'multi-project',
  'multiple projects',
  'cross-project',
  'both projects',
  'other projects',
  'the other project',
  'several projects'
]

/** Registered project names that are ordinary words never count as mentions. */
export const COMMON_PROJECT_WORDS: readonly string[] = [
  'test',
  'tests',
  'demo',
  'main',
  'game',
  'games',
  'site',
  'temp',
  'tools',
  'docs',
  'website',
  'apps',
  'project',
  'projects',
  'other',
  'misc',
  'scratch',
  'sandbox',
  'home',
  'work',
  'build',
  'client',
  'server',
  'notes',
  'todo',
  'shared',
  'common',
  'data',
  'files',
  'stuff',
  'backup',
  'archive',
  'code',
  'utils',
  'scripts',
  'assets',
  'images',
  'video',
  'audio',
  'music',
  'personal',
  'desktop',
  'downloads',
  'documents',
  'untitled',
  'default',
  'template',
  'templates',
  'example',
  'examples',
  'sample',
  'samples',
  'playground',
  'experiments',
  'research',
  'studio',
  'blog',
  'store',
  'shop',
  'admin',
  'dashboard',
  'portfolio',
  'landing',
  'mobile',
  'core',
  'base'
]

// ---------- matching machinery ----------

/** Simple English inflections of a phrase's last word (never of inner words). */
const INFLECTIONS = 's|ed|d|ing|ly|ped|ping|ted|ting|ged|ging|ned|ning'

/** "es" is only a plural after a sibilant (fix → fixes); "plan" + "es" would be "planes". */
const SIBILANT_END = /(?:[sxz]|ch|sh)$/

const NEVER = /(?!)/g

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Curly quotes → straight so "didn’t work" matches "didn't work". */
const normalizeText = (s: string): string => s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')

/** The last word of a phrase plus its simple inflections. */
function inflected(tok: string): string {
  const infl = `(?:${SIBILANT_END.test(tok) ? 'es|' : ''}${INFLECTIONS})?`
  // e-dropping stem so "rename" also matches "renaming" — but the bare stem must never match
  // on its own: "wipe" is not "wip" (work-in-progress) and "stripe" is not "strip"/"stripping"
  if (tok.length >= 4 && tok.endsWith('e')) return `${escapeRe(tok.slice(0, -1))}(?:e${infl}|ing|ed)`
  return escapeRe(tok) + infl
}

interface PhraseOptions {
  /** regex fragment allowed between the phrase's words */
  sep: string
  /** allow inflections of the last word (typo → typos, rename → renamed/renaming) */
  inflect: boolean
  /** what splits the phrase into words (default: whitespace, "_" and "-"; names add ".") */
  split?: RegExp
}

/** A spec keyword with a common second sense that must NOT route. The guard is a negative
 *  lookbehind / lookahead on the neighbouring words, so the word still counts everywhere else
 *  ("port Squishy Smash to Unreal" is deep; "run it on port 3000" is not). Keyword classes
 *  only — project names never go through it. */
interface SenseGuard {
  /** words right before the keyword that mark the other sense ("on port", "drag and drop") */
  before?: readonly string[]
  /** words right after it ("port number", "race track", "drop-down") */
  after?: readonly string[]
  /** a number right after it ("port 3000", "port: 8080") */
  digits?: boolean
  /** replaces the inflected body: bug-sense "race"/"races" only — "racing" is a game */
  body?: string
}

const SENSE_GUARDS: Readonly<Record<string, SenseGuard>> = {
  port: {
    before: [
      'on',
      'the',
      'a',
      'an',
      'at',
      'which',
      'what',
      'same',
      'different',
      'another',
      'new',
      'free',
      'open',
      'default',
      'any',
      'every',
      'each',
      'from',
      'via',
      'over',
      'local',
      'remote',
      'server',
      'listening on',
      'listen on',
      'listens on',
      'tcp',
      'udp',
      'http',
      'https',
      'ssh',
      'serial',
      'usb',
      'com',
      'dev',
      'localhost'
    ],
    after: [
      'number',
      'numbers',
      'forwarding',
      'mapping',
      'range',
      'conflict',
      'conflicts',
      'in use',
      'is in use',
      'already in use',
      'is busy',
      'is taken',
      'is free',
      'is open'
    ],
    digits: true
  },
  race: {
    body: 'races?',
    before: [
      'kart',
      'car',
      'boat',
      'horse',
      'foot',
      'drag',
      'street',
      'road',
      'space',
      'bike',
      'relay',
      'sprint',
      'go-kart',
      'win the',
      'wins the',
      'won the',
      'lose the',
      'lost the',
      'join the',
      'joined the',
      'start the',
      'starts the',
      'started the',
      'finish the',
      'finished the',
      'enter the',
      'entered the',
      'during the',
      'before the',
      'after the',
      'end of the',
      'next',
      'first',
      'last',
      'each',
      'every'
    ],
    after: [
      'track',
      'tracks',
      'car',
      'cars',
      'game',
      'games',
      'mode',
      'modes',
      'kart',
      'karts',
      'course',
      'courses',
      'circuit',
      'circuits',
      'lap',
      'laps',
      'map',
      'maps',
      'level',
      'levels',
      'event',
      'events',
      'day',
      'ui',
      'hud',
      'start',
      'starts',
      'started',
      'finish',
      'finishes',
      'finished',
      'ends',
      'ended',
      'begins',
      'began',
      'winner',
      'winners',
      'result',
      'results',
      'timer',
      'countdown',
      'type',
      'types',
      'leaderboard',
      'is over'
    ]
  },
  drop: {
    before: [
      'drag and',
      'drag &',
      'drag n',
      'drag',
      'frame',
      'frames',
      'fps',
      'packet',
      'packets',
      'connection',
      'signal',
      'price',
      'prices',
      'rate',
      'call',
      'calls',
      'loot',
      'item',
      'items',
      'mic',
      'the mic'
    ],
    after: [
      'down',
      'downs',
      'zone',
      'zones',
      'target',
      'targets',
      'shadow',
      'shadows',
      'area',
      'areas',
      'handler',
      'handlers',
      'event',
      'events',
      'list',
      'lists',
      'menu',
      'menus',
      'in',
      'off',
      'by',
      'out',
      'support',
      'frame',
      'frames',
      'rate',
      'rates',
      'the frame',
      'the ball',
      'the connection',
      'connections',
      'the call',
      'item',
      'items',
      'loot',
      'me',
      'a note',
      'a line',
      'a hint',
      'a comment'
    ]
  }
}

/** "drag and|drag &" → `drag[\s_-]*and|drag[\s_-]*&` — each guard phrase with flexible separators. */
const alternation = (phrases: readonly string[]): string =>
  phrases
    .map((p) =>
      p
        .toLowerCase()
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map(escapeRe)
        .join('[\\s_-]*')
    )
    .join('|')

/** Wrap a single keyword's body in its sense guard, when it has one. */
function guarded(tok: string, body: string): string {
  const g = SENSE_GUARDS[tok]
  if (!g) return body
  const before = g.before?.length ? `(?<!(?<!\\w)(?:${alternation(g.before)})[\\s_-]+)` : ''
  const after = g.after?.length ? `(?![\\s_-]+(?:${alternation(g.after)})(?!\\w))` : ''
  const digits = g.digits ? '(?![\\s:=#]*\\d)' : ''
  return `${before}${g.body ?? body}${after}${digits}`
}

/** "api key" → /(?<!\w)api[\s_-]*key(?:s|…)?(?!\w)/gi — whole words, flexible separators. */
function phraseRegex(phrase: string, opts: PhraseOptions): RegExp {
  const tokens = phrase
    .trim()
    .toLowerCase()
    .split(opts.split ?? /[\s_-]+/)
    .filter(Boolean)
  if (tokens.length === 0) return NEVER
  const body =
    tokens.length === 1 && opts.inflect
      ? guarded(tokens[0], inflected(tokens[0]))
      : tokens
          .map((tok, i) => (opts.inflect && i === tokens.length - 1 ? inflected(tok) : escapeRe(tok)))
          .join(opts.sep)
  return new RegExp(`(?<!\\w)${body}(?!\\w)`, 'gi')
}

interface Matcher {
  word: string
  re: RegExp
}

/** Longest phrase first so "still not working" claims its span before "not working". */
function compile(words: readonly string[]): Matcher[] {
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map((word) => ({ word, re: phraseRegex(word, { sep: '[\\s_-]*', inflect: true }) }))
}

const blank = (m: string): string => ' '.repeat(m.length)

/** Phrases from `matchers` found in `text`, in the order they appear in the text.
 *  Each matched span is consumed, so an overlapping shorter phrase ("again"
 *  inside "try again") reports once. */
function matchClass(text: string, matchers: Matcher[]): string[] {
  let work = text
  const found: { word: string; at: number }[] = []
  for (const m of matchers) {
    const at = work.search(m.re)
    if (at < 0) continue
    found.push({ word: m.word, at })
    work = work.replace(m.re, blank)
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.word)
}

const LIGHT_MATCHERS = compile(LIGHT_KEYWORDS)
const STANDARD_MATCHERS = compile(STANDARD_KEYWORDS)
const DEEP_MATCHERS = compile(DEEP_KEYWORDS)
const MAX_MATCHERS = compile(MAX_KEYWORDS)
const RISK_MATCHERS = compile(RISK_KEYWORDS)
const UNCERTAINTY_MATCHERS = compile(UNCERTAINTY_KEYWORDS)
const CROSS_MATCHERS = compile(CROSS_PROJECT_PHRASES)
const CROSS_SET = new Set(CROSS_PROJECT_PHRASES)
const COMMON_SET = new Set(COMMON_PROJECT_WORDS)

const tierIndex = (t: RouterTier): number => TIER_ORDER.indexOf(t)
const atLeast = (t: RouterTier, min: RouterTier): RouterTier => (tierIndex(t) >= tierIndex(min) ? t : min)
const tierUp = (t: RouterTier): RouterTier => TIER_ORDER[Math.min(tierIndex(t) + 1, TIER_ORDER.length - 1)]

/** "a, b, c, +2 more" for labels; `countRest: false` just names the first few (reasons stay one short sentence). */
const listWords = (words: readonly string[], max = 4, countRest = true): string =>
  words.length <= max || !countRest
    ? words.slice(0, max).join(', ')
    : `${words.slice(0, max).join(', ')}, +${words.length - max} more`

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0

/** Coerce anything (an old on-disk record, a partial object, garbage) into valid signals. */
export function normalizeSignals(raw: unknown): RouterSignals {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RouterSignals, unknown>>
  return {
    consecutiveFailures: count(s.consecutiveFailures),
    failures: count(s.failures),
    passes: count(s.passes),
    filesEdited: count(s.filesEdited),
    projectsTouched: count(s.projectsTouched),
    mechanicalStreak: count(s.mechanicalStreak),
    uncertaintyHits: count(s.uncertaintyHits),
    maxQualityRequested: s.maxQualityRequested === true,
    riskHits: count(s.riskHits)
  }
}

// ---------- prompt classification ----------

export interface PromptClass {
  tier: RouterTier
  /** human-readable reasons ("mentions architecture", "risk: payment") */
  reasons: string[]
  risk: boolean
  uncertainty: boolean
  maxQuality: boolean
  /** true when the prompt names 2+ registered projects, or says "across projects" */
  crossProject: boolean
}

type HitClass = 'light' | 'standard' | 'deep' | 'max' | 'risk' | 'uncertainty' | 'cross'

/** Everything classifyPrompt knows, plus the raw hits recommend() needs for its reason/confidence. */
interface PromptAnalysis extends PromptClass {
  hits: Record<HitClass, string[]>
  /** registered project names mentioned (only listed when 2+, i.e. cross-project) */
  projectNames: string[]
  /** the tier the keywords alone imply, before the length rule */
  keywordTier: RouterTier
  length: number
  /** the tier the length rule alone implies */
  lengthTier?: 'standard' | 'deep'
  hasText: boolean
}

function analyzePrompt(text: string | undefined, projects?: Project[]): PromptAnalysis {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const hasText = trimmed.length > 0
  const t = normalizeText(trimmed)
  const hits: Record<HitClass, string[]> = {
    light: matchClass(t, LIGHT_MATCHERS),
    standard: matchClass(t, STANDARD_MATCHERS),
    // cross-project phrases live in DEEP_KEYWORDS too; they report under "cross-project" only
    deep: matchClass(t, DEEP_MATCHERS).filter((w) => !CROSS_SET.has(w)),
    max: matchClass(t, MAX_MATCHERS),
    risk: matchClass(t, RISK_MATCHERS),
    uncertainty: matchClass(t, UNCERTAINTY_MATCHERS),
    cross: matchClass(t, CROSS_MATCHERS)
  }
  const named = hasText && Array.isArray(projects) ? mentionedProjects(t, projects) : []
  const projectNames = named.length >= 2 ? named.map(projectLabel) : []
  const crossProject = projectNames.length > 0 || hits.cross.length > 0
  const risk = hits.risk.length > 0
  const uncertainty = hits.uncertainty.length > 0
  const maxQuality = hits.max.length > 0

  // Precedence for the prompt alone: MAX > DEEP > LIGHT > STANDARD. Risk and
  // cross-project reach are deep-class signals — a light word never lowers them.
  const keywordTier: RouterTier = maxQuality
    ? 'max'
    : hits.deep.length > 0 || crossProject || risk
      ? 'deep'
      : hits.light.length > 0
        ? 'light'
        : 'standard'
  const length = trimmed.length
  const lengthTier =
    length > LONG_PROMPT_DEEP ? 'deep' : length > LONG_PROMPT_STANDARD ? 'standard' : undefined
  const tier = lengthTier ? atLeast(keywordTier, lengthTier) : keywordTier

  const reasons: string[] = []
  if (maxQuality) reasons.push(`max quality: ${listWords(hits.max)}`)
  if (hits.deep.length) reasons.push(`deep: ${listWords(hits.deep)}`)
  if (hits.light.length) reasons.push(`light: ${listWords(hits.light)}`)
  if (hits.standard.length) reasons.push(`standard: ${listWords(hits.standard)}`)
  if (risk) reasons.push(`risk: ${listWords(hits.risk)}`)
  if (uncertainty) reasons.push(`uncertainty: ${listWords(hits.uncertainty)}`)
  if (crossProject) reasons.push(`cross-project: ${listWords([...projectNames, ...hits.cross])}`)
  if (lengthTier) reasons.push(`long prompt: ${length} chars`)

  return {
    tier,
    reasons,
    risk,
    uncertainty,
    maxQuality,
    crossProject,
    hits,
    projectNames,
    keywordTier,
    length,
    lengthTier,
    hasText
  }
}

/**
 * Classify a prompt into a base tier. `projects` (optional) enables
 * cross-project detection by registered project NAME (case-insensitive, whole
 * words). Empty/absent prompt → 'standard' with no reasons.
 */
export function classifyPrompt(text: string | undefined, projects?: Project[]): PromptClass {
  const a = analyzePrompt(text, projects)
  return {
    tier: a.tier,
    reasons: a.reasons,
    risk: a.risk,
    uncertainty: a.uncertainty,
    maxQuality: a.maxQuality,
    crossProject: a.crossProject
  }
}

/** What to call a project in a label: its name, else its folder name, else its id. A path-only
 *  mention can hit a registry entry whose name is missing or blank, and a label must never throw. */
function projectLabel(p: Project): string {
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  if (name) return name
  const folder =
    typeof p.path === 'string'
      ? p.path
          .trim()
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop()
      : ''
  return folder || (typeof p.id === 'string' && p.id) || 'project'
}

function isMentionableName(name: string): boolean {
  const n = name.trim()
  if (n.length < MIN_PROJECT_NAME_LENGTH) return false
  // the minimum length is of substance, not punctuation: "a---" or "Go!!" would hit every "a" / "go"
  const alnum = n.replace(/[^a-z0-9]/gi, '')
  if (alnum.length < MIN_PROJECT_NAME_LENGTH || !/[a-z]/i.test(alnum)) return false
  return !COMMON_SET.has(n.toLowerCase())
}

/** `pathText` is normPath(prompt); a registered folder counts when it appears as a whole path segment. */
function pathMentioned(pathText: string, projectPath: string): boolean {
  const p = normPath(projectPath.trim())
  if (p.length < MIN_PROJECT_NAME_LENGTH || !p.includes('\\')) return false
  let from = pathText.indexOf(p)
  while (from >= 0) {
    const prev = from > 0 ? pathText[from - 1] : ''
    const after = pathText.slice(from + p.length)
    // a longer sibling folder ("…-old", "…2", "….bak") is not this project; a separator,
    // sentence punctuation ("…\Income-Kit.") or the end of the text is
    const sibling = /^[\w-]/.test(after) || /^\.\w/.test(after)
    if (!/\w/.test(prev) && !sibling) return true
    from = pathText.indexOf(p, from + 1)
  }
  return false
}

/** Registered projects whose NAME appears in the text (whole-word, case-insensitive). */
export function mentionedProjects(text: string, projects: Project[]): Project[] {
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(projects)) return []
  const t = normalizeText(text)
  const hit = new Set<Project>()

  // Names, longest first: "Income Kit Pro" claims its span before "Income Kit"
  // can; a consumed span never re-matches. Spaces/hyphens/underscores/dots are
  // interchangeable, so "income-kit" and "Fable 5.1 week" both count.
  const byName = projects
    .filter((p): p is Project => !!p && typeof p.name === 'string' && isMentionableName(p.name))
    .sort((a, b) => b.name.trim().length - a.name.trim().length)
  let work = t
  for (const p of byName) {
    const re = phraseRegex(p.name, { sep: '[\\s_.-]*', inflect: false, split: /[\s_.-]+/ })
    if (work.search(re) < 0) continue
    hit.add(p)
    work = work.replace(re, blank)
  }

  // A registered folder pasted into the prompt (either slash style) is a mention too.
  const pathText = normPath(t)
  for (const p of projects) {
    if (p && !hit.has(p) && typeof p.path === 'string' && pathMentioned(pathText, p.path)) hit.add(p)
  }

  return projects.filter((p) => hit.has(p))
}

// ---------- model / effort / tier lookups ----------

/** Canonical model id or alias → Hub alias ('claude-opus-5' → 'opus', 'Haiku' → 'haiku'). */
export function modelAlias(model: string | undefined): ClaudeModel | undefined {
  if (typeof model !== 'string') return undefined
  const m = model.toLowerCase()
  return CLAUDE_MODELS.find((alias) => m.includes(alias))
}

/** Effort string (any case, padded) → allowlisted effort, else undefined. */
export function effortAlias(effort: string | undefined): ClaudeEffort | undefined {
  if (typeof effort !== 'string') return undefined
  const e = effort.trim().toLowerCase()
  return CLAUDE_EFFORTS.find((level) => level === e)
}

/** Nearest tier for a model alias/id (+ optional effort). Unknown model → undefined. */
export function tierOf(current: { model?: string; effort?: string } | undefined): RouterTier | undefined {
  if (!current) return undefined
  const model = modelAlias(current.model)
  if (!model) return undefined
  const effort = effortAlias(current.effort)
  switch (model) {
    case 'haiku':
      return 'light'
    case 'sonnet':
      // model dominates: sonnet at low effort is still standard work
      return 'standard'
    case 'opus':
      // effort only nudges opus, and only upward
      return effort === 'max' || effort === 'xhigh' ? 'max' : 'deep'
    case 'fable':
      return 'max'
  }
}

// ---------- the recommendation ----------

export interface RecommendInput {
  /** the latest prompt (or task text) — may be absent */
  prompt?: string
  signals: RouterSignals
  /** what the session currently runs (canonical id or alias + effort), when known */
  current?: { model?: string; effort?: string }
  /** registry, for cross-project detection */
  projects?: Project[]
  now: number
}

interface ReasonInput {
  a: PromptAnalysis
  signals: RouterSignals
  tier: RouterTier
  held: boolean
  maxQuality: boolean
  /** no evidence at all — holding at the session's current tier */
  idle?: boolean
}

/** One short sentence naming the strongest signal, in decision order. No trailing period. */
function reasonFor({ a, signals, tier, held, maxQuality, idle }: ReasonInput): string {
  const cf = signals.consecutiveFailures
  const uh = signals.uncertaintyHits
  if (held) return 'recent failures — holding'
  if (idle) {
    return a.uncertainty
      ? `unsure/retry language (${listWords(a.hits.uncertainty, 3, false)}) — holding until it repeats`
      : 'nothing specific in the request — keeping the current model'
  }
  if (maxQuality) return 'you asked for maximum quality'
  if (cf >= ROUTER_LIMITS.failuresToEscalate) return `${cf} consecutive test failures — escalating`
  if (uh >= ROUTER_LIMITS.uncertaintyToEscalate) return `${uh} unsure/retry prompts — escalating`
  if (a.risk) return `risky change (${listWords(a.hits.risk, 3, false)}) — use a strong model`
  if (a.crossProject) {
    const what = a.projectNames.length > 0 ? a.projectNames : a.hits.cross
    return `cross-project work (${listWords(what, 3, false)})`
  }
  if (signals.projectsTouched > 1) return `edits already span ${signals.projectsTouched} projects`
  if (a.hits.deep.length) return `architecture-level change (${listWords(a.hits.deep, 3, false)})`
  if (a.lengthTier === 'deep') return 'long, multi-part request'
  if (tier === 'light') return `simple wording/CSS change (${listWords(a.hits.light, 3, false)})`
  // length lifted a light (or unmatched) prompt to standard — that, not the words, is the reason
  if (a.lengthTier === 'standard' && tierIndex(a.keywordTier) < tierIndex('standard')) {
    return 'long, multi-part request'
  }
  if (a.hits.standard.length) return `ordinary feature work (${listWords(a.hits.standard, 3, false)})`
  if (a.lengthTier === 'standard') return 'long, multi-part request'
  // a single unsure/retry prompt is a signal worth naming, though it only escalates once it repeats
  if (a.uncertainty)
    return `unsure/retry language (${listWords(a.hits.uncertainty, 3, false)}) — standard until it repeats`
  if (!a.hasText) return 'no task text yet'
  return 'nothing specific in the request — standard by default'
}

/**
 * The recommendation. Rules (in order):
 *  - base = classifyPrompt().tier ('standard' without a prompt)
 *  - maxQualityRequested → 'max'
 *  - risk or crossProject or projectsTouched > 1 → at least 'deep'
 *  - consecutiveFailures ≥ 2 → one tier up; ≥ 4 → 'max'
 *  - uncertaintyHits ≥ 2 → one tier up
 *  - mechanicalStreak ≥ 3 with no failures and base ≤ 'standard' → hold at base
 *    (never below 'light'; de-escalation only ever goes to the prompt's own tier)
 *  - NO evidence at all (no tier keyword, no length, no escalation signal — a
 *    "thanks, that works" or a vague aside) → hold at the session's current tier
 *    with changes=false; only a mechanical streak or a real keyword moves it
 *  - confidence: explicit keyword/signal hits ≥ 0.85; length-only ≥ 0.6; nothing → 0.5
 *  - direction/changes computed against `current` when known.
 */
export function recommend(input: RecommendInput): RouterRecommendation {
  const signals = normalizeSignals(input.signals)
  const a = analyzePrompt(input.prompt, input.projects)
  const cf = signals.consecutiveFailures
  const uh = signals.uncertaintyHits
  const maxQuality = signals.maxQualityRequested || a.maxQuality

  const L = ROUTER_LIMITS
  const escalating = cf >= L.failuresToEscalate
  const unsure = uh >= L.uncertaintyToEscalate

  // Escalation stacks upward and saturates at max.
  let tier = a.tier
  if (maxQuality) tier = 'max'
  if (a.risk || a.crossProject || signals.projectsTouched > 1) tier = atLeast(tier, 'deep')
  if (cf >= L.failuresToMax) tier = 'max'
  else if (escalating) tier = tierUp(tier)
  if (unsure) tier = tierUp(tier)

  // De-escalation guard: never step down while the last check is still red.
  // (A clearly light prompt on a clean, expensive session steps down at once.)
  const curTier = tierOf(input.current)
  let held = false
  if (curTier !== undefined && cf >= 1 && tierIndex(tier) < tierIndex(curTier)) {
    tier = curTier
    held = true
  }

  const labels = [...a.reasons]
  if (signals.maxQualityRequested && !a.maxQuality) labels.push('max quality requested')
  if (signals.projectsTouched > 1) labels.push(`projects touched: ${signals.projectsTouched}`)
  if (cf >= 1) labels.push(`failures: ${cf}`)
  if (unsure) labels.push(`uncertainty hits: ${uh}`)
  const mechanical =
    signals.mechanicalStreak >= L.mechanicalStreakMin && cf === 0 && tierIndex(tier) <= tierIndex('standard')
  if (mechanical) labels.push(`mechanical streak: ${signals.mechanicalStreak}`)
  if (held) labels.push('holding: recent failures')

  // A turn with no evidence at all says nothing about the work: it must not move
  // the model in either direction (a chat reply on an expensive session is not a
  // reason to downgrade; a vague ask on a cheap one is not a reason to upgrade).
  // A mechanical streak is the one thing that earns a step down here.
  const evidence =
    maxQuality ||
    escalating ||
    unsure ||
    a.risk ||
    a.crossProject ||
    signals.projectsTouched > 1 ||
    a.hits.light.length > 0 ||
    a.hits.standard.length > 0 ||
    a.hits.deep.length > 0 ||
    Boolean(a.lengthTier)
  let idle = false
  if (!evidence && !held && !mechanical && curTier !== undefined && tier !== curTier) {
    tier = curTier
    idle = true
    labels.push('no task evidence: holding')
  }

  const strong =
    held ||
    maxQuality ||
    escalating ||
    unsure ||
    a.risk ||
    a.crossProject ||
    signals.projectsTouched > 1 ||
    a.hits.light.length > 0 ||
    a.hits.standard.length > 0 ||
    a.hits.deep.length > 0
  let confidence = strong ? L.confidenceKeyword : a.lengthTier ? L.confidenceLength : L.confidenceNone
  if (mechanical)
    confidence += L.confidenceStreakStep * (signals.mechanicalStreak - (L.mechanicalStreakMin - 1))
  confidence = Math.round(Math.min(L.confidenceMax, confidence) * 100) / 100

  // Holding means "stay where you are": the target is the session's own pair
  // when we can name it, so a hold never asks for a model switch.
  const curModel = modelAlias(input.current?.model)
  const curEffort = effortAlias(input.current?.effort)
  const target: ModelEffort =
    (held || idle) && curModel && curEffort
      ? { model: curModel, effort: curEffort }
      : ROUTER_TIER_TARGETS[tier]

  const direction: RouterRecommendation['direction'] =
    curTier === undefined
      ? 'hold'
      : tierIndex(tier) > tierIndex(curTier)
        ? 'escalate'
        : tierIndex(tier) < tierIndex(curTier)
          ? 'deescalate'
          : 'hold'
  const changes =
    curModel !== undefined &&
    (curModel !== target.model || (curEffort !== undefined && curEffort !== target.effort))

  return {
    tier,
    target,
    reason: reasonFor({ a, signals, tier, held, maxQuality, idle }),
    confidence,
    direction,
    changes,
    signals: labels,
    at: Number.isFinite(input.now) ? input.now : Date.now()
  }
}

/** "Suggested: sonnet / low — <reason>" */
export function formatRecommendation(r: RouterRecommendation): string {
  return `Suggested: ${r.target.model} / ${r.target.effort} — ${r.reason}`
}

/** The documented slash commands that apply a target in a running session.
 *  Re-checked against the allowlists: these are typed into a PTY, so a stale
 *  or hand-edited recommendation can never smuggle text in. */
export function slashCommandsFor(target: ModelEffort): string[] {
  const out: string[] = []
  const model = modelAlias(target?.model)
  const effort = effortAlias(target?.effort)
  if (model !== undefined && model === target.model) out.push(`/model ${model}`)
  if (effort !== undefined) out.push(`/effort ${effort}`)
  return out
}

/** Effort levels in order (for comparisons). */
export const EFFORT_ORDER: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// ---------- signal updates (called by the session-board reducer) ----------

/** A new prompt arrived: bump uncertainty / risk / max-quality counters. */
export function signalsAfterPrompt(signals: RouterSignals, prompt: string): RouterSignals {
  const s = normalizeSignals(signals)
  const a = analyzePrompt(prompt)
  return {
    ...s,
    uncertaintyHits: s.uncertaintyHits + (a.uncertainty ? 1 : 0),
    riskHits: s.riskHits + (a.risk ? 1 : 0),
    // sticky: once the user asked for max quality, the session keeps it
    maxQualityRequested: s.maxQualityRequested || a.maxQuality
  }
}

/** A test/build/lint/typecheck command finished. Other kinds are ignored. */
export function signalsAfterCommand(
  signals: RouterSignals,
  kind: CommandKind,
  outcome: CommandOutcome
): RouterSignals {
  const s = normalizeSignals(signals)
  if (!COUNTED_COMMAND_KINDS.includes(kind)) return s
  if (outcome === 'fail')
    return { ...s, failures: s.failures + 1, consecutiveFailures: s.consecutiveFailures + 1 }
  if (outcome === 'pass') return { ...s, passes: s.passes + 1, consecutiveFailures: 0 }
  return s
}

/** A turn ended (Stop). `editsThisTurn` = distinct files edited since the prompt. */
export function signalsAfterTurn(
  signals: RouterSignals,
  turn: { promptLength: number; editsThisTurn: number; failuresThisTurn: number }
): RouterSignals {
  const s = normalizeSignals(signals)
  const mechanical =
    count(turn?.promptLength) <= ROUTER_LIMITS.mechanicalPromptChars &&
    count(turn?.editsThisTurn) <= ROUTER_LIMITS.mechanicalEdits &&
    count(turn?.failuresThisTurn) === 0
  return { ...s, mechanicalStreak: mechanical ? s.mechanicalStreak + 1 : 0 }
}

/** Distinct-file / project counters (idempotent set sizes). */
export function signalsWithCounts(
  signals: RouterSignals,
  counts: { filesEdited: number; projectsTouched: number }
): RouterSignals {
  const s = normalizeSignals(signals)
  return { ...s, filesEdited: count(counts?.filesEdited), projectsTouched: count(counts?.projectsTouched) }
}
