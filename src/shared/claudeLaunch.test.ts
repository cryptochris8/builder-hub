import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS,
  PERMISSION_MODE_META,
  PROFILE_META,
  PROFILE_PRESETS,
  claudeArgs,
  claudeShellArgs,
  isPermissionMode,
  normalizeSessionConfig,
  normalizeSettings,
  resolveSessionConfig,
  sessionArgs,
  suggestProfile
} from './claudeLaunch'
import { CLAUDE_PERMISSION_MODES, SESSION_PROFILES } from './types'
import type { HubSettings, Project, SessionConfig } from './types'

describe('claudeArgs', () => {
  it('passes no flag in default mode — Claude asks as usual', () => {
    expect(claudeArgs('default')).toEqual([])
  })
  it('maps acceptEdits to --permission-mode acceptEdits', () => {
    expect(claudeArgs('acceptEdits')).toEqual(['--permission-mode', 'acceptEdits'])
  })
  it('maps bypassPermissions to the canonical --dangerously-skip-permissions', () => {
    expect(claudeArgs('bypassPermissions')).toEqual(['--dangerously-skip-permissions'])
  })
  it('only ever emits allowlisted flags (no user input can reach argv)', () => {
    for (const mode of CLAUDE_PERMISSION_MODES) {
      for (const a of claudeArgs(mode)) {
        expect(['--permission-mode', 'acceptEdits', '--dangerously-skip-permissions']).toContain(a)
      }
    }
  })
})

describe('claudeShellArgs', () => {
  it('builds `cmd /k claude` + the mode flags on Windows', () => {
    expect(claudeShellArgs('win32', { runClaude: true, mode: 'default' })).toEqual(['/k', 'claude'])
    expect(claudeShellArgs('win32', { runClaude: true, mode: 'acceptEdits' })).toEqual([
      '/k',
      'claude',
      '--permission-mode',
      'acceptEdits'
    ])
    expect(claudeShellArgs('win32', { runClaude: true, mode: 'bypassPermissions' })).toEqual([
      '/k',
      'claude',
      '--dangerously-skip-permissions'
    ])
  })
  it('defaults to the safe mode when none is given', () => {
    expect(claudeShellArgs('win32', { runClaude: true })).toEqual(['/k', 'claude'])
  })
  it('returns [] for a plain shell tab (runClaude falsy), whatever the mode', () => {
    expect(claudeShellArgs('win32', { runClaude: false, mode: 'bypassPermissions' })).toEqual([])
    expect(claudeShellArgs('win32', { mode: 'bypassPermissions' })).toEqual([])
  })
  it('returns [] off Windows — non-Windows opens a plain shell, no auto-launch', () => {
    expect(claudeShellArgs('darwin', { runClaude: true, mode: 'bypassPermissions' })).toEqual([])
    expect(claudeShellArgs('linux', { runClaude: true, mode: 'acceptEdits' })).toEqual([])
  })
})

describe('isPermissionMode', () => {
  it('accepts exactly the three modes', () => {
    expect(isPermissionMode('default')).toBe(true)
    expect(isPermissionMode('acceptEdits')).toBe(true)
    expect(isPermissionMode('bypassPermissions')).toBe(true)
  })
  it('rejects everything else', () => {
    expect(isPermissionMode('plan')).toBe(false) // a real CLI mode, but not one we expose
    expect(isPermissionMode('--dangerously-skip-permissions')).toBe(false)
    expect(isPermissionMode('')).toBe(false)
    expect(isPermissionMode(null)).toBe(false)
    expect(isPermissionMode(undefined)).toBe(false)
    expect(isPermissionMode(1)).toBe(false)
    expect(isPermissionMode({ claudePermissionMode: 'default' })).toBe(false)
  })
})

