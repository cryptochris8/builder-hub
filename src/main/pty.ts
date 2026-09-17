import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { existsSync } from 'fs'
import { spawn } from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { randomUUID } from 'crypto'
import { allProjects } from './db'
import { registryFilePath } from './hubContext'
import { getSettings } from './settings'
import { claudeShellArgs, resolvePermissionMode, resolveSessionConfig } from '../shared/claudeLaunch'
import { HUB_HOOK_PORT, normPath, resolveSessionProject } from '../shared/sessionLogic'
import type { ClaudePtyBinding } from '../shared/sessionLogic'
import type { PtyCreateOptions } from '../shared/types'

interface Session {
  proc: IPty
  wc: WebContents
  cwd: string
  /** true for Claude Code sessions (vs. plain shells) */
  runClaude: boolean
  /** the Claude session id this PTY was launched with (--session-id), so the
   *  board can mark it embedded and Apply/Auto can find exactly this PTY; the
   *  orchestrator re-binds it when the same terminal starts a new session (/clear) */
  claudeSessionId?: string
  /** when the PTY was spawned */
  createdAt: number
  /** when the user last typed into this PTY (idle gate for routing applies) */
  lastInputAt: number
}

/** How long the user must have been silent before the Hub types a slash command
 *  into an idle Claude session. Guards against appending to a half-typed prompt. */
const APPLY_IDLE_MS = 2000
/** Delay before the first typed command — lets the Stop hook's reply flush to
 *  curl and Claude return to its prompt before any keystroke arrives. */
const APPLY_LEAD_MS = 400
/** Delay between the two slash commands so Claude processes them one at a time. */
const APPLY_GAP_MS = 700

const sessions = new Map<string, Session>()

// One 'destroyed' listener per webContents, so opening many terminals in a window
// doesn't pile up handlers.
const hookedWc = new WeakSet<WebContents>()

export interface PtyExitInfo {
  cwd: string
  claudeSessionId?: string
}
type ExitListener = (info: PtyExitInfo) => void
const exitListeners: ExitListener[] = []

/** Subscribe to Claude PTY endings (tab closed, worktree removed, process exit) —
 *  the orchestrator uses this to end the matching board record. */
export function onClaudePtyExit(listener: ExitListener): void {
  exitListeners.push(listener)
}

function notifyExit(s: Session): void {
  if (!s.runClaude) return
  for (const l of exitListeners) {
    try {
      l({ cwd: s.cwd, claudeSessionId: s.claudeSessionId })
    } catch {
      /* a listener must never break PTY teardown */
    }
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || 'bash'
}

function killSession(id: string, s: Session): void {
  try {
    s.proc.kill()
  } catch {
    /* already gone */
  }
  sessions.delete(id)
  notifyExit(s)
}

function killSessionsFor(wc: WebContents): void {
  for (const [id, s] of sessions) {
    if (s.wc !== wc) continue
    killSession(id, s)
  }
}

// Kill a window's PTYs when its renderer goes away — window closed, renderer
// crashed, OR the page reloaded/navigated (Ctrl+R / dev full reload): the new
// document has no terminal ids, so surviving processes would be orphans that
// keep running (and keep burning Claude usage) until app quit.
function hookWebContents(wc: WebContents): void {
  if (hookedWc.has(wc)) return
  hookedWc.add(wc)
  wc.once('destroyed', () => killSessionsFor(wc))
  wc.on('render-process-gone', () => killSessionsFor(wc))
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) killSessionsFor(wc)
  })
}

// Kill every live PTY — call on app quit.
export function killAllPtys(): void {
  for (const { proc } of sessions.values()) {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }
  sessions.clear()
}

