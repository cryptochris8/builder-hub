import { execFile } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fingerprintFromScan, firstParagraph } from '../shared/contextLogic'
import type { ProjectScan } from '../shared/contextLogic'
import type { ContextFingerprint } from '../shared/types'

// Deterministic project scan — the "targeted discovery" the spec asks for.
// Reads a handful of well-known files (manifest, README, .env.example, CLAUDE.md)
// and asks git three cheap questions. No model, no recursion into the tree, no
// file contents kept beyond what the context needs (README first paragraph,
// script names, dependency NAMES, env var NAMES).

// Each git call is capped so a SessionStart reply always beats curl's 2 s budget.
const GIT_TIMEOUT_MS = 900
const MAX_DEPS = 60
const MAX_TOP_LEVEL = 60
const MAX_HEADINGS = 20

function readSafe(path: string, cap = 256 * 1024): string | undefined {
  try {
    const size = statSync(path).size
    if (size > cap) return readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, cap)
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function mtime(path: string): number | undefined {
  try {
    return Math.round(statSync(path).mtimeMs)
  } catch {
    return undefined
  }
}

/** One git question, async, bounded; undefined on any failure/timeout. */
function git(dir: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : String(stdout).trim())
    )
  })
}

/** HEAD / branch / dirty count — the three probes run concurrently. */
async function gitFacts(dir: string): Promise<ProjectScan['git'] | undefined> {
  if (!existsSync(join(dir, '.git'))) return undefined
  const [head, branch, porcelain] = await Promise.all([
    git(dir, ['rev-parse', '--short', 'HEAD']),
    git(dir, ['symbolic-ref', '--short', 'HEAD']),
    git(dir, ['status', '--porcelain'])
  ])
  const dirty = porcelain === undefined ? undefined : porcelain === '' ? 0 : porcelain.split('\n').length
  return { head: head || undefined, branch: branch || undefined, dirty }
}

interface Manifest {
  kind: 'npm' | 'pubspec' | 'rojo' | 'unreal' | 'python' | 'none'
  name?: string
  scripts?: Record<string, string>
  deps?: string[]
  file?: string
}

