import { describe, it, expect } from 'vitest'
import {
  BOARD_EVENTS,
  BOARD_LIMITS,
  COMMAND_CHARS,
  applyHookEvent,
  boardSummaryLine,
  classifyCommand,
  FILE_KEY_CHARS,
  FILE_MAP_LIMIT,
  isSessionIdle,
  OTHER_SESSION_WINDOW_MS,
  detectOutcome,
  editedFileOf,
  findEditConflicts,
  newSessionRecord,
  otherSessionsSummary,
  pruneBoard,
  readFileOf,
  sessionLabel,
  staleAfterRead,
  trimText
} from './sessionBoard'
import type { ApplyContext, Board, HookInput } from './sessionBoard'
import type { CommandKind, CommandOutcome, Project, SessionRecord } from './types'

// The REAL router is used throughout (no mock): the acceptance list requires
// e.g. signals.consecutiveFailures === 1 after a failed `npm test`, and that is
// only worth asserting against the actual signal updaters the board wires in.

// ---------- fixtures ----------

function project(id: string, name: string, path: string): Project {
  return {
    id,
    name,
    path,
    type: 'web-app',
    stack: '',
    status: 'active',
    favorite: false,
    notes: '',
    lastOpenedAt: null,
    createdAt: 0,
    updatedAt: 0
  }
}

const HUB = project('hub', 'Builder Hub', 'C:\\Users\\chris\\builder-hub')
const KIT = project('kit', 'Income Kit', 'C:\\Users\\chris\\Income-Kit')
const PROJECTS = [HUB, KIT]

const CWD = 'C:\\Users\\chris\\builder-hub'
const SID = 'sess-1'
const T0 = 1_700_000_000_000

const ctx = (now: number, extra: Partial<ApplyContext> = {}): ApplyContext => ({
  projects: PROJECTS,
  now,
  ...extra
})

const ev = (event: string, extra: Record<string, unknown> = {}, sid = SID, cwd = CWD): HookInput =>
  ({ hook_event_name: event, session_id: sid, cwd, ...extra }) as HookInput

const bash = (command: string, tool_response: unknown, extra: Record<string, unknown> = {}): HookInput =>
  ev('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response, ...extra })

const edit = (file_path: string, tool = 'Edit', extra: Record<string, unknown> = {}): HookInput =>
  ev('PostToolUse', { tool_name: tool, tool_input: { file_path }, ...extra })

const read = (file_path: string, extra: Record<string, unknown> = {}): HookInput =>
  ev('PostToolUse', { tool_name: 'Read', tool_input: { file_path }, ...extra })

/** Fold a scripted list of [input, now] over an empty board. */
function play(steps: [HookInput, number][], board: Board = {}, extra: Partial<ApplyContext> = {}) {
  const results = steps.map(([input, now]) => {
    const r = applyHookEvent(board, input, ctx(now, extra))
    board = r.board
    return r
  })
  return { board, results, record: board[SID] }
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { ...newSessionRecord(overrides.sessionId ?? SID, overrides.cwd ?? CWD, ctx(T0)), ...overrides }
}

// ---------- contract constants ----------

describe('board constants', () => {
  it('pins the documented limits (a change here is a deliberate contract change)', () => {
    expect(BOARD_LIMITS).toEqual({
      commands: 30,
      recaps: 4,
      recapChars: 1200,
      promptChars: 4000,
      endedTtlMs: 30 * 60 * 1000,
      staleMs: 12 * 60 * 60 * 1000,
      conflictWindowMs: 15 * 60 * 1000
    })
    expect(COMMAND_CHARS).toBe(200)
  })
  it('understands exactly the eleven hook events the Hub wires (v1.1 adds subagents)', () => {
    expect([...BOARD_EVENTS]).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'Notification',
      'PreCompact',
      'PostModelSwitch',
      'SessionEnd',
      'SubagentStart',
      'SubagentStop'
    ])
  })
})

// ---------- trimText ----------

describe('trimText', () => {
  it('collapses whitespace runs to single spaces and trims the ends', () => {
    expect(trimText('  add   a\n\tlogin\r\n form  ', 100)).toBe('add a login form')
  })
  it('cuts to exactly `max` chars with a trailing ellipsis', () => {
    const out = trimText('abcdefghij', 5)
    expect(out).toBe('abcd…')
    expect(out.length).toBe(5)
  })
  it('does not cut text that fits exactly', () => {
    expect(trimText('abcde', 5)).toBe('abcde')
  })
  it('drops a trailing space before the ellipsis', () => {
    expect(trimText('hello world', 7)).toBe('hello…')
  })
  it('treats undefined / non-string input as empty', () => {
    expect(trimText(undefined, 10)).toBe('')
    expect(trimText('', 10)).toBe('')
    expect(trimText(42 as unknown as string, 10)).toBe('')
  })
  it('clamps max to at least 1 (and survives NaN)', () => {
    expect(trimText('abc', 0)).toBe('…')
    expect(trimText('abc', -5)).toBe('…')
    expect(trimText('a', 0)).toBe('a')
    expect(trimText('abc', Number.NaN)).toBe('…')
  })
  it('never cuts inside a surrogate pair (regression: lone high surrogate before the ellipsis)', () => {
    const cut = trimText('ab\u{1F600}cd', 4) // the cut lands between the emoji's two halves
    expect(cut).toBe('ab…')
    expect(/[\uD800-\uDBFF]…$/.test(cut)).toBe(false)
    expect(trimText('ab\u{1F600}cd', 5)).toBe('ab\u{1F600}…')
    expect(trimText('\u{1F600}', 1)).toBe('…')
  })
})

// ---------- classifyCommand ----------

