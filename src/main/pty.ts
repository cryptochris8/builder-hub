import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { spawn } from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { randomUUID } from 'crypto'
import type { PtyCreateOptions } from '../shared/types'

interface Session {
  proc: IPty
  wc: WebContents
}

const sessions = new Map<string, Session>()

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || 'bash'
}

export function registerPtyIpc(): void {
  ipcMain.handle('pty:create', (e, opts: PtyCreateOptions): string => {
    const id = randomUUID()
    const wc = e.sender
    const shell = defaultShell()
    // On Windows, `cmd /k claude` starts Claude Code and keeps the shell alive after it exits.
    const args = process.platform === 'win32' && opts.runClaude ? ['/k', 'claude'] : []

    const proc = spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: process.env as { [key: string]: string }
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
