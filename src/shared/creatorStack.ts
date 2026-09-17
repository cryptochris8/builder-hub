// Creator Stack registry — PURE (no node/electron), tested.
//
// "Awareness of reusable tools and related projects": Income Kit's trailer
// factory, the video factory, the agent pack, playbooks, stack profiles, the
// tool catalog. Stored as creator-stack.json (main/creatorStack.ts), rendered
// for Claude at ~/.claude/builder-hub/creator-stack.md, and matched against
// prompts so a "make a trailer with our trailer kit" request gets the kit's
// card injected (path + docs to read first + entrypoints + usage notes) instead
// of Claude reinventing the pipeline.
//
// SEED entries below were verified on disk on 2026-09-16 (paths relative to the
// home dir, forward slashes). Seeding only registers entries whose path exists;
// nothing is ever hard-coded as present.

import { CREATOR_STACK_KINDS, PROJECT_TYPES } from './types'
import type {
  CapabilityMatch,
  CreatorCapability,
  CreatorStack,
  CreatorStackEntry,
  CreatorStackKind,
  Project,
  ProjectType
} from './types'

export interface SeedCapability {
  id: string
  name: string
  aliases: string[]
  purpose: string
  entrypoints: string[]
  docs: string[]
  usageNotes?: string
  worksFor?: ProjectType[]
  tags?: string[]
}

export interface SeedEntry {
  id: string
  name: string
  aliases: string[]
  /** relative to the home dir, forward slashes */
  relPath: string
  kind: CreatorStackKind
  docs: string[]
  capabilities: SeedCapability[]
  tags?: string[]
  dependencies?: string[]
}