describe('classifyCommand', () => {
  it.each<[string, CommandKind]>([
    ['npm test', 'test'],
    ['npm t', 'test'],
    ['npm run test', 'test'],
    ['npm run test:unit -- --run src/x.test.ts', 'test'],
    ['npm run --if-present test', 'test'],
    ['npx vitest run src/shared/sessionBoard.test.ts', 'test'],
    ['vitest', 'test'],
    ['jest --watch', 'test'],
    ['pytest tests/', 'test'],
    ['python -m pytest', 'test'],
    ['go test ./...', 'test'],
    ['cargo test', 'test'],
    ['bun test', 'test'],
    ['bun run test', 'test'],
    ['pnpm test', 'test'],
    ['yarn test', 'test'],
    ['flutter test', 'test'],
    ['dotnet test', 'test'],
    ['npx playwright test', 'test'],
    ['./gradlew test', 'test'],
    ['npm run build', 'build'],
    ['npm run build:win', 'build'],
    ['vite build', 'build'],
    ['electron-vite build', 'build'],
    ['npx electron-vite build', 'build'],
    ['tsc -b', 'build'],
    ['tsc --build', 'build'],
    ['next build', 'build'],
    ['flutter build apk', 'build'],
    ['cargo build --release', 'build'],
    ['go build ./cmd/x', 'build'],
    ['dotnet build', 'build'],
    ['gradle assemble', 'build'],
    ['./gradlew build', 'build'],
    ['gradlew.bat assembleDebug', 'build'],
    ['bun run build', 'build'],
    ['eslint .', 'lint'],
    ['npx eslint src/', 'lint'],
    ['npm run lint', 'lint'],
    ['npm run lint:fix', 'lint'],
    ['prettier --check "src/**/*.ts"', 'lint'],
    ['ruff check .', 'lint'],
    ['flake8', 'lint'],
    ['tsc --noEmit', 'typecheck'],
    ['npm run typecheck', 'typecheck'],
    ['npx tsc', 'typecheck'],
    ['npx tsc --noEmit -p tsconfig.json', 'typecheck'],
    ['tsc', 'typecheck'],
    ['mypy src', 'typecheck'],
    ['pyright', 'typecheck'],
    ['pnpm typecheck', 'typecheck'],
    ['git status', 'git'],
    ['git add . && git commit -m "x"', 'git'],
    ['npm i', 'install'],
    ['npm install', 'install'],
    ['npm ci', 'install'],
    ['npm install --save-dev vitest', 'install'],
    ['pnpm i', 'install'],
    ['pnpm install --frozen-lockfile', 'install'],
    ['yarn', 'install'],
    ['yarn --frozen-lockfile', 'install'],
    ['yarn install', 'install'],
    ['bun install', 'install'],
    ['pip install -r requirements.txt', 'install'],
    ['python -m pip install requests', 'install'],
    ['ls -la', 'other'],
    ['prettier --write src/', 'other'],
    ['npm run dev', 'other'],
    ['electron-vite dev', 'other'],
    ['vite', 'other'],
    ['cat package.json', 'other'],
    ['echo done', 'other'],
    ['', 'other'],
    ['   ', 'other']
  ])('%j → %s', (command, kind) => {
    expect(classifyCommand(command)).toBe(kind)
  })

  it('is case-insensitive', () => {
    expect(classifyCommand('NPM TEST')).toBe('test')
    expect(classifyCommand('Git Status')).toBe('git')
  })

  it('ignores env-var prefixes and runners', () => {
    expect(classifyCommand('CI=true npm test')).toBe('test')
    expect(classifyCommand('NODE_ENV=production npm run build')).toBe('build')
    expect(classifyCommand('bunx vitest')).toBe('test')
    expect(classifyCommand('pnpm exec eslint .')).toBe('lint')
    expect(classifyCommand('npx --yes tsc --noEmit')).toBe('typecheck')
    expect(classifyCommand('./node_modules/.bin/vitest run')).toBe('test')
  })

  it('does not match on a bare substring', () => {
    expect(classifyCommand('jestx')).toBe('other')
    expect(classifyCommand('gitk')).toBe('other')
    expect(classifyCommand('echo npm test')).toBe('other')
  })

  it('classifies a chain by priority test > build > typecheck > lint, then install, then git', () => {
    expect(classifyCommand('npm run typecheck && npm test')).toBe('test')
    expect(classifyCommand('npm test && npm run build')).toBe('test')
    expect(classifyCommand('npm run lint && npm run typecheck')).toBe('typecheck')
    expect(classifyCommand('npm run lint; npm run build')).toBe('build')
    expect(classifyCommand('cd C:\\Users\\chris\\builder-hub && npm test')).toBe('test')
    expect(classifyCommand('git pull && npm ci')).toBe('install')
    // a verdict kind beats an install even when the install comes first
    expect(classifyCommand('npm ci && npm test')).toBe('test')
    expect(classifyCommand('npm install && npm run build')).toBe('build')
    expect(classifyCommand('pip install -r requirements.txt && pytest')).toBe('test')
    expect(classifyCommand('npm ci && npm run lint')).toBe('lint')
    expect(classifyCommand('git pull && cd x && npm test 2>&1 | tail -20')).toBe('test')
    expect(classifyCommand('npm test || echo failed')).toBe('test')
    expect(classifyCommand('git pull && ls')).toBe('git')
    expect(classifyCommand('cd x && ls')).toBe('other')
    expect(classifyCommand('npm run typecheck\nnpm test')).toBe('test')
  })

  it('only inspects the first ~200 chars', () => {
    const long = 'echo ' + 'x'.repeat(300) + ' && npm test'
    expect(classifyCommand(long)).toBe('other')
  })

  it('tolerates a non-string', () => {
    expect(classifyCommand(undefined as unknown as string)).toBe('other')
    expect(classifyCommand(null as unknown as string)).toBe('other')
  })

  describe('shell data is not a command (regression: heredoc commit classified as test)', () => {
    const heredocCommit =
      'git commit -m "$(cat <<\'EOF\'\nBump to 0.3.1\n\nnpm test passes with 206 tests; npm run build is clean\nEOF\n)"'
    it('ignores a heredoc body — Claude Code’s own commit convention', () => {
      expect(classifyCommand(heredocCommit)).toBe('git')
      expect(classifyCommand(heredocCommit.replace(/\n/g, '\r\n'))).toBe('git')
      expect(classifyCommand('cat <<EOF > notes.txt\nnpm test\nEOF')).toBe('other')
      expect(classifyCommand('cat <<-"EOF"\n\tnpm test\n\tEOF')).toBe('other')
      expect(classifyCommand('cat <<EOF\nEOF')).toBe('other')
    })
    it('still sees the commands around a heredoc', () => {
      expect(classifyCommand("cat > f.txt <<'EOF'\nhello\nEOF\nnpm run build")).toBe('build')
      expect(classifyCommand('npm test && cat <<EOF\nx\nEOF')).toBe('test')
      // a body longer than the 200-char window no longer hides the real command
      expect(classifyCommand(`cat <<'EOF'\n${'x'.repeat(400)}\nEOF\nnpm test`)).toBe('test')
    })
    it('ignores chain separators inside quotes', () => {
      expect(classifyCommand('git commit -m "fix build; npm test passes"')).toBe('git')
      expect(classifyCommand("git commit -m 'lint && typecheck && test all green'")).toBe('git')
      expect(classifyCommand('echo "a && b | c" && npm test')).toBe('test')
      expect(classifyCommand("echo 'x; y' ; npm test")).toBe('test')
      expect(classifyCommand('npm test -- -t "renders; twice"')).toBe('test')
      expect(classifyCommand('git commit -m "don\'t break; npm test"')).toBe('git')
    })
    it('survives an unterminated quote or heredoc', () => {
      expect(classifyCommand('echo "oops && npm test')).toBe('other')
      expect(classifyCommand('cat <<EOF\nnpm test')).toBe('test')
      expect(classifyCommand('"')).toBe('other')
    })
  })
})

// ---------- detectOutcome ----------

describe('detectOutcome', () => {
  it('an explicit numeric exit code wins over any text', () => {
    expect(detectOutcome('test', { exit_code: 0, stdout: 'Tests: 3 failed' })).toBe('pass')
    expect(detectOutcome('test', { exit_code: 1, stdout: '10 passed' })).toBe('fail')
    expect(detectOutcome('test', { exitCode: 2 })).toBe('fail')
    expect(detectOutcome('build', { code: 0 })).toBe('pass')
    expect(detectOutcome('build', { code: 127 })).toBe('fail')
  })
  it('ignores a non-numeric code field and falls back to text', () => {
    expect(detectOutcome('other', { code: 'ENOENT', stderr: 'Error: spawn ENOENT' })).toBe('fail')
    expect(detectOutcome('test', { code: '0', stdout: '3 passed' })).toBe('pass')
    expect(detectOutcome('test', { code: Number.NaN, stdout: '3 passed' })).toBe('pass')
  })
  it('reads a plain string response', () => {
    expect(detectOutcome('test', 'Tests: 3 failed, 10 passed')).toBe('fail')
    expect(detectOutcome('test', 'Tests  12 passed (12)')).toBe('pass')
    expect(detectOutcome('test', 'nothing to see')).toBe('unknown')
  })
  it('reads stdout + stderr + output + content of an object', () => {
    expect(detectOutcome('test', { stdout: 'ok', stderr: ' FAIL  src/a.test.ts', interrupted: false })).toBe(
      'fail'
    )
    expect(detectOutcome('test', { output: '5 passing' })).toBe('pass')
    expect(detectOutcome('test', { content: 'All checks passed' })).toBe('pass')
    expect(detectOutcome('test', { content: [{ type: 'text', text: 'Tests: 2 failed' }] })).toBe('fail')
    expect(detectOutcome('test', { content: { text: 'Build succeeded' } })).toBe('pass')
  })
  it.each<[string, CommandOutcome]>([
    ['Tests: 3 failed, 10 passed', 'fail'],
    ['Test Files  1 failed | 2 passed (3)', 'fail'],
    ['2 failing', 'fail'],
    [' FAIL  src/x.test.ts > suite > case', 'fail'],
    ['src/main/pty.ts(12,5): error TS2322: Type string is not assignable', 'fail'],
    ['npm ERR! code ELIFECYCLE', 'fail'],
    ['✖ 3 problems (3 errors, 0 warnings)', 'fail'],
    ['✗ build failed', 'fail'],
    ['Tests: 1 failed', 'fail'],
    ['Process exited with exit code 1', 'fail'],
    ['Command failed with exit code 2', 'fail'],
    ['Traceback (most recent call last):\n  File "x.py"', 'fail'],
    ['Error: Cannot find module ./x', 'fail'],
    ['TypeError: x is not a function', 'fail'],
    ['Tests  10 passed (10)', 'pass'],
    ['✓ src/a.test.ts (3 tests)', 'pass'],
    ['12 passing (40ms)', 'pass'],
    ['Found 0 errors. Watching for file changes.', 'pass'],
    ['Tests: 4 passed, 4 total', 'pass'],
    ['All checks passed!', 'pass'],
    ['Build succeeded.', 'pass'],
    ['✓ built in 1.23s', 'pass'],
    ['Successfully installed requests-2.31', 'pass'],
    ['success', 'pass'],
    ['0 failed', 'unknown'],
    ['Compiling...', 'unknown'],
    ['fail', 'unknown'],
    ['', 'unknown']
  ])('%j → %s', (text, outcome) => {
    expect(detectOutcome('test', text)).toBe(outcome)
  })
  it('hard fail patterns beat pass patterns; the generic "Error:" does not', () => {
    expect(detectOutcome('test', '✓ 9 passed\nTests: 1 failed, 9 passed')).toBe('fail')
    expect(detectOutcome('test', 'Error: retrying…\nTests  10 passed (10)')).toBe('pass')
    expect(detectOutcome('test', 'Error: boom')).toBe('fail')
  })
  it('"10 errors" is not "0 errors" (regression: ruff/tsc summaries read as pass)', () => {
    expect(detectOutcome('lint', 'Found 10 errors.')).toBe('unknown')
    expect(detectOutcome('typecheck', 'Found 20 errors in 3 files.')).toBe('unknown')
    expect(detectOutcome('lint', 'Found 0 errors.')).toBe('pass')
    expect(detectOutcome('lint', 'found 0 errors, 2 warnings')).toBe('pass')
  })
  it('"Tests: 0 failed" is not a failure (regression)', () => {
    expect(detectOutcome('test', 'Tests: 0 failed, 5 passed, 5 total')).toBe('pass')
    expect(detectOutcome('test', 'Tests: 0 failed')).toBe('unknown')
    expect(detectOutcome('test', 'Tests: 10 failed, 5 passed')).toBe('fail')
  })
  it('returns unknown for garbage / empty responses', () => {
    expect(detectOutcome('test', undefined)).toBe('unknown')
    expect(detectOutcome('test', null)).toBe('unknown')
    expect(detectOutcome('test', 42)).toBe('unknown')
    expect(detectOutcome('test', true)).toBe('unknown')
    expect(detectOutcome('test', {})).toBe('unknown')
    expect(detectOutcome('test', [])).toBe('unknown')
    expect(detectOutcome('test', { stdout: '', stderr: '' })).toBe('unknown')
    expect(detectOutcome('test', { stdout: 12, stderr: null })).toBe('unknown')
  })
  it('gives the same detection to every kind', () => {
    for (const kind of ['other', 'git', 'install', 'lint', 'typecheck', 'build'] as CommandKind[]) {
      expect(detectOutcome(kind, 'npm ERR! boom')).toBe('fail')
      expect(detectOutcome(kind, { exit_code: 0 })).toBe('pass')
    }
  })
  it('does not recurse forever into a cyclic response', () => {
    const cyclic: Record<string, unknown> = { stdout: 'x' }
    cyclic.content = cyclic
    expect(detectOutcome('test', cyclic)).toBe('unknown')
  })
})

