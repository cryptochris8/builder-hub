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
  resolvePermissionMode,
  resolveRoutingMode,
  resolveSessionConfig,
  sessionArgs,
  sessionIdArgs,
  suggestProfile
} from './claudeLaunch'
import { CLAUDE_PERMISSION_MODES, ROUTING_MODES, SESSION_PROFILES } from './types'
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
  it('falls back to the fresh-install defaults for missing/absent input', () => {
    // No object / no recorded mode = fresh install → DEFAULT_SETTINGS (bypass by default).
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('bypassPermissions')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings([])).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })
  it('fails a present-but-invalid mode SAFE (default), never open — and never to argv', () => {
    // A stored key that's present but garbage is corruption/tampering: drop to the safe
    // mode, NOT the bypass-by-default fresh-install value. (An ABSENT key = fresh install
    // → DEFAULT_SETTINGS; that path is covered above.)
    const safe = {
      ...DEFAULT_SETTINGS,
      claudePermissionMode: 'default',
      defaultSessionProfile: { profile: 'standard' }
    }
    expect(normalizeSettings({ claudePermissionMode: 'yolo' })).toEqual(safe)
    expect(normalizeSettings({ claudePermissionMode: '--exec evil' })).toEqual(safe)
    expect(normalizeSettings({ claudePermissionMode: ['bypassPermissions'] })).toEqual(safe)
  })
  it('keeps a valid mode and strips unknown keys', () => {
    expect(normalizeSettings({ claudePermissionMode: 'bypassPermissions' })).toEqual({
      ...DEFAULT_SETTINGS,
      claudePermissionMode: 'bypassPermissions',
      defaultSessionProfile: { profile: 'standard' }
    })
    expect(normalizeSettings({ claudePermissionMode: 'acceptEdits', extra: 'ignored' })).toEqual({
      ...DEFAULT_SETTINGS,
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
    s.claudePermissionMode = 'acceptEdits'
    expect(DEFAULT_SETTINGS.claudePermissionMode).toBe('bypassPermissions')
  })
})

