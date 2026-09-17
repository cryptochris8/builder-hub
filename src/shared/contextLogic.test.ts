import { describe, it, expect } from 'vitest'
import {
  CONTEXT_LIMITS,
  NOTABLE_DEPS,
  SESSION_START_RULES,
  applyContextPatch,
  buildHandoffPacket,
  buildPromptContext,
  buildSessionStartContext,
  computeFreshness,
  emptyProjectContext,
  extractServices,
  fingerprintFromScan,
  firstParagraph,
  mergeScan,
  normalizeProjectContext,
  recordWork,
  relativeToProject,
  renderHandoffMarkdown,
  renderProjectContextMarkdown
} from './contextLogic'
import type { ProjectScan, SessionStartInput } from './contextLogic'
import type {
  CapabilityMatch,
  ContextFreshness,
  CreatorStackEntry,
  HandoffPacket,
  Project,
  ProjectContext,
  ProjectContextPatch,
  RouterSignals,
  SessionRecord
} from './types'

// 2026-09-16T12:00:00Z — a fixed "now" so ISO dates are stable in goldens
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0)
const DAY = 86_400_000
const PROJECT_PATH = 'C:\\Users\\chris\\proj'

const signals: RouterSignals = {
  consecutiveFailures: 0,
  failures: 0,
  passes: 0,
  filesEdited: 0,
  projectsTouched: 0,
  mechanicalStreak: 0,
  uncertaintyHits: 0,
  maxQualityRequested: false,
  riskHits: 0
}

function mkProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo',
    path: PROJECT_PATH,
    type: 'web-app',
    stack: 'Vite + React',
    status: 'active',
    favorite: false,
    notes: '',
    lastOpenedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

function mkRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 's1',
    cwd: PROJECT_PATH,
    state: 'working',
    startedAt: 0,
    updatedAt: 0,
    filesEdited: {},
    filesRead: {},
    commands: [],
    recaps: [],
    otherProjectsTouched: [],
    sharedToolsUsed: [],
    signals,
    locked: false,
    ...over
  }
}

function mkCtx(over: Partial<ProjectContext> = {}): ProjectContext {
  return { ...emptyProjectContext('p1', 0), ...over }
}

function mkPacket(over: Partial<HandoffPacket> = {}): HandoffPacket {
  return {
    projectId: 'p1',
    projectName: 'Demo',
    objective: '',
    attempted: [],
    filesChanged: [],
    decisions: [],
    unresolved: [],
    createdAt: NOW,
    ...over
  }
}

const fresh: ContextFreshness = { status: 'fresh', reasons: [], checkedAt: NOW }

const PATHS = {
  registry: 'C:\\Users\\chris\\.claude\\builder-hub-projects.md',
  contextFile: 'C:\\Users\\chris\\.claude\\builder-hub\\context\\p1.md',
  creatorStack: 'C:\\Users\\chris\\.claude\\builder-hub\\creator-stack.md'
}

const seq = (n: number, prefix: string): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

describe('contract surface', () => {
  it('exports every function of the contract', () => {
    const exported = [
      applyContextPatch,
      buildHandoffPacket,
      buildPromptContext,
      buildSessionStartContext,
      computeFreshness,
      emptyProjectContext,
      extractServices,
      fingerprintFromScan,
      firstParagraph,
      mergeScan,
      normalizeProjectContext,
      recordWork,
      relativeToProject,
      renderHandoffMarkdown,
      renderProjectContextMarkdown
    ]
    for (const fn of exported) expect(typeof fn).toBe('function')
  })
  it('publishes the documented limits (positive integers; the ones the spec names by value)', () => {
    for (const [key, value] of Object.entries(CONTEXT_LIMITS)) {
      expect(Number.isInteger(value), key).toBe(true)
      expect(value, key).toBeGreaterThan(0)
    }
    expect(CONTEXT_LIMITS).toMatchObject({
      recentWork: 8,
      keyFiles: 12,
      injectionChars: 2600,
      recapChars: 300
    })
    expect(CONTEXT_LIMITS.recapChars).toBeLessThan(CONTEXT_LIMITS.injectionChars)
  })
  it('spells the rules line exactly as the contract does', () => {
    expect(SESSION_START_RULES).toBe(
      "Rules: summaries orient, source is truth — re-verify before architectural or destructive changes. Before modifying another project's source, say so explicitly."
    )
  })
  it('NOTABLE_DEPS is a non-empty list of distinct package names', () => {
    expect(NOTABLE_DEPS.length).toBeGreaterThan(0)
    expect(new Set(NOTABLE_DEPS).size).toBe(NOTABLE_DEPS.length)
    for (const dep of NOTABLE_DEPS) expect(dep).toMatch(/^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/)
  })
})

describe('emptyProjectContext', () => {
  it('is empty everywhere and stamped with now', () => {
    expect(emptyProjectContext('p9', 42)).toEqual({
      projectId: 'p9',
      commands: {},
      services: [],
      sharedTools: [],
      decisions: [],
      currentTasks: [],
      knownBugs: [],
      recentWork: [],
      keyFiles: [],
      updatedAt: 42
    })
  })
})

describe('normalizeProjectContext', () => {
  it('returns undefined for anything that is not an object', () => {
    for (const raw of [undefined, null, 'x', 42, true, [], () => 1]) {
      expect(normalizeProjectContext(raw, 'p1')).toBeUndefined()
    }
  })
  it('turns an empty object into an empty context with updatedAt 0', () => {
    expect(normalizeProjectContext({}, 'p1')).toEqual(emptyProjectContext('p1', 0))
  })
  it('forces the projectId from the argument, never from the raw object', () => {
    expect(normalizeProjectContext({ projectId: 'other' }, 'p1')?.projectId).toBe('p1')
  })
  it('trims string fields and drops empty / non-string ones', () => {
    const ctx = normalizeProjectContext({ purpose: '  a purpose  ', architecture: '   ' }, 'p1')
    expect(ctx?.purpose).toBe('a purpose')
    expect(ctx).not.toHaveProperty('architecture')
    expect(normalizeProjectContext({ purpose: 12 }, 'p1')).not.toHaveProperty('purpose')
  })
  it('cleans string arrays: drop non-strings, trim, drop empties, dedupe', () => {
    const ctx = normalizeProjectContext(
      { decisions: [' a ', 'a', '', 3, null, undefined, { x: 1 }, 'b', 'b '], services: 'not-an-array' },
      'p1'
    )
    expect(ctx?.decisions).toEqual(['a', 'b'])
    expect(ctx?.services).toEqual([])
  })
  it('bounds every array to its CONTEXT_LIMITS entry', () => {
    const ctx = normalizeProjectContext(
      {
        decisions: seq(40, 'd'),
        currentTasks: seq(40, 't'),
        knownBugs: seq(40, 'b'),
        services: seq(40, 's'),
        keyFiles: seq(40, 'k'),
        recentWork: seq(12, 'w').map((summary, i) => ({ at: i, summary }))
      },
      'p1'
    )
    expect(ctx?.decisions).toHaveLength(CONTEXT_LIMITS.decisions)
    expect(ctx?.currentTasks).toHaveLength(CONTEXT_LIMITS.tasks)
    expect(ctx?.knownBugs).toHaveLength(CONTEXT_LIMITS.bugs)
    expect(ctx?.services).toHaveLength(CONTEXT_LIMITS.services)
    expect(ctx?.keyFiles).toHaveLength(CONTEXT_LIMITS.keyFiles)
    expect(ctx?.keyFiles[0]).toBe('k0') // MRU list keeps the FRONT
    expect(ctx?.recentWork).toHaveLength(CONTEXT_LIMITS.recentWork)
    expect(ctx?.recentWork[0].summary).toBe('w4') // newest last → keeps the TAIL
    expect(ctx?.recentWork[7].summary).toBe('w11')
  })
  it('dedupes keyFiles case-insensitively (Windows paths)', () => {
    const ctx = normalizeProjectContext({ keyFiles: ['src/A.ts', 'src/a.ts', 'src/b.ts'] }, 'p1')
    expect(ctx?.keyFiles).toEqual(['src/A.ts', 'src/b.ts'])
  })
  it('keeps commands as a string→string record, trimmed, dropping garbage', () => {
    const ctx = normalizeProjectContext(
      { commands: { dev: ' vite ', bad: 3, '': 'x', empty: '', ' test ': 'vitest run', obj: {} } },
      'p1'
    )
    expect(ctx?.commands).toEqual({ dev: 'vite', test: 'vitest run' })
    expect(normalizeProjectContext({ commands: ['dev'] }, 'p1')?.commands).toEqual({})
  })
  it('keeps scripts whose names collide with Object.prototype and never lets __proto__ through', () => {
    const commands = JSON.parse(
      '{"constructor":"c","toString":"t","hasOwnProperty":"h","__proto__":"p","dev":"vite"}'
    )
    const ctx = normalizeProjectContext({ commands }, 'p1')!
    expect(Object.keys(ctx.commands)).toEqual(['constructor', 'toString', 'hasOwnProperty', 'dev'])
    expect(Object.getPrototypeOf(ctx.commands)).toBe(Object.prototype)
  })
  it('dedupes keyFiles across separators too (src\\a.ts vs src/a.ts)', () => {
    expect(
      normalizeProjectContext({ keyFiles: ['src\\a.ts', 'src/A.ts', 'src/b.ts'] }, 'p1')?.keyFiles
    ).toEqual(['src\\a.ts', 'src/b.ts'])
  })
  it('validates recentWork entries: numeric at + non-empty summary; sessionId kept when a string', () => {
    const ctx = normalizeProjectContext(
      {
        recentWork: [
          { at: 1, summary: ' did a ', sessionId: 's1' },
          { at: '2', summary: 'bad at' },
          { at: 3, summary: '' },
          { at: 4 },
          'garbage',
          null,
          { at: 5, summary: 'ok', sessionId: 9 }
        ]
      },
      'p1'
    )
    expect(ctx?.recentWork).toEqual([
      { at: 1, summary: 'did a', sessionId: 's1' },
      { at: 5, summary: 'ok' }
    ])
  })
  it('keeps only numeric fingerprint numbers and string head/branch; garbage fingerprint is dropped', () => {
    const ctx = normalizeProjectContext(
      {
        fingerprint: {
          head: 'abc1234',
          branch: 7,
          dirty: '3',
          claudeMdMtime: 10,
          manifestMtime: NaN,
          computedAt: 'x'
        }
      },
      'p1'
    )
    expect(ctx?.fingerprint).toEqual({ head: 'abc1234', claudeMdMtime: 10, computedAt: 0 })
    expect(normalizeProjectContext({ fingerprint: 'nope' }, 'p1')).not.toHaveProperty('fingerprint')
    expect(normalizeProjectContext({ fingerprint: null }, 'p1')).not.toHaveProperty('fingerprint')
  })
  it('keeps numeric indexedAt/updatedAt; anything else → absent / 0', () => {
    expect(normalizeProjectContext({ indexedAt: 5, updatedAt: 6 }, 'p1')).toMatchObject({
      indexedAt: 5,
      updatedAt: 6
    })
    const bad = normalizeProjectContext({ indexedAt: '5', updatedAt: 'later' }, 'p1')
    expect(bad).not.toHaveProperty('indexedAt')
    expect(bad?.updatedAt).toBe(0)
  })
  it('always returns a fresh object (no shared references with the raw input)', () => {
    const raw = { decisions: ['a'], commands: { dev: 'vite' } }
    const ctx = normalizeProjectContext(raw, 'p1')!
    ctx.decisions.push('b')
    ctx.commands.test = 'x'
    expect(raw.decisions).toEqual(['a'])
    expect(raw.commands).toEqual({ dev: 'vite' })
  })
})