// ---------- editedFileOf / readFileOf ----------

describe('editedFileOf', () => {
  it('reads file_path for Edit / Write / MultiEdit', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      expect(editedFileOf(tool, { file_path: 'C:\\x\\a.ts' })).toBe('C:\\x\\a.ts')
    }
  })
  it('reads notebook_path for NotebookEdit (file_path as a fallback)', () => {
    expect(editedFileOf('NotebookEdit', { notebook_path: 'C:\\x\\n.ipynb' })).toBe('C:\\x\\n.ipynb')
    expect(editedFileOf('NotebookEdit', { file_path: 'C:\\x\\n.ipynb' })).toBe('C:\\x\\n.ipynb')
  })
  it('returns undefined for other tools, missing input, or non-string paths', () => {
    expect(editedFileOf('Read', { file_path: 'C:\\x\\a.ts' })).toBeUndefined()
    expect(editedFileOf('Bash', { command: 'ls' })).toBeUndefined()
    expect(editedFileOf(undefined, { file_path: 'C:\\x\\a.ts' })).toBeUndefined()
    expect(editedFileOf('Edit', undefined)).toBeUndefined()
    expect(editedFileOf('Edit', {})).toBeUndefined()
    expect(editedFileOf('Edit', { file_path: 42 })).toBeUndefined()
    expect(editedFileOf('Edit', { file_path: '   ' })).toBeUndefined()
    expect(editedFileOf('edit', { file_path: 'C:\\x\\a.ts' })).toBeUndefined()
  })
})

describe('readFileOf', () => {
  it('reads file_path for Read only', () => {
    expect(readFileOf('Read', { file_path: 'C:\\x\\a.ts' })).toBe('C:\\x\\a.ts')
    expect(readFileOf('Edit', { file_path: 'C:\\x\\a.ts' })).toBeUndefined()
    expect(readFileOf('Read', {})).toBeUndefined()
    expect(readFileOf('Read', undefined)).toBeUndefined()
    expect(readFileOf(undefined, undefined)).toBeUndefined()
    expect(readFileOf('Read', { file_path: null })).toBeUndefined()
  })
})

// ---------- newSessionRecord ----------

describe('newSessionRecord', () => {
  it('starts idle with empty containers and resolves a registered project', () => {
    const r = newSessionRecord(SID, CWD, ctx(T0))
    expect(r).toMatchObject({
      sessionId: SID,
      cwd: CWD,
      projectId: 'hub',
      projectName: 'Builder Hub',
      state: 'done',
      embedded: false,
      startedAt: T0,
      updatedAt: T0,
      filesEdited: {},
      filesRead: {},
      commands: [],
      recaps: [],
      otherProjectsTouched: [],
      sharedToolsUsed: [],
      locked: false
    })
    expect(r.task).toBeUndefined()
    expect(r.signals.consecutiveFailures).toBe(0)
    expect(r.signals.filesEdited).toBe(0)
  })
  it('resolves a task worktree and a nested cwd (longest prefix)', () => {
    const wt = newSessionRecord('s2', 'C:\\Users\\chris\\builder-hub.worktrees\\fix-login\\src', ctx(T0))
    expect(wt.projectId).toBe('hub')
    expect(wt.task).toBe('fix-login')
    const nested = newSessionRecord('s3', 'c:/users/chris/income-kit/tools', ctx(T0))
    expect(nested.projectId).toBe('kit')
  })
  it('leaves project fields unset for an unknown folder', () => {
    const r = newSessionRecord('s4', 'D:\\scratch\\thing', ctx(T0))
    expect(r.projectId).toBeUndefined()
    expect(r.projectName).toBeUndefined()
  })
  it('marks embedded when ctx.embeddedCwds holds normPath(cwd), whatever the slashes', () => {
    const embeddedCwds = new Set(['c:\\users\\chris\\builder-hub'])
    expect(newSessionRecord(SID, CWD, ctx(T0, { embeddedCwds })).embedded).toBe(true)
    expect(newSessionRecord(SID, 'C:/Users/chris/builder-hub/', ctx(T0, { embeddedCwds })).embedded).toBe(
      true
    )
    expect(newSessionRecord(SID, 'C:\\Users\\chris\\Income-Kit', ctx(T0, { embeddedCwds })).embedded).toBe(
      false
    )
  })
})

// ---------- applyHookEvent ----------

describe('applyHookEvent — a full scripted session', () => {
  const transcript_path = 'C:\\Users\\chris\\.claude\\projects\\x\\sess-1.jsonl'
  const steps: [HookInput, number][] = [
    [ev('SessionStart', { source: 'startup', model: 'claude-opus-5', transcript_path }), T0],
    [ev('UserPromptSubmit', { prompt: 'add a login form' }), T0 + 1000],
    [read('C:\\Users\\chris\\builder-hub\\src\\a.ts'), T0 + 2000],
    [edit('C:\\Users\\chris\\builder-hub\\src\\a.ts', 'Edit', { effort: { level: 'high' } }), T0 + 3000],
    [bash('npm test', { stdout: 'Tests: 3 failed, 10 passed' }), T0 + 4000],
    [ev('Stop', { last_assistant_message: 'Added the form; tests fail on X. Next: fix Y' }), T0 + 5000],
    [ev('Notification', { message: 'needs input' }), T0 + 6000],
    [ev('PostModelSwitch', { from_model: 'claude-opus-5', to_model: 'claude-sonnet-5' }), T0 + 7000],
    [ev('SessionEnd'), T0 + 8000]
  ]
  const embeddedCwds = new Set(['c:\\users\\chris\\builder-hub'])
  const { board, results, record: rec } = play(steps, {}, { embeddedCwds })
  const states = results.map((r) => r.record?.state)

  it('applies every event to one record keyed by session_id', () => {
    expect(results.every((r) => r.changed)).toBe(true)
    expect(Object.keys(board)).toEqual([SID])
    expect(rec.sessionId).toBe(SID)
    expect(rec.startedAt).toBe(T0)
    expect(rec.updatedAt).toBe(T0 + 8000)
    expect(rec.lastEvent).toBe('SessionEnd')
    expect(rec.transcriptPath).toBe(transcript_path)
  })
  it('walks working → done → waiting → ended', () => {
    expect(states).toEqual([
      'done',
      'working',
      'working',
      'working',
      'working',
      'done',
      'waiting',
      'waiting',
      'ended'
    ])
  })
  it('resolves the registered project and the embedded flag', () => {
    expect(rec.projectId).toBe('hub')
    expect(rec.projectName).toBe('Builder Hub')
    expect(rec.embedded).toBe(true)
  })
  it('records the objective once and the prompt', () => {
    expect(rec.objective).toBe('add a login form')
    expect(rec.lastPrompt).toBe('add a login form')
    expect(rec.lastPromptAt).toBe(T0 + 1000)
    expect(results[1].prompt).toBe('add a login form')
    expect(results[1].record?.lastAction).toBe('prompt: add a login form')
  })
  it('keys filesRead / filesEdited by normPath', () => {
    expect(rec.filesRead).toEqual({ 'c:\\users\\chris\\builder-hub\\src\\a.ts': T0 + 2000 })
    expect(rec.filesEdited).toEqual({ 'c:\\users\\chris\\builder-hub\\src\\a.ts': T0 + 3000 })
    expect(results[3].editedFile).toBe('c:\\users\\chris\\builder-hub\\src\\a.ts')
    expect(results[3].record?.lastAction).toBe('edited a.ts')
    expect(rec.turnEdits).toBe(1)
    expect(rec.signals.filesEdited).toBe(1)
    expect(rec.signals.projectsTouched).toBe(1)
    expect(rec.otherProjectsTouched).toEqual([])
  })
  it('picks up effort from the tool payload', () => {
    expect(rec.effort).toBe('high')
  })
  it('classifies the test command, detects the failure, and sets the verdict', () => {
    expect(rec.commands).toHaveLength(1)
    expect(rec.commands[0]).toEqual({ command: 'npm test', kind: 'test', outcome: 'fail', at: T0 + 4000 })
    expect(rec.testStatus).toEqual(rec.commands[0])
    expect(results[4].command).toEqual(rec.commands[0])
    expect(results[4].record?.lastAction).toBe('ran npm test → fail')
    expect(rec.turnFailures).toBe(1)
    expect(rec.signals.consecutiveFailures).toBe(1)
    expect(rec.signals.failures).toBe(1)
  })
  it('records the recap on Stop', () => {
    expect(rec.recaps).toEqual(['Added the form; tests fail on X. Next: fix Y'])
    expect(rec.lastAssistantMessage).toBe('Added the form; tests fail on X. Next: fix Y')
    expect(results[5].recap).toBe('Added the form; tests fail on X. Next: fix Y')
    expect(results[5].record?.lastAction).toBe('recap: Added the form; tests fail on X. Next: fix Y')
    expect(rec.signals.mechanicalStreak).toBe(0) // a failure this turn is not mechanical
  })
  it('surfaces the notification text', () => {
    expect(results[6].record?.lastAction).toBe('needs input')
  })
  it('tracks the model from SessionStart then PostModelSwitch', () => {
    expect(results[0].record?.model).toBe('claude-opus-5')
    expect(results[0].record?.lastAction).toBe('session startup')
    expect(rec.model).toBe('claude-sonnet-5')
    expect(results[7].record?.lastAction).toBe('model → claude-sonnet-5')
  })
  it('reports the ended session', () => {
    expect(results[8].endedSessionId).toBe(SID)
    expect(rec.state).toBe('ended')
  })
})