describe('normalizeSettings', () => {
  it('falls back to the safe default for missing/garbage input', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('bypassPermissions')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings([])).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })
  it('drops an unknown mode rather than passing it through to argv', () => {
    expect(normalizeSettings({ claudePermissionMode: 'yolo' })).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ claudePermissionMode: '--exec evil' })).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ claudePermissionMode: ['bypassPermissions'] })).toEqual(DEFAULT_SETTINGS)
  })
  it('keeps a valid mode and strips unknown keys', () => {
    expect(normalizeSettings({ claudePermissionMode: 'bypassPermissions' })).toEqual({
      claudePermissionMode: 'bypassPermissions',
      defaultSessionProfile: { profile: 'standard' }
    })
    expect(normalizeSettings({ claudePermissionMode: 'acceptEdits', extra: 'ignored' })).toEqual({
      claudePermissionMode: 'acceptEdits',
      defaultSessionProfile: { profile: 'standard' }
    })
  })
  it('fills defaultSessionProfile for a legacy settings.json that predates it', () => {
    expect(normalizeSettings({ claudePermissionMode: 'acceptEdits' }).defaultSessionProfile).toEqual({
      profile: 'standard'
    })
  })
  it('keeps a valid stored session profile and drops a garbage one', () => {
    expect(normalizeSettings({ defaultSessionProfile: { profile: 'light' } }).defaultSessionProfile).toEqual({
      profile: 'light'
    })
    expect(normalizeSettings({ defaultSessionProfile: { profile: 'yolo' } }).defaultSessionProfile).toEqual({
      profile: 'standard'
    })
  })
  it('returns a fresh object — callers must not be able to mutate DEFAULT_SETTINGS', () => {
    const s = normalizeSettings(null)
    s.claudePermissionMode = 'bypassPermissions'
    expect(DEFAULT_SETTINGS.claudePermissionMode).toBe('default')
  })
})

describe('PERMISSION_MODE_META', () => {
  it('describes every mode, and marks only Bypass as dangerous', () => {
    for (const mode of CLAUDE_PERMISSION_MODES) {
      expect(PERMISSION_MODE_META[mode].label).toBeTruthy()
      expect(PERMISSION_MODE_META[mode].blurb).toBeTruthy()
    }
    expect(PERMISSION_MODE_META.bypassPermissions.danger).toBe(true)
    expect(PERMISSION_MODE_META.default.danger).toBeUndefined()
    expect(PERMISSION_MODE_META.acceptEdits.danger).toBeUndefined()
  })
})

// ---------- session profiles ----------

describe('normalizeSessionConfig', () => {
  it('returns undefined for missing/garbage shapes (= inherit)', () => {
    expect(normalizeSessionConfig(undefined)).toBeUndefined()
    expect(normalizeSessionConfig(null)).toBeUndefined()
    expect(normalizeSessionConfig('deep')).toBeUndefined()
    expect(normalizeSessionConfig(['deep'])).toBeUndefined()
    expect(normalizeSessionConfig({})).toBeUndefined()
    expect(normalizeSessionConfig({ profile: 'yolo' })).toBeUndefined()
  })
  it('keeps a named profile and IGNORES stray model/effort on it', () => {
    expect(normalizeSessionConfig({ profile: 'deep', model: 'haiku', effort: 'low' })).toEqual({
      profile: 'deep'
    })
  })
  it('keeps valid custom model/effort and drops unrecognized values', () => {
    expect(normalizeSessionConfig({ profile: 'custom', model: 'sonnet', effort: 'xhigh' })).toEqual({
      profile: 'custom',
      model: 'sonnet',
      effort: 'xhigh'
    })
    expect(normalizeSessionConfig({ profile: 'custom', model: 'gpt-5', effort: 'ultra' })).toEqual({
      profile: 'custom'
    })
    expect(normalizeSessionConfig({ profile: 'custom', model: 'opus' })).toEqual({
      profile: 'custom',
      model: 'opus'
    })
  })
})

describe('sessionArgs', () => {
  it('passes nothing for standard / missing config', () => {
    expect(sessionArgs(undefined)).toEqual([])
    expect(sessionArgs({ profile: 'standard' })).toEqual([])
  })
  it('maps the named presets to their model + effort flags', () => {
    expect(sessionArgs({ profile: 'deep' })).toEqual(['--model', 'opus', '--effort', 'high'])
    expect(sessionArgs({ profile: 'light' })).toEqual(['--model', 'haiku', '--effort', 'low'])
  })
  it('maps a custom config, tolerating a partial one', () => {
    expect(sessionArgs({ profile: 'custom', model: 'sonnet', effort: 'max' })).toEqual([
      '--model',
      'sonnet',
      '--effort',
      'max'
    ])
    expect(sessionArgs({ profile: 'custom', effort: 'medium' })).toEqual(['--effort', 'medium'])
    expect(sessionArgs({ profile: 'custom' })).toEqual([])
  })
  it('re-validates internally — an un-normalized/garbage config cannot inject argv', () => {
    expect(sessionArgs({ profile: 'custom', model: '--exec evil' } as unknown as SessionConfig)).toEqual([])
    expect(sessionArgs({ profile: 'pwn' } as unknown as SessionConfig)).toEqual([])
  })
})

