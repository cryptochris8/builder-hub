import type { Project, ProjectPatch, ProjectType } from './types'

// Pure, dependency-free logic (no electron/fs) so it's unit-testable with Vitest.

/** The only fields the renderer is allowed to change. `id` and `path` are NOT
 *  here on purpose — the handoff writer resolves its output path from the
 *  registry, so a renderer that could rewrite `path` could write anywhere. */
export const EDITABLE_FIELDS: (keyof Project)[] = [
  'name',
  'type',
  'stack',
  'url',
  'status',
  'favorite',
  'notes',
  // Focus & health + brief (FounderOS harvest)
  'stage',
  'revenueScore',
  'strategicScore',
  'excitementScore',
  'readinessScore',
  'effortScore',
  'blockers',
  'nextAction',
  'currentFocus',
  'shortDescription',
  'problemSolved',
  'targetAudience',
  'monetizationModel',
  'mvpDefinition'
]

/** Apply an edit to a project, in place. Only whitelisted fields move.
 *  `undefined`/absent leaves a field alone; `null` CLEARS it. Without that
 *  distinction an optional field (stage, a score) could be set but never
 *  unset — "clear" arrived as `undefined`, which is indistinguishable from
 *  "not in this patch", so the old value silently survived. */
export function applyProjectPatch(project: Project, patch: ProjectPatch): Project {
  for (const key of EDITABLE_FIELDS) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (value === undefined) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (value === null) delete (project as any)[key]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else (project as any)[key] = value
  }
  return project
}

/** Turn a display name into a safe folder name; falls back to "new-project". */
export function sanitizeFolder(name: string): string {
  return (
    name
      .trim()
      .replace(/[<>:"/\\|?*]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'new-project'
  )
}

/** Registry sort order: favorites first, then non-archived, then
 *  most-recently-opened, then name. Archived work sinks to the bottom. */
export function compareProjects(a: Project, b: Project): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
  const aArch = a.status === 'archived'
  const bArch = b.status === 'archived'
  if (aArch !== bArch) return aArch ? 1 : -1
  const al = a.lastOpenedAt ?? 0
  const bl = b.lastOpenedAt ?? 0
  if (al !== bl) return bl - al
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

export interface RegistryRecovery {
  rows: Project[]
  /** true when the main file exists but couldn't be parsed (corrupt) — it should be
   *  moved aside before the next write so the data loss isn't made permanent. */
  preserveCorruptMain: boolean
}

/**
 * Decide which registry rows to trust from what could be read off disk. Pure.
 * @param main       parsed projects.json, or null if missing/corrupt/wrong-shape
 * @param mainExists  whether projects.json exists on disk (corrupt vs. fresh install)
 * @param bak        parsed projects.json.bak, or null
 */
export function recoverRegistry(
  main: Project[] | null,
  mainExists: boolean,
  bak: Project[] | null
): RegistryRecovery {
  if (main) return { rows: main, preserveCorruptMain: false }
  if (mainExists) return { rows: bak ?? [], preserveCorruptMain: true } // corrupt main
  return { rows: [], preserveCorruptMain: false } // fresh install
}

const ENV_BY_TYPE: Partial<Record<ProjectType, string[]>> = {
  'web-app': [
    'DATABASE_URL=',
    'STRIPE_SECRET_KEY=',
    'STRIPE_WEBHOOK_SECRET=',
    'RESEND_API_KEY=',
    'SENTRY_DSN='
  ],
  'mobile-app': ['FIREBASE_API_KEY=', 'ADMOB_APP_ID=', 'REVENUECAT_IOS_API_KEY='],
  'ai-content': ['OPENAI_API_KEY=', 'ELEVENLABS_API_KEY=', 'FAL_KEY=', 'RECRAFT_KEY='],
  'crypto-web3': [
    'BASE_RPC_URL=https://mainnet.base.org',
    'SOLANA_RPC_URL=https://api.mainnet-beta.solana.com',
    'COINBASE_API_KEY=',
    'KRAKEN_API_KEY=',
    'NEWS_API_KEY='
  ],
  hytopia: ['ELEVENLABS_API_KEY=', 'MESHY_API_KEY='],
  roblox: ['# ROBLOX_OPEN_CLOUD_KEY and MESHY_API_KEY usually live in Windows env (HKCU:\\Environment)'],
  'static-site': ['# FORMSPREE_ID=']
}

/** Human-readable byte size (Files pane). Pure. */
export function prettyBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

/** The .env.example body for a project type, or null if it needs none. */
export function envExampleFor(type: ProjectType): string | null {
  const lines = ENV_BY_TYPE[type]
  if (!lines || lines.length === 0) return null
  return (
    `# .env.example — copy to .env and fill in. NEVER commit real secrets.\n` +
    `# Never put a secret in a NEXT_PUBLIC_/client var — it ships to users.\n\n` +
    `${lines.join('\n')}\n`
  )
}

// ---------- git status parsing (pure; main runs `git`, these parse its output) ----------

export interface GitWorkingState {
  /** branch name, or undefined when HEAD is detached */
  branch?: string
  detached: boolean
  ahead: number
  behind: number
  /** whether the branch tracks an upstream (so ahead/behind are meaningful) */
  hasUpstream: boolean
  /** count of changed files (staged + unstaged + untracked) */
  dirty: number
}

/**
 * Parse `git status --porcelain=v2 --branch` output. Pure.
 * Header lines start with `# `; every non-header line is one changed/untracked file.
 */
export function parseGitStatusV2(stdout: string): GitWorkingState {
  const state: GitWorkingState = { detached: false, ahead: 0, behind: 0, hasUpstream: false, dirty: 0 }
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      if (head === '(detached)') state.detached = true
      else state.branch = head
    } else if (line.startsWith('# branch.ab ')) {
      state.hasUpstream = true
      const m = line.match(/\+(\d+)\s+-(\d+)/)
      if (m) {
        state.ahead = Number(m[1])
        state.behind = Number(m[2])
      }
    } else if (!line.startsWith('#')) {
      state.dirty++
    }
  }
  return state
}

/** Parse one line of `git log -1 --format=%s%x1f%cr` (subject \x1f relative-time). Pure. */
export function parseLastCommit(stdout: string): { subject: string; relative: string } | null {
  const line = (stdout.split('\n')[0] ?? '').replace(/\r$/, '')
  if (!line) return null
  const [subject, relative] = line.split('\x1f')
  if (!subject) return null
  return { subject, relative: relative ?? '' }
}

interface Pkgish {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** Guess a project's type from its top-level entries + optional package.json. Pure. */
export function detectTypeFromFiles(entries: string[], pkg?: Pkgish): ProjectType {
  if (entries.some((f) => f.endsWith('.uproject'))) return 'unreal'
  if (
    entries.includes('default.project.json') ||
    entries.includes('rokit.toml') ||
    entries.includes('aftman.toml')
  )
    return 'roblox'
  if (entries.includes('pubspec.yaml')) return 'mobile-app'
  if (entries.includes('package.json')) {
    const deps: Record<string, string> = { ...pkg?.dependencies, ...pkg?.devDependencies }
    if (deps['hytopia'] || deps['@hytopia.com/assets']) return 'hytopia'
    if (deps['@capacitor/core']) return 'mobile-app'
    if (deps['ethers'] || deps['@solana/web3.js'] || deps['hardhat']) return 'crypto-web3'
    if (deps['next'] || deps['vite'] || deps['react']) return 'web-app'
    return 'web-app'
  }
  if (entries.includes('index.html')) return 'static-site'
  return 'other'
}