describe('applyHookEvent — validation', () => {
  const board: Board = { [SID]: record() }

  it('ignores payloads missing hook_event_name / session_id / cwd', () => {
    for (const input of [
      {},
      { hook_event_name: 'Stop' },
      { hook_event_name: 'Stop', session_id: SID },
      { hook_event_name: 'Stop', cwd: CWD },
      { session_id: SID, cwd: CWD }
    ]) {
      const r = applyHookEvent(board, input as HookInput, ctx(T0))
      expect(r).toEqual({ board, changed: false })
    }
  })
  it('ignores non-string or empty identity fields', () => {
    for (const input of [
      { hook_event_name: 42, session_id: SID, cwd: CWD },
      { hook_event_name: 'Stop', session_id: { id: 1 }, cwd: CWD },
      { hook_event_name: 'Stop', session_id: SID, cwd: ['C:\\'] },
      { hook_event_name: '', session_id: SID, cwd: CWD },
      { hook_event_name: 'Stop', session_id: '', cwd: CWD },
      { hook_event_name: 'Stop', session_id: SID, cwd: '' }
    ]) {
      expect(applyHookEvent(board, input as unknown as HookInput, ctx(T0)).changed).toBe(false)
    }
  })
  it('ignores unknown events (and PreModelSwitch, which the Hub does not wire)', () => {
    for (const name of ['Nope', 'stop', 'PreModelSwitch', 'SESSIONSTART']) {
      const r = applyHookEvent(board, ev(name), ctx(T0))
      expect(r.changed).toBe(false)
      expect(r.board).toBe(board)
      expect(r.record).toBeUndefined()
    }
  })
  it('ignores a non-object input', () => {
    for (const input of [null, undefined, 'Stop', 7, []]) {
      expect(applyHookEvent(board, input as unknown as HookInput, ctx(T0)).changed).toBe(false)
    }
  })
  it('accepts exactly BOARD_EVENTS', () => {
    for (const name of BOARD_EVENTS) expect(applyHookEvent({}, ev(name), ctx(T0)).changed).toBe(true)
  })
  it('survives garbage in optional fields', () => {
    const r = applyHookEvent(
      {},
      {
        hook_event_name: 'PostToolUse',
        session_id: SID,
        cwd: CWD,
        tool_name: 7,
        tool_input: 'ls',
        tool_response: null,
        effort: 'high',
        transcript_path: 3,
        model: {}
      } as unknown as HookInput,
      ctx(T0)
    )
    expect(r.changed).toBe(true)
    expect(r.record?.state).toBe('working')
    expect(r.record?.effort).toBeUndefined()
    expect(r.record?.transcriptPath).toBeUndefined()
    expect(r.record?.commands).toEqual([])
    const p = applyHookEvent({}, ev('UserPromptSubmit', { prompt: 12 }), ctx(T0))
    expect(p.record?.lastPrompt).toBe('')
    expect(p.record?.objective).toBeUndefined()
    expect(p.record?.lastAction).toBe('prompt')
    const s = applyHookEvent({}, ev('Stop', { last_assistant_message: ['x'] }), ctx(T0))
    expect(s.record?.recaps).toEqual([])
    expect(s.recap).toBeUndefined()
    expect(s.record?.lastAction).toBe('stopped')
  })
})

describe('applyHookEvent — immutability', () => {
  it('never mutates the input board or its records', () => {
    const start = play([
      [ev('SessionStart', { source: 'startup' }), T0],
      [ev('UserPromptSubmit', { prompt: 'first' }), T0 + 1]
    ]).board
    const snapshot = JSON.parse(JSON.stringify(start))
    const before = start[SID]
    const steps: [HookInput, number][] = [
      [edit('C:\\Users\\chris\\builder-hub\\src\\b.ts'), T0 + 2],
      [read('C:\\Users\\chris\\builder-hub\\src\\c.ts'), T0 + 3],
      [bash('npm test', 'Tests: 1 failed'), T0 + 4],
      [ev('Stop', { last_assistant_message: 'done' }), T0 + 5],
      [ev('PostModelSwitch', { to_model: 'claude-haiku-5' }), T0 + 6],
      [ev('SessionEnd'), T0 + 7]
    ]
    let board = start
    for (const [input, now] of steps) {
      const r = applyHookEvent(board, input, ctx(now))
      expect(r.board).not.toBe(board)
      expect(r.record).not.toBe(board[SID])
      board = r.board
    }
    expect(start).toEqual(snapshot)
    expect(start[SID]).toBe(before)
    expect(before.filesEdited).toEqual({})
    expect(before.commands).toEqual([])
    expect(before.recaps).toEqual([])
    expect(before.state).toBe('working')
  })
  it('keeps other sessions\u2019 records by reference', () => {
    const other = record({ sessionId: 's2' })
    const r = applyHookEvent({ s2: other }, ev('Stop'), ctx(T0))
    expect(r.board.s2).toBe(other)
    expect(Object.keys(r.board).sort()).toEqual(['s2', SID].sort())
  })
})

describe('applyHookEvent — prompts and turns', () => {
  it('sets the objective from the first non-slash prompt and never overwrites it', () => {
    const { record: rec } = play([
      [ev('UserPromptSubmit', { prompt: '/clear' }), T0],
      [ev('UserPromptSubmit', { prompt: '/model opus' }), T0 + 1],
      [ev('UserPromptSubmit', { prompt: '  fix   the\nlogin bug ' }), T0 + 2],
      [ev('UserPromptSubmit', { prompt: 'now add tests' }), T0 + 3]
    ])
    expect(rec.objective).toBe('fix the login bug')
    expect(rec.lastPrompt).toBe('now add tests')
  })
  it('does not treat a path-like prompt as a slash command', () => {
    const { record: rec } = play([[ev('UserPromptSubmit', { prompt: '/c/Users/x/app is broken' }), T0]])
    expect(rec.objective).toBe('/c/Users/x/app is broken')
  })
  it('trims the prompt to BOARD_LIMITS.promptChars and lastAction to 60', () => {
    const long = 'a'.repeat(5000)
    const { record: rec, results } = play([[ev('UserPromptSubmit', { prompt: long }), T0]])
    expect(rec.lastPrompt?.length).toBe(BOARD_LIMITS.promptChars)
    expect(rec.lastPrompt?.endsWith('…')).toBe(true)
    expect(rec.objective).toBe(rec.lastPrompt)
    expect(results[0].prompt).toBe(rec.lastPrompt)
    expect(rec.lastAction).toBe('prompt: ' + 'a'.repeat(59) + '…')
  })
  it('feeds the prompt to signalsAfterPrompt', () => {
    const { record: rec } = play([[ev('UserPromptSubmit', { prompt: 'it is still failing' }), T0]])
    expect(rec.signals.uncertaintyHits).toBe(1)
  })
  it('resets turn bookkeeping on each prompt and counts distinct files per turn', () => {
    const a = 'C:\\Users\\chris\\builder-hub\\src\\a.ts'
    const b = 'C:\\Users\\chris\\builder-hub\\src\\b.ts'
    const { results } = play([
      [ev('UserPromptSubmit', { prompt: 'one' }), T0],
      [edit(a), T0 + 1],
      [edit(a), T0 + 2],
      [edit(b), T0 + 3],
      [bash('npm test', 'Tests: 1 failed'), T0 + 4],
      [bash('npm run typecheck', 'error TS1'), T0 + 5],
      [ev('Stop', { last_assistant_message: 'r1' }), T0 + 6],
      [ev('UserPromptSubmit', { prompt: 'two' }), T0 + 7],
      [edit(a), T0 + 8],
      [ev('Stop', { last_assistant_message: 'r2' }), T0 + 9]
    ])
    const afterFirst = results[5].record!
    expect(afterFirst.turnEdits).toBe(2)
    expect(afterFirst.turnFailures).toBe(2)
    expect(afterFirst.signals.consecutiveFailures).toBe(2)
    expect(afterFirst.signals.filesEdited).toBe(2)
    const afterPrompt = results[7].record!
    expect(afterPrompt.turnEdits).toBe(0)
    expect(afterPrompt.turnFailures).toBe(0)
    const afterSecond = results[9].record!
    expect(afterSecond.turnEdits).toBe(1) // only a.ts since the second prompt
    expect(afterSecond.signals.filesEdited).toBe(2) // session-wide distinct
    expect(afterSecond.signals.mechanicalStreak).toBe(1)
  })
  it('counts edits before any prompt against the session start', () => {
    const { record: rec } = play([
      [ev('SessionStart', { source: 'resume' }), T0],
      [edit('C:\\Users\\chris\\builder-hub\\src\\a.ts'), T0 + 1]
    ])
    expect(rec.turnEdits).toBe(1)
  })
  it('SessionStart records the source without changing state', () => {
    const { record: rec } = play([
      [ev('UserPromptSubmit', { prompt: 'x' }), T0],
      [ev('SessionStart', { source: 'compact' }), T0 + 1]
    ])
    expect(rec.state).toBe('working')
    expect(rec.lastAction).toBe('session compact')
    expect(applyHookEvent({}, ev('SessionStart'), ctx(T0)).record?.lastAction).toBe('session')
  })
  it('PreToolUse records effort (and lastEvent) and nothing else', () => {
    const base = play([[ev('UserPromptSubmit', { prompt: 'x' }), T0]]).board
    const r = applyHookEvent(
      base,
      ev('PreToolUse', {
        tool_name: 'Edit',
        tool_input: { file_path: 'C:\\Users\\chris\\builder-hub\\src\\a.ts' },
        effort: { level: 'max' }
      }),
      ctx(T0 + 1)
    )
    expect(r.changed).toBe(true)
    expect(r.record?.effort).toBe('max')
    expect(r.record?.lastEvent).toBe('PreToolUse')
    expect(r.record?.filesEdited).toEqual({})
    expect(r.record?.state).toBe('working')
    expect(r.record?.lastAction).toBe('prompt: x')
    expect(r.editedFile).toBeUndefined()
  })
  it('PreCompact only notes the trigger', () => {
    expect(applyHookEvent({}, ev('PreCompact', { trigger: 'auto' }), ctx(T0)).record?.lastAction).toBe(
      'compacting (auto)'
    )
    expect(applyHookEvent({}, ev('PreCompact'), ctx(T0)).record?.lastAction).toBe('compacting')
  })
  it('PostModelSwitch without a to_model leaves the model alone', () => {
    const base = play([[ev('SessionStart', { model: 'claude-opus-5' }), T0]]).board
    const r = applyHookEvent(base, ev('PostModelSwitch', { from_model: 'claude-opus-5' }), ctx(T0 + 1))
    expect(r.record?.model).toBe('claude-opus-5')
  })
  it('Notification without a message only flips state', () => {
    const base = play([[ev('UserPromptSubmit', { prompt: 'x' }), T0]]).board
    const r = applyHookEvent(base, ev('Notification'), ctx(T0 + 1))
    expect(r.record?.state).toBe('waiting')
    expect(r.record?.lastAction).toBe('prompt: x')
    const long = applyHookEvent(base, ev('Notification', { message: 'm'.repeat(200) }), ctx(T0 + 1))
    expect(long.record?.lastAction?.length).toBe(80)
  })
  it('a Read does not change lastAction but a PostToolUse always marks working', () => {
    const base = play([[ev('Notification', { message: 'waiting on you' }), T0]]).board
    const r = applyHookEvent(base, read('C:\\Users\\chris\\builder-hub\\README.md'), ctx(T0 + 1))
    expect(r.record?.state).toBe('working')
    expect(r.record?.lastAction).toBe('waiting on you')
    expect(r.record?.filesRead).toEqual({ 'c:\\users\\chris\\builder-hub\\readme.md': T0 + 1 })
  })
})