describe('applyContextPatch', () => {
  const base = mkCtx({
    purpose: 'keep me',
    architecture: 'arch',
    commands: { dev: 'vite' },
    decisions: ['d1'],
    knownBugs: ['b1'],
    fingerprint: { head: 'abc', computedAt: 1 },
    indexedAt: 1,
    updatedAt: 1
  })

  it('undefined leaves a field alone; null clears it', () => {
    const patch: ProjectContextPatch = {
      purpose: undefined,
      architecture: null,
      decisions: undefined,
      knownBugs: null,
      commands: null,
      fingerprint: null,
      indexedAt: null
    }
    const next = applyContextPatch(base, patch, NOW)
    expect(next.purpose).toBe('keep me')
    expect(next).not.toHaveProperty('architecture')
    expect(next.decisions).toEqual(['d1'])
    expect(next.knownBugs).toEqual([])
    expect(next.commands).toEqual({})
    expect(next).not.toHaveProperty('fingerprint')
    expect(next).not.toHaveProperty('indexedAt')
    expect(next.updatedAt).toBe(NOW)
  })
  it('a key absent from the patch is untouched (same as undefined)', () => {
    const next = applyContextPatch(base, {}, NOW)
    expect({ ...next, updatedAt: 1 }).toEqual(base)
  })
  it('assigns trimmed strings and deduped, bounded arrays', () => {
    const next = applyContextPatch(
      base,
      { purpose: '  new purpose ', decisions: [' x ', 'x', '', 'y'], currentTasks: seq(40, 't') },
      NOW
    )
    expect(next.purpose).toBe('new purpose')
    expect(next.decisions).toEqual(['x', 'y'])
    expect(next.currentTasks).toHaveLength(CONTEXT_LIMITS.tasks)
  })
  it('an empty string clears a string field, like null', () => {
    expect(applyContextPatch(base, { purpose: '   ' }, NOW)).not.toHaveProperty('purpose')
  })
  it('replaces commands with a cleaned record and fingerprint with a cleaned one', () => {
    const next = applyContextPatch(
      base,
      {
        commands: { test: ' vitest ', bad: 1 } as unknown as Record<string, string>,
        fingerprint: { head: 'def', dirty: 2, computedAt: 9 }
      },
      NOW
    )
    expect(next.commands).toEqual({ test: 'vitest' })
    expect(next.fingerprint).toEqual({ head: 'def', dirty: 2, computedAt: 9 })
  })
  it('never patches projectId, and always stamps updatedAt with now (ignoring patch.updatedAt)', () => {
    const patch = { projectId: 'evil', updatedAt: 5 } as unknown as ProjectContextPatch
    const next = applyContextPatch(base, patch, NOW)
    expect(next.projectId).toBe('p1')
    expect(next.updatedAt).toBe(NOW)
  })
  it('ignores unknown keys and garbage values without throwing', () => {
    const patch = {
      bogus: 1,
      recentWork: [{ at: 'x' }, 7]
    } as unknown as ProjectContextPatch
    const next = applyContextPatch(base, patch, NOW)
    expect(next).not.toHaveProperty('bogus')
    expect(next.recentWork).toEqual([]) // an array of bad entries is an (empty) array
    expect(applyContextPatch(base, null as unknown as ProjectContextPatch, NOW).decisions).toEqual(['d1'])
  })
  it('a value of the WRONG type is ignored — only null (or a blank string) may clear stored data', () => {
    const patch = {
      purpose: 42,
      architecture: ['not', 'a', 'string'],
      decisions: 'not-an-array',
      knownBugs: { 0: 'b' },
      commands: ['dev'],
      fingerprint: 'abc',
      indexedAt: '5'
    } as unknown as ProjectContextPatch
    const next = applyContextPatch(base, patch, NOW)
    expect({ ...next, updatedAt: 1 }).toEqual(base)
  })
  it('does not mutate its input', () => {
    const before = JSON.stringify(base)
    applyContextPatch(base, { decisions: ['z'], commands: null, purpose: null }, NOW)
    expect(JSON.stringify(base)).toBe(before)
  })
})

describe('fingerprintFromScan', () => {
  it('copies git head/branch/dirty and the two mtimes, stamped with now', () => {
    const scan: ProjectScan = {
      git: { head: 'abc1234', branch: 'main', dirty: 3 },
      claudeMdMtime: 100,
      manifestMtime: 200
    }
    expect(fingerprintFromScan(scan, NOW)).toEqual({
      head: 'abc1234',
      branch: 'main',
      dirty: 3,
      claudeMdMtime: 100,
      manifestMtime: 200,
      computedAt: NOW
    })
  })
  it('omits what the scan does not know (no undefined keys)', () => {
    expect(fingerprintFromScan({}, NOW)).toEqual({ computedAt: NOW })
    expect(fingerprintFromScan({ git: { branch: '' } }, NOW)).toEqual({ computedAt: NOW })
  })
})

