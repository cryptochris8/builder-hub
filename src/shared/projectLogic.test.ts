import { describe, it, expect } from 'vitest'
import {
  applyProjectPatch,
  sanitizeFolder,
  compareProjects,
  envExampleFor,
  detectTypeFromFiles,
  recoverRegistry,
  parseGitStatusV2,
  parseLastCommit
} from './projectLogic'
import type { Project } from './types'

const proj = (over: Partial<Project>): Project => ({
  id: 'x',
  name: 'X',
  path: 'C:/x',
  type: 'other',
  stack: '',
  status: 'active',
  favorite: false,
  notes: '',
  lastOpenedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over
})

describe('applyProjectPatch', () => {
  it('sets a whitelisted field', () => {
    const p = applyProjectPatch(proj({}), { name: 'Renamed', stage: 'launch-prep' })
    expect(p.name).toBe('Renamed')
    expect(p.stage).toBe('launch-prep')
  })

  it('clears a field when the value is null (regression: stage could be set but never unset)', () => {
    const p = applyProjectPatch(proj({ stage: 'launch-prep', revenueScore: 9 }), {
      stage: null,
      revenueScore: null
    })
    expect('stage' in p).toBe(false)
    expect('revenueScore' in p).toBe(false)
  })

  it('leaves a field alone when it is absent or explicitly undefined', () => {
    const p = applyProjectPatch(proj({ stage: 'building', notes: 'keep me' }), {
      stage: undefined,
      name: 'Renamed'
    })
    expect(p.stage).toBe('building') // undefined = "not in this patch", not "clear"
    expect(p.notes).toBe('keep me') // absent entirely
    expect(p.name).toBe('Renamed')
  })

  it('ignores fields outside the whitelist — a renderer cannot move a project', () => {
    const p = applyProjectPatch(proj({ id: 'x', path: 'C:/x' }), {
      id: 'hijacked',
      path: 'C:/Windows/System32',
      createdAt: 1
    } as never)
    expect(p.id).toBe('x')
    expect(p.path).toBe('C:/x')
    expect(p.createdAt).toBe(0)
  })

  it('cannot be used to delete a non-whitelisted field either', () => {
    const p = applyProjectPatch(proj({ path: 'C:/x' }), { path: null } as never)
    expect(p.path).toBe('C:/x')
  })

  it('sets and clears the session profile with the null sentinel', () => {
    const p = applyProjectPatch(proj({}), { sessionProfile: { profile: 'deep' } })
    expect(p.sessionProfile).toEqual({ profile: 'deep' })
    applyProjectPatch(p, { sessionProfile: null })
    expect('sessionProfile' in p).toBe(false)
  })

  it('sets and clears per-task profiles (whole-map replacement)', () => {
    const p = applyProjectPatch(proj({}), {
      taskProfiles: { 'fix-login': { profile: 'light' } }
    })
    expect(p.taskProfiles).toEqual({ 'fix-login': { profile: 'light' } })
    applyProjectPatch(p, { taskProfiles: null })
    expect('taskProfiles' in p).toBe(false)
  })
})

describe('sanitizeFolder', () => {
  it('replaces spaces with dashes', () => expect(sanitizeFolder('My Cool Game')).toBe('My-Cool-Game'))
  it('strips invalid path characters', () => expect(sanitizeFolder('a/b:c*d')).toBe('abcd'))
  it('collapses repeated dashes', () => expect(sanitizeFolder('a   b')).toBe('a-b'))
  it('trims leading/trailing dots and dashes', () => expect(sanitizeFolder('  -.name.-  ')).toBe('name'))
  it('falls back to new-project when empty/invalid', () => {
    expect(sanitizeFolder('   ')).toBe('new-project')
    expect(sanitizeFolder('***')).toBe('new-project')
  })
})

describe('compareProjects', () => {
  it('puts favorites first', () => {
    expect(compareProjects(proj({ favorite: true }), proj({ favorite: false }))).toBeLessThan(0)
  })
  it('sinks archived below non-archived (but under favorite)', () => {
    expect(compareProjects(proj({ status: 'active' }), proj({ status: 'archived' }))).toBeLessThan(0)
    // favorite still wins over archived-ness
    expect(
      compareProjects(
        proj({ favorite: true, status: 'archived' }),
        proj({ favorite: false, status: 'active' })
      )
    ).toBeLessThan(0)
  })
  it('then ranks most-recently-opened first', () => {
    expect(compareProjects(proj({ lastOpenedAt: 200 }), proj({ lastOpenedAt: 100 }))).toBeLessThan(0)
  })
  it('then sorts by name, case-insensitive', () => {
    expect(compareProjects(proj({ name: 'apple' }), proj({ name: 'Banana' }))).toBeLessThan(0)
  })
})