describe('applyHookEvent — edits and paths', () => {
  it('normalizes forward slashes, trailing separators and case', () => {
    const { record: rec, results } = play([
      [edit('C:/Users/chris/builder-hub/src/A.ts', 'Write'), T0],
      [edit('C:\\Users\\chris\\builder-hub\\src\\a.ts', 'MultiEdit'), T0 + 1],
      [
        ev('PostToolUse', {
          tool_name: 'NotebookEdit',
          tool_input: { notebook_path: 'C:/Users/chris/builder-hub/n.ipynb' }
        }),
        T0 + 2
      ]
    ])
    expect(Object.keys(rec.filesEdited)).toEqual([
      'c:\\users\\chris\\builder-hub\\src\\a.ts',
      'c:\\users\\chris\\builder-hub\\n.ipynb'
    ])
    expect(rec.filesEdited['c:\\users\\chris\\builder-hub\\src\\a.ts']).toBe(T0 + 1)
    expect(results[2].editedFile).toBe('c:\\users\\chris\\builder-hub\\n.ipynb')
    expect(rec.signals.filesEdited).toBe(2)
  })
  it('anchors a relative path to the session cwd', () => {
    const { record: rec } = play([
      [edit('src/a.ts'), T0],
      [edit('.\\src\\a.ts'), T0 + 1],
      [read('./README.md'), T0 + 2]
    ])
    expect(Object.keys(rec.filesEdited)).toEqual(['c:\\users\\chris\\builder-hub\\src\\a.ts'])
    expect(Object.keys(rec.filesRead)).toEqual(['c:\\users\\chris\\builder-hub\\readme.md'])
  })
  it('records edits under a different registered project in otherProjectsTouched (deduped)', () => {
    const { record: rec, results } = play([
      [edit('C:\\Users\\chris\\builder-hub\\src\\a.ts'), T0],
      [edit('C:\\Users\\chris\\Income-Kit\\tools\\x.ts'), T0 + 1],
      [edit('c:/users/chris/income-kit/tools/y.ts'), T0 + 2],
      [edit('D:\\elsewhere\\z.ts'), T0 + 3]
    ])
    expect(rec.otherProjectsTouched).toEqual(['kit'])
    expect(rec.signals.projectsTouched).toBe(2)
    expect(rec.signals.filesEdited).toBe(4)
    expect(results[0].record?.otherProjectsTouched).toEqual([])
    expect(results[0].record?.signals.projectsTouched).toBe(1)
  })
  it('an unregistered session editing a registered project counts that project', () => {
    const external = applyHookEvent(
      {},
      { ...edit('C:\\Users\\chris\\Income-Kit\\a.ts'), cwd: 'D:\\scratch' },
      ctx(T0)
    )
    expect(external.record?.projectId).toBeUndefined()
    expect(external.record?.otherProjectsTouched).toEqual(['kit'])
    expect(external.record?.signals.projectsTouched).toBe(1)
  })
  it('edits in a task worktree resolve to the parent project', () => {
    const wt = 'C:\\Users\\chris\\builder-hub.worktrees\\fix-login'
    const r = applyHookEvent({}, { ...edit(`${wt}\\src\\a.ts`), cwd: wt }, ctx(T0))
    expect(r.record?.task).toBe('fix-login')
    expect(r.record?.otherProjectsTouched).toEqual([])
  })
})

describe('applyHookEvent — commands', () => {
  it('accepts PowerShell as a shell tool', () => {
    const r = applyHookEvent(
      {},
      ev('PostToolUse', {
        tool_name: 'PowerShell',
        tool_input: { command: 'npm run build' },
        tool_response: 'built in 2.1s'
      }),
      ctx(T0)
    )
    expect(r.command).toEqual({ command: 'npm run build', kind: 'build', outcome: 'pass', at: T0 })
    expect(r.record?.testStatus?.outcome).toBe('pass')
  })
  it('reads a plain-string tool_response', () => {
    const r = applyHookEvent({}, bash('npx vitest run', ' FAIL  src/a.test.ts'), ctx(T0))
    expect(r.command?.outcome).toBe('fail')
  })
  it('lets an exit_code object win over contradictory text', () => {
    const r = applyHookEvent({}, bash('npm test', { exit_code: 0, stdout: 'Tests: 3 failed' }), ctx(T0))
    expect(r.command?.outcome).toBe('pass')
    expect(r.record?.turnFailures ?? 0).toBe(0)
  })
  it('non-verdict kinds are recorded but never become testStatus or touch signals', () => {
    const { record: rec, results } = play([
      [bash('git status', { exit_code: 1 }), T0],
      [bash('npm install', 'npm ERR! boom'), T0 + 1],
      [bash('ls', ''), T0 + 2]
    ])
    expect(rec.commands.map((c) => [c.kind, c.outcome])).toEqual([
      ['git', 'fail'],
      ['install', 'fail'],
      ['other', 'unknown']
    ])
    expect(rec.testStatus).toBeUndefined()
    expect(rec.turnFailures).toBeUndefined()
    expect(rec.signals.consecutiveFailures).toBe(0)
    expect(results[2].record?.lastAction).toBe('ran ls → unknown')
  })
  it('a pass resets consecutive failures (via the signal hook)', () => {
    const { record: rec } = play([
      [bash('npm test', 'Tests: 1 failed'), T0],
      [bash('npm test', 'Tests  9 passed (9)'), T0 + 1]
    ])
    expect(rec.signals.consecutiveFailures).toBe(0)
    expect(rec.signals.passes).toBe(1)
    expect(rec.testStatus?.outcome).toBe('pass')
  })
  it('keeps at most BOARD_LIMITS.commands, dropping the oldest', () => {
    const steps: [HookInput, number][] = []
    for (let i = 0; i < BOARD_LIMITS.commands + 5; i++) steps.push([bash(`echo ${i}`, ''), T0 + i])
    const { record: rec } = play(steps)
    expect(rec.commands).toHaveLength(BOARD_LIMITS.commands)
    expect(rec.commands[0].command).toBe('echo 5')
    expect(rec.commands[rec.commands.length - 1].command).toBe(`echo ${BOARD_LIMITS.commands + 4}`)
  })
  it('stores a whitespace-collapsed command bounded to COMMAND_CHARS and a 60-char lastAction', () => {
    const long = 'npm   test  -- ' + 'x'.repeat(500)
    const r = applyHookEvent({}, bash(long, ''), ctx(T0))
    expect(r.command?.command.length).toBe(COMMAND_CHARS)
    expect(r.command?.command.startsWith('npm test -- x')).toBe(true)
    expect(r.record?.lastAction).toBe('ran ' + trimText(long, 60) + ' → unknown')
    expect(r.record?.lastAction?.length).toBe('ran '.length + 60 + ' → unknown'.length)
  })
  it('ignores a shell tool without a string command', () => {
    for (const tool_input of [{}, { command: 7 }, { command: '   ' }, undefined]) {
      const r = applyHookEvent({}, ev('PostToolUse', { tool_name: 'Bash', tool_input }), ctx(T0))
      expect(r.changed).toBe(true)
      expect(r.command).toBeUndefined()
      expect(r.record?.commands).toEqual([])
    }
  })
  it('ignores a command on a non-shell tool', () => {
    const r = applyHookEvent(
      {},
      ev('PostToolUse', { tool_name: 'Task', tool_input: { command: 'npm test' } }),
      ctx(T0)
    )
    expect(r.command).toBeUndefined()
  })
})