describe('resolveSessionConfig', () => {
  const settings: HubSettings = {
    claudePermissionMode: 'default',
    defaultSessionProfile: { profile: 'standard' }
  }
  const project = {
    sessionProfile: { profile: 'deep' },
    taskProfiles: { 'fix-login': { profile: 'light' }, bad: { profile: 'yolo' } }
  } as unknown as Project

  it('prefers task override, then project, then the global default', () => {
    expect(resolveSessionConfig(project, 'fix-login', settings)).toEqual({ profile: 'light' })
    expect(resolveSessionConfig(project, 'other-task', settings)).toEqual({ profile: 'deep' })
    expect(resolveSessionConfig(project, undefined, settings)).toEqual({ profile: 'deep' })
    expect(resolveSessionConfig(undefined, undefined, settings)).toEqual({ profile: 'standard' })
  })
  it('falls through an INVALID task/project config instead of failing', () => {
    expect(resolveSessionConfig(project, 'bad', settings)).toEqual({ profile: 'deep' })
    const garbageProject = { sessionProfile: 'deep' } as unknown as Project
    expect(resolveSessionConfig(garbageProject, undefined, settings)).toEqual({ profile: 'standard' })
  })
  it('uses the global default when set', () => {
    const s: HubSettings = { ...settings, defaultSessionProfile: { profile: 'light' } }
    expect(resolveSessionConfig(undefined, undefined, s)).toEqual({ profile: 'light' })
  })
})

describe('claudeShellArgs with a session config', () => {
  it('composes permission mode + model/effort flags', () => {
    expect(
      claudeShellArgs('win32', {
        runClaude: true,
        mode: 'bypassPermissions',
        session: { profile: 'deep' }
      })
    ).toEqual(['/k', 'claude', '--dangerously-skip-permissions', '--model', 'opus', '--effort', 'high'])
  })
  it('adds nothing for a standard session', () => {
    expect(
      claudeShellArgs('win32', { runClaude: true, mode: 'default', session: { profile: 'standard' } })
    ).toEqual(['/k', 'claude'])
  })
  it('still returns [] for shell tabs and non-Windows regardless of session', () => {
    expect(claudeShellArgs('win32', { runClaude: false, session: { profile: 'deep' } })).toEqual([])
    expect(claudeShellArgs('darwin', { runClaude: true, session: { profile: 'deep' } })).toEqual([])
  })
})

describe('suggestProfile', () => {
  it('suggests deep for heavy-thinking task text', () => {
    expect(suggestProfile('Refactor the auth flow')).toBe('deep')
    expect(suggestProfile('debug the race condition in pty cleanup')).toBe('deep')
    expect(suggestProfile('Port FounderOS scoring engine')).toBe('deep')
    expect(suggestProfile('research best migration path')).toBe('deep')
  })
  it('suggests light for chore-class task text', () => {
    expect(suggestProfile('fix typo in README')).toBe('light')
    expect(suggestProfile('bump version and update docs')).toBe('light')
    expect(suggestProfile('rename the settings file')).toBe('light')
  })
  it('defaults to standard when nothing matches, and deep wins over light', () => {
    expect(suggestProfile('add login page')).toBe('standard')
    expect(suggestProfile('')).toBe('standard')
    expect(suggestProfile('refactor the docs pipeline')).toBe('deep')
  })
  it('is case-insensitive and does not fire on substrings of larger words', () => {
    expect(suggestProfile('REFACTOR THIS')).toBe('deep')
    expect(suggestProfile('update the dockside artwork')).toBe('standard') // "dock" ≠ "docs"
  })
})

describe('PROFILE_META / PROFILE_PRESETS', () => {
  it('describes every profile', () => {
    for (const p of SESSION_PROFILES) {
      expect(PROFILE_META[p].label).toBeTruthy()
      expect(PROFILE_META[p].blurb).toBeTruthy()
    }
  })
  it('presets only ever contain allowlisted model/effort values', () => {
    for (const preset of Object.values(PROFILE_PRESETS)) {
      expect(sessionArgs({ profile: 'custom', ...preset })).toHaveLength(4)
    }
  })
})