describe('computeFreshness', () => {
  const stored = mkCtx({
    fingerprint: {
      head: 'abc1234',
      branch: 'main',
      dirty: 3,
      claudeMdMtime: 100,
      manifestMtime: 200,
      computedAt: 1
    }
  })
  const same = {
    head: 'abc1234',
    branch: 'main',
    dirty: 3,
    claudeMdMtime: 100,
    manifestMtime: 200,
    computedAt: NOW
  }

  it('is unknown ("never indexed") without a context or without a fingerprint', () => {
    expect(computeFreshness(undefined, same, NOW)).toEqual({
      status: 'unknown',
      reasons: ['never indexed'],
      checkedAt: NOW
    })
    expect(computeFreshness(mkCtx(), same, NOW)).toEqual({
      status: 'unknown',
      reasons: ['never indexed'],
      checkedAt: NOW
    })
  })
  it('is fresh when every shared field matches', () => {
    expect(computeFreshness(stored, same, NOW)).toEqual({ status: 'fresh', reasons: [], checkedAt: NOW })
  })
  it('names each thing that moved, in a fixed order', () => {
    const moved = {
      head: 'def5678',
      branch: 'hub/x',
      dirty: 7,
      claudeMdMtime: 101,
      manifestMtime: 201,
      computedAt: NOW
    }
    expect(computeFreshness(stored, moved, NOW)).toEqual({
      status: 'stale',
      reasons: [
        'HEAD abc1234 → def5678',
        'branch main → hub/x',
        'uncommitted files 3 → 7',
        'CLAUDE.md changed',
        'manifest changed'
      ],
      checkedAt: NOW
    })
  })
  it('reports a single reason for a single change', () => {
    expect(computeFreshness(stored, { ...same, dirty: 4 }, NOW).reasons).toEqual(['uncommitted files 3 → 4'])
    expect(computeFreshness(stored, { ...same, manifestMtime: 999 }, NOW).reasons).toEqual([
      'manifest changed'
    ])
  })
  it('ignores a field that is missing on either side (defined-on-both only)', () => {
    const partial = mkCtx({ fingerprint: { head: 'abc1234', computedAt: 1 } })
    expect(computeFreshness(partial, same, NOW).status).toBe('fresh')
    expect(computeFreshness(stored, { computedAt: NOW }, NOW).status).toBe('unknown') // git probe failed → never 'fresh'
    expect(computeFreshness(stored, { head: 'zzz', computedAt: NOW }, NOW).reasons).toEqual([
      'HEAD abc1234 → zzz'
    ])
  })
  it('never compares computedAt', () => {
    expect(computeFreshness(stored, { ...same, computedAt: 123456 }, NOW).status).toBe('fresh')
  })
})

describe('mergeScan', () => {
  const scan: ProjectScan = {
    manifest: {
      kind: 'npm',
      scripts: {
        zeta: 'z',
        test: 'vitest run',
        alpha: 'a',
        dev: 'vite',
        lint: 'eslint .',
        format: 'prettier'
      },
      deps: ['zod', 'vite', 'react', 'stripe']
    },
    readmeFirstParagraph: 'From the README.',
    envKeys: ['STRIPE_KEY', 'OPENAI_API_KEY=sk-should-not-leak'],
    git: { head: 'abc1234', branch: 'main', dirty: 0 },
    claudeMdMtime: 10,
    manifestMtime: 20
  }

  it('orders commands well-known first (dev, start, build, test, typecheck, lint, format) then A→Z', () => {
    const next = mergeScan(mkCtx(), scan, NOW)
    expect(Object.keys(next.commands)).toEqual(['dev', 'test', 'lint', 'format', 'alpha', 'zeta'])
    expect(next.commands.test).toBe('vitest run')
  })
  it('puts all seven well-known names first, in the contract order, before the alphabetical rest', () => {
    const scripts: Record<string, string> = {}
    for (const n of [
      'zeta',
      'format',
      'lint',
      'typecheck',
      'test',
      'build',
      'start',
      'dev',
      'Alpha',
      'beta'
    ]) {
      scripts[n] = n
    }
    const next = mergeScan(mkCtx(), { manifest: { kind: 'npm', scripts } }, NOW)
    expect(Object.keys(next.commands)).toEqual([
      'dev',
      'start',
      'build',
      'test',
      'typecheck',
      'lint',
      'format',
      'Alpha',
      'beta',
      'zeta'
    ])
  })
  it('bounds commands to CONTEXT_LIMITS.commands, keeping the well-known ones', () => {
    const scripts: Record<string, string> = {}
    for (const n of seq(30, 'a')) scripts[n] = 'x'
    scripts.test = 'vitest'
    const next = mergeScan(mkCtx(), { manifest: { kind: 'npm', scripts } }, NOW)
    expect(Object.keys(next.commands)).toHaveLength(CONTEXT_LIMITS.commands)
    expect(Object.keys(next.commands)[0]).toBe('test')
  })
  it('derives services from notable deps + env key NAMES (values never survive)', () => {
    const next = mergeScan(mkCtx(), scan, NOW)
    expect(next.services).toEqual(['react', 'vite', 'stripe', 'env: STRIPE_KEY', 'env: OPENAI_API_KEY'])
    expect(JSON.stringify(next)).not.toContain('sk-should')
  })
  it('bounds services', () => {
    const next = mergeScan(mkCtx(), { envKeys: seq(40, 'K') }, NOW)
    expect(next.services).toHaveLength(CONTEXT_LIMITS.services)
  })
  it('fills purpose from the README only when purpose is empty (user text wins)', () => {
    expect(mergeScan(mkCtx(), scan, NOW).purpose).toBe('From the README.')
    expect(mergeScan(mkCtx({ purpose: 'user wrote this' }), scan, NOW).purpose).toBe('user wrote this')
    expect(mergeScan(mkCtx({ purpose: '   ' }), scan, NOW).purpose).toBe('From the README.')
    expect(mergeScan(mkCtx(), { ...scan, readmeFirstParagraph: undefined }, NOW)).not.toHaveProperty(
      'purpose'
    )
    expect(mergeScan(mkCtx(), { readmeFirstParagraph: 'x'.repeat(500) }, NOW).purpose).toHaveLength(400)
  })
  it('refreshes fingerprint, indexedAt and updatedAt', () => {
    const next = mergeScan(mkCtx(), scan, NOW)
    expect(next.fingerprint).toEqual(fingerprintFromScan(scan, NOW))
    expect(next.indexedAt).toBe(NOW)
    expect(next.updatedAt).toBe(NOW)
  })
  it('never touches decisions / tasks / bugs / recentWork / keyFiles / sharedTools / architecture', () => {
    const ctx = mkCtx({
      architecture: 'arch',
      sharedTools: ['trailer-kit'],
      decisions: ['d'],
      currentTasks: ['t'],
      knownBugs: ['b'],
      recentWork: [{ at: 1, summary: 'w' }],
      keyFiles: ['src/a.ts']
    })
    const next = mergeScan(ctx, scan, NOW)
    expect(next).toMatchObject({
      architecture: 'arch',
      sharedTools: ['trailer-kit'],
      decisions: ['d'],
      currentTasks: ['t'],
      knownBugs: ['b'],
      recentWork: [{ at: 1, summary: 'w' }],
      keyFiles: ['src/a.ts']
    })
  })
  it('an empty scan clears commands/services (the manifest is gone) and does not throw', () => {
    const next = mergeScan(mkCtx({ commands: { dev: 'x' }, services: ['react'] }), {}, NOW)
    expect(next.commands).toEqual({})
    expect(next.services).toEqual([])
    expect(next.fingerprint).toEqual({ computedAt: NOW })
  })
  it('does not mutate its input', () => {
    const ctx = mkCtx({ commands: { dev: 'x' } })
    const before = JSON.stringify(ctx)
    mergeScan(ctx, scan, NOW)
    expect(JSON.stringify(ctx)).toBe(before)
  })
})

