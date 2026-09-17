import { describe, it, expect } from 'vitest'
import {
  HOOK_URL,
  HUB_HOOK_EVENTS,
  HUB_HOOK_SPECS,
  PTY_CLAIM_GRACE_MS,
  STATUSLINE_URL,
  applyTargetError,
  buildHookCommand,
  buildStatusLineCommand,
  ensureHubHooks,
  ensureHubStatusLine,
  hubWorktrees,
  isUnclaimedPty,
  normPath,
  parseUnifiedDiff,
  parseWorktreeList,
  resolveSessionProject,
  sanitizeBranch,
  stateForHookEvent,
  unclaimedPtyCwds,
  unclaimedPtyIn
} from './sessionLogic'
import type { ClaudePtyBinding, SessionStateOf } from './sessionLogic'
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
    expect(stateForHookEvent('SubagentStop')).toBeNull()
  })
})

describe('ensureHubHooks — upgrades & shape safety', () => {
  it('upgrades a stale hub-owned command in place', () => {
    const stale = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `curl -s -m 2 -X POST ${HOOK_URL} --data-binary @-` }] }]
      }
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

describe('resolveSessionProject — nested projects', () => {
  const parent = { id: 'a', name: 'Fable week', path: 'C:\\Users\\chris\\Fable-5-1-week' } as Project
  const child = {
    id: 'b',
    name: 'leaguecast',
    path: 'C:\\Users\\chris\\Fable-5-1-week\\projects\\leaguecast'
  } as Project
  it('picks the LONGEST matching project path regardless of registry order', () => {
    const cwd = 'C:\\Users\\chris\\Fable-5-1-week\\projects\\leaguecast\\src'
    expect(resolveSessionProject(cwd, [parent, child]).project?.id).toBe('b')
    expect(resolveSessionProject(cwd, [child, parent]).project?.id).toBe('b')
    expect(resolveSessionProject('C:/Users/chris/Fable-5-1-week/projects', [parent, child]).project?.id).toBe(
      'a'
    )
  })
  it("a nested project's task worktree still wins over the parent project", () => {
    const cwd = 'C:\\Users\\chris\\Fable-5-1-week\\projects\\leaguecast.worktrees\\fix-x\\lib'
    const r = resolveSessionProject(cwd, [parent, child])
    expect(r.project?.id).toBe('b')
    expect(r.task).toBe('fix-x')
    expect(r.label).toBe('leaguecast · fix-x')
  })
})

describe('hook wiring — matchers, fail-silent command, status line (2026-09 upgrade)', () => {
  it('wires every spec event, with the PreToolUse matcher and a fail-silent command', () => {
    const { next, changed } = ensureHubHooks('{}')
    expect(changed).toBe(true)
    const s = JSON.parse(next) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    for (const spec of HUB_HOOK_SPECS) {
      expect(s.hooks[spec.event]).toHaveLength(1)
      expect(s.hooks[spec.event][0].matcher).toBe(spec.matcher)
      expect(s.hooks[spec.event][0].hooks[0].command).toBe(buildHookCommand())
    }
    expect(buildHookCommand().endsWith('|| cd .')).toBe(true)
    expect(buildHookCommand()).toContain(HOOK_URL)
  })
  it('upgrades an older Hub wiring in place: new command, matcher added, no duplicates, user hooks kept', () => {
    const old = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] },
          { hooks: [{ type: 'command', command: `curl -s -X POST ${HOOK_URL} --data-binary @-` }] }
        ],
        Stop: [{ hooks: [{ type: 'command', command: `curl -s -X POST ${HOOK_URL} --data-binary @-` }] }]
      }
    })
    const { next, changed } = ensureHubHooks(old)
    expect(changed).toBe(true)
    const s = JSON.parse(next) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    expect(s.hooks.PreToolUse).toHaveLength(2)
    expect(s.hooks.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo user-hook' }]
    })
    expect(s.hooks.PreToolUse[1].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit')
    expect(s.hooks.PreToolUse[1].hooks[0].command).toBe(buildHookCommand())
    expect(s.hooks.Stop[0].matcher).toBeUndefined()
    expect(s.hooks.SessionStart).toHaveLength(1)
    // idempotent afterwards
    expect(ensureHubHooks(next).changed).toBe(false)
  })
  it('drops a stray matcher from a hub-owned entry on an unfiltered event', () => {
    const wired = ensureHubHooks('{}').next
    const s = JSON.parse(wired) as { hooks: Record<string, { matcher?: string }[]> }
    s.hooks.Stop[0].matcher = 'Bash'
    const { next, changed } = ensureHubHooks(JSON.stringify(s))
    expect(changed).toBe(true)
    expect((JSON.parse(next) as typeof s).hooks.Stop[0].matcher).toBeUndefined()
  })
  it('status line: installs only when absent or ours, never replaces a foreign one, removes only ours', () => {
    const a = ensureHubStatusLine('{}', true)
    expect(a.changed).toBe(true)
    expect(a.installed).toBe(true)
    const s = JSON.parse(a.next) as { statusLine: { type: string; command: string } }
    expect(s.statusLine.type).toBe('command')
    expect(s.statusLine.command).toBe(buildStatusLineCommand())
    expect(buildStatusLineCommand()).toContain(STATUSLINE_URL)
    // idempotent
    expect(ensureHubStatusLine(a.next, true).changed).toBe(false)
    // foreign is untouched
    const foreign = JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/statusline.sh' } })
    const f = ensureHubStatusLine(foreign, true)
    expect(f.changed).toBe(false)
    expect(f.foreign).toBe(true)
    expect(f.next).toBe(foreign)
    expect(ensureHubStatusLine(foreign, false).changed).toBe(false)
    // remove ours, keep the rest of the file
    const r = ensureHubStatusLine(JSON.stringify({ model: 'opus', statusLine: s.statusLine }), false)
    expect(r.changed).toBe(true)
    expect(JSON.parse(r.next)).toEqual({ model: 'opus' })
    // garbage
    expect(ensureHubStatusLine('nope', true).error).toBeTruthy()
    expect(ensureHubStatusLine('[]', true).error).toBeTruthy()
  })
  it('PreToolUse implies working', () => {
    expect(stateForHookEvent('PreToolUse')).toBe('working')
    expect(stateForHookEvent('PostModelSwitch')).toBeNull()
  })
})