/** Verified on disk 2026-09-16. Keep paths relative to home; keep docs relative to the entry. */
export const SEED_CREATOR_STACK: readonly SeedEntry[] = [
  {
    id: 'income-kit',
    name: 'Income Kit',
    aliases: ['income kit', 'side income kit', 'creator kit'],
    relPath: 'income-kit',
    kind: 'shared-tool',
    docs: ['START-HERE.md', 'CLAUDE.md'],
    tags: ['creator', 'marketing', 'video', 'agents'],
    capabilities: [
      {
        id: 'trailer-kit',
        name: 'Trailer Factory (audio-first game trailers)',
        aliases: [
          'trailer kit',
          'trailer factory',
          'trailer creator',
          'video creator',
          'trailer pipeline',
          'game trailer',
          'cinematic trailer',
          'make a trailer',
          'trailer'
        ],
        purpose:
          "Create a 60–90 s cinematic game/product trailer with the owner's proven pipeline: script on a timecode grid → ElevenLabs VO + bespoke score → radio edit → cinema shots rendered from the game's own code → bot/human gameplay capture → 16:9 and 9:16 cuts.",
        entrypoints: [
          'trailer-factory/tools/build-trailer-audio.mjs',
          'trailer-factory/tools/build-trailer-radio.mjs',
          'trailer-factory/tools/cinema/render.mjs',
          'trailer-factory/tools/cinema/capture.mjs',
          'trailer-factory/tools/cinema/cards.mjs',
          'trailer-factory/tools/cinema/assemble.mjs',
          'trailer-factory/package.json (npm run audio | radio | render | capture | cards | cut)'
        ],
        docs: [
          'trailer-factory/README.md',
          'trailer-factory/PLAYBOOK.md',
          'trailer-factory/template/edit.example.json'
        ],
        usageNotes:
          "Do NOT build a new trailer generator. Copy trailer-factory/tools into the game repo (README 'Setup in a new game repo'), fill trailer/edit.json, then change only: NARRATOR voice id + VO lines + MUSIC prompts (build-trailer-audio.mjs), the SHOTS table imports (cinema.html), the bot (capture.mjs), the card texts (cards.mjs). Three.js/web games get the whole pipeline; HYTOPIA/Roblox use the audio half + cards + assembly and swap the camera tool (see README's honest table). Needs ffmpeg (h264_nvenc), Chrome, ELEVENLABS_API_KEY.",
        worksFor: ['web-app', 'hytopia', 'roblox', 'unreal', 'mobile-app'],
        tags: ['trailer', 'video', 'elevenlabs', 'ffmpeg', 'playwright']
      },
      {
        id: 'video-factory',
        name: 'Video Factory (vertical social clips)',
        aliases: [
          'video factory',
          'social clip',
          'vertical video',
          'tiktok video',
          'shorts',
          'reels',
          'captioned video'
        ],
        purpose:
          'Turn a JSON spec (images + on-screen captions + narration) into a finished 1080×1920 vertical MP4 with voiceover and burned-in captions for TikTok / Reels / Shorts. Reusable for any project.',
        entrypoints: ['video-factory/video_factory.py (python video_factory.py specs/<spec>.json)'],
        docs: ['video-factory/README.md', 'video-factory/specs'],
        usageNotes:
          'Run from the video-factory directory with `python` (NOT the `py` launcher — it resolves to a Store Python without the deps). Spec paths resolve against the cwd. ElevenLabs key: elevenlabs.key in that folder or ELEVENLABS_API_KEY.',
        tags: ['video', 'ffmpeg', 'python', 'elevenlabs']
      },
      {
        id: 'claude-agent-pack',
        name: 'Claude Agent Pack (19 subagents)',
        aliases: ['agent pack', 'subagent pack', 'claude agents', '19 agents', 'agent team'],
        purpose:
          'Nineteen production-grade Claude Code subagents (architect, code-review, security, testing-qa, backend/frontend, database…) in native .claude/agents format with least-privilege tools and model tiers.',
        entrypoints: ['claude-agent-pack/agents'],
        docs: ['claude-agent-pack/README.md', 'claude-agent-pack/QUICKSTART.md'],
        usageNotes:
          'Copy the agents/ folder into a project’s .claude/agents to use them there. GUMROAD-LISTING.md is the product listing — never ship it in the zip.',
        tags: ['agents', 'claude-code']
      },
      {
        id: 'roblox-marketing',
        name: 'Roblox marketing engine',
        aliases: [
          'roblox marketing',
          'content pack',
          'content engine',
          'short video scripts',
          'metricool sop'
        ],
        purpose:
          'Ready-to-film short-video scripts, a reusable content-generator prompt + 4-week calendar, and the Metricool scheduling SOP for Roblox games.',
        entrypoints: [],
        docs: [
          'roblox-marketing/CONTENT-ENGINE.md',
          'roblox-marketing/GNARLY-NUTMEG-CONTENT-PACK.md',
          'roblox-marketing/METRICOOL-SOP.md'
        ],
        worksFor: ['roblox', 'hytopia'],
        tags: ['marketing', 'roblox', 'metricool']
      },
      {
        id: 'freelancing-kit',
        name: 'Freelancing kit',
        aliases: ['freelancing kit', 'fiverr gigs', 'upwork kit', 'proposal template'],
        purpose: 'Fiverr gig copy, Upwork profile + proposal templates and a 30-day playbook.',
        entrypoints: [],
        docs: ['freelancing-kit/FIVERR-GIGS.md', 'freelancing-kit/UPWORK-KIT.md'],
        tags: ['freelancing']
      }
    ]
  },
  {
    id: 'game-trailer-playbook',
    name: 'Game Trailer Playbook',
    aliases: ['trailer playbook', 'game trailer playbook'],
    relPath: '.claude/playbooks/game-trailer-playbook.md',
    kind: 'playbook',
    docs: ['.'],
    tags: ['trailer', 'method'],
    capabilities: [
      {
        id: 'trailer-method',
        name: 'Audio-first trailer method',
        aliases: ['trailer method', 'audio first', 'radio edit'],
        purpose:
          'The five-step method and the traps (sidechain apad, camera paths, LUFS targets) behind the Trailer Factory. Read alongside trailer-kit.',
        entrypoints: [],
        docs: ['.'],
        tags: ['trailer']
      }
    ]
  },
  {
    id: 'everlight-trailer-reference',
    name: 'Everlight trailer reference implementation',
    aliases: ['everlight trailer', 'trailer reference', 'fable one-shot trailer'],
    relPath: 'Fable-5.1-one-shot/tools',
    kind: 'reference',
    docs: ['../trailer/edit.json', '../BUILD-SPEC.md'],
    tags: ['trailer', 'reference'],
    capabilities: [
      {
        id: 'trailer-reference-impl',
        name: 'Working trailer rig (Three.js game)',
        aliases: ['trailer rig', 'render rig', 'cinema rig'],
        purpose:
          'The working render/capture/assemble scripts + edit sheet the Trailer Factory was extracted from. Copy from trailer-factory, compare against this when something is unclear.',
        entrypoints: [
          'build-trailer-audio.mjs',
          'build-trailer-radio.mjs',
          'cinema/render.mjs',
          'cinema/assemble.mjs'
        ],
        docs: ['../trailer/edit.json'],
        worksFor: ['web-app'],
        tags: ['trailer', 'threejs']
      }
    ]
  },
  {
    id: 'subagents-repo',
    name: 'Subagents repo (19-agent pack source)',
    aliases: ['subagents repo', 'subagents', 'agent source'],
    relPath: 'subagents-repo',
    kind: 'agent-pack',
    docs: ['README.md'],
    tags: ['agents'],
    capabilities: []
  },
  {
    id: 'tool-stack',
    name: 'TOOL-STACK.md — master tool catalog',
    aliases: ['tool stack', 'tool catalog', 'toolbox', 'api key map'],
    relPath: 'TOOL-STACK.md',
    kind: 'catalog',
    docs: ['.'],
    tags: ['catalog'],
    capabilities: [
      {
        id: 'tool-catalog',
        name: 'Every tool/service/API + where each key lives',
        aliases: ['which tools do I have', 'what tools', 'api keys', 'where is the key'],
        purpose:
          '~250 tools by category, an API-key location map (names only) and Appendix A: every project → its stack. Prefer tools listed here before proposing new ones.',
        entrypoints: [],
        docs: ['.'],
        tags: ['catalog']
      }
    ]
  },
  {
    id: 'stack-profiles',
    name: 'Stack profiles',
    aliases: ['stack profiles', 'stack profile', 'project type profile'],
    relPath: '.claude/stack-profiles',
    kind: 'profile',
    docs: ['README.md'],
    tags: ['conventions'],
    capabilities: [
      {
        id: 'stack-profile',
        name: 'Per-project-type conventions & scaffolds',
        aliases: ['roblox profile', 'hytopia profile', 'web-app profile', 'mobile profile', 'unreal profile'],
        purpose:
          'Focused tools, conventions, scaffolds and gotchas per project type (roblox · hytopia · unreal · web-app · mobile-app · ai-content · crypto-web3 · static-site).',
        entrypoints: [],
        docs: ['README.md'],
        tags: ['conventions']
      }
    ]
  },
  {
    id: 'ai-creators',
    name: 'AI Creators pipelines',
    aliases: ['ai creators', 'flux pipeline', 'recraft pipeline', 'image pipeline'],
    relPath: 'AI-creators',
    kind: 'reference',
    docs: ['README.md'],
    tags: ['ai-content', 'python'],
    capabilities: [
      {
        id: 'ai-content-pipelines',
        name: 'FLUX / Recraft / ElevenLabs + FFmpeg content pipelines',
        aliases: ['generate images', 'image generation pipeline', 'content pipeline'],
        purpose:
          'Python reference pipelines for image (Fal FLUX, Recraft), voice (ElevenLabs) and FFmpeg assembly — reuse before writing new generation code.',
        entrypoints: [],
        docs: ['README.md'],
        worksFor: ['ai-content'],
        tags: ['ai-content']
      }
    ]
  }
]

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