// Kill every PTY whose cwd is (inside) the given directory. Windows can't delete
// a directory that is any process's cwd, so worktree removal must evict its
// sessions first. The renderer still gets pty:exit via onExit → tab shows ended.
export function killPtysUnder(dir: string): number {
  const root = normPath(dir)
  let killed = 0
  for (const [id, s] of sessions) {
    const cwd = normPath(s.cwd)
    if (cwd !== root && !cwd.startsWith(root + '\\')) continue
    killSession(id, s)
    killed++
  }
  return killed
}

/** normPath(cwd) of every live embedded Claude session — the board's fallback for `embedded`. */
export function embeddedClaudeCwds(): Set<string> {
  const out = new Set<string>()
  for (const s of sessions.values()) if (s.runClaude) out.add(normPath(s.cwd))
  return out
}

/** Claude session ids of every live embedded Claude session (launched with --session-id). */
export function embeddedClaudeSessionIds(): Set<string> {
  const out = new Set<string>()
  for (const s of sessions.values()) if (s.runClaude && s.claudeSessionId) out.add(s.claudeSessionId)
  return out
}

/** Every live Hub Claude PTY with the session id it is bound to — the
 *  orchestrator decides from the board which of them are free to adopt a new
 *  session (see sessionLogic's unclaimedPtyIn). */
export function claudePtyBindings(): ClaudePtyBinding[] {
  const out: ClaudePtyBinding[] = []
  for (const [id, s] of sessions) {
    if (s.runClaude) out.push({ id, cwd: s.cwd, claudeSessionId: s.claudeSessionId, createdAt: s.createdAt })
  }
  return out
}

/** Bind a Hub Claude PTY to a (new) Claude session id — the same terminal after
 *  a /clear, or a `claude` that ignored --session-id. Returns false when the PTY
 *  is gone. */
export function rebindClaudePty(ptyId: string, claudeSessionId: string): boolean {
  const s = sessions.get(ptyId)
  if (!s || !s.runClaude) return false
  s.claudeSessionId = claudeSessionId
  return true
}

/** The one Claude PTY for a board record: by session id first (exact), else by
 *  cwd when exactly one Hub Claude PTY runs there (a `/clear` gives the same PTY a
 *  new session id, so the folder fallback keeps Apply working after one). */
function findClaudePty(target: { sessionId?: string; cwd: string }): Session | undefined {
  if (target.sessionId) {
    const byId = [...sessions.values()].find((x) => x.runClaude && x.claudeSessionId === target.sessionId)
    if (byId) return byId
  }
  const key = normPath(target.cwd)
  const byCwd = [...sessions.values()].filter((x) => x.runClaude && normPath(x.cwd) === key)
  return byCwd.length === 1 ? byCwd[0] : undefined
}

/**
 * Apply a routing recommendation to an embedded Claude session by typing the
 * documented slash commands (`/model <alias>`, `/effort <level>`) followed by
 * Enter — exactly what the user would type. This is the best SUPPORTED
 * approximation of programmatic switching (there is no API to change a running
 * session's model), so it is gated hard: only a Claude PTY, only when the user
 * has not typed for APPLY_IDLE_MS, and the caller (orchestrator) only calls it
 * for sessions whose last hook state is idle. Commands come from
 * slashCommandsFor() — allowlisted model/effort values, never free text.
 *
 * `opts.noInputSince`: refuse if the user typed ANYTHING after that time. Silence
 * alone is not proof that Claude's input box is empty — a prompt typed during the
 * turn and left for a few seconds is still sitting there, and Enter would submit
 * "<draft>/model haiku". The unattended (auto) path passes the timestamp of the
 * prompt that started the turn, so only a box untouched since then is typed into;
 * the manual Apply button keeps the looser idle gate (the user is looking at it).
 */
