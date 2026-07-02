import { app, shell, dialog, ipcMain } from 'electron'
import { spawn, execSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import { allProjects, persist } from './db'
import { SEED_PROJECTS } from './seed-projects'
import { TYPE_META } from '../shared/types'
import { compareProjects, detectTypeFromFiles, envExampleFor, sanitizeFolder } from '../shared/projectLogic'
import type {
  CreateProjectOptions,
  CreateProjectResult,
  LaunchResult,
  Project,
  ProjectType,
  RescanResult
} from '../shared/types'

// ---------- queries ----------
export function listProjects(): Project[] {
  return [...allProjects()].sort(compareProjects)
}

function getById(id: string): Project | null {
  return allProjects().find((p) => p.id === id) ?? null
}

function getByPath(path: string): Project | null {
  const lc = path.toLowerCase()
  return allProjects().find((p) => p.path.toLowerCase() === lc) ?? null
}

interface NewProject {
  name: string
  path: string
  type: ProjectType
  stack: string
}

function insert(p: NewProject): Project {
  const existing = getByPath(p.path)
  if (existing) return existing
  const now = Date.now()
  const project: Project = {
    id: randomUUID(),
    name: p.name,
    path: p.path,
    type: p.type,
    stack: p.stack,
    status: 'active',
    favorite: false,
    notes: '',
    lastOpenedAt: null,
    createdAt: now,
    updatedAt: now
  }
  const rows = allProjects()
  rows.push(project)
  persist(rows)
  return project
}

const EDITABLE: (keyof Project)[] = ['name', 'type', 'stack', 'url', 'status', 'favorite', 'notes']

export function updateProject(id: string, patch: Partial<Project>): Project | null {
  const rows = allProjects()
  const project = rows.find((p) => p.id === id)
  if (!project) return null
  for (const key of EDITABLE) {
    if (key in patch && patch[key] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(project as any)[key] = patch[key]
    }
  }
  project.updatedAt = Date.now()
  persist(rows)
  return project
}

function removeProject(id: string): void {
  persist(allProjects().filter((p) => p.id !== id))
}

function touchOpened(path: string): void {
  const project = getByPath(path)
  if (project) {
    project.lastOpenedAt = Date.now()
    persist(allProjects())
  }
}

// Mark a project opened by id (used when launching the embedded Claude session).
function touchOpenedById(id: string): Project | null {
  const rows = allProjects()
  const project = rows.find((p) => p.id === id)
  if (!project) return null
  project.lastOpenedAt = Date.now()
  persist(rows)
  return project
}

// ---------- type detection ----------
function hasFile(dir: string, file: string): boolean {
  return existsSync(join(dir, file))
}

function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function listDirentsSafe(dir: string): import('fs').Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function detectType(dir: string): ProjectType {
  const entries = listDirSafe(dir)
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined
  if (entries.includes('package.json')) {
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      /* ignore malformed package.json */
    }
  }
  return detectTypeFromFiles(entries, pkg)
}

function looksLikeProject(dir: string): boolean {
  if (
    hasFile(dir, '.git') ||
    hasFile(dir, 'package.json') ||
    hasFile(dir, 'default.project.json') ||
    hasFile(dir, 'rokit.toml') ||
    hasFile(dir, 'aftman.toml') ||
    hasFile(dir, 'pubspec.yaml') ||
    hasFile(dir, 'index.html')
  )
    return true
  return listDirSafe(dir).some((f) => f.endsWith('.uproject'))
}

// ---------- seeding & scanning ----------
export function seedIfEmpty(): void {
  if (allProjects().length > 0) return
  const home = app.getPath('home')
  for (const s of SEED_PROJECTS) {
    const dir = join(home, ...s.dir.split('/'))
    if (existsSync(dir)) insert({ name: s.name, path: dir, type: s.type, stack: s.stack })
  }
}