describe('embedded PTY ownership — claim + apply safety', () => {
  const NOW = 1_000_000
  const pty = (over: Partial<ClaudePtyBinding>): ClaudePtyBinding => ({
    id: 'pty-1',
    cwd: 'C:\\Users\\chris\\proj',
    claudeSessionId: 'A',
    createdAt: NOW - 60_000,
    ...over
  })
  const stateOf =
    (states: Record<string, string>): SessionStateOf =>
    (id) =>
      Object.hasOwn(states, id) ? states[id] : undefined

  it('a PTY bound to a live session is owned; one whose session ended is free', () => {
    const p = pty({})
    expect(isUnclaimedPty(p, stateOf({ A: 'working' }), NOW)).toBe(false)
    expect(isUnclaimedPty(p, stateOf({ A: 'done' }), NOW)).toBe(false)
    expect(isUnclaimedPty(p, stateOf({ A: 'ended' }), NOW)).toBe(true)
    expect(isUnclaimedPty(pty({ claudeSessionId: undefined }), stateOf({}), NOW)).toBe(true)
  })
  it('a minted id that never reported in keeps the PTY owned for the grace period only', () => {
    const fresh = pty({ createdAt: NOW - 1_000 })
    expect(isUnclaimedPty(fresh, stateOf({}), NOW)).toBe(false)
    expect(isUnclaimedPty(fresh, stateOf({}), NOW + PTY_CLAIM_GRACE_MS + 1)).toBe(true)
  })
  it('unclaimedPtyIn: exactly one free PTY in the folder, matched via normPath; ambiguity adopts nothing', () => {
    const ended = stateOf({ A: 'ended', B: 'ended' })
    const one = [pty({ id: 'p1' }), pty({ id: 'p2', cwd: 'C:\\Users\\chris\\other' })]
    expect(unclaimedPtyIn('c:/users/chris/proj/', one, ended, NOW)?.id).toBe('p1')
    expect(unclaimedPtyIn('C:\\Users\\chris\\proj', [], ended, NOW)).toBeUndefined()
    const two = [pty({ id: 'p1' }), pty({ id: 'p2', claudeSessionId: 'B' })]
    expect(unclaimedPtyIn('C:\\Users\\chris\\proj', two, ended, NOW)).toBeUndefined()
    // the live tab is never offered to a session that is not its own
    expect(
      unclaimedPtyIn('C:\\Users\\chris\\proj', [pty({})], stateOf({ A: 'working' }), NOW)
    ).toBeUndefined()
  })
  it('unclaimedPtyCwds: only folders whose Hub terminal is free', () => {
    const bindings = [
      pty({ id: 'p1' }),
      pty({ id: 'p2', cwd: 'C:\\Users\\chris\\free', claudeSessionId: 'B' })
    ]
    const cwds = unclaimedPtyCwds(bindings, stateOf({ A: 'working', B: 'ended' }), NOW)
    expect([...cwds]).toEqual(['c:\\users\\chris\\free'])
  })
  it('applyTargetError: a session bound by id owns its PTY regardless of neighbours', () => {
    const rows = [
      { sessionId: 'A', cwd: 'C:\\Users\\chris\\proj', state: 'done' },
      { sessionId: 'B', cwd: 'C:\\Users\\chris\\proj', state: 'working' }
    ]
    expect(applyTargetError(rows[0], rows, new Set(['A']))).toBeUndefined()
  })
  it('applyTargetError: a folder-matched session is refused while any other live session shares the folder', () => {
    const rows = [
      { sessionId: 'A', cwd: 'C:\\Users\\chris\\proj', state: 'working' },
      { sessionId: 'B', cwd: 'c:/users/chris/proj', state: 'done' },
      { sessionId: 'C', cwd: 'C:\\Users\\chris\\proj', state: 'ended' }
    ]
    // B (external, not bound) must not have its recommendation typed into A's terminal
    expect(applyTargetError(rows[1], rows, new Set(['A']))).toMatch(/shares this folder/)
    // after A ended (a /clear), the lone new session in the folder may use the fallback
    const after = [
      { sessionId: 'A', cwd: 'C:\\Users\\chris\\proj', state: 'ended' },
      { sessionId: 'A2', cwd: 'C:\\Users\\chris\\proj', state: 'done' }
    ]
    expect(applyTargetError(after[1], after, new Set(['A']))).toBeUndefined()
    // …but not once an external session is live in the same folder too
    const ambiguous = [...after, { sessionId: 'B', cwd: 'C:\\Users\\chris\\proj', state: 'done' }]
    expect(applyTargetError(ambiguous[1], ambiguous, new Set(['A']))).toMatch(/shares this folder/)
    // other folders never count
    const elsewhere = [...after, { sessionId: 'D', cwd: 'C:\\Users\\chris\\elsewhere', state: 'working' }]
    expect(applyTargetError(elsewhere[1], elsewhere, new Set(['A']))).toBeUndefined()
  })
})