describe('applyHookEvent — recaps', () => {
  it('trims to recapChars, skips an identical consecutive recap, and bounds the list', () => {
    const long = 'r'.repeat(BOARD_LIMITS.recapChars + 100)
    const steps: [HookInput, number][] = [
      [ev('Stop', { last_assistant_message: long }), T0],
      [ev('Stop', { last_assistant_message: long }), T0 + 1],
      [ev('Stop', { last_assistant_message: '   ' }), T0 + 2],
      [ev('Stop'), T0 + 3]
    ]
    for (let i = 0; i < BOARD_LIMITS.recaps + 2; i++) {
      steps.push([ev('Stop', { last_assistant_message: `recap ${i}` }), T0 + 10 + i])
    }
    const { record: rec, results } = play(steps)
    expect(results[0].recap?.length).toBe(BOARD_LIMITS.recapChars)
    expect(results[1].record?.recaps).toHaveLength(1)
    expect(results[1].recap).toBe(results[0].recap) // still reported, just not re-pushed
    expect(results[2].recap).toBeUndefined()
    expect(results[3].recap).toBeUndefined()
    expect(results[3].record?.lastAssistantMessage).toBe(results[0].recap)
    expect(rec.recaps).toHaveLength(BOARD_LIMITS.recaps)
    expect(rec.recaps[rec.recaps.length - 1]).toBe(`recap ${BOARD_LIMITS.recaps + 1}`)
    expect(rec.recaps[0]).toBe('recap 2')
    expect(rec.lastAssistantMessage).toBe(`recap ${BOARD_LIMITS.recaps + 1}`)
  })
  it('allows the same recap again once another one has intervened', () => {
    const { record: rec } = play([
      [ev('Stop', { last_assistant_message: 'a' }), T0],
      [ev('Stop', { last_assistant_message: 'b' }), T0 + 1],
      [ev('Stop', { last_assistant_message: 'a' }), T0 + 2]
    ])
    expect(rec.recaps).toEqual(['a', 'b', 'a'])
  })
  it('feeds the turn shape to signalsAfterTurn', () => {
    const { results } = play([
      [ev('UserPromptSubmit', { prompt: 'rename x' }), T0],
      [ev('Stop', { last_assistant_message: 'done' }), T0 + 1],
      [ev('UserPromptSubmit', { prompt: 'rename y' }), T0 + 2],
      [ev('Stop', { last_assistant_message: 'done' }), T0 + 3],
      // a wall of text (trimmed to promptChars = 400, still > the router's short-prompt cut) is not mechanical
      [ev('UserPromptSubmit', { prompt: 'p'.repeat(500) }), T0 + 4],
      [ev('Stop', { last_assistant_message: 'done' }), T0 + 5]
    ])
    expect(results[1].record?.signals.mechanicalStreak).toBe(1)
    expect(results[3].record?.signals.mechanicalStreak).toBe(2)
    expect(results[5].record?.signals.mechanicalStreak).toBe(0)
  })
})

describe('applyHookEvent — sessions and embedding', () => {
  it('keeps two sessions in one cwd apart', () => {
    let board: Board = {}
    board = applyHookEvent(board, ev('UserPromptSubmit', { prompt: 'a' }, 's1'), ctx(T0)).board
    board = applyHookEvent(board, ev('UserPromptSubmit', { prompt: 'b' }, 's2'), ctx(T0 + 1)).board
    board = applyHookEvent(board, ev('Stop', {}, 's1'), ctx(T0 + 2)).board
    expect(board.s1.state).toBe('done')
    expect(board.s2.state).toBe('working')
    expect(board.s1.objective).toBe('a')
    expect(board.s2.objective).toBe('b')
  })
  it('upgrades embedded once the cwd appears in embeddedCwds, and never downgrades', () => {
    const first = applyHookEvent({}, ev('SessionStart'), ctx(T0))
    expect(first.record?.embedded).toBe(false)
    const embeddedCwds = new Set(['c:\\users\\chris\\builder-hub'])
    const second = applyHookEvent(
      first.board,
      ev('UserPromptSubmit', { prompt: 'x' }),
      ctx(T0 + 1, { embeddedCwds })
    )
    expect(second.record?.embedded).toBe(true)
    const third = applyHookEvent(second.board, ev('Stop'), ctx(T0 + 2))
    expect(third.record?.embedded).toBe(true)
  })
  it('does not fall for prototype keys as session ids', () => {
    const r = applyHookEvent({}, ev('SessionStart', {}, '__proto__'), ctx(T0))
    expect(r.changed).toBe(true)
    expect(Object.hasOwn(r.board, '__proto__')).toBe(true)
    expect(r.record?.sessionId).toBe('__proto__')
  })
  it('revives an ended record on any event but SessionEnd (regression: resumed session stayed ended)', () => {
    // the Hub reloads its board with every session marked ended; `claude --resume` keeps the session id
    const ended: Board = { [SID]: record({ state: 'ended', updatedAt: T0 - 1 }) }
    expect(applyHookEvent(ended, ev('SessionStart', { source: 'resume' }), ctx(T0)).record?.state).toBe(
      'done'
    )
    expect(
      applyHookEvent(ended, ev('PreToolUse', { effort: { level: 'high' } }), ctx(T0)).record?.state
    ).toBe('done')
    expect(applyHookEvent(ended, ev('PreCompact', { trigger: 'auto' }), ctx(T0)).record?.state).toBe('done')
    expect(applyHookEvent(ended, ev('PostModelSwitch', { to_model: 'x' }), ctx(T0)).record?.state).toBe(
      'done'
    )
    expect(applyHookEvent(ended, ev('UserPromptSubmit', { prompt: 'go' }), ctx(T0)).record?.state).toBe(
      'working'
    )
    expect(applyHookEvent(ended, ev('Notification', { message: 'm' }), ctx(T0)).record?.state).toBe('waiting')
    expect(applyHookEvent(ended, ev('SessionEnd'), ctx(T0)).record?.state).toBe('ended')
    expect(ended[SID].state).toBe('ended') // input untouched
    // a live session's state is still left alone by SessionStart / PreToolUse
    const live: Board = { [SID]: record({ state: 'waiting' }) }
    expect(applyHookEvent(live, ev('SessionStart', { source: 'compact' }), ctx(T0)).record?.state).toBe(
      'waiting'
    )
    expect(applyHookEvent(live, ev('PreToolUse'), ctx(T0)).record?.state).toBe('waiting')
  })
  it('rebuilds containers a record lost on disk instead of throwing (regression)', () => {
    const stripped = record({ state: 'working' }) as unknown as Record<string, unknown>
    for (const k of [
      'filesEdited',
      'filesRead',
      'commands',
      'recaps',
      'otherProjectsTouched',
      'sharedToolsUsed',
      'signals'
    ]) {
      delete stripped[k]
    }
    const board: Board = { [SID]: stripped as unknown as SessionRecord }
    const stop = applyHookEvent(board, ev('Stop', { last_assistant_message: 'r' }), ctx(T0))
    expect(stop.record?.recaps).toEqual(['r'])
    expect(stop.record?.signals.mechanicalStreak).toBe(1)
    const ran = applyHookEvent(board, bash('npm test', 'Tests: 1 failed'), ctx(T0))
    expect(ran.record?.commands).toHaveLength(1)
    expect(ran.record?.signals.consecutiveFailures).toBe(1)
    const edited = applyHookEvent(board, edit('C:\\Users\\chris\\Income-Kit\\a.ts'), ctx(T0))
    expect(edited.record?.otherProjectsTouched).toEqual(['kit'])
    expect(edited.record?.filesRead).toEqual({})
    expect(edited.record?.sharedToolsUsed).toEqual([])
    const wrongShape = {
      ...stripped,
      commands: 'nope',
      filesEdited: [1],
      signals: 4
    } as unknown as SessionRecord
    const fixed = applyHookEvent({ [SID]: wrongShape }, bash('ls', ''), ctx(T0))
    expect(fixed.record?.commands).toHaveLength(1)
    expect(fixed.record?.filesEdited).toEqual({})
    expect(fixed.record?.signals.failures).toBe(0)
  })
})

// ---------- findEditConflicts ----------

