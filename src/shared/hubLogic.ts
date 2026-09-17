import { normalize, resolve, sep } from 'path'
import { TYPE_META } from './types'
import { compareProjects } from './projectLogic'
import type { FileKind, Project } from './types'

// Pure helpers for the Files pane + the hub-wide Claude context. Imported by the
// MAIN process and tests only (uses node:path — keep out of the renderer).

// ---------- path containment ----------

/** True when `child` is `root` or inside it. Case-insensitive by default (Windows). */
export function isPathInside(child: string, root: string, caseInsensitive = true): boolean {
  const clean = (p: string): string => {
    let n = normalize(resolve(p))
    // strip trailing separators so "C:\a\" === "C:\a"
    while (n.length > 1 && (n.endsWith('\\') || n.endsWith('/'))) n = n.slice(0, -1)
    return caseInsensitive ? n.toLowerCase() : n
  }
  const c = clean(child)
  const r = clean(root)
  return c === r || c.startsWith(r + sep)
}

// ---------- file classification ----------

const EXT_KINDS: Record<string, FileKind> = {
  // images
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  ico: 'image',
  bmp: 'image',
  avif: 'image',
  // video / audio
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  // documents
  pdf: 'pdf',
  // text / code (open in the in-app text viewer)
  txt: 'text',
  md: 'text',
  markdown: 'text',
  json: 'text',
  jsonc: 'text',
  yaml: 'text',
  yml: 'text',
  toml: 'text',
  ini: 'text',
  cfg: 'text',
  conf: 'text',
  env: 'text',
  csv: 'text',
  log: 'text',
  xml: 'text',
  html: 'text',
  htm: 'text',
  css: 'text',
  scss: 'text',
  js: 'text',
  jsx: 'text',
  ts: 'text',
  tsx: 'text',
  mjs: 'text',
  cjs: 'text',
  mts: 'text',
  cts: 'text',
  py: 'text',
  rb: 'text',
  go: 'text',
  rs: 'text',
  java: 'text',
  kt: 'text',
  cs: 'text',
  c: 'text',
  h: 'text',
  cpp: 'text',
  hpp: 'text',
  lua: 'text',
  luau: 'text',
  sql: 'text',
  sh: 'text',
  bash: 'text',
  ps1: 'text',
  bat: 'text',
  cmd: 'text',
  gitignore: 'text',
  gitattributes: 'text',
  editorconfig: 'text',
  prettierrc: 'text',
  vue: 'text',
  svelte: 'text',
  astro: 'text',
  prisma: 'text',
  graphql: 'text',
  proto: 'text'
}

const TEXT_BASENAMES = new Set([
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.env',
  '.env.example',
  '.env.local',
  '.prettierrc',
  '.eslintrc',
  '.npmrc',
  'dockerfile',
  'makefile',
  'license',
  'readme',
  'claude.md',
  'procfile'
])

/** Classify a file by name for the preview pane. Dirs should not be passed here. */
export function classifyFile(name: string): FileKind {
  const lower = name.toLowerCase()
  if (TEXT_BASENAMES.has(lower)) return 'text'
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return 'other'
  return EXT_KINDS[lower.slice(dot + 1)] ?? 'other'
}

// ---------- marked-block upsert (global CLAUDE.md) ----------

/**
 * Replace the region between `start` and `end` markers (inclusive) with `block`,
 * or append `block` at the end when NEITHER marker is present. Never touches
 * anything outside the markers — safe for a hand-curated file. Pure.
 * `block` should itself contain the markers.
 *
 * Fail-safe: if exactly one marker is present (hand-edit damage, partial write),
 * the doc is returned UNCHANGED. Appending in that state would leave an orphaned
 * marker that a later sync pairs with the new block's marker — silently deleting
 * every hand-written line in between. A stale block is recoverable; that isn't.
 */