const SKIP_DIRS = new Set([
  'node_modules',
  'AppData',
  'OneDrive',
  'Documents',
  'Downloads',
  'Pictures',
  'Music',
  'Videos',
  'Saved Games',
  'Searches',
  'Contacts',
  'Links',
  'Favorites',
  'Application Data',
  'Local Settings',
  'My Documents',
  'NetHood',
  'PrintHood',
  'Recent',
  'SendTo',
  'Start Menu',
  'Templates',
  'Cookies'
])

// Scan the home dir for project folders. Adds one level of nesting: a top-level
// folder that is itself a project is registered directly; a grouping folder that
// is NOT a project (e.g. New-apps/, App-store/) has its immediate children
// scanned so nested projects aren't missed. Never descends deeper than that, and
// never into a real project's internals.
function rescan(): RescanResult {
  const home = app.getPath('home')
  const known = new Set(allProjects().map((p) => p.path.toLowerCase()))
  let scanned = 0
  let added = 0

  const skip = (name: string): boolean => name.startsWith('.') || SKIP_DIRS.has(name)
  const consider = (dir: string, name: string): void => {
    scanned++
    if (known.has(dir.toLowerCase())) return
    insert({ name, path: dir, type: detectType(dir), stack: '' })
    known.add(dir.toLowerCase())
    added++
  }

  for (const d of listDirentsSafe(home)) {
    if (!d.isDirectory() || skip(d.name)) continue
    const dir = join(home, d.name)
    if (looksLikeProject(dir)) {
      consider(dir, d.name)
    } else {
      // Grouping folder — look one level in for nested projects.
      for (const c of listDirentsSafe(dir)) {
        if (!c.isDirectory() || skip(c.name)) continue
        const child = join(dir, c.name)
        if (looksLikeProject(child)) consider(child, c.name)
      }
    }
  }
  return { scanned, added }
}

async function addFromDialog(): Promise<Project | null> {
  const res = await dialog.showOpenDialog({
    title: 'Add a project folder',
    properties: ['openDirectory']
  })
  const dir = res.filePaths[0]
  if (res.canceled || !dir) return null
  return getByPath(dir) ?? insert({ name: basename(dir), path: dir, type: detectType(dir), stack: '' })
}

// ---------- new project scaffolding ----------
function readProfile(type: ProjectType): string | null {
  const profile = TYPE_META[type].profile
  if (!profile) return null
  try {
    return readFileSync(join(app.getPath('home'), '.claude', 'stack-profiles', profile), 'utf8')
  } catch {
    return null
  }
}

// The CLAUDE.md a project gets so its Claude session knows the whole toolbox +
// the focused stack for its type. Points at TOOL-STACK.md and inlines the profile.
function buildProjectClaudeMd(
  name: string,
  type: ProjectType,
  stack: string | undefined,
  fresh: boolean
): string {
  const profile = readProfile(type)
  const home = app.getPath('home')
  const today = new Date().toISOString().slice(0, 10)
  const closing = fresh
    ? 'Fresh scaffold — nothing built yet. Ask Claude to set up the starter for this stack, then build from there.'
    : 'Existing project, opened via Builder Hub. Work within the stack above; check TOOL-STACK.md for anything else available.'
  return (
    `# ${name}\n\n` +
    `${TYPE_META[type].label} project.${stack ? ` Stack: ${stack}.` : ''} _(stack context wired by Builder Hub, ${today})_\n\n` +
    `_Claude Code reads this file automatically._\n\n` +
    `## Tools & stacks available to me\n` +
    `- **Full tool catalog** — every tool / service / API / app I use, with versions and where each API key lives: \`${join(home, 'TOOL-STACK.md')}\`. Read it before choosing a tool or scoping work, and **prefer tools I already have**.\n` +
    `- **Stack profiles** — focused tool set + conventions per project type: \`${join(home, '.claude', 'stack-profiles')}\`.\n` +
    `- **All my other projects** — the Builder Hub registry (name → path · type · stack · notes): \`${join(home, '.claude', 'builder-hub-projects.md')}\` (auto-managed). When I mention another project, resolve it there — you may read those folders directly.\n` +
    `- This project's type is **${TYPE_META[type].label}**${profile ? ' — its profile is inlined below.' : '.'}\n` +
    (profile ? `\n---\n\n${profile.trim()}\n\n---\n` : '') +
    `\n## This project\n${closing}\n`
  )
}