describe('relativeToProject', () => {
  it('handles mixed separators and a case-insensitive prefix, keeping the file spelling', () => {
    expect(relativeToProject('c:/users/CHRIS/proj/src/Foo.ts', PROJECT_PATH)).toBe('src/Foo.ts')
    expect(relativeToProject('C:\\Users\\chris\\proj\\src\\a.ts', 'c:/users/chris/proj/')).toBe('src/a.ts')
    expect(relativeToProject('C:\\Users\\chris\\proj\\src\\\\b.ts', PROJECT_PATH)).toBe('src/b.ts')
  })
  it('returns undefined for files outside the project, the root itself, and garbage', () => {
    expect(relativeToProject('D:\\other\\x.ts', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject('C:\\Users\\chris\\proj-two\\x.ts', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject(PROJECT_PATH, PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject(PROJECT_PATH + '\\', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject('src/a.ts', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject('\\\\server\\share\\x.ts', '')).toBeUndefined()
    expect(relativeToProject(undefined as unknown as string, PROJECT_PATH)).toBeUndefined()
  })
  it('a ".." segment escapes the project (never "inside"); "." segments are dropped; padding is trimmed', () => {
    expect(relativeToProject('C:\\Users\\chris\\proj\\..\\proj-two\\x.ts', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject('C:\\Users\\chris\\proj\\src\\..\\..\\..\\x.ts', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject('C:\\Users\\chris\\proj\\..', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject('C:\\Users\\chris\\proj\\.\\src\\.\\a.ts', PROJECT_PATH)).toBe('src/a.ts')
    expect(relativeToProject('  C:\\Users\\chris\\proj\\src\\a.ts \n', PROJECT_PATH)).toBe('src/a.ts')
    // "..ts" is a file name, not a parent reference
    expect(relativeToProject('C:\\Users\\chris\\proj\\..ts', PROJECT_PATH)).toBe('..ts')
  })
  it('maps a file inside a task worktree (<project>.worktrees\\<task>\\…) to the same relative path', () => {
    expect(relativeToProject('C:\\Users\\chris\\proj.worktrees\\auth\\src\\a.ts', PROJECT_PATH)).toBe(
      'src/a.ts'
    )
    expect(relativeToProject('c:/users/chris/PROJ.worktrees/auth/src/a.ts', PROJECT_PATH)).toBe('src/a.ts')
    // the worktree root itself, the .worktrees folder, and a sibling that merely shares the prefix
    expect(relativeToProject('C:\\Users\\chris\\proj.worktrees\\auth', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject('C:\\Users\\chris\\proj.worktrees\\auth\\', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject('C:\\Users\\chris\\proj.worktrees', PROJECT_PATH)).toBeUndefined()
    expect(relativeToProject('C:\\Users\\chris\\proj.worktreesX\\a\\b.ts', PROJECT_PATH)).toBeUndefined()
  })
})

describe('recordWork', () => {
  it('appends a recap (newest last) with its sessionId and stamps updatedAt', () => {
    const next = recordWork(
      mkCtx(),
      { at: 5, summary: ' did a thing ', sessionId: 's1' },
      [],
      PROJECT_PATH,
      NOW
    )
    expect(next.recentWork).toEqual([{ at: 5, summary: 'did a thing', sessionId: 's1' }])
    expect(next.updatedAt).toBe(NOW)
  })
  it('skips a recap whose summary equals the LAST entry (de-dup by text)', () => {
    const ctx = mkCtx({ recentWork: [{ at: 1, summary: 'same' }] })
    expect(recordWork(ctx, { at: 2, summary: 'same' }, [], PROJECT_PATH, NOW).recentWork).toHaveLength(1)
    const older = mkCtx({
      recentWork: [
        { at: 1, summary: 'same' },
        { at: 2, summary: 'other' }
      ]
    })
    expect(recordWork(older, { at: 3, summary: 'same' }, [], PROJECT_PATH, NOW).recentWork).toHaveLength(3)
  })
  it('skips an empty summary but still records the files', () => {
    const next = recordWork(
      mkCtx(),
      { at: 1, summary: '  ' },
      [PROJECT_PATH + '\\src\\a.ts'],
      PROJECT_PATH,
      NOW
    )
    expect(next.recentWork).toEqual([])
    expect(next.keyFiles).toEqual(['src/a.ts'])
  })
  it('bounds recentWork to CONTEXT_LIMITS.recentWork, dropping the oldest', () => {
    let ctx = mkCtx()
    for (let i = 0; i < 12; i++) ctx = recordWork(ctx, { at: i, summary: `w${i}` }, [], PROJECT_PATH, NOW)
    expect(ctx.recentWork).toHaveLength(CONTEXT_LIMITS.recentWork)
    expect(ctx.recentWork[0].summary).toBe('w4')
    expect(ctx.recentWork[7].summary).toBe('w11')
  })
  it('keeps keyFiles as an MRU list: newly edited files first (in the given order), then the old ones', () => {
    const ctx = mkCtx({ keyFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'] })
    const next = recordWork(
      ctx,
      { at: 1, summary: 'x' },
      [
        'C:\\Users\\chris\\proj\\src\\c.ts',
        'c:/users/chris/proj/src/D.ts',
        'D:\\elsewhere\\z.ts',
        'C:\\Users\\chris\\proj\\src\\c.ts'
      ],
      PROJECT_PATH,
      NOW
    )
    expect(next.keyFiles).toEqual(['src/c.ts', 'src/D.ts', 'src/a.ts', 'src/b.ts'])
  })
  it('replaces an old spelling that differs only by case (Windows) instead of duplicating it', () => {
    const ctx = mkCtx({ keyFiles: ['src/A.ts', 'src/b.ts'] })
    const next = recordWork(ctx, { at: 1, summary: 'x' }, [PROJECT_PATH + '\\src\\a.ts'], PROJECT_PATH, NOW)
    expect(next.keyFiles).toEqual(['src/a.ts', 'src/b.ts'])
  })
  it('replaces an old backslash spelling (hand-edited context.json) instead of duplicating it', () => {
    const ctx = mkCtx({ keyFiles: ['src\\a.ts', 'src/b.ts'] })
    const next = recordWork(ctx, { at: 1, summary: 'x' }, [PROJECT_PATH + '\\src\\a.ts'], PROJECT_PATH, NOW)
    expect(next.keyFiles).toEqual(['src/a.ts', 'src/b.ts'])
  })
  it('records files edited inside a task worktree as project files', () => {
    const next = recordWork(
      mkCtx(),
      { at: 1, summary: 'x' },
      ['c:\\users\\chris\\proj.worktrees\\auth\\src\\login.ts'],
      PROJECT_PATH,
      NOW
    )
    expect(next.keyFiles).toEqual(['src/login.ts'])
  })
  it('caps keyFiles at CONTEXT_LIMITS.keyFiles', () => {
    const ctx = mkCtx({ keyFiles: seq(12, 'old').map((n) => `${n}.ts`) })
    const edited = seq(5, 'new').map((n) => `${PROJECT_PATH}\\${n}.ts`)
    const next = recordWork(ctx, { at: 1, summary: 'x' }, edited, PROJECT_PATH, NOW)
    expect(next.keyFiles).toHaveLength(CONTEXT_LIMITS.keyFiles)
    expect(next.keyFiles.slice(0, 5)).toEqual(['new0.ts', 'new1.ts', 'new2.ts', 'new3.ts', 'new4.ts'])
    expect(next.keyFiles[11]).toBe('old6.ts')
  })
  it('ignores files outside the project and garbage input', () => {
    const next = recordWork(
      mkCtx(),
      { at: 1, summary: 'x' },
      ['D:\\x.ts', 'src/rel.ts', 3 as unknown as string],
      PROJECT_PATH,
      NOW
    )
    expect(next.keyFiles).toEqual([])
    expect(
      recordWork(mkCtx(), { at: 1, summary: 'x' }, null as unknown as string[], PROJECT_PATH, NOW).keyFiles
    ).toEqual([])
  })
  it('does not mutate its input', () => {
    const ctx = mkCtx({ keyFiles: ['src/a.ts'], recentWork: [{ at: 1, summary: 'w' }] })
    const before = JSON.stringify(ctx)
    recordWork(ctx, { at: 2, summary: 'new' }, [PROJECT_PATH + '\\src\\b.ts'], PROJECT_PATH, NOW)
    expect(JSON.stringify(ctx)).toBe(before)
  })
})

describe('extractServices', () => {
  it('filters deps in NOTABLE_DEPS order regardless of the input order', () => {
    expect(extractServices(['stripe', 'zod', 'react', 'vite', 'left-pad'], [])).toEqual([
      'react',
      'vite',
      'stripe'
    ])
    expect(NOTABLE_DEPS.indexOf('react')).toBeLessThan(NOTABLE_DEPS.indexOf('stripe'))
  })
  it('appends env key NAMES as "env: NAME", never values', () => {
    expect(
      extractServices([], ['STRIPE_KEY', 'OPENAI_API_KEY=sk-live-123', 'export DB_URL=postgres://x'])
    ).toEqual(['env: STRIPE_KEY', 'env: OPENAI_API_KEY', 'env: DB_URL'])
  })
  it('drops comments, blanks, and anything that does not look like a name; dedupes', () => {
    expect(extractServices([], ['# comment', '', '  ', 'not a name!', 'A_KEY', 'A_KEY', ' A_KEY '])).toEqual([
      'env: A_KEY'
    ])
  })
  it('tolerates garbage input', () => {
    expect(extractServices(null as unknown as string[], undefined as unknown as string[])).toEqual([])
    expect(extractServices([3, null, 'react'] as unknown as string[], [4] as unknown as string[])).toEqual([
      'react'
    ])
  })
})

describe('firstParagraph', () => {
  it('skips headings, badges, html and blank lines, then takes the first run of lines', () => {
    const readme = [
      '# Title',
      '',
      '[![ci](https://x/badge.svg)](https://x)',
      '![logo](logo.png)',
      '<p align="center"><img src="x.png"></p>',
      '',
      'First line of the **intro** with a [link](https://a.b) and `code`.',
      'Second line _italic_ and *starred*.',
      '',
      'Second paragraph should not appear.',
      '## Next heading'
    ].join('\n')
    expect(firstParagraph(readme)).toBe(
      'First line of the intro with a link and code. Second line italic and starred.'
    )
  })
  it('stops a run at a heading, and drops a badge line inside the run', () => {
    expect(firstParagraph('Intro line.\n![b](x)\nMore.\n## H\nafter')).toBe('Intro line. More.')
  })
  it('handles CRLF, front matter and horizontal rules', () => {
    expect(firstParagraph('---\r\ntitle: x\r\n---\r\n# H\r\n---\r\nThe para.\r\n\r\nno')).toBe('The para.')
  })
  it('keeps snake_case words intact while stripping underscore emphasis', () => {
    expect(firstParagraph('Uses snake_case_names and _emphasis_ here.')).toBe(
      'Uses snake_case_names and emphasis here.'
    )
  })
  it('caps at 400 chars with an ellipsis', () => {
    const out = firstParagraph('word '.repeat(200))
    expect(out).toHaveLength(400)
    expect(out.endsWith('…')).toBe(true)
    expect(firstParagraph('x'.repeat(400))).toHaveLength(400)
    expect(firstParagraph('x'.repeat(400)).endsWith('…')).toBe(false)
  })
  it('returns "" for empty input, non-strings, or a README with only headings/badges', () => {
    expect(firstParagraph('')).toBe('')
    expect(firstParagraph(undefined as unknown as string)).toBe('')
    expect(firstParagraph('# Only\n## Headings\n![b](x)')).toBe('')
  })
  it('treats an unclosed leading "---" as a rule, not as front matter swallowing the file', () => {
    expect(firstParagraph('---\n# Title\nThe para.\n')).toBe('The para.')
  })
  it('skips setext headings (Title\\n=====) instead of quoting them as the paragraph', () => {
    expect(firstParagraph('My Project\n==========\n\nDescription here.\nSecond line.\n')).toBe(
      'Description here. Second line.'
    )
    expect(firstParagraph('Install\n-------\nrun npm i')).toBe('run npm i')
    // a paragraph directly followed by an underline IS a (multi-line) setext heading (CommonMark)
    expect(firstParagraph('Line one\nline two\n---\nReal para.')).toBe('Real para.')
  })
  it('skips a leading fenced code block and a multi-line html comment (README templates)', () => {
    expect(firstParagraph('```bash\nnpm i\n```\nAfter the fence.')).toBe('After the fence.')
    expect(firstParagraph('~~~\ncode\n~~~\n\nAfter tilde fence.')).toBe('After tilde fence.')
    expect(firstParagraph('<!--\n*** Thanks for checking out the template\n-->\n\nThe real intro.')).toBe(
      'The real intro.'
    )
    expect(firstParagraph('<!-- one line -->\nIntro.')).toBe('Intro.')
    // a fence ends the paragraph rather than being quoted
    expect(firstParagraph('Intro.\n```\ncode\n```\nmore')).toBe('Intro.')
    // an unclosed fence / comment yields nothing rather than code
    expect(firstParagraph('```\nnever closed')).toBe('')
  })
  it('strips only tag-shaped <…>, keeping comparisons and inline comments out', () => {
    expect(firstParagraph('Fast when a < b and c > d, see <b>docs</b> <!-- hidden -->.')).toBe(
      'Fast when a < b and c > d, see docs .'
    )
  })
})

describe('buildHandoffPacket', () => {
  it('resolves the objective: record → first task → currentFocus → nextAction → ""', () => {
    const ctx = mkCtx({ currentTasks: ['task one'] })
    const project = mkProject({ currentFocus: 'focus', nextAction: 'next' })
    expect(buildHandoffPacket(project, ctx, mkRecord({ objective: ' from prompt ' }), NOW).objective).toBe(
      'from prompt'
    )
    expect(buildHandoffPacket(project, ctx, mkRecord({ objective: '  ' }), NOW).objective).toBe('task one')
    expect(buildHandoffPacket(project, mkCtx(), mkRecord(), NOW).objective).toBe('focus')
    expect(buildHandoffPacket(mkProject({ nextAction: 'next' }), undefined, undefined, NOW).objective).toBe(
      'next'
    )
    expect(buildHandoffPacket(mkProject(), undefined, undefined, NOW).objective).toBe('')
  })
  it('maps recaps (most recent last) to attempted, each capped at recapChars', () => {
    const long = 'a'.repeat(400)
    const p = buildHandoffPacket(mkProject(), undefined, mkRecord({ recaps: ['one', ' ', long] }), NOW)
    expect(p.attempted).toHaveLength(2)
    expect(p.attempted[0]).toBe('one')
    expect(p.attempted[1]).toHaveLength(CONTEXT_LIMITS.recapChars)
    expect(p.attempted[1].endsWith('…')).toBe(true)
  })
  it('lists files by last edit desc, relative to the project (forward slashes) or absolute when outside', () => {
    const record = mkRecord({
      filesEdited: {
        'c:\\users\\chris\\proj\\src\\a.ts': 100,
        'c:\\users\\chris\\proj\\src\\b.ts': 300,
        'd:\\other\\x.ts': 200
      }
    })
    expect(buildHandoffPacket(mkProject(), undefined, record, NOW).filesChanged).toEqual([
      'src/b.ts',
      'd:\\other\\x.ts',
      'src/a.ts'
    ])
    // forward-slash project path, same answer
    expect(
      buildHandoffPacket(mkProject({ path: 'C:/Users/chris/proj' }), undefined, record, NOW).filesChanged
    ).toEqual(['src/b.ts', 'd:\\other\\x.ts', 'src/a.ts'])
  })
  it('caps filesChanged at 20', () => {
    const filesEdited: Record<string, number> = {}
    for (let i = 0; i < 30; i++) filesEdited[`c:\\users\\chris\\proj\\f${i}.ts`] = i
    const p = buildHandoffPacket(mkProject(), undefined, mkRecord({ filesEdited }), NOW)
    expect(p.filesChanged).toHaveLength(20)
    expect(p.filesChanged[0]).toBe('f29.ts')
  })
  it('carries decisions from the context and the test verdict from the record', () => {
    const p = buildHandoffPacket(
      mkProject(),
      mkCtx({ decisions: ['no shadcn'] }),
      mkRecord({ testStatus: { command: 'npm test', kind: 'test', outcome: 'pass', at: 1 } }),
      NOW
    )
    expect(p.decisions).toEqual(['no shadcn'])
    expect(p.testStatus).toBe('npm test → pass')
    expect(buildHandoffPacket(mkProject(), undefined, mkRecord(), NOW)).not.toHaveProperty('testStatus')
  })
  it('unresolved = the LAST failing command + known bugs, at most 5 total', () => {
    const record = mkRecord({
      commands: [
        { command: 'npm test', kind: 'test', outcome: 'fail', at: 1 },
        { command: 'npm run lint', kind: 'lint', outcome: 'pass', at: 2 },
        { command: 'npm run build', kind: 'build', outcome: 'fail', at: 3 },
        { command: 'git status', kind: 'git', outcome: 'unknown', at: 4 }
      ]
    })
    const ctx = mkCtx({ knownBugs: seq(6, 'bug') })
    expect(buildHandoffPacket(mkProject(), ctx, record, NOW).unresolved).toEqual([
      'npm run build → fail',
      'bug0',
      'bug1',
      'bug2',
      'bug3'
    ])
    expect(buildHandoffPacket(mkProject(), ctx, undefined, NOW).unresolved).toEqual(seq(5, 'bug'))
    expect(buildHandoffPacket(mkProject(), undefined, mkRecord(), NOW).unresolved).toEqual([])
  })
  it('falls back to a failing testStatus when the bounded command list has no failure', () => {
    const record = mkRecord({ testStatus: { command: 'npm test', kind: 'test', outcome: 'fail', at: 1 } })
    expect(buildHandoffPacket(mkProject(), undefined, record, NOW).unresolved).toEqual(['npm test → fail'])
  })
  it('nextAction prefers the project, else the last recap sentence starting with Next/Remaining/TODO/Left to do', () => {
    const recaps = [
      'Next: do not pick me (not the last recap).',
      'Fixed the bug. Next: wire the IPC. Then test.'
    ]
    expect(
      buildHandoffPacket(mkProject({ nextAction: 'ship' }), undefined, mkRecord({ recaps }), NOW).nextAction
    ).toBe('ship')
    expect(buildHandoffPacket(mkProject(), undefined, mkRecord({ recaps }), NOW).nextAction).toBe(
      'Next: wire the IPC.'
    )
    const variants: [string, string][] = [
      ['Done.\nremaining work: tests', 'remaining work: tests'],
      ['Done. TODO add docs.', 'TODO add docs.'],
      ['Done. Left to do: polish', 'Left to do: polish'],
      ['a | b | - Next up: c', 'Next up: c']
    ]
    for (const [recap, want] of variants) {
      expect(buildHandoffPacket(mkProject(), undefined, mkRecord({ recaps: [recap] }), NOW).nextAction).toBe(
        want
      )
    }
    expect(
      buildHandoffPacket(mkProject(), undefined, mkRecord({ recaps: ['Nextel phones. All done.'] }), NOW)
    ).not.toHaveProperty('nextAction')
    expect(buildHandoffPacket(mkProject(), undefined, undefined, NOW)).not.toHaveProperty('nextAction')
  })
  it('sees through markdown in a recap: "**Next:** …", "## Next steps", numbered and bulleted lines', () => {
    const cases: [string, string][] = [
      ['Fixed it. **Next:** wire the `IPC` bridge.', 'Next: wire the IPC bridge.'],
      ['Done. __Remaining__: docs', 'Remaining: docs'],
      ['All green. ## Next steps - run the build', 'Next steps - run the build'],
      ['Summary. 2) TODO: polish', 'TODO: polish'],
      ['Summary.\n* *Left to do*: ship', 'Left to do: ship']
    ]
    for (const [recap, want] of cases) {
      expect(buildHandoffPacket(mkProject(), undefined, mkRecord({ recaps: [recap] }), NOW).nextAction).toBe(
        want
      )
    }
  })
  it('trims command text and never prints an undefined outcome', () => {
    const record = mkRecord({
      testStatus: { command: '  npm test  ', kind: 'test', outcome: 'weird' as never, at: 1 },
      commands: [{ command: ' npm run build ', kind: 'build', outcome: 'fail', at: 2 }]
    })
    const p = buildHandoffPacket(mkProject(), undefined, record, NOW)
    expect(p.testStatus).toBe('npm test → unknown')
    expect(p.unresolved).toEqual(['npm run build → fail'])
    const garbage = mkRecord({
      testStatus: 'npm test' as never,
      commands: [null, 'x', { outcome: 'fail' }] as never
    })
    const q = buildHandoffPacket(mkProject(), undefined, garbage, NOW)
    expect(q).not.toHaveProperty('testStatus')
    expect(q.unresolved).toEqual([])
  })
  it('lists a file edited inside a task worktree by its in-project relative path', () => {
    const record = mkRecord({ filesEdited: { 'c:\\users\\chris\\proj.worktrees\\auth\\src\\a.ts': 1 } })
    expect(buildHandoffPacket(mkProject(), undefined, record, NOW).filesChanged).toEqual(['src/a.ts'])
  })
  it('copies sessionId / model / effort from the record only when present', () => {
    const p = buildHandoffPacket(mkProject(), undefined, mkRecord({ model: 'opus', effort: 'high' }), NOW)
    expect(p).toMatchObject({
      sessionId: 's1',
      model: 'opus',
      effort: 'high',
      projectId: 'p1',
      projectName: 'Demo',
      createdAt: NOW
    })
    const bare = buildHandoffPacket(mkProject(), undefined, undefined, NOW)
    expect(bare).not.toHaveProperty('sessionId')
    expect(bare).not.toHaveProperty('model')
    expect(bare).not.toHaveProperty('effort')
  })
  it('builds a packet from the context alone when there is no record', () => {
    const p = buildHandoffPacket(
      mkProject(),
      mkCtx({ currentTasks: ['t1'], knownBugs: ['b1'], decisions: ['d1'] }),
      undefined,
      NOW
    )
    expect(p).toEqual({
      projectId: 'p1',
      projectName: 'Demo',
      objective: 't1',
      attempted: [],
      filesChanged: [],
      decisions: ['d1'],
      unresolved: ['b1'],
      createdAt: NOW
    })
  })
})

describe('renderHandoffMarkdown', () => {
  it('renders the golden layout', () => {
    const md = renderHandoffMarkdown(
      mkPacket({
        sessionId: 's1',
        objective: 'Ship the thing',
        attempted: ['tried A', 'tried B'],
        filesChanged: ['src/a.ts'],
        decisions: ['no shadcn'],
        testStatus: 'npm test → pass',
        unresolved: ['flaky login'],
        nextAction: 'Wire the IPC',
        model: 'opus',
        effort: 'high'
      })
    )
    expect(md).toBe(
      [
        '# Handoff: Demo',
        '',
        '_Published by Builder Hub 2026-09-16 · model opus / effort high_',
        '',
        '## Objective',
        'Ship the thing',
        '',
        '## Attempted',
        '- tried A',
        '- tried B',
        '',
        '## Files changed',
        '- src/a.ts',
        '',
        '## Tests / build',
        'npm test → pass',
        '',
        '## Unresolved',
        '- flaky login',
        '',
        '## Decisions',
        '- no shadcn',
        '',
        '## Next action',
        'Wire the IPC',
        ''
      ].join('\n')
    )
  })
  it('uses the placeholders for an empty packet and omits Decisions', () => {
    expect(renderHandoffMarkdown(mkPacket())).toBe(
      [
        '# Handoff: Demo',
        '',
        '_Published by Builder Hub 2026-09-16 · model unknown / effort unknown_',
        '',
        '## Objective',
        '(none recorded)',
        '',
        '## Attempted',
        '- (nothing recorded)',
        '',
        '## Files changed',
        '- (none)',
        '',
        '## Tests / build',
        'unknown',
        '',
        '## Unresolved',
        '- (none known)',
        '',
        '## Next action',
        '(decide next action)',
        ''
      ].join('\n')
    )
  })
  it('ends with exactly one newline and survives a bad createdAt', () => {
    const md = renderHandoffMarkdown(mkPacket({ createdAt: NaN }))
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
    expect(md).toContain('_Published by Builder Hub unknown ·')
  })
  it('never prints "undefined" for a missing project name', () => {
    const md = renderHandoffMarkdown(mkPacket({ projectName: undefined as unknown as string }))
    expect(md.startsWith('# Handoff: p1\n')).toBe(true)
    expect(md).not.toContain('undefined')
  })
})

describe('renderProjectContextMarkdown', () => {
  const generatedOn = '2026-09-16 12:00'
  const intro = [
    '# Demo — Builder Hub project context',
    '',
    `_Generated ${generatedOn}. Auto-maintained by Builder Hub (Reindex refreshes the auto fields); edit notes in the Hub, not here._`,
    ''
  ]

  it('renders every section (golden), recent work newest first', () => {
    const ctx = mkCtx({
      purpose: 'A demo app.',
      commands: { dev: 'vite', test: 'vitest run' },
      services: ['react', 'env: STRIPE_KEY'],
      sharedTools: ['trailer-kit'],
      decisions: ['no shadcn'],
      currentTasks: ['ship it'],
      knownBugs: ['flaky login'],
      recentWork: [
        { at: NOW - DAY, summary: 'older' },
        { at: NOW, summary: 'newer' }
      ],
      keyFiles: ['src/a.ts'],
      fingerprint: { branch: 'main', computedAt: 0 }
    })
    const freshness: ContextFreshness = {
      status: 'stale',
      reasons: ['HEAD abc1234 → def5678'],
      checkedAt: NOW
    }
    expect(renderProjectContextMarkdown(mkProject(), ctx, freshness, generatedOn)).toBe(
      [
        ...intro,
        '## Purpose',
        'A demo app.',
        '',
        '## Stack & type',
        '- Type: Web app',
        '- Stack: Vite + React',
        '- Branch: main',
        '',
        '## Freshness',
        'STALE — HEAD abc1234 → def5678',
        '',
        '## Commands',
        '- dev — vite',
        '- test — vitest run',
        '',
        '## Services & dependencies',
        '- react',
        '- env: STRIPE_KEY',
        '',
        '## Shared tools',
        '- trailer-kit',
        '',
        '## Decisions',
        '- no shadcn',
        '',
        '## Current tasks',
        '- ship it',
        '',
        '## Known bugs',
        '- flaky login',
        '',
        '## Recent work',
        '- 2026-09-16 — newer',
        '- 2026-09-15 — older',
        '',
        '## Key files',
        '- src/a.ts',
        ''
      ].join('\n')
    )
  })
  it('omits empty sections but always shows Purpose ("(not set)") and Stack & type', () => {
    expect(renderProjectContextMarkdown(mkProject(), mkCtx(), undefined, generatedOn)).toBe(
      [
        ...intro,
        '## Purpose',
        '(not set)',
        '',
        '## Stack & type',
        '- Type: Web app',
        '- Stack: Vite + React',
        ''
      ].join('\n')
    )
  })
  it('renders fresh / unknown freshness and an Architecture section when set', () => {
    const md = renderProjectContextMarkdown(
      mkProject({ stack: '' }),
      mkCtx({ architecture: 'main is thin' }),
      { status: 'unknown', reasons: ['never indexed'], checkedAt: NOW },
      generatedOn
    )
    expect(md).toContain('## Architecture\nmain is thin\n')
    expect(md).toContain('## Freshness\nnot indexed — never indexed\n')
    expect(md).toContain('## Stack & type\n- Type: Web app\n')
    expect(md).not.toContain('- Stack:')
    expect(renderProjectContextMarkdown(mkProject(), mkCtx(), fresh, generatedOn)).toContain(
      '## Freshness\nfresh\n'
    )
  })
  it('falls back to the raw type for an unknown project type', () => {
    const md = renderProjectContextMarkdown(
      mkProject({ type: 'weird' as Project['type'] }),
      mkCtx(),
      undefined,
      generatedOn
    )
    expect(md).toContain('- Type: weird')
  })
  it('never prints "undefined" for a missing project name', () => {
    const md = renderProjectContextMarkdown(
      mkProject({ name: undefined as unknown as string }),
      mkCtx(),
      undefined,
      generatedOn
    )
    expect(md.startsWith('# p1 — Builder Hub project context\n')).toBe(true)
    expect(md).not.toContain('undefined')
  })
})

describe('buildSessionStartContext', () => {
  const ctx = mkCtx({
    commands: {
      dev: 'vite',
      build: 'vite build',
      test: 'vitest run',
      lint: 'eslint .',
      format: 'prettier -w',
      zzz: 'x'
    },
    fingerprint: { branch: 'main', computedAt: 0 }
  })
  const packet = mkPacket({
    objective: 'Ship the thing',
    attempted: ['tried A', 'tried B'],
    filesChanged: ['src/a.ts', 'src/b.ts'],
    testStatus: 'npm test → pass',
    unresolved: ['flaky login'],
    nextAction: 'Wire the IPC',
    model: 'opus',
    effort: 'high'
  })
  const full: SessionStartInput = {
    project: mkProject(),
    ctx,
    packet,
    freshness: fresh,
    source: 'startup',
    otherSessions: ['tab 2 · working on auth', 'external · idle'],
    sharedTools: ['trailer-kit', 'agent-pack'],
    paths: PATHS
  }
  const GOLDEN = [
    '[Builder Hub context — Demo (Web app · Vite + React) · branch main · context fresh]',
    'Run: dev: vite · build: vite build · test: vitest run · lint: eslint .',
    'Task packet (2026-09-16, opus/high):',
    '- Objective: Ship the thing',
    '- Attempted: tried A | tried B',
    '- Files changed: src/a.ts, src/b.ts',
    '- Tests: npm test → pass',
    '- Unresolved: flaky login',
    '- Next: Wire the IPC',
    'Other terminals on this project: tab 2 · working on auth || external · idle',
    'Shared tools used here (Creator Stack): trailer-kit, agent-pack',
    'Deeper context, read on demand only what you need: C:\\Users\\chris\\.claude\\builder-hub\\context\\p1.md; Creator Stack: C:\\Users\\chris\\.claude\\builder-hub\\creator-stack.md; project registry: C:\\Users\\chris\\.claude\\builder-hub-projects.md.',
    SESSION_START_RULES
  ].join('\n')

  it('renders the exact template (golden)', () => {
    expect(buildSessionStartContext(full)).toBe(GOLDEN)
  })
  it('includes the packet for startup / clear / compact / fork but NOT for resume', () => {
    for (const source of ['startup', 'clear', 'compact', 'fork', 'something-new']) {
      expect(buildSessionStartContext({ ...full, source })).toContain('Task packet (')
    }
    const resumed = buildSessionStartContext({ ...full, source: 'resume' })
    expect(resumed).not.toContain('Task packet')
    expect(resumed).not.toContain('- Objective:')
    expect(resumed).toBe(
      GOLDEN.split('\n')
        .filter((l) => !l.startsWith('Task packet') && !l.startsWith('- '))
        .join('\n')
    )
  })
  it('says STALE in the header and adds the warning line with the reasons', () => {
    const stale: ContextFreshness = {
      status: 'stale',
      reasons: ['HEAD abc1234 → def5678', 'CLAUDE.md changed'],
      checkedAt: NOW
    }
    const lines = buildSessionStartContext({ ...full, freshness: stale }).split('\n')
    expect(lines[0]).toBe(
      '[Builder Hub context — Demo (Web app · Vite + React) · branch main · context STALE]'
    )
    expect(lines[1]).toBe(
      '⚠ STALE: HEAD abc1234 → def5678; CLAUDE.md changed — trust the files, not this summary.'
    )
    expect(lines[2]).toMatch(/^Run: /)
  })
  it('falls back to a generic stale reason, and says "not indexed" for unknown (no warning line)', () => {
    const noReason = buildSessionStartContext({
      ...full,
      freshness: { status: 'stale', reasons: [], checkedAt: NOW }
    })
    expect(noReason.split('\n')[1]).toBe(
      '⚠ STALE: source moved since indexed — trust the files, not this summary.'
    )
    const unknown = buildSessionStartContext({
      ...full,
      ctx: undefined,
      freshness: { status: 'unknown', reasons: ['never indexed'], checkedAt: NOW }
    })
    expect(unknown.split('\n')[0]).toBe(
      '[Builder Hub context — Demo (Web app · Vite + React) · context not indexed]'
    )
    expect(unknown).not.toContain('⚠')
    expect(unknown).not.toContain('Run:')
  })
  it('omits the stack and branch parts when absent', () => {
    const out = buildSessionStartContext({ ...full, project: mkProject({ stack: '' }), ctx: mkCtx() })
    expect(out.split('\n')[0]).toBe('[Builder Hub context — Demo (Web app) · context fresh]')
  })
  it('lists at most 4 commands, well-known ones first', () => {
    const many = mkCtx({ commands: { zeta: 'z', alpha: 'a', lint: 'l', test: 't', dev: 'd' } })
    expect(buildSessionStartContext({ ...full, ctx: many }).split('\n')[1]).toBe(
      'Run: dev: d · test: t · lint: l · alpha: a'
    )
  })
  it('omits the packet block when there is no packet or the packet is empty, and omits empty lines', () => {
    const bare = buildSessionStartContext({
      project: mkProject(),
      freshness: fresh,
      source: 'startup',
      otherSessions: [],
      sharedTools: [],
      paths: { registry: 'R', creatorStack: 'S' }
    })
    expect(bare).toBe(
      [
        '[Builder Hub context — Demo (Web app · Vite + React) · context fresh]',
        'Deeper context, read on demand only what you need: Creator Stack: S; project registry: R.',
        SESSION_START_RULES
      ].join('\n')
    )
    expect(buildSessionStartContext({ ...full, packet: mkPacket() })).not.toContain('Task packet')
  })
  it('bounds the packet lines: last 3 attempted, first 8 files, first 3 unresolved, recapChars per entry', () => {
    const big = mkPacket({
      objective: 'o'.repeat(500),
      attempted: seq(5, 'att'),
      filesChanged: seq(10, 'f'),
      unresolved: seq(5, 'u'),
      nextAction: 'n'.repeat(500)
    })
    const lines = buildSessionStartContext({ ...full, packet: big, maxChars: 10_000 }).split('\n')
    const line = (prefix: string): string => lines.find((l) => l.startsWith(prefix))!
    expect(line('- Objective: ')).toHaveLength('- Objective: '.length + CONTEXT_LIMITS.recapChars)
    expect(line('- Attempted: ')).toBe('- Attempted: att2 | att3 | att4')
    expect(line('- Files changed: ')).toBe('- Files changed: f0, f1, f2, f3, f4, f5, f6, f7')
    expect(line('- Unresolved: ')).toBe('- Unresolved: u0 | u1 | u2')
    expect(line('- Next: ')).toHaveLength('- Next: '.length + CONTEXT_LIMITS.recapChars)
    expect(line('Task packet')).toBe('Task packet (2026-09-16):')
  })
  it('shows model alone when effort is unknown (and effort alone when model is unknown)', () => {
    const out = buildSessionStartContext({ ...full, packet: mkPacket({ objective: 'x', model: 'sonnet' }) })
    expect(out).toContain('Task packet (2026-09-16, sonnet):')
    expect(
      buildSessionStartContext({ ...full, packet: mkPacket({ objective: 'x', effort: 'high' }) })
    ).toContain('Task packet (2026-09-16, high):')
  })
  it('on resume keeps the freshness note even though the packet is dropped', () => {
    const stale: ContextFreshness = { status: 'stale', reasons: ['HEAD a → b'], checkedAt: NOW }
    const lines = buildSessionStartContext({ ...full, source: 'resume', freshness: stale }).split('\n')
    expect(lines[0]).toBe(
      '[Builder Hub context — Demo (Web app · Vite + React) · branch main · context STALE]'
    )
    expect(lines[1]).toBe('⚠ STALE: HEAD a → b — trust the files, not this summary.')
    expect(lines.some((l) => l.startsWith('Task packet') || l.startsWith('- '))).toBe(false)
  })
  it('uses CONTEXT_LIMITS.injectionChars when maxChars is absent or not a number', () => {
    expect(buildSessionStartContext({ ...full, maxChars: NaN })).toBe(GOLDEN)
    expect(buildSessionStartContext({ ...full, maxChars: '5' as unknown as number })).toBe(GOLDEN)
    const tight = buildSessionStartContext({ ...full, maxChars: 1 })
    expect(tight.length).toBeGreaterThan(1) // the header and rules lines are never dropped
  })
  it('a 20 kB packet still yields ≤ injectionChars, starting with the header and keeping the rules', () => {
    const huge = mkPacket({
      objective: 'O'.repeat(5000),
      attempted: seq(10, '').map(() => 'A'.repeat(1500)),
      filesChanged: seq(20, '').map((_, i) => `src/${'f'.repeat(200)}${i}.ts`),
      unresolved: seq(5, '').map(() => 'U'.repeat(1000)),
      nextAction: 'N'.repeat(3000)
    })
    expect(JSON.stringify(huge).length).toBeGreaterThan(20_000)
    const out = buildSessionStartContext({ ...full, packet: huge })
    expect(out.length).toBeLessThanOrEqual(CONTEXT_LIMITS.injectionChars)
    expect(out.startsWith('[Builder Hub context')).toBe(true)
    expect(out).toContain('Rules:')
    expect(out).toContain('Other terminals on this project')
  })
  it('trims at a line boundary, dropping from the END of the packet block first', () => {
    const out = buildSessionStartContext({ ...full, maxChars: GOLDEN.length - 1 })
    expect(out).toBe(
      GOLDEN.split('\n')
        .filter((l) => !l.startsWith('- Next:'))
        .join('\n')
    )
    expect(out.length).toBeLessThanOrEqual(GOLDEN.length - 1)
  })
  it('after the packet block, drops other terminals, shared tools, pointers, the run line, then the stale note', () => {
    const stale: ContextFreshness = { status: 'stale', reasons: ['HEAD a → b'], checkedAt: NOW }
    const input: SessionStartInput = { ...full, freshness: stale }
    const whole = buildSessionStartContext(input)
    const isPacketLine = (l: string): boolean => l.startsWith('Task packet') || l.startsWith('- ')
    const packetGone = whole
      .split('\n')
      .filter((l) => !isPacketLine(l))
      .join('\n')
    expect(packetGone).not.toBe(whole)
    let out = buildSessionStartContext({ ...input, maxChars: packetGone.length })
    expect(out).toBe(packetGone)
    for (const prefix of ['Other terminals', 'Shared tools', 'Deeper context', 'Run:', '⚠ STALE']) {
      expect(out).toContain(prefix)
      const next = buildSessionStartContext({ ...input, maxChars: out.length - 1 })
      expect(next).toBe(
        out
          .split('\n')
          .filter((l) => !l.startsWith(prefix))
          .join('\n')
      )
      out = next
    }
    expect(out).toBe(`${whole.split('\n')[0]}\n${SESSION_START_RULES}`)
  })
  it('drops a packet header whose items were all trimmed away', () => {
    const noItems = GOLDEN.split('\n')
      .filter((l) => !l.startsWith('- '))
      .join('\n')
    const out = buildSessionStartContext({ ...full, maxChars: noItems.length })
    expect(out).toBe(
      noItems
        .split('\n')
        .filter((l) => !l.startsWith('Task packet'))
        .join('\n')
    )
  })
  it('never drops the first line or the rules line, even under an impossible budget', () => {
    const out = buildSessionStartContext({ ...full, maxChars: 10 })
    expect(out).toBe(`${GOLDEN.split('\n')[0]}\n${SESSION_START_RULES}`)
  })
  it('never contains file contents: only paths are referenced', () => {
    expect(buildSessionStartContext(full)).not.toContain('# Demo — Builder Hub project context')
  })
  it('keeps every entry on ONE physical line: embedded newlines / CRLF in any value are squashed', () => {
    const messy: SessionStartInput = {
      ...full,
      project: mkProject({ name: 'Demo\r\nApp', stack: 'Vite\n+ React' }),
      ctx: mkCtx({ commands: { dev: 'vite\n--host' } }),
      packet: mkPacket({
        objective: 'line one\r\nline two',
        attempted: ['a\nb'],
        filesChanged: ['src/a.ts'],
        unresolved: ['bug\n\twith tab'],
        nextAction: 'next\n\n\nstep'
      }),
      freshness: { status: 'stale', reasons: ['HEAD a → b\nextra'], checkedAt: NOW },
      otherSessions: ['tab 2\nworking'],
      sharedTools: ['kit\none']
    }
    const out = buildSessionStartContext(messy)
    const lines = out.split('\n')
    expect(lines[0]).toBe('[Builder Hub context — Demo App (Web app · Vite + React) · context STALE]')
    expect(lines[1]).toBe('⚠ STALE: HEAD a → b extra — trust the files, not this summary.')
    expect(lines[2]).toBe('Run: dev: vite --host')
    expect(lines).toContain('- Objective: line one line two')
    expect(lines).toContain('- Attempted: a b')
    expect(lines).toContain('- Unresolved: bug with tab')
    expect(lines).toContain('- Next: next step')
    expect(lines).toContain('Other terminals on this project: tab 2 working')
    expect(lines).toContain('Shared tools used here (Creator Stack): kit one')
    expect(out).not.toMatch(/\r/)
    expect(lines.every((l) => l.length > 0)).toBe(true)
  })
  it('lists only the pointer paths it was given, and omits the line when there are none', () => {
    const partial = buildSessionStartContext({
      ...full,
      paths: { registry: 'R', creatorStack: '', contextFile: undefined }
    })
    expect(partial).toContain('Deeper context, read on demand only what you need: project registry: R.')
    expect(partial).not.toContain('Creator Stack: ;')
    const none = buildSessionStartContext({
      ...full,
      paths: undefined as unknown as SessionStartInput['paths']
    })
    expect(none).not.toContain('Deeper context')
    expect(none).toContain('Rules:')
  })
})

describe('buildPromptContext', () => {
  const entry = { id: 'e1', name: 'Trailer kit' } as CreatorStackEntry
  const m1: CapabilityMatch = { entry, matched: 'trailer kit', score: 1 }
  const m2: CapabilityMatch = { entry, matched: 'video', score: 0.5 }

  it('joins rendered cards with a blank line', () => {
    expect(buildPromptContext([m1, m2], (m) => `card:${m.matched}`)).toBe('card:trailer kit\n\ncard:video')
  })
  it('drops empty renders and returns "" with no matches', () => {
    expect(buildPromptContext([m1, m2], (m) => (m === m1 ? '' : ' x '))).toBe('x')
    expect(buildPromptContext([], () => 'never')).toBe('')
    expect(buildPromptContext(undefined as unknown as CapabilityMatch[], () => 'never')).toBe('')
  })
})

describe('computeFreshness — failed git probe', () => {
  it('reports unknown (not fresh) when the stored fingerprint had git facts but the live probe has none', () => {
    const ctx = {
      ...emptyProjectContext('p', 1),
      fingerprint: { head: 'abc1234', branch: 'main', dirty: 0, computedAt: 1 }
    }
    const f = computeFreshness(ctx, { computedAt: 2 }, 2)
    expect(f.status).toBe('unknown')
    expect(f.reasons[0]).toMatch(/git probe failed/)
    // a repo that never had git facts stored still compares the rest normally
    const noGit = { ...emptyProjectContext('p', 1), fingerprint: { claudeMdMtime: 5, computedAt: 1 } }
    expect(computeFreshness(noGit, { claudeMdMtime: 5, computedAt: 2 }, 2).status).toBe('fresh')
    expect(computeFreshness(noGit, { claudeMdMtime: 6, computedAt: 2 }, 2).status).toBe('stale')
  })
})

describe('freshness wording: failed probe vs never indexed', () => {
  const project = { id: 'p', name: 'P', path: 'C:\\p', type: 'web-app', stack: '' } as Project
  const paths = { registry: 'C:\\r.md', creatorStack: 'C:\\cs.md' }
  it('the injection header says "unknown (git probe failed)" for a failed probe and "not indexed" when never indexed', () => {
    const failed = buildSessionStartContext({
      project,
      freshness: { status: 'unknown', reasons: ['git probe failed — freshness unknown'], checkedAt: 1 },
      source: 'startup',
      otherSessions: [],
      sharedTools: [],
      paths
    })
    expect(failed.split('\n')[0]).toContain('context unknown (git probe failed)')
    const never = buildSessionStartContext({
      project,
      freshness: { status: 'unknown', reasons: ['never indexed'], checkedAt: 1 },
      source: 'startup',
      otherSessions: [],
      sharedTools: [],
      paths
    })
    expect(never.split('\n')[0]).toContain('context not indexed')
  })
  it('the rendered context file says the same', () => {
    const ctx = emptyProjectContext('p', 1)
    const md = renderProjectContextMarkdown(
      project,
      ctx,
      { status: 'unknown', reasons: ['git probe failed — freshness unknown'], checkedAt: 1 },
      '2026-09-16'
    )
    expect(md).toContain('unknown (git probe failed)')
  })
})