export function upsertMarkedBlock(doc: string, start: string, end: string, block: string): string {
  const s = doc.indexOf(start)
  const e = doc.indexOf(end, s === -1 ? 0 : s + start.length)
  if (s !== -1 && e !== -1) {
    // A second start marker inside the matched region means we'd be pairing an
    // orphaned start with a LATER block's end — replacing would eat whatever sits
    // between them. Malformed → don't touch.
    if (doc.slice(s + start.length, e).includes(start)) return doc
    return doc.slice(0, s) + block + doc.slice(e + end.length)
  }
  if (s !== -1 || doc.includes(end)) return doc // orphaned marker — leave the file alone
  const base = doc.trimEnd()
  return (base ? base + '\n\n' : '') + block + '\n'
}

// ---------- registry markdown (what Claude reads) ----------

export const HUB_BLOCK_START = '<!-- builder-hub:projects:start -->'
export const HUB_BLOCK_END = '<!-- builder-hub:projects:end -->'

/** The marked block Builder Hub maintains inside ~/.claude/CLAUDE.md. Pure.
 *  `creatorStackPath` / `contextDir` are optional so older callers/tests keep working. */
export function buildGlobalClaudeBlock(
  registryPath: string,
  creatorStackPath?: string,
  contextDir?: string
): string {
  const lines = [
    HUB_BLOCK_START,
    '## All my projects — Builder Hub registry (auto-managed block, do not hand-edit)',
    `- Every project I'm building (name → path · type · stack · status · notes): \`${registryPath}\` — Builder Hub regenerates it whenever the registry changes.`,
    '- When I mention a project by name, resolve it in that file; you may read/reference those folders directly. Hub-embedded terminals also set `BUILDER_HUB_PROJECTS` to that path.'
  ]
  if (creatorStackPath) {
    lines.push(
      `- **Creator Stack** — my reusable tools & related projects (Trailer Factory, Video Factory, agent pack, playbooks, profiles), each with the docs to read FIRST: \`${creatorStackPath}\`. **Before building a new tool, look there and reuse the established one.**`
    )
  }
  if (contextDir) {
    lines.push(
      `- **Project context** — Builder Hub keeps a durable per-project state (purpose, commands, decisions, recent work, key files) in \`${contextDir}\` (\`<projectId>.md\`); embedded sessions get the compact task packet injected at start. Summaries orient; source files are truth.`
    )
    lines.push(
      "- **Cross-project guardrail:** read/reference any registered project or shared tool freely, but before modifying ANOTHER project's source say so explicitly and prefer consuming shared tools through their documented entrypoints."
    )
  }
  lines.push(HUB_BLOCK_END)
  return lines.join('\n')
}

/** The full auto-generated registry file Claude sessions can read. Pure. */
export function buildRegistryMarkdown(projects: Project[], generatedOn: string): string {
  const rows = [...projects].sort(compareProjects)
  const lines: string[] = [
    '# Builder Hub — all of my projects (auto-generated)',
    '',
    `_Generated by Builder Hub on ${generatedOn}. Do not edit — this file is rewritten whenever the registry changes._`,
    '',
    'Every project registered in my Builder Hub, with its folder path. When I refer to a project by name, this is where to resolve it — you may read files from any of these folders when useful (e.g. to compare implementations, reuse code, or check a config).',
    ''
  ]
  for (const p of rows) {
    const label = TYPE_META[p.type]?.label ?? p.type
    // Tolerate hand-edited registries where optional-ish fields were removed.
    const notes = (p.notes ?? '').trim()
    lines.push(`## ${p.name}${p.favorite ? ' ★' : ''} — ${label}`)
    lines.push(`- **Path:** \`${p.path}\``)
    if (p.stack) lines.push(`- **Stack:** ${p.stack}`)
    lines.push(`- **Status:** ${p.status ?? 'active'}`)
    if (p.url) lines.push(`- **URL:** ${p.url}`)
    if (notes) lines.push(`- **Notes:** ${notes.replace(/\r?\n/g, ' · ')}`)
    lines.push('')
  }
  if (rows.length === 0) lines.push('_No projects registered yet._', '')
  return lines.join('\n')
}
