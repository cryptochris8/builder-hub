import { app, ipcMain } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { normalizeSettings } from '../shared/claudeLaunch'
import type { HubSettings, SettingsSaveResult } from '../shared/types'

// App preferences — a second small JSON file in userData, same atomic write pattern
// as db.ts (tmp + rename, keep a .bak). Deliberately separate from projects.json:
// this is machine/app config, not registry data.
//
// SECURITY: settings:set is reachable from the renderer, and claudePermissionMode
// ends up in the `claude` argv. normalizeSettings() is the single choke point — the
// renderer sends a mode STRING that must survive the allowlist, so it can never
// inject a flag. Every read AND every write goes through it.

let cache: HubSettings | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): HubSettings {
  if (cache) return cache
  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    raw = null // missing or corrupt — normalizeSettings falls back to the defaults
  }
  cache = normalizeSettings(raw)
  return cache
}

export function setSettings(patch: Partial<HubSettings>): SettingsSaveResult {
  const next = normalizeSettings({ ...getSettings(), ...patch })
  cache = next // applies to the next session opened, whether or not the write lands
  const f = file()
  try {
    mkdirSync(dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    try {
      if (existsSync(f)) copyFileSync(f, `${f}.bak`)
    } catch {
      /* best-effort backup */
    }
    renameSync(tmp, f) // atomic replace (MoveFileEx on Windows)
  } catch (e) {
    // A settings write must never take the app down — but it must never pass for saved
    // either. If a Bypass→Ask downgrade fails to persist, the next launch would come back
    // up in bypass while the user had been told it was off. Report the failure and let the
    // UI say so; the in-memory value still governs this run.
    console.error('[builder-hub] could not save settings:', e)
    return { ok: false, settings: next, error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, settings: next }
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', (): HubSettings => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<HubSettings>): SettingsSaveResult => setSettings(patch))
}
