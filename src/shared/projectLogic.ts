import type { Project, ProjectType } from './types'

// Pure, dependency-free logic (no electron/fs) so it's unit-testable with Vitest.

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

/** Registry sort order: favorites first, then most-recently-opened, then name. */
export function compareProjects(a: Project, b: Project): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
  const al = a.lastOpenedAt ?? 0
  const bl = b.lastOpenedAt ?? 0
  if (al !== bl) return bl - al
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

const ENV_BY_TYPE: Partial<Record<ProjectType, string[]>> = {
  'web-app': ['DATABASE_URL=', 'STRIPE_SECRET_KEY=', 'STRIPE_WEBHOOK_SECRET=', 'RESEND_API_KEY=', 'SENTRY_DSN='],
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