function readManifest(dir: string, entries: string[]): Manifest {
  if (entries.includes('package.json')) {
    const raw = readSafe(join(dir, 'package.json'))
    try {
      const pkg = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const scripts: Record<string, string> = {}
      const s = pkg.scripts
      if (s && typeof s === 'object') {
        for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
          if (typeof v === 'string') scripts[k] = v
        }
      }
      const deps = [
        ...Object.keys((pkg.dependencies as Record<string, unknown>) ?? {}),
        ...Object.keys((pkg.devDependencies as Record<string, unknown>) ?? {})
      ].slice(0, MAX_DEPS)
      return {
        kind: 'npm',
        name: typeof pkg.name === 'string' ? pkg.name : undefined,
        scripts,
        deps,
        file: 'package.json'
      }
    } catch {
      return { kind: 'npm', file: 'package.json' }
    }
  }
  if (entries.includes('pubspec.yaml')) {
    const raw = readSafe(join(dir, 'pubspec.yaml')) ?? ''
    const name = raw.match(/^name:\s*(\S+)/m)?.[1]
    // dependency names = keys indented under "dependencies:" until the next top-level key
    const deps: string[] = []
    const block = raw.match(/^dependencies:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? ''
    for (const line of block.split('\n')) {
      const m = line.match(/^\s{2}([a-zA-Z0-9_]+):/)
      if (m) deps.push(m[1])
    }
    return {
      kind: 'pubspec',
      name,
      deps: deps.slice(0, MAX_DEPS),
      scripts: { run: 'flutter run', test: 'flutter test', build: 'flutter build' },
      file: 'pubspec.yaml'
    }
  }
  if (entries.includes('default.project.json')) {
    const raw = readSafe(join(dir, 'default.project.json'))
    let name: string | undefined
    try {
      name = raw ? (JSON.parse(raw) as { name?: string }).name : undefined
    } catch {
      /* ignore */
    }
    return {
      kind: 'rojo',
      name,
      scripts: { serve: 'rojo serve', build: 'rojo build -o build.rbxl' },
      file: 'default.project.json'
    }
  }
  const uproject = entries.find((e) => e.endsWith('.uproject'))
  if (uproject) return { kind: 'unreal', name: uproject.replace(/\.uproject$/, ''), file: uproject }
  if (entries.includes('pyproject.toml') || entries.includes('requirements.txt')) {
    const file = entries.includes('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt'
    const raw = readSafe(join(dir, file)) ?? ''
    const deps =
      file === 'requirements.txt'
        ? raw
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
            .map((l) => l.split(/[<>=!~[; ]/)[0])
            .filter(Boolean)
        : (raw.match(/^\s*"?([A-Za-z0-9_.-]+)"?\s*[><=~!]/gm) ?? []).map((l) =>
            l.replace(/[^A-Za-z0-9_.-].*$/, '').trim()
          )
    return { kind: 'python', deps: deps.slice(0, MAX_DEPS), scripts: { test: 'pytest' }, file }
  }
  return { kind: 'none' }
}

/** Env var NAMES only — never values. */
function envKeys(dir: string): string[] {
  const raw = readSafe(join(dir, '.env.example'), 64 * 1024)
  if (!raw) return []
  const keys: string[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/)
    if (m && !keys.includes(m[1])) keys.push(m[1])
  }
  return keys.slice(0, 40)
}

function headings(md: string | undefined): string[] {
  if (!md) return []
  return (md.match(/^##\s+.+$/gm) ?? []).map((h) => h.replace(/^##\s+/, '').trim()).slice(0, MAX_HEADINGS)
}

/** Full deterministic scan (used by Reindex). Never throws. */
export async function scanProject(dir: string): Promise<ProjectScan> {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return {}
  }
  const manifest = readManifest(dir, entries)
  const readme = entries.find((e) => /^readme(\.md|\.markdown|\.txt)?$/i.test(e))
  const claudeMd = entries.find((e) => e.toLowerCase() === 'claude.md')
  const scan: ProjectScan = {
    manifest: { kind: manifest.kind, name: manifest.name, scripts: manifest.scripts, deps: manifest.deps },
    readmeFirstParagraph: readme ? firstParagraph(readSafe(join(dir, readme), 64 * 1024) ?? '') : undefined,
    envKeys: envKeys(dir),
    claudeMdHeadings: claudeMd ? headings(readSafe(join(dir, claudeMd), 128 * 1024)) : [],
    topLevel: entries.filter((e) => !['node_modules', '.git'].includes(e)).slice(0, MAX_TOP_LEVEL),
    git: await gitFacts(dir),
    claudeMdMtime: claudeMd ? mtime(join(dir, claudeMd)) : undefined,
    manifestMtime: manifest.file ? mtime(join(dir, manifest.file)) : undefined
  }
  return scan
}

/** Cheap freshness probe (git facts + two mtimes) — run at every SessionStart. */
export async function probeFingerprint(dir: string, now = Date.now()): Promise<ContextFingerprint> {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return { computedAt: now }
  }
  const manifestFile =
    ['package.json', 'pubspec.yaml', 'default.project.json', 'pyproject.toml', 'requirements.txt'].find((f) =>
      entries.includes(f)
    ) ?? entries.find((e) => e.endsWith('.uproject'))
  const claudeMd = entries.find((e) => e.toLowerCase() === 'claude.md')
  return fingerprintFromScan(
    {
      git: await gitFacts(dir),
      claudeMdMtime: claudeMd ? mtime(join(dir, claudeMd)) : undefined,
      manifestMtime: manifestFile ? mtime(join(dir, manifestFile)) : undefined
    },
    now
  )
}