// Seed a project-level CLAUDE.md if one doesn't already exist (never overwrite the user's).
function ensureStackAware(id: string): { seeded: boolean } {
  const project = getById(id)
  if (!project) return { seeded: false }
  const claudePath = join(project.path, 'CLAUDE.md')
  if (existsSync(claudePath)) return { seeded: false }
  try {
    writeFileSync(claudePath, buildProjectClaudeMd(project.name, project.type, project.stack, false), 'utf8')
    return { seeded: true }
  } catch {
    return { seeded: false }
  }
}

function createProject(opts: CreateProjectOptions): CreateProjectResult {
  try {
    const folder = sanitizeFolder(opts.name)
    const dir = join(opts.parentDir, folder)
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      return { ok: false, error: `A non-empty folder already exists:\n${dir}` }
    }
    mkdirSync(dir, { recursive: true })

    writeFileSync(
      join(dir, 'CLAUDE.md'),
      buildProjectClaudeMd(opts.name, opts.type, opts.stack, true),
      'utf8'
    )
    writeFileSync(
      join(dir, 'README.md'),
      `# ${opts.name}\n\n${TYPE_META[opts.type].label} project.${opts.stack ? ` Stack: ${opts.stack}.` : ''}\n\nScaffolded with Builder Hub.\n`,
      'utf8'
    )
    writeFileSync(
      join(dir, '.gitignore'),
      `node_modules\ndist\nout\nbuild\n.env\n.env.local\n*.log\n.DS_Store\n`,
      'utf8'
    )
    const env = envExampleFor(opts.type)
    if (env) writeFileSync(join(dir, '.env.example'), env, 'utf8')

    if (opts.initGit) {
      try {
        execSync('git init', { cwd: dir, stdio: 'ignore' })
      } catch {
        /* git not available — skip */
      }
    }

    const project = insert({ name: opts.name, path: dir, type: opts.type, stack: opts.stack ?? '' })
    return { ok: true, project }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function pickDirectory(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    title: 'Choose parent folder',
    properties: ['openDirectory']
  })
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
}

// ---------- launchers ----------
function quote(p: string): string {
  return `"${p.replace(/"/g, '')}"`
}

