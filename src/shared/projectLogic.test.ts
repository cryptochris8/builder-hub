import { describe, it, expect } from 'vitest'
import { sanitizeFolder, compareProjects, envExampleFor, detectTypeFromFiles } from './projectLogic'
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
  it('detects mobile from pubspec.yaml', () => expect(detectTypeFromFiles(['pubspec.yaml'])).toBe('mobile-app'))
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
