import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { existsSync } from 'fs'
import { spawn } from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { randomUUID } from 'crypto'
import { registryFilePath } from './hubContext'
import type { PtyCreateOptions } from '../shared/types'

interface Session {
  proc: IPty
  wc: WebContents
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
    // On Windows, `cmd /k claude` starts Claude Code and keeps the shell alive after it exits.
    const args = process.platform === 'win32' && opts.runClaude ? ['/k', 'claude'] : []

    // node-pty strips COLUMNS/LINES on Unix but NOT on Windows; a stale value from the
    // launching shell makes child TUIs (claude) latch a wrong width. Drop them so the
    // PTY's real (resizable) size governs.
    const env = { ...process.env }
    delete env.COLUMNS
    delete env.LINES
    // Let anything in the session (Claude especially) know it's running inside the
    // Hub and where the full project registry lives.
    env.BUILDER_HUB = '1'
    env.BUILDER_HUB_PROJECTS = registryFilePath()

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

    sessions.set(id, { proc, wc })
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