function spawnDetached(commandLine: string): LaunchResult {
  try {
    const child = spawn(commandLine, { shell: true, detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

let memoEditor: string | null | undefined
function resolveEditor(): string | null {
  if (memoEditor !== undefined) return memoEditor
  for (const cmd of ['cursor', 'code']) {
    try {
      execSync(`where ${cmd}`, { stdio: 'ignore' })
      return (memoEditor = cmd)
    } catch {
      /* not found, try next */
    }
  }
  return (memoEditor = null)
}

let memoWt: boolean | undefined
function hasWindowsTerminal(): boolean {
  if (memoWt !== undefined) return memoWt
  try {
    execSync('where wt', { stdio: 'ignore' })
    return (memoWt = true)
  } catch {
    return (memoWt = false)
  }
}

async function launchFolder(path: string): Promise<LaunchResult> {
  const err = await shell.openPath(path)
  return err ? { ok: false, error: err } : { ok: true }
}

function launchEditor(path: string): LaunchResult {
  const editor = resolveEditor()
  if (!editor) return { ok: false, error: 'No Cursor/VS Code CLI found on PATH' }
  const res = spawnDetached(`${editor} ${quote(path)}`)
  if (res.ok) touchOpened(path)
  return res
}

function launchTerminal(path: string): LaunchResult {
  const cmd = hasWindowsTerminal() ? `wt -d ${quote(path)}` : `start "" cmd /k cd /d ${quote(path)}`
  return spawnDetached(cmd)
}

function launchClaude(path: string): LaunchResult {
  // Interim external launch (the Hub normally embeds Claude via xterm + node-pty).
  // Both branches quote the path (`start /d` sets the working dir) so it survives
  // spaces and special characters.
  const cmd = hasWindowsTerminal()
    ? `wt -d ${quote(path)} cmd /k claude`
    : `start "" /d ${quote(path)} cmd /k claude`
  const res = spawnDetached(cmd)
  if (res.ok) touchOpened(path)
  return res
}

function findChrome(): string | null {
  const candidates = [
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    join(app.getPath('home'), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

async function launchChrome(url: string): Promise<LaunchResult> {
  const safe = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`
  const chrome = findChrome()
  if (chrome) {
    try {
      spawn(chrome, [safe], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  await shell.openExternal(safe) // fall back to the default browser
  return { ok: true }
}

function findRobloxStudio(): string | null {
  const versions = join(app.getPath('home'), 'AppData', 'Local', 'Roblox', 'Versions')
  try {
    for (const d of readdirSync(versions)) {
      const exe = join(versions, d, 'RobloxStudioBeta.exe')
      if (existsSync(exe)) return exe
    }
  } catch {
    /* not installed at the default location */
  }
  return null
}

function launchStudio(): LaunchResult {
  const exe = findRobloxStudio()
  if (!exe) return { ok: false, error: 'Roblox Studio not found (RobloxStudioBeta.exe)' }
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Launch a published game in the native Roblox Player via a roblox:// deep link.
async function launchRobloxPlay(input: string): Promise<LaunchResult> {
  const s = (input ?? '').trim()
  if (!s) {
    return { ok: false, error: "Add this game's Roblox URL (or place ID) in the project's URL field first." }
  }
  let deepLink: string
  if (s.startsWith('roblox://')) {
    deepLink = s
  } else {
    const m = s.match(/(?:games|places?)\/(\d+)/i) ?? s.match(/^(\d+)$/)
    if (!m) {
      return {
        ok: false,
        error: "Couldn't find a place ID — use the game's roblox.com URL or its numeric place ID."
      }
    }
    deepLink = `roblox://experiences/start?placeId=${m[1]}`
  }
  try {
    await shell.openExternal(deepLink)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- IPC ----------
export function registerProjectIpc(): void {
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:add', () => addFromDialog())
  ipcMain.handle('projects:update', (_e, id: string, patch: Partial<Project>) => updateProject(id, patch))
  ipcMain.handle('projects:remove', (_e, id: string) => {
    removeProject(id)
    return true
  })
  ipcMain.handle('projects:rescan', () => rescan())
  ipcMain.handle('projects:create', (_e, opts: CreateProjectOptions) => createProject(opts))
  ipcMain.handle('projects:ensureContext', (_e, id: string) => ensureStackAware(id))
  ipcMain.handle('projects:touch', (_e, id: string) => touchOpenedById(id))
  // System helpers used by the New Project modal (Browse… + default location).
  ipcMain.handle('dialog:pickDirectory', () => pickDirectory())
  ipcMain.handle('system:homeDir', () => app.getPath('home'))
  ipcMain.handle('launch:folder', (_e, path: string) => launchFolder(path))
  ipcMain.handle('launch:editor', (_e, path: string) => launchEditor(path))
  ipcMain.handle('launch:terminal', (_e, path: string) => launchTerminal(path))
  ipcMain.handle('launch:claude', (_e, path: string) => launchClaude(path))
  ipcMain.handle('launch:chrome', (_e, url: string) => launchChrome(url))
  ipcMain.handle('launch:studio', () => launchStudio())
  ipcMain.handle('launch:roblox', (_e, input: string) => launchRobloxPlay(input))
}
