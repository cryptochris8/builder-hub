import { describe, expect, it } from 'vitest'
import {
  DECISION_LIMITS,
  answersFromAskUserQuestion,
  applyDecisionRequest,
  buildDecisionContext,
  canonFolderSlug,
  decisionsByStatus,
  findEvidence,
  founderInputFromHook,
  isFounderPrompt,
  newDecisionId,
  normalizeDecision,
  normalizeForMatch,
  normalizeTopic,
  parseDecisionsJsonl,
  pushFounderInput,
  redactSecrets,
  renderDecisionsMarkdown,
  serializeDecisionsJsonl
} from './decisions'
import type { Decision, DecisionContext, DecisionRequest, FounderInput } from './decisions'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const HOUR = 60 * 60 * 1000

let idSeq = 0
function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    projectId: 'p1',
    now: NOW,
    by: 'cli',
    newId: () => newDecisionId(NOW, (0xa000 + (idSeq++ % 0x5fff)).toString(16)),
    founderInputs: [],
    ...over
  }
}

const said = (text: string, at = NOW - HOUR, kind: FounderInput['kind'] = 'prompt'): FounderInput => ({
  at,
  kind,
  text,
  sessionId: 'sess-1'
})

function run(list: Decision[], req: DecisionRequest, c: Partial<DecisionContext> = {}) {
  return applyDecisionRequest(list, req, ctx(c))
}