describe('findEditConflicts', () => {
  const file = 'C:\\Users\\chris\\builder-hub\\src\\a.ts'
  const key = 'c:\\users\\chris\\builder-hub\\src\\a.ts'
  const now = T0 + 20 * 60 * 1000
  const twoSessions = (otherEditedAt: number, otherState: SessionRecord['state'] = 'working'): Board => ({
    s1: record({ sessionId: 's1', filesEdited: { [key]: now } }),
    s2: record({ sessionId: 's2', state: otherState, filesEdited: { [key]: otherEditedAt } })
  })

  it('reports another live session that edited the file within 15 minutes', () => {
    const at = now - 5 * 60 * 1000
    expect(findEditConflicts(twoSessions(at), 's1', file, now)).toEqual([
      { file, otherSessionId: 's2', otherLabel: 'Builder Hub', at, kind: 'edited' }
    ])
  })
  it('reports nothing once the edit is older than the window', () => {
    const at = now - BOARD_LIMITS.conflictWindowMs - 1
    expect(findEditConflicts(twoSessions(at), 's1', file, now)).toEqual([])
    expect(findEditConflicts(twoSessions(now - BOARD_LIMITS.conflictWindowMs), 's1', file, now)).toHaveLength(
      1
    )
  })
  it('never reports this session, ended sessions, or other files', () => {
    const at = now - 1000
    expect(findEditConflicts(twoSessions(at, 'ended'), 's1', file, now)).toEqual([])
    expect(findEditConflicts(twoSessions(at), 's2', 'C:\\Users\\chris\\builder-hub\\src\\b.ts', now)).toEqual(
      []
    )
    const solo: Board = { s1: record({ sessionId: 's1', filesEdited: { [key]: at } }) }
    expect(findEditConflicts(solo, 's1', file, now)).toEqual([])
    expect(findEditConflicts(solo, 'unknown', file, now)).toHaveLength(1)
  })
  it('matches by normPath and returns newest first', () => {
    const board: Board = {
      me: record({ sessionId: 'me' }),
      old: record({ sessionId: 'old', filesEdited: { [key]: now - 9000 } }),
      new: record({ sessionId: 'new', state: 'waiting', filesEdited: { [key]: now - 1000 } }),
      mid: record({ sessionId: 'mid', state: 'done', filesEdited: { [key]: now - 5000 } })
    }
    const hits = findEditConflicts(board, 'me', 'c:/users/chris/builder-hub/src/A.TS', now)
    expect(hits.map((h) => h.otherSessionId)).toEqual(['new', 'mid', 'old'])
    expect(hits[0].file).toBe('c:/users/chris/builder-hub/src/A.TS')
  })
  it('labels the other session by project · task or folder', () => {
    const wt = 'C:\\Users\\chris\\builder-hub.worktrees\\fix-login'
    const board: Board = {
      me: record({ sessionId: 'me' }),
      t: { ...newSessionRecord('t', wt, ctx(T0)), filesEdited: { [key]: now } },
      x: { ...newSessionRecord('x', 'D:\\scratch\\thing', ctx(T0)), filesEdited: { [key]: now } }
    }
    const labels = findEditConflicts(board, 'me', file, now).map((h) => h.otherLabel)
    expect(labels.sort()).toEqual(['Builder Hub · fix-login', 'thing'])
  })
  it('returns [] on an empty board', () => {
    expect(findEditConflicts({}, 's1', file, now)).toEqual([])
  })
  it('a file named like a prototype key is never a conflict (regression: `at` was Object.prototype)', () => {
    const board: Board = { s1: record({ sessionId: 's1' }), s2: record({ sessionId: 's2' }) }
    expect(findEditConflicts(board, 's1', '__proto__', now)).toEqual([])
    expect(findEditConflicts(board, 's1', 'constructor', now)).toEqual([])
    expect(findEditConflicts(board, 's1', 'toString', now)).toEqual([])
    // a real edit of such a file (own key) still counts
    const edited = applyHookEvent(board, { ...edit('__proto__'), session_id: 's2' }, ctx(now - 1000))
    const hits = findEditConflicts(edited.board, 's1', `${CWD}\\__proto__`, now)
    expect(hits).toHaveLength(1)
    expect(hits[0].at).toBe(now - 1000)
  })
})

// ---------- staleAfterRead ----------

describe('staleAfterRead', () => {
  const file = 'C:\\Users\\chris\\builder-hub\\src\\a.ts'
  const key = 'c:\\users\\chris\\builder-hub\\src\\a.ts'
  it('is true when the file changed on disk after the read and was not edited since', () => {
    expect(staleAfterRead(record({ filesRead: { [key]: T0 } }), file, T0 + 1)).toBe(true)
    expect(
      staleAfterRead(record({ filesRead: { [key]: T0 }, filesEdited: { [key]: T0 - 1 } }), file, T0 + 1)
    ).toBe(true)
  })
  it('is false when the file was edited at/after the read (our own change)', () => {
    expect(
      staleAfterRead(record({ filesRead: { [key]: T0 }, filesEdited: { [key]: T0 } }), file, T0 + 1)
    ).toBe(false)
    expect(
      staleAfterRead(record({ filesRead: { [key]: T0 }, filesEdited: { [key]: T0 + 5 } }), file, T0 + 9)
    ).toBe(false)
  })
  it('is false when the mtime is not newer than the read', () => {
    expect(staleAfterRead(record({ filesRead: { [key]: T0 } }), file, T0)).toBe(false)
    expect(staleAfterRead(record({ filesRead: { [key]: T0 } }), file, T0 - 1)).toBe(false)
    expect(staleAfterRead(record({ filesRead: { [key]: T0 } }), file, Number.NaN)).toBe(false)
  })
  it('is false for a file this session never read', () => {
    expect(staleAfterRead(record(), file, T0 + 1)).toBe(false)
    expect(staleAfterRead(record({ filesEdited: { [key]: T0 } }), file, T0 + 1)).toBe(false)
  })
  it('matches by normPath', () => {
    expect(
      staleAfterRead(record({ filesRead: { [key]: T0 } }), 'c:/users/chris/builder-hub/src/A.ts', T0 + 1)
    ).toBe(true)
  })
  it('a file named like a prototype key reads as never seen (regression)', () => {
    expect(staleAfterRead(record(), '__proto__', T0 + 1)).toBe(false)
    expect(staleAfterRead(record(), 'constructor', T0 + 1)).toBe(false)
    // an OWN key that shadows a prototype member still counts (keys are normPath'd: lowercase)
    expect(staleAfterRead(record({ filesRead: { hasownproperty: T0 } }), 'hasOwnProperty', T0 + 1)).toBe(true)
    expect(staleAfterRead(record({ filesRead: { [key]: 'soon' as unknown as number } }), file, T0)).toBe(
      false
    )
  })
})

// ---------- pruneBoard ----------

describe('pruneBoard', () => {
  const now = T0 + 24 * 60 * 60 * 1000
  const board: Board = {
    liveFresh: record({ sessionId: 'liveFresh', state: 'working', updatedAt: now - 1000 }),
    liveOld: record({ sessionId: 'liveOld', state: 'done', updatedAt: now - BOARD_LIMITS.staleMs }),
    liveStale: record({
      sessionId: 'liveStale',
      state: 'working',
      updatedAt: now - BOARD_LIMITS.staleMs - 1
    }),
    endedFresh: record({ sessionId: 'endedFresh', state: 'ended', updatedAt: now - BOARD_LIMITS.endedTtlMs }),
    endedOld: record({ sessionId: 'endedOld', state: 'ended', updatedAt: now - BOARD_LIMITS.endedTtlMs - 1 })
  }
  it('drops ended sessions past their TTL and anything silent past staleMs', () => {
    const out = pruneBoard(board, now)
    expect(Object.keys(out).sort()).toEqual(['endedFresh', 'liveFresh', 'liveOld'].sort())
  })
  it('returns a new board and keeps surviving records by reference', () => {
    const out = pruneBoard(board, now)
    expect(out).not.toBe(board)
    expect(out.liveFresh).toBe(board.liveFresh)
    expect(Object.keys(board)).toHaveLength(5)
  })
  it('handles an empty board', () => {
    expect(pruneBoard({}, now)).toEqual({})
  })
  it('keeps a session whose id is a prototype key (regression: `out[id] = r` set the prototype)', () => {
    const proto = applyHookEvent({}, ev('SessionStart', {}, '__proto__'), ctx(now)).board
    const out = pruneBoard(proto, now)
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out)).toEqual(['__proto__'])
  })
})

// ---------- labels and summaries ----------

describe('sessionLabel', () => {
  it('uses "Project · task" for a worktree session', () => {
    expect(sessionLabel(record({ projectName: 'Income Kit', task: 'trailer' }))).toBe('Income Kit · trailer')
  })
  it('uses the project name alone without a task', () => {
    expect(sessionLabel(record())).toBe('Builder Hub')
  })
  it('falls back to the last cwd segment (either slash style)', () => {
    expect(sessionLabel(record({ projectName: undefined, cwd: 'D:\\scratch\\thing\\' }))).toBe('thing')
    expect(sessionLabel(record({ projectName: undefined, cwd: '/home/chris/thing' }))).toBe('thing')
    expect(sessionLabel(record({ projectName: undefined, cwd: 'thing' }))).toBe('thing')
  })
  it('falls back to the session id when even the cwd is empty', () => {
    expect(sessionLabel(record({ projectName: undefined, cwd: '' }))).toBe(SID)
  })
})