describe('envExampleFor', () => {
  it('returns key names for web-app', () => expect(envExampleFor('web-app')).toContain('STRIPE_SECRET_KEY='))
  it('returns null for types with no env needs', () => {
    expect(envExampleFor('unreal')).toBeNull()
    expect(envExampleFor('other')).toBeNull()
  })
  it('warns against NEXT_PUBLIC secrets', () => expect(envExampleFor('web-app')).toContain('NEXT_PUBLIC'))
})

describe('detectTypeFromFiles', () => {
  it('detects unreal from a .uproject', () => expect(detectTypeFromFiles(['Game.uproject'])).toBe('unreal'))
  it('detects roblox from default.project.json', () =>
    expect(detectTypeFromFiles(['default.project.json'])).toBe('roblox'))
  it('detects roblox from aftman.toml', () => expect(detectTypeFromFiles(['aftman.toml'])).toBe('roblox'))
  it('detects mobile from pubspec.yaml', () =>
    expect(detectTypeFromFiles(['pubspec.yaml'])).toBe('mobile-app'))
  it('detects hytopia from deps', () =>
    expect(detectTypeFromFiles(['package.json'], { dependencies: { hytopia: '^0.1' } })).toBe('hytopia'))
  it('detects crypto from ethers', () =>
    expect(detectTypeFromFiles(['package.json'], { dependencies: { ethers: '^6' } })).toBe('crypto-web3'))
  it('detects web-app from react', () =>
    expect(detectTypeFromFiles(['package.json'], { devDependencies: { react: '^19' } })).toBe('web-app'))
  it('detects static-site from index.html alone', () =>
    expect(detectTypeFromFiles(['index.html'])).toBe('static-site'))
  it('falls back to other', () => expect(detectTypeFromFiles(['notes.txt'])).toBe('other'))
})

describe('parseGitStatusV2', () => {
  it('reads a clean repo tracking an upstream', () => {
    const out = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      ''
    ].join('\n')
    expect(parseGitStatusV2(out)).toEqual({
      branch: 'main',
      detached: false,
      ahead: 0,
      behind: 0,
      hasUpstream: true,
      dirty: 0
    })
  })

  it('counts changed + untracked files and reads ahead/behind', () => {
    const out = [
      '# branch.head feature',
      '# branch.upstream origin/feature',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb file.ts',
      '1 M. N... 100644 100644 100644 ccc ddd staged.ts',
      '? untracked.ts'
    ].join('\n')
    expect(parseGitStatusV2(out)).toMatchObject({
      branch: 'feature',
      ahead: 2,
      behind: 1,
      hasUpstream: true,
      dirty: 3
    })
  })

  it('handles a branch with no upstream (no branch.ab line)', () => {
    const out = ['# branch.head wip', '1 A. N... 000000 100644 100644 000 eee new.ts'].join('\n')
    expect(parseGitStatusV2(out)).toMatchObject({
      branch: 'wip',
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      dirty: 1
    })
  })

  it('flags a detached HEAD with no branch name', () => {
    const r = parseGitStatusV2('# branch.head (detached)\n')
    expect(r.detached).toBe(true)
    expect(r.branch).toBeUndefined()
  })

  it('tolerates CRLF line endings', () => {
    expect(parseGitStatusV2('# branch.head main\r\n? a.ts\r\n').dirty).toBe(1)
  })
})

describe('parseLastCommit', () => {
  it('splits subject and relative time on the unit separator', () =>
    expect(parseLastCommit('Fix terminal width\x1f3 days ago\n')).toEqual({
      subject: 'Fix terminal width',
      relative: '3 days ago'
    }))
  it('returns null for empty output (e.g. a repo with no commits)', () =>
    expect(parseLastCommit('')).toBeNull())
})

describe('recoverRegistry', () => {
  const rows = [proj({ id: 'a' })]
  const bak = [proj({ id: 'b' })]
  it('trusts the main file when it parses', () =>
    expect(recoverRegistry(rows, true, bak)).toEqual({ rows, preserveCorruptMain: false }))
  it('falls back to .bak when main is corrupt, flagging it to be preserved', () =>
    expect(recoverRegistry(null, true, bak)).toEqual({ rows: bak, preserveCorruptMain: true }))
  it('returns empty (and preserves) when main is corrupt with no .bak', () =>
    expect(recoverRegistry(null, true, null)).toEqual({ rows: [], preserveCorruptMain: true }))
  it('returns empty without preserving on a fresh install (no main file)', () =>
    expect(recoverRegistry(null, false, null)).toEqual({ rows: [], preserveCorruptMain: false }))
})