describe('redactSecrets', () => {
  it.each([
    ['sk-ant-api03-abcdefghijklmnop', 'sk-ant'],
    ['sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX', 'sk-proj'],
    ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12', 'ghp_'],
    ['github_pat_ABCDEFGHIJKLMNOPQRSTUV_xyz', 'github_pat_'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIA'],
    ['xoxb-1234567890-abcdef', 'xoxb'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIza'],
    ['eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'eyJ']
  ])('masks %s', (secret, prefix) => {
    const out = redactSecrets(`use ${secret} now`)
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain(secret)
    expect(out.startsWith('use ')).toBe(true)
    expect(out).not.toContain(prefix + secret.slice(prefix.length + 2))
  })

  it('keeps variable names but drops values', () => {
    expect(redactSecrets('ELEVENLABS_API_KEY=abc123def456')).toBe('ELEVENLABS_API_KEY=[REDACTED]')
    expect(redactSecrets('"api_token": "zzzzzzzz"')).toBe('"api_token": "[REDACTED]"')
    expect(redactSecrets('password: hunter22')).toBe('password: [REDACTED]')
  })

  it('masks bearer tokens, URL passwords and private keys', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuv')).toBe(
      'Authorization: Bearer [REDACTED]'
    )
    expect(redactSecrets('https://user:pa55word@host/x')).toBe('https://user:[REDACTED]@host/x')
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    expect(redactSecrets(`k ${pem} done`)).toBe('k [REDACTED] done')
  })

  it('leaves commit shas, uuids and ordinary prose alone', () => {
    const text =
      'commit 2ca52bd1e4f9a7c3b8d6e5f4a3b2c1d0e9f8a7b6 in session 6767f323-1cf4-4810-a8fd-f29a195b3244: lets scrap openclaw for now'
    expect(redactSecrets(text)).toBe(text)
    expect(redactSecrets('the API key lives in elevenlabs.txt')).toBe('the API key lives in elevenlabs.txt')
  })

  it('masks long mixed-case blobs of unknown shape', () => {
    const blob = 'Ab1' + 'xY9'.repeat(15)
    expect(redactSecrets(`token ${blob}`)).toBe('token [REDACTED]')
  })

  it('is safe on junk', () => {
    expect(redactSecrets(undefined as unknown as string)).toBe('')
    expect(redactSecrets('')).toBe('')
  })
})

describe('founder input', () => {
  it('tells founder prompts from machine messages and slash commands', () => {
    expect(isFounderPrompt('lets scrap openclaw for now')).toBe(true)
    expect(isFounderPrompt('<cross-session-message from="x">yes</cross-session-message>')).toBe(false)
    expect(isFounderPrompt('  <task-notification>done</task-notification>')).toBe(false)
    expect(isFounderPrompt('/clear')).toBe(false)
    expect(isFounderPrompt('')).toBe(false)
    expect(isFounderPrompt('<b>bold</b> is fine from me')).toBe(true)
  })

  it('reads AskUserQuestion answers from tool_input or tool_response', () => {
    const answers = { 'Where should canon live?': 'One central git repo', 'Pick tools': ['A', 'B'] }
    expect(answersFromAskUserQuestion({ answers }, undefined)).toBe(
      'Where should canon live? → One central git repo | Pick tools → A, B'
    )
    expect(answersFromAskUserQuestion({}, { answers: { Q: 'Yes' } })).toBe('Q → Yes')
    expect(answersFromAskUserQuestion({ questions: [] }, 'text')).toBeUndefined()
    expect(answersFromAskUserQuestion({ answers: { Q: '' } }, undefined)).toBeUndefined()
  })

  it('founderInputFromHook takes prompts and AskUserQuestion answers only', () => {
    expect(
      founderInputFromHook({ hook_event_name: 'UserPromptSubmit', prompt: 'go with it' }, 's1', NOW)
    ).toEqual({
      at: NOW,
      kind: 'prompt',
      text: 'go with it',
      sessionId: 's1'
    })
    expect(
      founderInputFromHook({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>x' }, 's1', NOW)
    ).toBeUndefined()
    expect(
      founderInputFromHook(
        { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { answers: { Q: 'A' } } },
        's1',
        NOW
      )
    ).toMatchObject({ kind: 'answer', text: 'Q → A' })
    expect(
      founderInputFromHook(
        { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { answers: { Q: 'A' } } },
        's1',
        NOW
      )
    ).toBeUndefined()
    expect(founderInputFromHook({ hook_event_name: 'Stop' }, 's1', NOW)).toBeUndefined()
    expect(
      founderInputFromHook({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }, '', NOW)
    ).toBeUndefined()
  })

  it('keeps the head and tail of a long prompt (his words often wrap a paste)', () => {
    const long = 'Approve this: yes central repo. ' + 'pasted '.repeat(1000) + ' and also scrap openclaw'
    const [kept] = pushFounderInput([], said(long))
    expect(kept.text.length).toBe(DECISION_LIMITS.founderInputChars)
    expect(kept.text.startsWith('Approve this: yes central repo.')).toBe(true)
    expect(kept.text.endsWith('and also scrap openclaw')).toBe(true)
  })

  it('pushFounderInput redacts, caps, and keeps the newest N', () => {
    let list: FounderInput[] = []
    for (let i = 0; i < 25; i++) list = pushFounderInput(list, said(`prompt ${i}`, NOW + i))
    expect(list).toHaveLength(DECISION_LIMITS.founderInputs)
    expect(list[0].text).toBe('prompt 5')
    const one = pushFounderInput([], said('key sk-ant-api03-abcdefghijklmnop ' + 'x'.repeat(3000)))
    expect(one[0].text).toContain('[REDACTED]')
    expect(one[0].text.length).toBe(DECISION_LIMITS.founderInputChars)
    expect(pushFounderInput(list, said('   '))).toHaveLength(list.length)
    expect(pushFounderInput([{ junk: 1 } as unknown as FounderInput], said('ok'))).toHaveLength(1)
  })
})

describe('findEvidence', () => {
  const inputs = [
    said('I agree though, lets scrap openclaw for now and continue to tidy up', NOW - 2 * HOUR),
    said('Where should canon live? → One central git repo (Recommended)', NOW - HOUR, 'answer'),
    said('I know what I want', NOW - 30 * 60 * 1000)
  ]

  it('finds the founder words, ignoring case and punctuation', () => {
    const e = findEvidence('Let’s scrap OpenClaw, for now', inputs, NOW)
    expect(e).toBeUndefined() // "let's" ≠ "lets": quotes must be his words
    const e2 = findEvidence('lets scrap OpenClaw for now', inputs, NOW)
    expect(e2?.kind).toBe('prompt')
    expect(e2?.at).toBe(NOW - 2 * HOUR)
    expect(e2?.excerpt).toContain('scrap openclaw')
  })

  it('matches answers too', () => {
    expect(findEvidence('One central git repo', inputs, NOW)?.kind).toBe('answer')
  })

  it('matches whole words only', () => {
    expect(findEvidence('no', inputs, NOW)).toBeUndefined() // inside "know"/"now"
  })

  it('respects the window and prefers the newest match', () => {
    const old = [said('yes do it', NOW - 72 * HOUR)]
    expect(findEvidence('yes do it', old, NOW)).toBeUndefined()
    const two = [said('yes do it', NOW - 3 * HOUR), said('ok yes do it', NOW - HOUR)]
    expect(findEvidence('yes do it', two, NOW)?.at).toBe(NOW - HOUR)
  })

  it('refuses empty or one-char quotes and future inputs', () => {
    expect(findEvidence('', inputs, NOW)).toBeUndefined()
    expect(findEvidence('I', inputs, NOW)).toBeUndefined()
    expect(findEvidence('later', [said('later', NOW + 10 * HOUR)], NOW)).toBeUndefined()
  })

  it('bounds the excerpt around the match', () => {
    const long = said('a '.repeat(500) + 'the magic words here ' + 'b '.repeat(500))
    const e = findEvidence('the magic words', [long], NOW)
    expect(e?.excerpt?.length).toBeLessThanOrEqual(DECISION_LIMITS.excerptChars + 2)
    expect(e?.excerpt).toContain('the magic words')
  })

  it('normalizeForMatch flattens text', () => {
    expect(normalizeForMatch('  Hello,   WORLD! “ok” ')).toBe('hello world ok')
  })
})

describe('ids, topics, slugs', () => {
  it('normalizes topics to kebab case, bounded', () => {
    expect(normalizeTopic('Canon Home / Repo!')).toBe('canon-home-repo')
    expect(normalizeTopic('x'.repeat(100)).length).toBe(DECISION_LIMITS.topicChars)
    expect(normalizeTopic('---')).toBe('')
  })
  it('builds D-YYYYMMDD-xxxx ids', () => {
    expect(newDecisionId(NOW, 'AB12')).toBe('D-20261104-ab12')
    expect(newDecisionId(NOW, 'z')).toBe('D-20261104-0000')
  })
  it('slugs folder names', () => {
    expect(canonFolderSlug('Builder Hub (this app)')).toBe('builder-hub-this-app')
    expect(canonFolderSlug('???')).toBe('project')
  })
})

describe('applyDecisionRequest', () => {
  it('records a proposal without evidence', () => {
    const r = run([], { action: 'propose', topic: 'Canon home', statement: 'Keep canon in open-claw' })
    expect(r.ok).toBe(true)
    expect(r.outcome).toBe('proposed')
    expect(r.decisions).toHaveLength(1)
    expect(r.decision).toMatchObject({
      topic: 'canon-home',
      status: 'proposed',
      proposer: 'claude',
      projectId: 'p1'
    })
  })

  it('approves a new decision when the quote is found in founder input', () => {
    const r = run(
      [],
      {
        action: 'approve',
        topic: 'openclaw',
        statement: 'Scrap OpenClaw for now',
        quote: 'lets scrap openclaw for now'
      },
      { founderInputs: [said('I agree, lets scrap openclaw for now')] }
    )
    expect(r.outcome).toBe('approved')
    expect(r.decision?.status).toBe('approved')
    expect(r.decision?.evidence).toMatchObject({
      kind: 'prompt',
      quote: 'lets scrap openclaw for now',
      sessionId: 'sess-1'
    })
    expect(r.decision?.history.map((h) => h.action)).toEqual(['proposed', 'approved'])
  })

  it('never approves on a quote that is not found: stores a proposal instead', () => {
    const r = run(
      [],
      { action: 'approve', topic: 't', statement: 's', quote: 'Chris said yes' },
      { founderInputs: [said('maybe later')] }
    )
    expect(r.ok).toBe(true)
    expect(r.outcome).toBe('proposed')
    expect(r.decision?.status).toBe('proposed')
    expect(r.decision?.evidence).toBeUndefined()
    expect(r.message).toMatch(/PROPOSAL/)
    const noQuote = run([], { action: 'approve', topic: 't', statement: 's' })
    expect(noQuote.outcome).toBe('proposed')
    expect(noQuote.message).toMatch(/No quote/)
  })

  it('approves an existing proposal by id with evidence, and refuses without', () => {
    const p = run([], { action: 'propose', topic: 't', statement: 's' })
    const id = p.decision!.id
    const refused = run(p.decisions, { action: 'approve', id, quote: 'nope' })
    expect(refused.outcome).toBe('refused')
    expect(refused.decisions).toEqual(p.decisions) // existing proposal kept untouched
    const ok = run(
      p.decisions,
      { action: 'approve', id, quote: 'yes go' },
      { founderInputs: [said('yes go')] }
    )
    expect(ok.outcome).toBe('approved')
    expect(ok.decisions).toHaveLength(1)
    expect(ok.decisions[0].status).toBe('approved')
  })

  it('refuses a second approved decision on the same topic unless it supersedes', () => {
    const inputs = [said('use one central git repo'), said('actually put it in each repo')]
    const a = run(
      [],
      { action: 'approve', topic: 'canon-home', statement: 'Central repo', quote: 'one central git repo' },
      { founderInputs: inputs }
    )
    const clash = run(
      a.decisions,
      { action: 'approve', topic: 'canon-home', statement: 'Per repo', quote: 'put it in each repo' },
      { founderInputs: inputs }
    )
    expect(clash.outcome).toBe('refused')
    expect(clash.message).toMatch(/Conflict/)
    expect(clash.decisions).toEqual(a.decisions) // the new one is not left behind
    const sup = run(
      a.decisions,
      {
        action: 'approve',
        topic: 'canon-home',
        statement: 'Per repo',
        quote: 'put it in each repo',
        supersedes: a.decision!.id
      },
      { founderInputs: inputs }
    )
    expect(sup.outcome).toBe('approved')
    const g = decisionsByStatus(sup.decisions)
    expect(g.approved.map((d) => d.statement)).toEqual(['Per repo'])
    expect(g.superseded[0]).toMatchObject({ id: a.decision!.id, supersededBy: sup.decision!.id })
  })

  it('refuses to supersede a missing or non-approved decision', () => {
    const inputs = [said('yes')]
    const p = run([], { action: 'propose', topic: 'a', statement: 'x' })
    const bad = run(
      p.decisions,
      { action: 'approve', topic: 'b', statement: 'y', quote: 'yes', supersedes: p.decision!.id },
      { founderInputs: inputs }
    )
    expect(bad.outcome).toBe('refused')
    expect(bad.decisions).toEqual(p.decisions)
    const missing = run(
      [],
      { action: 'approve', topic: 'b', statement: 'y', quote: 'yes', supersedes: 'D-20260101-0000' },
      { founderInputs: inputs }
    )
    expect(missing.outcome).toBe('refused')
    expect(missing.decisions).toEqual([])
  })

  it('warns when a proposal conflicts with an approved decision', () => {
    const a = run(
      [],
      { action: 'approve', topic: 'stack', statement: 'Vite', quote: 'vite' },
      { founderInputs: [said('use vite')] }
    )
    const p = run(a.decisions, { action: 'propose', topic: 'stack', statement: 'Next.js' })
    expect(p.outcome).toBe('proposed')
    expect(p.message).toMatch(/conflicts with approved/)
    expect(decisionsByStatus(p.decisions).approved).toHaveLength(1)
  })

  it('records rejected approaches (new, or an existing proposal) only with evidence', () => {
    const inputs = [said('no OpenClaw on the Pi')]
    const r = run(
      [],
      {
        action: 'reject',
        topic: 'pi',
        statement: 'Install OpenClaw on the Pi',
        quote: 'no OpenClaw on the Pi'
      },
      { founderInputs: inputs }
    )
    expect(r.outcome).toBe('rejected')
    const p = run(r.decisions, { action: 'propose', topic: 'x', statement: 'y' })
    const nope = run(p.decisions, { action: 'reject', id: p.decision!.id, quote: 'missing words' })
    expect(nope.outcome).toBe('refused')
    const yes = run(
      p.decisions,
      { action: 'reject', id: p.decision!.id, quote: 'no OpenClaw' },
      { founderInputs: inputs }
    )
    expect(yes.outcome).toBe('rejected')
    expect(
      run(
        yes.decisions,
        { action: 'reject', id: p.decision!.id, quote: 'no OpenClaw' },
        { founderInputs: inputs }
      ).outcome
    ).toBe('refused')
  })

  it('treats a Hub UI click as evidence', () => {
    const p = run([], { action: 'propose', topic: 't', statement: 's' })
    const r = run(p.decisions, { action: 'approve', id: p.decision!.id }, { by: 'hub-ui' })
    expect(r.outcome).toBe('approved')
    expect(r.decision?.evidence).toMatchObject({ kind: 'hub-ui', quote: 'Approved in Builder Hub' })
    expect(r.decision?.history.at(-1)?.by).toBe('chris')
  })

  it('validates input', () => {
    expect(run([], { action: 'delete' as 'propose' }).outcome).toBe('refused')
    expect(run([], { action: 'propose', topic: '', statement: 's' }).outcome).toBe('refused')
    expect(run([], { action: 'approve', id: 'D-20260101-0000' }).message).toMatch(/No decision/)
    const p = run([], { action: 'propose', topic: 't', statement: 's' })
    expect(run(p.decisions, { action: 'propose', id: p.decision!.id }).outcome).toBe('refused')
    const a = run(p.decisions, { action: 'approve', id: p.decision!.id }, { by: 'hub-ui' })
    expect(run(a.decisions, { action: 'approve', id: p.decision!.id }, { by: 'hub-ui' }).message).toMatch(
      /only a proposal/
    )
  })
})

describe('storage', () => {
  it('round-trips through jsonl in stable order', () => {
    const a = run([], { action: 'propose', topic: 'b', statement: 'second' }, { now: NOW + 1000 })
    const b = run(a.decisions, { action: 'propose', topic: 'a', statement: 'first' })
    const text = serializeDecisionsJsonl(b.decisions)
    const back = parseDecisionsJsonl(text, 'p1')
    expect(back.map((d) => d.statement)).toEqual(['first', 'second'])
    expect(serializeDecisionsJsonl([])).toBe('')
  })

  it('skips bad lines and duplicate ids', () => {
    const good = run([], { action: 'propose', topic: 't', statement: 's' }).decision!
    const text = [
      'not json',
      JSON.stringify(good),
      JSON.stringify({ ...good, statement: 'dup' }),
      '{"id":"x"}',
      ''
    ].join('\n')
    const back = parseDecisionsJsonl(text, 'p1')
    expect(back).toHaveLength(1)
    expect(back[0].statement).toBe('s')
  })

  it('demotes an approved record that has no evidence (hand-edited files are not trusted)', () => {
    const d = normalizeDecision(
      { id: 'D-20261104-aaaa', topic: 't', statement: 's', status: 'approved', createdAt: NOW },
      'p1'
    )
    expect(d?.status).toBe('proposed')
    expect(d?.history.at(-1)?.note).toMatch(/demoted/)
  })

  it('redacts evidence it loads', () => {
    const d = normalizeDecision(
      {
        id: 'D-20261104-aaaa',
        topic: 't',
        statement: 's',
        status: 'approved',
        createdAt: NOW,
        evidence: { kind: 'prompt', quote: 'use sk-ant-api03-abcdefghijklmnop', at: NOW }
      },
      'p1'
    )
    expect(d?.status).toBe('approved')
    expect(d?.evidence?.quote).toBe('use [REDACTED]')
  })
})

describe('views', () => {
  const inputs = [said('yes central repo'), said('no openclaw')]
  const a = run(
    [],
    {
      action: 'approve',
      topic: 'canon',
      statement: 'Central repo',
      quote: 'yes central repo',
      rationale: 'one place'
    },
    { founderInputs: inputs }
  )
  const b = run(
    a.decisions,
    { action: 'reject', topic: 'openclaw', statement: 'Use OpenClaw', quote: 'no openclaw' },
    { founderInputs: inputs }
  )
  const c = run(b.decisions, { action: 'propose', topic: 'later', statement: 'Maybe X' })

  it('renders DECISIONS.md by status with evidence', () => {
    const md = renderDecisionsMarkdown('open-claw', c.decisions)
    expect(md).toContain('# open-claw — decisions')
    expect(md).toContain('## Approved (1)')
    expect(md).toContain('## Rejected approaches (1)')
    expect(md).toContain('## Proposed (not binding until Chris approves) (1)')
    expect(md).toContain('**Evidence:** 2026-11-04, prompt: "yes central repo"')
    expect(md).toContain('**Why:** one place')
    expect(md).not.toMatch(/\n{3,}/)
  })

  it('builds a bounded SessionStart block that always explains how to record', () => {
    const empty = buildDecisionContext({ decisions: [], cliCommand: 'node decide.mjs' })
    expect(empty).toContain('node decide.mjs propose|approve|reject')
    expect(empty).not.toContain('binding')
    const full = buildDecisionContext({
      decisions: c.decisions,
      cliCommand: 'node decide.mjs',
      vision: 'Make great films.',
      decisionsFile: 'K/DECISIONS.md'
    })
    expect(full).toContain('Founder vision: Make great films.')
    expect(full).toContain('1 approved, 1 rejected, 1 proposed')
    expect(full).toContain('- APPROVED')
    expect(full).toContain('- REJECTED')
    expect(full).toContain('proposal(s) await Chris')
    expect(full).toContain('Full record: K/DECISIONS.md')
  })

  it('keeps the newest decisions and counts the rest when over budget', () => {
    let list: Decision[] = []
    for (let i = 0; i < 60; i++) {
      list = run(
        list,
        { action: 'approve', topic: `topic-${i}`, statement: 'x'.repeat(150), quote: 'yes' },
        {
          founderInputs: [said('yes')],
          now: NOW + i,
          newId: () => newDecisionId(NOW, (0x1000 + i).toString(16))
        }
      ).decisions
    }
    const text = buildDecisionContext({ decisions: list, cliCommand: 'decide', maxChars: 2000 })
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).toMatch(/\+\d+ more in the full record/)
    expect(text).toContain('topic-59') // newest kept
  })
})