describe('boardSummaryLine', () => {
  it('renders the documented example shape', () => {
    const r = record({
      projectName: 'Income Kit',
      task: 'trailer',
      state: 'working',
      model: 'claude-opus-5',
      effort: 'high',
      filesEdited: { a: 1, b: 2, c: 3 },
      testStatus: { command: 'npm test', kind: 'test', outcome: 'pass', at: 1 }
    })
    expect(boardSummaryLine(r)).toBe('Income Kit · trailer — working · opus/high · 3 files · npm test ✓')
  })
  it('omits unknown pieces and pluralizes files', () => {
    expect(boardSummaryLine(record())).toBe('Builder Hub — done')
    expect(boardSummaryLine(record({ state: 'waiting', model: 'claude-sonnet-5' }))).toBe(
      'Builder Hub — waiting · sonnet'
    )
    expect(boardSummaryLine(record({ effort: 'low' }))).toBe('Builder Hub — done · effort low')
    expect(boardSummaryLine(record({ filesEdited: { a: 1 } }))).toBe('Builder Hub — done · 1 file')
  })
  it('marks fail and unknown verdicts and shortens long commands', () => {
    const long = 'npx vitest run ' + 'src/shared/sessionBoard.test.ts '.repeat(3)
    const fail = record({ testStatus: { command: long, kind: 'test', outcome: 'fail', at: 1 } })
    expect(boardSummaryLine(fail)).toBe(`Builder Hub — done · ${trimText(long, 40)} ✗`)
    const unknown = record({
      testStatus: { command: 'tsc --noEmit', kind: 'typecheck', outcome: 'unknown', at: 1 }
    })
    expect(boardSummaryLine(unknown)).toBe('Builder Hub — done · tsc --noEmit ?')
  })
  it('shows an unrecognized model id as-is', () => {
    expect(boardSummaryLine(record({ model: 'gpt-x' }))).toBe('Builder Hub — done · gpt-x')
    expect(boardSummaryLine(record({ model: 'Fable' }))).toBe('Builder Hub — done · fable')
  })
})

describe('otherSessionsSummary', () => {
  const board: Board = {
    me: record({ sessionId: 'me', updatedAt: T0 + 5 }),
    peer: record({ sessionId: 'peer', state: 'working', updatedAt: T0 + 1, lastAction: 'edited a.ts' }),
    peer2: record({ sessionId: 'peer2', state: 'waiting', updatedAt: T0 + 3 }),
    gone: record({ sessionId: 'gone', state: 'ended', updatedAt: T0 + 4, lastAction: 'x' }),
    kit: { ...newSessionRecord('kit', KIT.path, ctx(T0)), state: 'working', updatedAt: T0 + 9 }
  }
  it('lists other live sessions on the same project, most recent first, with their last action', () => {
    expect(otherSessionsSummary(board, 'me', 'hub')).toEqual([
      'Builder Hub — waiting',
      'Builder Hub — working · edited a.ts'
    ])
  })
  it('is empty when alone', () => {
    expect(otherSessionsSummary(board, 'kit', 'kit')).toEqual([])
    expect(otherSessionsSummary({}, 'me', 'hub')).toEqual([])
    expect(otherSessionsSummary({ me: board.me }, 'me', 'hub')).toEqual([])
  })
  it('falls back to the same cwd when the session has no project', () => {
    const ext: Board = {
      a: { ...newSessionRecord('a', 'D:\\scratch\\thing', ctx(T0)), state: 'working' },
      b: { ...newSessionRecord('b', 'd:/scratch/thing/', ctx(T0)), state: 'done', lastAction: 'recap: hi' },
      c: { ...newSessionRecord('c', 'D:\\scratch\\other', ctx(T0)), state: 'working' }
    }
    expect(otherSessionsSummary(ext, 'a', undefined)).toEqual(['thing — done · recap: hi'])
    expect(otherSessionsSummary(ext, 'zzz', undefined)).toEqual([])
  })
})

describe('bounds added after the integration review', () => {
  it('classifyCommand stays fast on a 256 KB heredoc flood (input is capped before the scanners)', () => {
    const flood = ('cat <<EOF\n' + 'x'.repeat(50) + '\n').repeat(4000) + 'npm test'
    expect(flood.length).toBeGreaterThan(200_000)
    const t0 = Date.now()
    classifyCommand(flood)
    expect(Date.now() - t0).toBeLessThan(500)
    // a normal chain still classifies from its real command
    expect(classifyCommand('cd x && npm test')).toBe('test')
  })
  it('filesEdited / filesRead are bounded to FILE_MAP_LIMIT distinct files (oldest dropped)', () => {
    const cwd = 'C:\\p'
    let board: Board = {}
    const ctx = { projects: [], now: 1 }
    board = applyHookEvent(
      board,
      { hook_event_name: 'SessionStart', session_id: 's', cwd, source: 'startup' },
      ctx
    ).board
    for (let i = 0; i < FILE_MAP_LIMIT + 20; i++) {
      board = applyHookEvent(
        board,
        {
          hook_event_name: 'PostToolUse',
          session_id: 's',
          cwd,
          tool_name: 'Edit',
          tool_input: { file_path: `C:\\p\\f${i}.ts` }
        },
        { ...ctx, now: 10 + i }
      ).board
      board = applyHookEvent(
        board,
        {
          hook_event_name: 'PostToolUse',
          session_id: 's',
          cwd,
          tool_name: 'Read',
          tool_input: { file_path: `C:\\p\\r${i}.ts` }
        },
        { ...ctx, now: 10 + i }
      ).board
    }
    const r = board['s']
    expect(Object.keys(r.filesEdited)).toHaveLength(FILE_MAP_LIMIT)
    expect(Object.keys(r.filesRead)).toHaveLength(FILE_MAP_LIMIT)
    expect(r.filesEdited['c:\\p\\f0.ts']).toBeUndefined() // oldest gone
    expect(r.filesEdited[`c:\\p\\f${FILE_MAP_LIMIT + 19}.ts`]).toBe(10 + FILE_MAP_LIMIT + 19) // newest kept
  })
  it('keeps enough of a long prompt for the router (promptChars) — not a 400-char stub', () => {
    const cwd = 'C:\\p'
    const long = 'please '.repeat(300) + 'redesign the architecture'
    const r = applyHookEvent(
      {},
      { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd, prompt: long },
      { projects: [], now: 1 }
    )
    expect(r.record?.lastPrompt?.length).toBeGreaterThan(1200)
    expect(r.record?.lastPrompt).toContain('redesign the architecture')
  })
})

describe('embedded by session id + isSessionIdle (integration review)', () => {
  const cwd = 'C:\\p'
  it('marks a session embedded when its id was launched by the Hub, even if the cwd set is empty', () => {
    const r = applyHookEvent(
      {},
      { hook_event_name: 'SessionStart', session_id: 'abc', cwd, source: 'startup' },
      {
        projects: [],
        now: 1,
        embeddedSessionIds: new Set(['abc'])
      }
    )
    expect(r.record?.embedded).toBe(true)
    const ext = applyHookEvent(
      {},
      { hook_event_name: 'SessionStart', session_id: 'zzz', cwd, source: 'startup' },
      {
        projects: [],
        now: 1,
        embeddedSessionIds: new Set(['abc'])
      }
    )
    expect(ext.record?.embedded).toBe(false)
  })
  it('isSessionIdle: done → idle; waiting on an idle prompt → idle; waiting on a permission prompt → busy; working → busy', () => {
    const base = newSessionRecord('s', cwd, { projects: [], now: 1 })
    expect(isSessionIdle({ ...base, state: 'done' })).toBe(true)
    expect(isSessionIdle({ ...base, state: 'waiting', lastAction: 'Claude is waiting for your input' })).toBe(
      true
    )
    expect(
      isSessionIdle({ ...base, state: 'waiting', lastAction: 'Claude needs your permission to use Bash' })
    ).toBe(false)
    expect(isSessionIdle({ ...base, state: 'working' })).toBe(false)
    expect(isSessionIdle({ ...base, state: 'ended' })).toBe(false)
  })
})

describe('review follow-ups: other-terminal liveness window + path key cap', () => {
  const cwd = 'C:\\p'
  const proj = { id: 'p1', name: 'P', path: cwd } as Project
  const start = (id: string, now: number): Board =>
    applyHookEvent(
      {},
      { hook_event_name: 'SessionStart', session_id: id, cwd, source: 'startup' },
      { projects: [proj], now }
    ).board
  it('a session silent for longer than OTHER_SESSION_WINDOW_MS is not listed as another terminal', () => {
    const board = { ...start('old', 1_000), ...start('me', 5_000_000) }
    // without `now` (legacy callers) the old rule applies: still listed
    expect(otherSessionsSummary(board, 'me', 'p1')).toHaveLength(1)
    // with `now`, a corpse from an hour+ ago is dropped…
    expect(otherSessionsSummary(board, 'me', 'p1', 1_000 + OTHER_SESSION_WINDOW_MS + 1)).toHaveLength(0)
    // …and a session that reported within the window is kept
    expect(otherSessionsSummary(board, 'me', 'p1', 1_000 + OTHER_SESSION_WINDOW_MS - 1)).toHaveLength(1)
  })
  it('a path longer than FILE_KEY_CHARS is never recorded as a file-map key', () => {
    const huge = 'C:\\p\\' + 'x'.repeat(FILE_KEY_CHARS + 10) + '.ts'
    let board = start('s', 1)
    board = applyHookEvent(
      board,
      {
        hook_event_name: 'PostToolUse',
        session_id: 's',
        cwd,
        tool_name: 'Edit',
        tool_input: { file_path: huge }
      },
      { projects: [proj], now: 2 }
    ).board
    board = applyHookEvent(
      board,
      {
        hook_event_name: 'PostToolUse',
        session_id: 's',
        cwd,
        tool_name: 'Read',
        tool_input: { file_path: huge }
      },
      { projects: [proj], now: 3 }
    ).board
    expect(Object.keys(board['s'].filesEdited)).toHaveLength(0)
    expect(Object.keys(board['s'].filesRead)).toHaveLength(0)
    // a normal path still records
    board = applyHookEvent(
      board,
      {
        hook_event_name: 'PostToolUse',
        session_id: 's',
        cwd,
        tool_name: 'Edit',
        tool_input: { file_path: 'C:\\p\\a.ts' }
      },
      { projects: [proj], now: 4 }
    ).board
    expect(Object.keys(board['s'].filesEdited)).toEqual(['c:\\p\\a.ts'])
  })
})