type EntrySource = CreatorStackEntry['source']

/** Same normalization as sessionLogic.normPath — backslashes, no trailing
 *  separator, lowercase. Kept local because this module imports ./types only. */
const pathKey = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase()

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** Array of non-empty strings; anything else (or a non-array) → []. */
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isNonEmptyStr) : [])

const isKind = (v: unknown): v is CreatorStackKind =>
  typeof v === 'string' && (CREATOR_STACK_KINDS as readonly string[]).includes(v)
const isSource = (v: unknown): v is EntrySource => v === 'seed' || v === 'user' || v === 'discovered'
const isProjectType = (v: unknown): v is ProjectType =>
  typeof v === 'string' && (PROJECT_TYPES as readonly string[]).includes(v)

/** Drive letter (`C:`) or a leading slash/backslash (POSIX root, UNC). */
const isAbsolutePath = (p: string): boolean => /^[a-zA-Z]:/.test(p) || /^[\\/]/.test(p)

// ---------------------------------------------------------------------------
// Limits (parity with CONTEXT_LIMITS / BOARD_LIMITS)
// ---------------------------------------------------------------------------

export const CREATOR_STACK_LIMITS = {
  /** hard cap on the injected capability card (chars, UserPromptSubmit additionalContext) */
  cardChars: 900,
  /** default `limit` for findCapabilities */
  matches: 3,
  /** best-hit score below which a query yields no matches at all */
  minMatchScore: 4
} as const

/** Naive join used only for the *display* markdown, where no joinPath is
 *  injected: picks the entry's own separator and leaves `..` segments in place
 *  (Windows resolves them). '.' → the entry path; absolute → as is. */
function displayPath(entry: CreatorStackEntry, rel: string): string {
  const r = rel.trim()
  if (!r || r === '.') return entry.path
  if (isAbsolutePath(r)) return r
  const sep = entry.path.includes('\\') || /^[a-zA-Z]:/.test(entry.path) ? '\\' : '/'
  const segs = r.split(/[\\/]+/).filter((s) => s && s !== '.')
  return entry.path.replace(/[\\/]+$/, '') + sep + segs.join(sep)
}

