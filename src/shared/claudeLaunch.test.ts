import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS,
  PERMISSION_MODE_META,
  claudeArgs,
  claudeShellArgs,
  isPermissionMode,
  normalizeSettings
} from './claudeLaunch'
import { CLAUDE_PERMISSION_MODES } from './types'

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
      claudePermissionMode: 'bypassPermissions'
    })
    expect(normalizeSettings({ claudePermissionMode: 'acceptEdits', extra: 'ignored' })).toEqual({
      claudePermissionMode: 'acceptEdits'
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