export function applyRecommendationToPty(
  target: { sessionId?: string; cwd: string },
  commands: string[],
  opts: { noInputSince?: number } = {}
): { ok: boolean; error?: string } {
  const s = findClaudePty(target)
  if (!s) return { ok: false, error: 'No embedded Claude session for that folder' }
  if (!commands.every((c) => /^\/(model|effort) [a-z]+$/.test(c))) {
    return { ok: false, error: 'Refusing non-allowlisted command' }
  }
  if (Date.now() - s.lastInputAt < APPLY_IDLE_MS)
    return { ok: false, error: 'You are typing — try again in a moment' }
  if (opts.noInputSince !== undefined && s.lastInputAt > opts.noInputSince)
    return { ok: false, error: 'Something was typed since the last prompt — not touching the input box' }
  commands.forEach((c, i) => {
    setTimeout(
      () => {
        try {
          s.proc.write(c + '\r')
        } catch {
          /* session died between the check and the write */
        }
      },
      APPLY_LEAD_MS + i * APPLY_GAP_MS
    )
  })
  return { ok: true }
}

export function registerPtyIpc(): void {
  ipcMain.handle('pty:create', (e, opts: PtyCreateOptions): string => {
    // node-pty throws opaquely (e.g. "error code: 267") when the cwd is gone —
    // registry entries can outlive their folders, so fail with a readable message.
    if (!existsSync(opts.cwd)) {
      throw new Error(`Folder not found: ${opts.cwd}`)
    }
    const id = randomUUID()
    const wc = e.sender
    hookWebContents(wc)
    const shell = defaultShell()
    // On Windows, `cmd /k claude` starts Claude Code and keeps the shell alive after
    // it exits. The permission mode AND the session profile (model/effort) are
    // resolved HERE, in main — the renderer only says "run Claude", never what flags
    // to pass (see claudeLaunch). Profile chain: task override → project → global.
    // Permission mode: per-project override → global default. The Claude session id
    // is minted here too (--session-id), so the board knows this PTY's session.
    const settings = getSettings()
    const { project, task } = resolveSessionProject(opts.cwd, allProjects())
    const claudeSessionId = opts.runClaude ? randomUUID() : undefined
    const args = claudeShellArgs(process.platform, {
      runClaude: opts.runClaude,
      mode: resolvePermissionMode(project, settings),
      session: resolveSessionConfig(project, task, settings),
      sessionId: claudeSessionId
    })

    // node-pty strips COLUMNS/LINES on Unix but NOT on Windows; a stale value from the
    // launching shell makes child TUIs (claude) latch a wrong width. Drop them so the
    // PTY's real (resizable) size governs.
    const env = { ...process.env }
    delete env.COLUMNS
    delete env.LINES
    // Let anything in the session (Claude especially) know it's running inside the
    // Hub, where the full project registry lives, and where hook posts should go.
    env.BUILDER_HUB = '1'
    env.BUILDER_HUB_PROJECTS = registryFilePath()
    env.BUILDER_HUB_PORT = String(HUB_HOOK_PORT)

    const proc = spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: env as { [key: string]: string }
    })

    const session: Session = {
      proc,
      wc,
      cwd: opts.cwd,
      runClaude: !!opts.runClaude,
      claudeSessionId,
      createdAt: Date.now(),
      lastInputAt: 0
    }

    proc.onData((data) => {
      if (!wc.isDestroyed()) wc.send('pty:data', { id, data })
    })
    proc.onExit(({ exitCode }) => {
      if (!wc.isDestroyed()) wc.send('pty:exit', { id, exitCode })
      if (sessions.delete(id)) notifyExit(session)
    })

    sessions.set(id, session)
    return id
  })

  ipcMain.on('pty:input', (_e, { id, data }: { id: string; data: string }) => {
    const s = sessions.get(id)
    if (!s) return
    s.lastInputAt = Date.now()
    s.proc.write(data)
  })

  ipcMain.on('pty:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    try {
      sessions.get(id)?.proc.resize(cols, rows)
    } catch {
      /* a resize on a dead pty can throw — ignore */
    }
  })

  ipcMain.on('pty:kill', (_e, id: string) => {
    const s = sessions.get(id)
    if (s) killSession(id, s)
  })
}