function normalizeCapability(raw: unknown): CreatorCapability | undefined {
  if (!isObj(raw)) return undefined
  if (!isNonEmptyStr(raw.id) || !isNonEmptyStr(raw.name) || typeof raw.purpose !== 'string') return undefined
  const cap: CreatorCapability = {
    id: raw.id,
    name: raw.name,
    aliases: strArray(raw.aliases),
    purpose: raw.purpose,
    entrypoints: strArray(raw.entrypoints),
    docs: strArray(raw.docs),
    tags: strArray(raw.tags)
  }
  if (isNonEmptyStr(raw.usageNotes)) cap.usageNotes = raw.usageNotes
  if (Array.isArray(raw.worksFor)) {
    const w = raw.worksFor.filter(isProjectType)
    if (w.length) cap.worksFor = w
  }
  return cap
}

function normalizeEntry(raw: unknown): CreatorStackEntry | undefined {
  if (!isObj(raw)) return undefined
  if (!isNonEmptyStr(raw.id) || !isNonEmptyStr(raw.name) || !isNonEmptyStr(raw.path)) return undefined
  if (!isKind(raw.kind)) return undefined
  const capabilities: CreatorCapability[] = []
  const seenCaps = new Set<string>()
  for (const c of Array.isArray(raw.capabilities) ? raw.capabilities : []) {
    const cap = normalizeCapability(c)
    if (cap && !seenCaps.has(cap.id)) {
      seenCaps.add(cap.id)
      capabilities.push(cap)
    }
  }
  const entry: CreatorStackEntry = {
    id: raw.id,
    name: raw.name,
    aliases: strArray(raw.aliases),
    path: raw.path,
    kind: raw.kind,
    capabilities,
    docs: strArray(raw.docs),
    tags: strArray(raw.tags),
    exists: typeof raw.exists === 'boolean' ? raw.exists : true,
    source: isSource(raw.source) ? raw.source : 'user'
  }
  if (isNonEmptyStr(raw.projectId)) entry.projectId = raw.projectId
  if (Array.isArray(raw.dependencies)) entry.dependencies = strArray(raw.dependencies)
  if (isFiniteNum(raw.indexedAt)) entry.indexedAt = raw.indexedAt
  return entry
}

