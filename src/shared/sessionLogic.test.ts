import { describe, it, expect } from 'vitest'
import {
  HOOK_URL,
  HUB_HOOK_EVENTS,
  buildHookCommand,
  ensureHubHooks,
  hubWorktrees,
  normPath,
  parseUnifiedDiff,
  parseWorktreeList,
  resolveSessionProject,
  sanitizeBranch,
  stateForHookEvent
} from './sessionLogic'
import type { Project } from './types'

const proj = (over: Partial<Project>): Project => ({
  id: 'x',
  name: 'X',
  path: 'C:\\Users\\chris\\proj',
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

describe('ensureHubHooks', () => {
  it('adds all four hub hooks to an empty settings file', () => {
    const { next, changed } = ensureHubHooks('')
    expect(changed).toBe(true)
    const parsed = JSON.parse(next)
    for (const ev of HUB_HOOK_EVENTS) {
      expect(JSON.stringify(parsed.hooks[ev])).toContain(HOOK_URL)
    }
  })
  it('is idempotent', () => {
    const once = ensureHubHooks('{}')
    const twice = ensureHubHooks(once.next)
    expect(twice.changed).toBe(false)
    expect(twice.next).toBe(once.next)
  })
  it('preserves unrelated settings and existing user hooks on the same event', () => {
    const doc = JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(npm:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] }
    })
    const { next } = ensureHubHooks(doc)
    const parsed = JSON.parse(next)
    expect(parsed.model).toBe('opus')
    expect(parsed.permissions.allow).toEqual(['Bash(npm:*)'])
    expect(JSON.stringify(parsed.hooks.Stop)).toContain('echo user-hook')
    expect(JSON.stringify(parsed.hooks.Stop)).toContain(HOOK_URL)
  })
  it('refuses to touch invalid JSON', () => {
    const { next, changed, error } = ensureHubHooks('{ not json')
    expect(changed).toBe(false)
    expect(next).toBe('{ not json')
    expect(error).toBeTruthy()
  })
  it('the hook command pipes stdin to the hub URL', () => {
    expect(buildHookCommand()).toContain('--data-binary @-')
    expect(buildHookCommand()).toContain(HOOK_URL)
  })
})

describe('stateForHookEvent', () => {
  it('maps the hub events and ignores others', () => {
    expect(stateForHookEvent('UserPromptSubmit')).toBe('working')
    expect(stateForHookEvent('PostToolUse')).toBe('working') // waiting → working after approval
    expect(stateForHookEvent('Notification')).toBe('waiting')
    expect(stateForHookEvent('Stop')).toBe('done')
    expect(stateForHookEvent('SessionEnd')).toBe('ended')
    expect(stateForHookEvent('PreToolUse')).toBeNull()
  })
})

describe('ensureHubHooks — upgrades & shape safety', () => {
  it('upgrades a stale hub-owned command in place', () => {
    const stale = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `curl -s -m 2 -X POST ${HOOK_URL} --data-binary @-` }] }] }
    })
    const { next, changed } = ensureHubHooks(stale)
    expect(changed).toBe(true)
    const stop = JSON.stringify(JSON.parse(next).hooks.Stop)
    expect(stop).toContain('--noproxy')
    expect(stop).not.toContain('-s -m 2 -X') // old command gone, not duplicated
    expect(JSON.parse(next).hooks.Stop).toHaveLength(1)
  })
  it('refuses to touch hooks with a non-object shape', () => {
    const doc = JSON.stringify({ hooks: 'oops' })
    const r = ensureHubHooks(doc)
    expect(r.changed).toBe(false)
    expect(r.error).toBeTruthy()
    expect(r.next).toBe(doc)
  })
  it('refuses to touch a non-array event entry', () => {
    const doc = JSON.stringify({ hooks: { Stop: { hooks: [] } } })
    const r = ensureHubHooks(doc)
    expect(r.changed).toBe(false)
    expect(r.error).toContain('Stop')
  })
})

describe('normPath', () => {
  it('unifies separators, trailing slashes and case', () => {
    expect(normPath('C:/Users/chris/Proj.worktrees/fix/')).toBe('c:\\users\\chris\\proj.worktrees\\fix')
    expect(normPath('C:\\Users\\chris\\proj')).toBe(normPath('c:/users/CHRIS/proj'))
  })
})

