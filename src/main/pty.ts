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
import type { PtyCreateOptions } from '../shared/types'

interface Session {
  proc: IPty
  wc: WebContents
  cwd: string
}

const sessions = new Map<string, Session>()

// One 'destroyed' listener per webContents, so opening many terminals in a window
// doesn't pile up handlers.
const hookedWc = new WeakSet<WebContents>()

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || 'bash'
}

function killSessionsFor(wc: WebContents): void {
  for (const [id, s] of sessions) {
    if (s.wc !== wc) continue
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
    sessions.delete(id)
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
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
    sessions.delete(id)
    killed++
  }
  return killed
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
    // Permission mode: per-project override → global default.
    const settings = getSettings()
    const { project, task } = resolveSessionProject(opts.cwd, allProjects())
    const args = claudeShellArgs(process.platform, {
      runClaude: opts.runClaude,
      mode: resolvePermissionMode(project, settings),
      session: resolveSessionConfig(project, task, settings)
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

    proc.onData((data) => {
      if (!wc.isDestroyed()) wc.send('pty:data', { id, data })
    })
    proc.onExit(({ exitCode }) => {
      if (!wc.isDestroyed()) wc.send('pty:exit', { id, exitCode })
      sessions.delete(id)
    })

    sessions.set(id, { proc, wc, cwd: opts.cwd })
    return id
  })

  ipcMain.on('pty:input', (_e, { id, data }: { id: string; data: string }) => {
    sessions.get(id)?.proc.write(data)
  })

  ipcMain.on('pty:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    try {
      sessions.get(id)?.proc.resize(cols, rows)
    } catch {
      /* a resize on a dead pty can throw — ignore */
    }
  })

  ipcMain.on('pty:kill', (_e, id: string) => {
    sessions.get(id)?.proc.kill()
    sessions.delete(id)
  })
}