function copyCapability(c: SeedCapability): CreatorCapability {
  const cap: CreatorCapability = {
    id: c.id,
    name: c.name,
    aliases: [...c.aliases],
    purpose: c.purpose,
    entrypoints: [...c.entrypoints],
    docs: [...c.docs],
    tags: [...(c.tags ?? [])]
  }
  if (c.usageNotes) cap.usageNotes = c.usageNotes
  if (c.worksFor?.length) cap.worksFor = [...c.worksFor]
  return cap
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export function emptyStack(now: number): CreatorStack {
  return { version: 1, entries: [], updatedAt: now }
}

/** Tolerant read from disk: wrong shape → empty; bad entries dropped; ids de-duplicated (first wins). */
export function normalizeStack(raw: unknown, now: number): CreatorStack {
  if (!isObj(raw) || !Array.isArray(raw.entries)) return emptyStack(now)
  const entries: CreatorStackEntry[] = []
  const seen = new Set<string>()
  for (const r of raw.entries) {
    const e = normalizeEntry(r)
    if (e && !seen.has(e.id)) {
      seen.add(e.id)
      entries.push(e)
    }
  }
  const removed = Array.isArray(raw.removed)
    ? Array.from(new Set(raw.removed.filter((x): x is string => typeof x === 'string' && x.trim() !== '')))
    : []
  return {
    version: 1,
    entries,
    ...(removed.length ? { removed } : {}),
    updatedAt: isFiniteNum(raw.updatedAt) ? raw.updatedAt : now
  }
}

/**
 * Resolve the seed against the machine: absolute paths from `home` (backslashes
 * on win32 — use `joinPath`), `exists` from the probe, `projectId` = the
 * registered project whose path is the LONGEST prefix of the entry path. Only
 * entries whose path exists are returned.
 */
export function seedEntries(
  home: string,
  exists: (absPath: string) => boolean,
  projects: Project[],
  now: number,
  joinPath: (...parts: string[]) => string
): CreatorStackEntry[] {
  const out: CreatorStackEntry[] = []
  for (const seed of SEED_CREATOR_STACK) {
    const abs = joinPath(home, ...seed.relPath.split('/'))
    let present = false
    try {
      present = exists(abs) === true
    } catch {
      present = false
    }
    if (!present) continue
    const projectId = projectForPath(abs, projects)?.id
    out.push({
      id: seed.id,
      name: seed.name,
      aliases: [...seed.aliases],
      path: abs,
      ...(projectId ? { projectId } : {}),
      kind: seed.kind,
      capabilities: seed.capabilities.map(copyCapability),
      docs: [...seed.docs],
      ...(seed.dependencies ? { dependencies: [...seed.dependencies] } : {}),
      tags: [...(seed.tags ?? [])],
      exists: true,
      indexedAt: now,
      source: 'seed'
    })
  }
  return out
}

/** The refreshed form of a stored seed-sourced entry. The stored path is kept
 *  (the user may have moved the tool) unless it is marked missing and the
 *  seeded path is present — then the seeded path is adopted. When the stored
 *  path is kept AND differs from the seeded one, the seed's probe says nothing
 *  about it, so only `indexedAt` moves. */
function refreshSeeded(stored: CreatorStackEntry, seed: CreatorStackEntry, now: number): CreatorStackEntry {
  const indexedAt = seed.indexedAt ?? now
  const samePath = pathKey(stored.path) === pathKey(seed.path)
  const adopt = !samePath && !stored.exists && seed.exists
  if (!samePath && !adopt) return { ...stored, indexedAt }
  const next: CreatorStackEntry = {
    ...stored,
    path: adopt ? seed.path : stored.path,
    exists: seed.exists,
    indexedAt
  }
  if (seed.projectId) next.projectId = seed.projectId
  else delete next.projectId
  return next
}

/** Add seed entries the stack lacks (by id); for existing seed-sourced entries
 *  refresh only `exists`, `projectId`, `indexedAt` (user edits to aliases,
 *  capabilities, notes are preserved). User/discovered entries untouched. */
export function mergeSeed(stack: CreatorStack, seeded: CreatorStackEntry[], now: number): CreatorStack {
  const entries = [...stack.entries]
  const index = new Map<string, number>()
  entries.forEach((e, i) => {
    if (!index.has(e.id)) index.set(e.id, i)
  })
  const removed = new Set(stack.removed ?? [])
  for (const seed of seeded) {
    const i = index.get(seed.id)
    if (i === undefined) {
      if (removed.has(seed.id)) continue // the user removed it — stays removed
      index.set(seed.id, entries.length)
      entries.push({ ...seed, indexedAt: seed.indexedAt ?? now })
      continue
    }
    const stored = entries[i]
    if (stored.source !== 'seed') continue
    entries[i] = refreshSeeded(stored, seed, now)
  }
  return {
    version: 1,
    entries,
    ...(stack.removed?.length ? { removed: [...stack.removed] } : {}),
    updatedAt: now
  }
}

export function upsertEntry(stack: CreatorStack, entry: CreatorStackEntry, now: number): CreatorStack {
  const i = stack.entries.findIndex((e) => e.id === entry.id)
  const entries = i >= 0 ? stack.entries.map((e, j) => (j === i ? entry : e)) : [...stack.entries, entry]
  return { version: 1, entries, updatedAt: now }
}

/** Returns the same object when `id` is not present (nothing changed, no updatedAt bump). */
export function removeEntry(stack: CreatorStack, id: string, now: number): CreatorStack {
  const entry = stack.entries.find((e) => e.id === id)
  if (!entry) return stack
  // Remember a removed SEED so the next Reindex/mergeSeed does not resurrect it.
  const removed =
    entry.source === 'seed' ? Array.from(new Set([...(stack.removed ?? []), id])) : (stack.removed ?? [])
  return {
    version: 1,
    entries: stack.entries.filter((e) => e.id !== id),
    ...(removed.length ? { removed } : {}),
    updatedAt: now
  }
}

/** Registered project whose path is the longest prefix of `absPath` (case-insensitive, separator-agnostic). */
export function projectForPath(absPath: string, projects: Project[]): Project | undefined {
  const key = pathKey(typeof absPath === 'string' ? absPath : '')
  if (!key || !Array.isArray(projects)) return undefined
  let best: Project | undefined
  let bestLen = -1
  for (const p of projects) {
    if (!p || typeof p.path !== 'string') continue
    const root = pathKey(p.path)
    if (!root) continue
    if ((key === root || key.startsWith(root + '\\')) && root.length > bestLen) {
      best = p
      bestLen = root.length
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Alias matching
// ---------------------------------------------------------------------------

/** Score below which a hit is not enough ON ITS OWN to trigger a card. A lone
 *  single-word tag hit ("video") scores ≈ 3.1 and never triggers; any alias or
 *  name hit scores ≥ 4. Tag hits still ride along as related matches once the
 *  best hit clears the bar ("trailer" → trailer-kit, then trailer-method). */
export const MIN_MATCH_SCORE = CREATOR_STACK_LIMITS.minMatchScore

const SCORE_CAPABILITY = 3
const SCORE_ENTRY = 2
const SCORE_TAG = 1

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A "word" character for the boundary check: any letter or digit in any
 *  script (JS's \b and [a-z0-9] are ASCII-only, so 'écafé' would match 'café'). */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/** Whole-word phrase matcher: the phrase must not be glued to a word character
 *  on either side (the lookaround form of \b…\b, which also behaves for phrases
 *  that start or end with punctuation). Whitespace runs match flexibly. */
function phraseRegex(phrase: string): RegExp | undefined {
  const words = phrase.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return undefined
  return new RegExp(`(?<!${WORD_CHAR})${words.map(escapeRegex).join('\\s+')}(?!${WORD_CHAR})`, 'iu')
}

function phraseScore(base: number, phrase: string): number {
  const words = phrase.trim().split(/\s+/).filter(Boolean).length
  return base + words * 2 + phrase.trim().length / 50
}

const matchName = (m: CapabilityMatch): string => (m.capability?.name ?? m.entry.name).toLowerCase()

/**
 * Alias/name matching for a free-text query. Whole-word, case-insensitive;
 * longer alias phrases score higher; capability aliases beat entry aliases beat
 * tags; entries with exists=false are skipped. Sorted by score desc, `limit` max.
 * "create a trailer using our trailer kit" → [trailer-kit (income-kit), trailer-method…].
 */
export function findCapabilities(
  query: string,
  stack: CreatorStack,
  limit: number = CREATOR_STACK_LIMITS.matches
): CapabilityMatch[] {
  const q = typeof query === 'string' ? query.toLowerCase().trim() : ''
  // +Infinity means "no limit"; anything else non-finite (NaN, -Infinity) is garbage → nothing.
  const max =
    limit === Number.POSITIVE_INFINITY
      ? Infinity
      : Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : 0
  const entries = Array.isArray(stack?.entries) ? stack.entries : []
  if (!q || max === 0) return []

  const best = new Map<string, CapabilityMatch>()
  const consider = (
    entry: CreatorStackEntry,
    capability: CreatorCapability | undefined,
    phrase: string,
    base: number
  ): void => {
    if (typeof phrase !== 'string') return
    const re = phraseRegex(phrase)
    if (!re || !re.test(q)) return
    const score = phraseScore(base, phrase)
    const key = `${entry.id}\u0000${capability?.id ?? ''}`
    const prev = best.get(key)
    if (prev && prev.score >= score) return
    best.set(key, { entry, ...(capability ? { capability } : {}), matched: phrase, score })
  }

  for (const entry of entries) {
    if (!entry || !entry.exists) continue
    for (const a of [entry.name, ...(entry.aliases ?? [])]) consider(entry, undefined, a, SCORE_ENTRY)
    for (const t of entry.tags ?? []) consider(entry, undefined, t, SCORE_TAG)
    for (const cap of entry.capabilities ?? []) {
      for (const a of [cap.name, ...(cap.aliases ?? [])]) consider(entry, cap, a, SCORE_CAPABILITY)
      for (const t of cap.tags ?? []) consider(entry, cap, t, SCORE_TAG)
    }
  }

  const ranked = [...best.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const an = matchName(a)
    const bn = matchName(b)
    return an < bn ? -1 : an > bn ? 1 : 0
  })
  if (!ranked.length || ranked[0].score < MIN_MATCH_SCORE) return []
  return ranked.slice(0, max)
}

/** Slug: lowercase, [a-z0-9-], collapsed dashes, trimmed; '' → 'entry'. */
export function slugId(s: string): string {
  const slug = (typeof s === 'string' ? s : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'entry'
}

/** Absolute path of a doc/entrypoint given the entry path ('.' = the entry itself). */
export function resolveDoc(
  entry: CreatorStackEntry,
  rel: string,
  joinPath: (...parts: string[]) => string
): string {
  const r = (typeof rel === 'string' ? rel : '').trim()
  if (!r || r === '.') return entry.path
  if (isAbsolutePath(r)) return r
  return joinPath(entry.path, ...r.split(/[\\/]+/).filter(Boolean))
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const code = (s: string): string => `\`${s}\``

export const CREATOR_STACK_MD_TITLE =
  '# Creator Stack — shared tools & reusable projects (auto-generated by Builder Hub)'
export const CREATOR_STACK_MD_INTRO =
  'Before building a new tool, look here. Each entry lists what it does, where it lives, and the docs to read FIRST.'
export const CREATOR_STACK_GUARDRAIL: readonly string[] = [
  '- You may read and reference any of these freely (paths, docs, entrypoints) from any project.',
  '- Consume shared tools through their documented entrypoints instead of copying their implementation.',
  "- Before modifying another project's or tool's source, say so explicitly and prefer changes in the current project."
]

/**
 * ~/.claude/builder-hub/creator-stack.md — what Claude reads. Per entry: name,
 * aliases, path, kind, docs; per capability: purpose, read-first docs,
 * entrypoints, usage notes, works for. Ends with the cross-project guardrail:
 * read/reference freely; consume through the stable entrypoints; before
 * modifying another project's source, say so explicitly and prefer changes in
 * the current project.
 */
export function renderCreatorStackMarkdown(stack: CreatorStack, generatedOn: string): string {
  const out: string[] = []
  out.push(CREATOR_STACK_MD_TITLE, '')
  out.push(
    `_Generated on ${generatedOn}. Do not edit by hand — Builder Hub regenerates this file from its Creator Stack registry._`,
    ''
  )
  out.push(CREATOR_STACK_MD_INTRO, '')
  const entries = Array.isArray(stack?.entries) ? stack.entries : []
  if (!entries.length) out.push('_No entries yet — add tools in Builder Hub (Settings → Creator Stack)._', '')
  for (const e of entries) {
    out.push(`## ${e.name}`)
    out.push(`- **Kind:** ${e.kind}`)
    out.push(`- **Path:** ${code(e.path)}`)
    if (e.aliases.length) out.push(`- **Aliases:** ${e.aliases.join(', ')}`)
    if (e.docs.length) out.push(`- **Docs:** ${e.docs.map((d) => code(displayPath(e, d))).join(', ')}`)
    if (!e.exists)
      out.push(
        '- **Missing on disk** — the path above was not found; fix or remove the entry in Builder Hub.'
      )
    // Extras after the contract's Kind / Path / Aliases / Docs / Missing sequence.
    if (e.projectId) out.push(`- **Project:** ${e.projectId}`)
    if (e.dependencies?.length) out.push(`- **Depends on:** ${e.dependencies.join(', ')}`)
    if (e.tags?.length) out.push(`- **Tags:** ${e.tags.join(', ')}`)
    for (const c of e.capabilities) {
      out.push('', `### ${c.name} (${code(c.id)})`)
      out.push(`- **Purpose:** ${c.purpose}`)
      const docs = c.docs.length ? c.docs : e.docs
      if (docs.length) out.push(`- **Read first:** ${docs.map((d) => code(displayPath(e, d))).join(', ')}`)
      if (c.entrypoints.length) {
        out.push(`- **Entrypoints:** ${c.entrypoints.map((d) => code(displayPath(e, d))).join('; ')}`)
      }
      if (c.usageNotes) out.push(`- **Notes:** ${c.usageNotes}`)
      if (c.worksFor?.length) out.push(`- **Works for:** ${c.worksFor.join(', ')}`)
      if (c.aliases.length) out.push(`- **Aliases:** ${c.aliases.join(', ')}`)
    }
    out.push('')
  }
  out.push('## Cross-project guardrail', ...CREATOR_STACK_GUARDRAIL, '')
  return out.join('\n')
}

// --- capability card -------------------------------------------------------

/** Hard cap on the injected card (UserPromptSubmit additionalContext). */
export const CAPABILITY_CARD_MAX = CREATOR_STACK_LIMITS.cardChars
export const CAPABILITY_CARD_CLOSING =
  'Use this tool rather than building a new one — adapt it per its README. Reference it freely; if you must change ITS source, say so explicitly first.'

/** Floors the first truncation pass leaves in place so the opening sentence(s)
 *  survive while the bulkier lines (entrypoints, purpose) are trimmed next. */
const NOTES_FLOOR = 140
const PURPOSE_FLOOR = 120
/** Below this a truncated text is worthless — drop the line instead. */
const MIN_KEEP = 24

interface CardParts {
  header: string
  purpose?: string
  docs: string[]
  entrypoints: string[]
  /** entrypoints dropped to fit — surfaced as "(+N more)" */
  omitted: number
  notes?: string
  worksFor?: string
  closing: string
}

type CardTextField = 'notes' | 'purpose'

/** Truncate to at most `total` chars INCLUDING the trailing ellipsis, preferring a word boundary. */
function truncate(s: string, total: number): string {
  if (s.length <= total) return s
  let cut = s.slice(0, Math.max(0, total - 1))
  const sp = cut.lastIndexOf(' ')
  if (sp > cut.length * 0.6) cut = cut.slice(0, sp)
  return cut.trimEnd() + '…'
}

function renderCard(p: CardParts): string {
  const lines = [p.header]
  if (p.purpose) lines.push(`Purpose: ${p.purpose}`)
  lines.push(`Read first (minimum needed): ${p.docs.join('; ')}`)
  if (p.entrypoints.length) {
    const more = p.omitted > 0 ? ` (+${p.omitted} more — see the README)` : ''
    lines.push(`Entrypoints: ${p.entrypoints.join('; ')}${more}`)
  }
  if (p.notes) lines.push(`Notes: ${p.notes}`)
  if (p.worksFor) lines.push(`Works for: ${p.worksFor}`)
  lines.push(p.closing)
  return lines.join('\n')
}

/** Shrink the card to `max` chars. Order: Notes first (down to a floor that
 *  keeps its opening sentence), then trailing entrypoints one at a time, then
 *  Purpose (to a floor), then Notes again (may be dropped), then the remaining
 *  entrypoints, Purpose, Works-for, and finally the docs list; a hard cut is
 *  the last resort. The header and the closing guardrail line are never cut
 *  unless nothing else is left. */
function fitCard(p: CardParts, max: number): string {
  let text = renderCard(p)
  const excess = (): number => text.length - max

  const shrinkText = (field: CardTextField, floor: number): boolean => {
    const cur = p[field]
    if (!cur) return false
    const target = Math.max(floor, cur.length - excess() - 1)
    if (target >= cur.length) return false
    if (target < MIN_KEEP && floor === 0) {
      p[field] = undefined
      return true
    }
    p[field] = truncate(cur, Math.max(target, MIN_KEEP))
    return true
  }
  const popEntrypoint = (): boolean => {
    if (p.entrypoints.length <= 1) return false
    p.entrypoints.pop()
    p.omitted++
    return true
  }
  const dropEntrypoints = (): boolean => {
    if (!p.entrypoints.length) return false
    p.entrypoints = []
    p.omitted = 0
    return true
  }
  const dropWorksFor = (): boolean => {
    if (!p.worksFor) return false
    p.worksFor = undefined
    return true
  }
  const popDoc = (): boolean => {
    if (p.docs.length <= 1) return false
    p.docs.pop()
    return true
  }

  const steps: (() => boolean)[] = [
    () => shrinkText('notes', NOTES_FLOOR),
    popEntrypoint,
    () => shrinkText('purpose', PURPOSE_FLOOR),
    () => shrinkText('notes', 0),
    dropEntrypoints,
    () => shrinkText('purpose', 0),
    dropWorksFor,
    popDoc
  ]

  outer: while (text.length > max) {
    for (const step of steps) {
      if (step()) {
        text = renderCard(p)
        continue outer
      }
    }
    break
  }
  if (text.length > max) text = truncate(text, max)
  return text
}

/** The compact card injected at UserPromptSubmit for one match (≤ ~900 chars):
 *  "Builder Hub: you have an established tool for this — <name> at <path>. Read
 *  first: <docs>. Entrypoints: … Notes: … Use it; do not build a new one." */
export function renderCapabilityCard(
  match: CapabilityMatch,
  joinPath: (...parts: string[]) => string
): string {
  const { entry, capability } = match
  const name = capability?.name ?? entry.name
  // Tolerate a capability that skipped normalizeStack (this runs inside a hook reply — never throw).
  const capDocs = strArray(capability?.docs)
  const entryDocs = strArray(entry.docs)
  const docsRel = capDocs.length ? capDocs : entryDocs.length ? entryDocs : ['.']
  const worksFor = strArray(capability?.worksFor)
  const parts: CardParts = {
    header: `[Builder Hub · Creator Stack] You already have an established tool for this: **${name}** — ${code(entry.path)}`,
    purpose: (typeof capability?.purpose === 'string' && capability.purpose.trim()) || undefined,
    docs: docsRel.map((d) => resolveDoc(entry, d, joinPath)),
    entrypoints: strArray(capability?.entrypoints).map((d) => resolveDoc(entry, d, joinPath)),
    omitted: 0,
    notes: (typeof capability?.usageNotes === 'string' && capability.usageNotes.trim()) || undefined,
    worksFor: worksFor.length ? worksFor.join(', ') : undefined,
    closing: CAPABILITY_CARD_CLOSING
  }
  return fitCard(parts, CAPABILITY_CARD_MAX)
}

/** Convenience for tests/UI: flatten to (entry, capability) pairs. */
export function allCapabilities(
  stack: CreatorStack
): { entry: CreatorStackEntry; capability: CreatorCapability }[] {
  const entries = Array.isArray(stack?.entries) ? stack.entries : []
  return entries.flatMap((entry) => (entry.capabilities ?? []).map((capability) => ({ entry, capability })))
}
