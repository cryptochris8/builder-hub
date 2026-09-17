import { app, ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { writeAtomic } from './fsAtomic'
import { ensureHubStatusLine } from '../shared/sessionLogic'
import type { StatusLineInfo } from '../shared/types'

// Opt-in session telemetry: a Hub-owned `statusLine` in ~/.claude/settings.json
// that pipes Claude's status JSON (model, effort, context %, prompt-cache state,
// rate limits, cost) to the Hub and shows the Hub's one-line reply in Claude's
// own status bar. Off by default — it changes what the user sees in every
// Claude terminal — and it NEVER replaces a status line the Hub did not write.

function settingsPath(): string {
  return join(app.getPath('home'), '.claude', 'settings.json')
}

function readSettings(): string {
  const f = settingsPath()
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

export function statusLineInfo(): StatusLineInfo {
  try {
    const probe = ensureHubStatusLine(readSettings(), true)
    if (probe.error) return { installed: false, foreign: false, error: probe.error }
    // `installed` from a dry run: true when already ours (no change needed) or
    // when we WOULD install — so check the current text directly instead.
    const current = ensureHubStatusLine(readSettings(), false)
    return { installed: current.changed, foreign: probe.foreign }
  } catch (e) {
    return { installed: false, foreign: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * v1.1 startup: keep the Hub's status line installed while the setting is on
 * (the default), so context-aware switching gets Claude Code's exact context
 * figure without Chris remembering any setup. Never replaces a status line the
 * user configured (foreign), never re-adds one after an explicit opt-out, and
 * never throws — without it, switching cost falls back to transcript estimates.
 */
export function ensureStatusLineForSettings(enabled: boolean): StatusLineInfo {
  if (!enabled) return statusLineInfo()
  const info = setStatusLine(true)
  if (info.error && !info.foreign) console.error('[builder-hub] status line not installed:', info.error)
  return info
}

export function registerStatusLineIpc(): void {
  ipcMain.handle('statusline:info', () => statusLineInfo())
  ipcMain.handle('statusline:set', (_e, install: boolean) => setStatusLine(!!install))
}

/** Install (true) or remove (false) the Hub's status line. Atomic write, .bak. */
export function setStatusLine(install: boolean): StatusLineInfo {
  try {
    const current = readSettings()
    const res = ensureHubStatusLine(current, install)
    if (res.error) return { installed: false, foreign: false, error: res.error }
    if (res.foreign)
      return {
        installed: false,
        foreign: true,
        error: 'A status line you configured yourself is in place — the Hub will not replace it.'
      }
    if (res.changed) writeAtomic(settingsPath(), res.next, true)
    return { installed: res.installed, foreign: false }
  } catch (e) {
    return { installed: false, foreign: false, error: e instanceof Error ? e.message : String(e) }
  }
}