describe('sanitizeBranch', () => {
  it('kebab-cases and strips invalid characters', () => {
    expect(sanitizeBranch('Fix Login Flow!')).toBe('fix-login-flow')
    expect(sanitizeBranch('a//b:c*d')).toBe('a-b-c-d')
  })
  it('never ends with .lock or dots/dashes (even repeated .lock)', () => {
    expect(sanitizeBranch('thing.lock')).toBe('thing')
    expect(sanitizeBranch('x.lock.lock')).toBe('x')
    expect(sanitizeBranch('--task--')).toBe('task')
  })
  it('falls back to "task"', () => {
    expect(sanitizeBranch('***')).toBe('task')
  })
})

describe('parseWorktreeList + hubWorktrees', () => {
  const porcelain = [
    'worktree C:/Users/chris/proj',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree C:/Users/chris/proj.worktrees/fix-login',
    'HEAD def456',
    'branch refs/heads/hub/fix-login',
    '',
    'worktree C:/Users/chris/elsewhere',
    'HEAD 999',
    'detached',
    ''
  ].join('\n')

  it('parses entries and strips refs/heads/', () => {
    const all = parseWorktreeList(porcelain)
    expect(all).toEqual([
      { path: 'C:/Users/chris/proj', branch: 'main' },
      { path: 'C:/Users/chris/proj.worktrees/fix-login', branch: 'hub/fix-login' }
    ])
  })
  it('keeps only hub/ tasks with the task name extracted', () => {
    const tasks = hubWorktrees(parseWorktreeList(porcelain))
    expect(tasks).toEqual([
      { path: 'C:/Users/chris/proj.worktrees/fix-login', branch: 'hub/fix-login', task: 'fix-login' }
    ])
  })
  it('tolerates CRLF and missing trailing blank line', () => {
    const out = parseWorktreeList('worktree C:/x\r\nHEAD 1\r\nbranch refs/heads/main')
    expect(out).toEqual([{ path: 'C:/x', branch: 'main' }])
  })
})

describe('parseUnifiedDiff', () => {
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 111..222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ'
  ].join('\n')

  it('splits files and counts adds/dels', () => {
    const files = parseUnifiedDiff(diff)
    expect(files.map((f) => f.path)).toEqual(['src/app.ts', 'gone.txt', 'img.png'])
    expect(files[0].adds).toBe(2)
    expect(files[0].dels).toBe(1)
    expect(files[1].deleted).toBe(true)
    expect(files[2].binary).toBe(true)
  })
  it('classifies line types (headers are meta, not add/del)', () => {
    const f = parseUnifiedDiff(diff)[0]
    const types = f.lines.map((l) => l.t)
    expect(types).toContain('hunk')
    expect(types).toContain('ctx')
    // '--- a/…' and '+++ b/…' must not count as del/add
    expect(f.lines.filter((l) => l.t === 'del')).toHaveLength(1)
    expect(f.lines.filter((l) => l.t === 'add')).toHaveLength(2)
  })
  it('handles an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
  it('counts deleted "--" lines (Lua comments) inside hunks as dels, not headers', () => {
    const luaDiff = [
      'diff --git a/init.luau b/init.luau',
      '--- a/init.luau',
      '+++ b/init.luau',
      '@@ -1,2 +1,2 @@',
      '--- old lua comment', // del line whose content starts with '--'
      '+++ new lua comment', // add line whose content starts with '++'
      ' local x = 1'
    ].join('\n')
    const f = parseUnifiedDiff(luaDiff)[0]
    expect(f.dels).toBe(1)
    expect(f.adds).toBe(1)
  })
})

describe('resolveSessionProject', () => {
  const projects = [proj({ name: 'Proj', path: 'C:\\Users\\chris\\proj' })]

  it('matches the project root and children', () => {
    expect(resolveSessionProject('C:\\Users\\chris\\proj', projects).label).toBe('Proj')
    expect(resolveSessionProject('c:/users/chris/proj/src', projects).label).toBe('Proj')
  })
  it('recognizes task worktrees and extracts the task', () => {
    const r = resolveSessionProject('C:\\Users\\chris\\proj.worktrees\\fix-login', projects)
    expect(r.label).toBe('Proj · fix-login')
    expect(r.task).toBe('fix-login')
  })
  it('does not match sibling folders sharing a prefix', () => {
    const r = resolveSessionProject('C:\\Users\\chris\\proj-two\\x', projects)
    expect(r.project).toBeUndefined()
    expect(r.label).toBe('x')
  })
  it('falls back to the last path segment for unknown folders', () => {
    expect(resolveSessionProject('D:\\elsewhere\\thing', projects).label).toBe('thing')
  })
})