describe('resolvePermissionMode', () => {
  const bypassGlobal: HubSettings = normalizeSettings({
    claudePermissionMode: 'bypassPermissions',
    defaultSessionProfile: { profile: 'standard' }
  })
  const proj = (mode?: unknown): Project =>
    ({ id: 'p', name: 'p', path: 'C:/p', claudePermissionMode: mode }) as unknown as Project

  it('inherits the global default when the project has no override', () => {
    expect(resolvePermissionMode(proj(undefined), bypassGlobal)).toBe('bypassPermissions')
    expect(resolvePermissionMode(undefined, bypassGlobal)).toBe('bypassPermissions')
  })
  it('lets a project override the (bypass) default back to a safer mode', () => {
    expect(resolvePermissionMode(proj('default'), bypassGlobal)).toBe('default')
    expect(resolvePermissionMode(proj('acceptEdits'), bypassGlobal)).toBe('acceptEdits')
  })
  it('a project can also opt INTO bypass when the global is Ask', () => {
    const askGlobal: HubSettings = normalizeSettings({
      claudePermissionMode: 'default',
      defaultSessionProfile: { profile: 'standard' }
    })
    expect(resolvePermissionMode(proj('bypassPermissions'), askGlobal)).toBe('bypassPermissions')
    expect(resolvePermissionMode(proj(undefined), askGlobal)).toBe('default')
  })
  it('re-validates — a garbage stored override falls through to the global, never to argv', () => {
    expect(resolvePermissionMode(proj('yolo'), bypassGlobal)).toBe('bypassPermissions')
    expect(resolvePermissionMode(proj('--exec evil'), bypassGlobal)).toBe('bypassPermissions')
    expect(resolvePermissionMode(proj(['default']), bypassGlobal)).toBe('bypassPermissions')
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
  const settings: HubSettings = normalizeSettings({
    claudePermissionMode: 'default',
    defaultSessionProfile: { profile: 'standard' }
  })
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

describe('routing settings (2026-09 upgrade)', () => {
  it('defaults to suggest-only routing with injection + conflict warnings on and the status line off', () => {
    const s = normalizeSettings({})
    expect(s.routingMode).toBe('suggest')
    expect(s.contextInjection).toBe(true)
    expect(s.conflictWarnings).toBe(true)
    expect(s.statusLineTelemetry).toBe(true) // v1.1: on by default (absent key only)
  })
  it('keeps every valid routing mode and falls back to suggest for garbage (never auto by accident)', () => {
    for (const m of ROUTING_MODES) expect(normalizeSettings({ routingMode: m }).routingMode).toBe(m)
    expect(normalizeSettings({ routingMode: 'yolo' }).routingMode).toBe('suggest')
    expect(normalizeSettings({ routingMode: 1 }).routingMode).toBe('suggest')
  })
  it('only accepts real booleans for the toggles', () => {
    expect(normalizeSettings({ statusLineTelemetry: true }).statusLineTelemetry).toBe(true)
    expect(normalizeSettings({ statusLineTelemetry: 'true' }).statusLineTelemetry).toBe(true) // garbage → default
    expect(normalizeSettings({ contextInjection: false }).contextInjection).toBe(false)
    expect(normalizeSettings({ conflictWarnings: 0 }).conflictWarnings).toBe(true)
  })
  it('resolveRoutingMode: project override -> global, garbage falls through', () => {
    const s = normalizeSettings({ routingMode: 'auto' })
    const proj = (routingMode?: unknown): Project =>
      ({ id: 'p', name: 'p', path: 'C:/p', routingMode }) as unknown as Project
    expect(resolveRoutingMode(proj('lock'), s)).toBe('lock')
    expect(resolveRoutingMode(proj(undefined), s)).toBe('auto')
    expect(resolveRoutingMode(proj('nope'), s)).toBe('auto')
    expect(resolveRoutingMode(undefined, s)).toBe('auto')
  })
})

describe('sessionIdArgs / claudeShellArgs --session-id', () => {
  it('passes a well-formed UUID and nothing else', () => {
    expect(sessionIdArgs('6F1C2D3E-4A5B-4C6D-8E9F-0A1B2C3D4E5F')).toEqual([
      '--session-id',
      '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
    ])
    expect(sessionIdArgs(undefined)).toEqual([])
    expect(sessionIdArgs('not-a-uuid')).toEqual([])
    expect(sessionIdArgs('--dangerously-skip-permissions')).toEqual([])
  })
  it('claudeShellArgs appends it after the mode/profile flags on Windows only', () => {
    const id = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
    expect(claudeShellArgs('win32', { runClaude: true, mode: 'default', sessionId: id })).toEqual([
      '/k',
      'claude',
      '--session-id',
      id
    ])
    expect(claudeShellArgs('linux', { runClaude: true, sessionId: id })).toEqual([])
    expect(claudeShellArgs('win32', { runClaude: true, sessionId: 'junk' })).toEqual(['/k', 'claude'])
  })
})

describe('v1.1 settings: status line default + agent ceiling', () => {
  it('an explicit opt-out of the status line is kept; only an absent key defaults on', () => {
    expect(normalizeSettings({}).statusLineTelemetry).toBe(true)
    expect(normalizeSettings({ statusLineTelemetry: false }).statusLineTelemetry).toBe(false)
  })
  it('agentCeiling defaults to 8 and is clamped to an integer in range', () => {
    expect(normalizeSettings({}).agentCeiling).toBe(8)
    expect(normalizeSettings({ agentCeiling: 3.6 }).agentCeiling).toBe(4)
    expect(normalizeSettings({ agentCeiling: 0 }).agentCeiling).toBe(1)
    expect(normalizeSettings({ agentCeiling: 999 }).agentCeiling).toBe(64)
    expect(normalizeSettings({ agentCeiling: 'lots' }).agentCeiling).toBe(8)
    expect(normalizeSettings({ agentCeiling: Number.NaN }).agentCeiling).toBe(8)
  })
})
