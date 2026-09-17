import { describe, it, expect } from 'vitest'
import {
  SWITCHING_LIMITS,
  SWITCHING_WEIGHTS,
  applySwitchingPolicy,
  assessCapture,
  assessContinuity,
  assessSize,
  assessSwitching,
  describeSwitching,
  detectTaskBoundary,
  emptyLedger,
  inferContextWindow,
  isApproval,
  mergeContextUsage,
  normalizeLedger,
  recapLanguage,
  scoreContextValue,
  significantWords,
  transcriptUsage,
  usageFromTranscriptTail
} from './switchingCost'
import type { ContinuityInput, SwitchingInput } from './switchingCost'
import { emptySignals, recommend } from './router'
import { applyHookEvent } from './sessionBoard'
import type { Board } from './sessionBoard'
import type { ContextUsage, ContinuityLedger, Project, SessionRecord } from './types'

const NOW = 1_800_000_000_000
const MIN = 60_000

const HUB: Project = { id: 'p1', name: 'Builder Hub', path: 'C:\\hub' } as Project
const GNARLY: Project = { id: 'p2', name: 'Gnarly Nutmeg', path: 'C:\\games\\gnarly' } as Project
const PROJECTS = [HUB, GNARLY]

const exact = (pct: number): ContextUsage => ({
  pct,
  windowSize: 1_000_000,
  tokens: pct * 10_000,
  source: 'statusline',
  at: NOW
})

const ledger = (over: Partial<ContinuityLedger>): ContinuityLedger => ({ ...emptyLedger(), ...over })

/** A long, productive Builder Hub session — the "Scenario A" shape. */
const valuableRecord = (over: Partial<SwitchingInput['record']> = {}): SwitchingInput['record'] => ({
  projectId: 'p1',
  objective: 'build context-aware switching cost into the router',
  recaps: [
    'Decided to keep the task tier separate from switching cost; the root cause of the noisy suggestion was the default tier.',
    'Router policy now holds downgrades when risk is high; tests pass.'
  ],
  filesEdited: {
    'c:\\hub\\src\\shared\\router.ts': NOW - 5 * MIN,
    'c:\\hub\\src\\shared\\switchingcost.ts': NOW - 4 * MIN,
    'c:\\hub\\src\\main\\orchestrator.ts': NOW - 3 * MIN,
    'c:\\hub\\src\\shared\\types.ts': NOW - 3 * MIN,
    'c:\\hub\\src\\renderer\\src\\components\\sessionbar.tsx': NOW - 2 * MIN
  },
  otherProjectsTouched: [],
  signals: emptySignals(),
  contextUsage: exact(95),
  ledger: ledger({
    turns: 12,
    editTurns: 8,
    passesAfterEdit: 3,
    decisionHits: 3,
    rootCauseHits: 1,
    lastEditAt: NOW - 2 * MIN,
    lastSubstantiveAt: NOW - 2 * MIN,
    lastCaptureAt: NOW - MIN,
    substantiveTurnsSinceHandoff: 8,
    decisionsSinceHandoff: 4
  }),
  ...over
})

const FABLE = { model: 'claude-fable-5-1', effort: 'xhigh' }

/** Router + switching policy, exactly as the orchestrator composes them. */
const route = (
  record: SwitchingInput['record'],
  prompt: string,
  current = FABLE,
  signals = emptySignals()
): ReturnType<typeof applySwitchingPolicy> => {
  const rec = recommend({ prompt, signals, current, projects: PROJECTS, now: NOW })
  const a = assessSwitching({ record, prompt, projects: PROJECTS, now: NOW })
  return applySwitchingPolicy(rec, a, current, { unresolvedFailure: record.testStatus?.outcome === 'fail' })
}

// ---------------------------------------------------------------------------
describe('ledger normalization + language proxies', () => {
  it('normalizeLedger resets garbage and keeps valid counters, times and boundary', () => {
    const l = normalizeLedger({
      editTurns: 3,
      turns: -2,
      searchCalls: 'lots',
      lastEditAt: NOW,
      lastCaptureAt: Number.NaN,
      boundary: { at: NOW, strength: 'strong', reason: 'x' },
      junk: 1
    })
    expect(l.editTurns).toBe(3)
    expect(l.turns).toBe(0)
    expect(l.searchCalls).toBe(0)
    expect(l.lastEditAt).toBe(NOW)
    expect(l.lastCaptureAt).toBeUndefined()
    expect(l.boundary).toEqual({ at: NOW, strength: 'strong', reason: 'x' })
    expect(normalizeLedger(null)).toEqual(emptyLedger())
    expect(
      normalizeLedger({ boundary: { at: NOW, strength: 'maybe', reason: 'x' } }).boundary
    ).toBeUndefined()
  })
  it('recapLanguage recognizes decisions, root causes and constraints / negative findings', () => {
    expect(recapLanguage('We decided to use a JSON store instead of SQLite.')).toEqual({
      decision: true,
      rootCause: false,
      constraint: false
    })
    expect(recapLanguage('The root cause was a first-match resolver.').rootCause).toBe(true)
    expect(recapLanguage('HTTP hooks are not supported for SessionStart — verified.').constraint).toBe(true)
    expect(recapLanguage('Renamed the label.')).toEqual({
      decision: false,
      rootCause: false,
      constraint: false
    })
    expect(recapLanguage(undefined)).toEqual({ decision: false, rootCause: false, constraint: false })
  })
  it('isApproval spots approvals, not ordinary prompts', () => {
    for (const p of ['yes, do it', 'Go ahead with option B', 'sounds good', 'LGTM', 'ok ship it'])
      expect(isApproval(p)).toBe(true)
    for (const p of ['fix the router test', 'how does this work?', '', undefined])
      expect(isApproval(p)).toBe(false)
  })
  it('significantWords drops short words and stopwords', () => {
    expect([...significantWords('Fix the router test in this file please')]).toEqual(['router', 'test'])
  })
})

// ---------------------------------------------------------------------------
describe('context size (G: exact, estimated or unknown — never faked)', () => {
  it('status line data is exact and classified by percentage', () => {
    expect(assessSize(exact(10))).toMatchObject({ size: 'low', source: 'exact', pct: 10 })
    expect(assessSize(exact(40)).size).toBe('moderate')
    expect(assessSize(exact(70)).size).toBe('high')
    expect(assessSize(exact(95)).size).toBe('very-high')
  })
  it('no data at all is Unknown', () => {
    expect(assessSize(undefined)).toEqual({ size: 'unknown', source: 'unknown' })
    expect(assessSize({ source: 'unknown', at: NOW })).toEqual({ size: 'unknown', source: 'unknown' })
  })
  it('inferContextWindow only answers when the window is actually known', () => {
    expect(inferContextWindow('claude-opus-5[1m]', 10)).toBe(1_000_000)
    expect(inferContextWindow('claude-opus-5', 779_115)).toBe(1_000_000) // cannot fit a standard window
    expect(inferContextWindow('claude-opus-5', 150_000)).toBeUndefined()
    expect(inferContextWindow(undefined, undefined)).toBeUndefined()
  })
  it('a transcript estimate with an unknown window reports tokens, NOT a percentage', () => {
    const u = transcriptUsage(150_000, 'claude-sonnet-5', NOW)
    expect(u.pct).toBeUndefined()
    expect(u.windowSize).toBeUndefined()
    expect(assessSize(u)).toEqual({ size: 'high', source: 'estimated', tokens: 150_000 })
    const big = transcriptUsage(300_000, 'claude-opus-5', NOW)
    expect(big.pct).toBe(30)
    expect(assessSize(big)).toMatchObject({ size: 'moderate', source: 'estimated', pct: 30 })
  })
  it('usageFromTranscriptTail reads the last main-thread assistant usage and skips partial lines and sidechains', () => {
    const tail = [
      'ncated": true, "type": "assistant"}', // cut first line of a tail read
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 10,
            output_tokens: 20
          }
        }
      }),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 999999 } } })
    ].join('\n')
    expect(usageFromTranscriptTail(tail)).toEqual({ tokens: 1035, model: 'claude-opus-5' })
    expect(usageFromTranscriptTail('')).toBeUndefined()
    expect(usageFromTranscriptTail('{"type":"user"}')).toBeUndefined()
  })
  it('mergeContextUsage keeps a fresh exact reading over a transcript estimate, and lets a newer one win otherwise', () => {
    const status = exact(50)
    const est: ContextUsage = { tokens: 100, source: 'transcript', at: NOW + 60_000 }
    expect(mergeContextUsage(status, est)).toBe(status)
    const late: ContextUsage = { ...est, at: NOW + SWITCHING_LIMITS.statusLineFreshMs + 1 }
    expect(mergeContextUsage(status, late)).toBe(late)
    expect(mergeContextUsage(undefined, est)).toBe(est)
    expect(mergeContextUsage(status, undefined)).toBe(status)
  })
})

// ---------------------------------------------------------------------------
describe('context value', () => {
  const base = { filesEdited: 0, projectsTouched: 0, now: NOW }
  it('productive work scores high; the reasons name what counted', () => {
    const r = scoreContextValue({
      ...base,
      filesEdited: 5,
      ledger: valuableRecord().ledger as ContinuityLedger
    })
    expect(r.value).toBe('critical')
    expect(r.score).toBeGreaterThanOrEqual(SWITCHING_LIMITS.valueHigh)
    expect(r.reasons.join(' ')).toMatch(/turn\(s\) with edits/)
    expect(r.reasons.join(' ')).toMatch(/decision/)
  })
  it('exploration with no lasting finding scores low (Scenario B)', () => {
    const r = scoreContextValue({
      ...base,
      ledger: ledger({ readOnlyTurns: 25, editTurns: 1, searchCalls: 120 })
    })
    expect(r.value).toBe('low')
    expect(r.reasons.join(' ')).toMatch(/exploratory/)
  })
  it('research without edits that established constraints still has value', () => {
    const noEdits = scoreContextValue({
      ...base,
      ledger: ledger({ readOnlyTurns: 10, constraintHits: 3, rootCauseHits: 1 })
    })
    expect(noEdits.score).toBeGreaterThan(0)
    expect(noEdits.value).not.toBe('low')
  })
  it('compaction and staleness reduce value', () => {
    const l = ledger({ editTurns: 5, decisionHits: 2, lastSubstantiveAt: NOW - MIN })
    const fresh = scoreContextValue({ ...base, ledger: l }).score
    expect(scoreContextValue({ ...base, ledger: { ...l, compactions: 2 } }).score).toBeLessThan(fresh)
    expect(
      scoreContextValue({ ...base, ledger: { ...l, lastSubstantiveAt: NOW - 7 * 60 * MIN } }).score
    ).toBeLessThan(fresh)
    expect(
      scoreContextValue({ ...base, ledger: { ...l, lastSubstantiveAt: NOW - 25 * 60 * MIN } }).score
    ).toBeLessThan(
      scoreContextValue({ ...base, ledger: { ...l, lastSubstantiveAt: NOW - 7 * 60 * MIN } }).score
    )
  })
  it('an in-progress fix (failing check after edits) and multi-file work add value', () => {
    const l = ledger({ editTurns: 2 })
    const plain = scoreContextValue({ ...base, ledger: l }).score
    const failing = scoreContextValue({
      ...base,
      ledger: l,
      testStatus: { command: 'npm test', kind: 'test', outcome: 'fail', at: NOW }
    }).score
    expect(failing).toBeGreaterThan(plain)
    expect(scoreContextValue({ ...base, ledger: l, filesEdited: 8 }).score).toBeGreaterThan(plain)
  })
})

// ---------------------------------------------------------------------------
describe('task boundary + continuity', () => {
  const input = (prompt: string, over: Partial<ContinuityInput> = {}): ContinuityInput => {
    const r = valuableRecord()
    return {
      prompt,
      objective: r.objective,
      recaps: r.recaps as string[],
      filesEdited: Object.keys(r.filesEdited as Record<string, number>),
      sessionProjectId: 'p1',
      projects: PROJECTS,
      ...over
    }
  }
  const cont = (prompt: string, over: Partial<ContinuityInput> = {}): ReturnType<typeof assessContinuity> => {
    const i = input(prompt, over)
    return assessContinuity(i, detectTaskBoundary(i))
  }

  it('naming another registered project is a strong boundary with very-low continuity', () => {
    const i = input('open Gnarly Nutmeg and change PLAY to START')
    expect(detectTaskBoundary(i)).toMatchObject({ strength: 'strong' })
    expect(cont('open Gnarly Nutmeg and change PLAY to START').continuity).toBe('very-low')
  })
  it('naming the SESSION project is not a boundary', () => {
    expect(detectTaskBoundary(input('in Builder Hub, fix the remaining router test')).strength).toBe('none')
  })
  it('explicit "that task is over" language is a strong boundary', () => {
    expect(detectTaskBoundary(input("That's done — new task: update the pricing page")).strength).toBe(
      'strong'
    )
    expect(cont("That's done — new task: update the pricing page").continuity).toBe('low')
  })
  it('a completed objective followed by an unrelated request is a strong boundary (H)', () => {
    const i = input('change the footer copyright year on the marketing website', {
      recaps: ['All tests pass — the switching-cost router work is complete.'],
      testStatus: { command: 'npm test', kind: 'test', outcome: 'pass', at: NOW }
    })
    expect(detectTaskBoundary(i)).toMatchObject({
      strength: 'strong',
      reason: expect.stringMatching(/completed/)
    })
    // …but not while the last check is failing
    expect(
      detectTaskBoundary({
        ...i,
        testStatus: { command: 'npm test', kind: 'test', outcome: 'fail', at: NOW }
      }).strength
    ).toBe('none')
  })
  it('"next" with drift is a weak boundary and caps continuity at moderate', () => {
    const i = input('next, tidy up the settings panel spacing values')
    expect(detectTaskBoundary(i).strength).toBe('weak')
    expect(['moderate', 'low']).toContain(cont('next, tidy up the settings panel spacing values').continuity)
  })
  it('touching a file this session changed, or continuation language, is high continuity', () => {
    expect(cont('fix the remaining router test')).toMatchObject({ continuity: 'high', confident: true })
    expect(cont('keep going with the policy wiring')).toMatchObject({ continuity: 'high' })
  })
  it('word overlap with the objective decides between high / moderate / low', () => {
    expect(cont('tune the switching cost weights for the router policy').continuity).toBe('high')
    expect(cont('write marketing emails for the holiday sale campaign').continuity).toBe('low')
  })
  it('a too-thin prompt is moderate and NOT confident (auto must not act)', () => {
    expect(cont('ok')).toEqual({
      continuity: 'moderate',
      confident: false,
      reasons: [expect.stringMatching(/too little/)]
    })
  })
})

// ---------------------------------------------------------------------------
describe('capture adequacy', () => {
  it('nothing substantive yet is good (nothing to lose)', () => {
    expect(assessCapture({ ledger: emptyLedger() }).capture).toBe('good')
  })
  it('edits not yet captured, or no capture at all, is poor', () => {
    expect(
      assessCapture({ ledger: ledger({ editTurns: 1, editsSinceCapture: 2 }), objective: 'x' })
    ).toMatchObject({ capture: 'poor' })
    expect(assessCapture({ ledger: ledger({ editTurns: 1 }), objective: 'x' }).capture).toBe('poor')
  })
  it('a handoff after the last substantive work is excellent — unless a check is failing', () => {
    const l = ledger({
      editTurns: 5,
      lastSubstantiveAt: NOW - 5 * MIN,
      lastCaptureAt: NOW - 5 * MIN,
      lastHandoffAt: NOW
    })
    expect(assessCapture({ ledger: l, objective: 'x' }).capture).toBe('excellent')
    expect(
      assessCapture({
        ledger: l,
        objective: 'x',
        testStatus: { command: 't', kind: 'test', outcome: 'fail', at: NOW }
      }).capture
    ).toBe('partial')
    expect(assessCapture({ ledger: { ...l, editsSinceHandoff: 1 }, objective: 'x' }).capture).not.toBe(
      'excellent'
    )
  })
  it('a recap existing is not enough: many substantive turns or unrecorded decisions are partial', () => {
    const captured = ledger({
      editTurns: 2,
      lastSubstantiveAt: NOW,
      lastCaptureAt: NOW,
      substantiveTurnsSinceHandoff: 2
    })
    expect(assessCapture({ ledger: captured, objective: 'x' }).capture).toBe('good')
    expect(
      assessCapture({ ledger: { ...captured, substantiveTurnsSinceHandoff: 9 }, objective: 'x' }).capture
    ).toBe('partial')
    expect(assessCapture({ ledger: { ...captured, decisionsSinceHandoff: 2 }, objective: 'x' }).capture).toBe(
      'partial'
    )
    expect(assessCapture({ ledger: captured }).capture).toBe('partial') // no objective
  })
})

// ---------------------------------------------------------------------------
describe('risk score', () => {
  it('is the normalized product of the four factor weights, with pinned thresholds', () => {
    const a = assessSwitching({
      record: valuableRecord(),
      prompt: 'fix the remaining router test',
      projects: PROJECTS,
      now: NOW
    })
    const W = SWITCHING_WEIGHTS
    const expected =
      Math.round(
        W.size[a.size] * W.value[a.value] * W.continuity[a.continuity] * W.captureGap[a.capture] * 100
      ) / 100
    expect(a.riskScore).toBe(expected)
    expect(SWITCHING_LIMITS.riskHigh).toBe(0.3)
    expect(SWITCHING_LIMITS.riskModerate).toBe(0.1)
  })
  it('describeSwitching produces the SessionBar rows', () => {
    const a = assessSwitching({
      record: valuableRecord(),
      prompt: 'fix the remaining router test',
      projects: PROJECTS,
      now: NOW
    })
    const rows = describeSwitching(a, 'standard')
    expect(rows.map((r) => r.label)).toEqual([
      'Task complexity',
      'Context utilization',
      'Context value',
      'Task continuity',
      'Capture adequacy',
      'Switching risk'
    ])
    expect(rows[1].value).toBe('95% · very-high')
    const unknown = describeSwitching({
      ...a,
      sizeSource: 'unknown',
      size: 'unknown',
      sizePct: undefined,
      sizeTokens: undefined
    })
    expect(unknown[0].value).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
describe('acceptance scenarios (spec v1.1 §Acceptance)', () => {
  it('A — valuable 95% context + simple continuation: hold the premium model, high switching risk', () => {
    const r = route(valuableRecord(), 'fix the remaining router test')
    expect(r.taskTier).toBe('standard')
    expect(r.switching).toMatchObject({
      size: 'very-high',
      value: 'critical',
      continuity: 'high',
      risk: 'high'
    })
    expect(r.heldForContext).toBe(true)
    expect(r.direction).toBe('hold')
    expect(r.changes).toBe(false)
    expect(r.target).toEqual({ model: 'fable', effort: 'xhigh' })
    expect(r.deferredTarget).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(r.autoAllowed).toBe(false)
    expect(r.offerHandoff).toBe(true)
    expect(r.reason).toMatch(/finish on fable and reassess at the next task boundary/)
  })

  it('B — low-value 95% context + simple task: downgrade may be recommended', () => {
    const r = route(
      valuableRecord({
        objective: 'investigate why the production build is slow',
        recaps: ['Searched the bundler config and plugins; nothing conclusive yet.'],
        filesEdited: { 'c:\\hub\\readme.md': NOW - 30 * MIN },
        ledger: ledger({
          turns: 26,
          readOnlyTurns: 25,
          editTurns: 1,
          searchCalls: 120,
          lastCaptureAt: NOW,
          substantiveTurnsSinceHandoff: 1,
          lastSubstantiveAt: NOW - 30 * MIN
        })
      }),
      'fix the typo in the pricing page heading'
    )
    expect(r.switching?.value).toBe('low')
    expect(r.switching?.risk).toBe('low')
    expect(r.heldForContext).toBeUndefined()
    expect(r.direction).toBe('deescalate')
    expect(r.changes).toBe(true)
    expect(r.target.model).toBe('haiku')
    expect(r.autoAllowed).toBe(true)
    expect(r.reason).toMatch(/low switching risk/)
  })

  it('C — valuable 95% context + unrelated project: continuity very low, downgrade allowed', () => {
    const r = route(valuableRecord(), 'open Gnarly Nutmeg and fix the button label from PLAY to START')
    expect(r.switching).toMatchObject({ continuity: 'very-low', boundary: 'strong', risk: 'low' })
    expect(r.heldForContext).toBeUndefined()
    expect(r.changes).toBe(true)
    expect(r.direction).toBe('deescalate')
  })

  it('D — valuable context + excellent handoff: capture lowers switching risk and the switch is allowed', () => {
    const before = route(valuableRecord(), 'fix the remaining router test')
    expect(before.switching?.risk).toBe('high')
    const handedOff = valuableRecord({
      ledger: { ...(valuableRecord().ledger as ContinuityLedger), lastHandoffAt: NOW, editsSinceHandoff: 0 }
    })
    const after = route(handedOff, 'fix the remaining router test')
    expect(after.switching?.capture).toBe('excellent')
    expect(after.switching?.risk).toBe('low')
    expect(after.heldForContext).toBeUndefined()
    expect(after.changes).toBe(true)
  })

  it('E — valuable context + substantive uncaptured changes: downgrade held / handoff required', () => {
    const uncaptured = valuableRecord({
      ledger: { ...(valuableRecord().ledger as ContinuityLedger), editsSinceCapture: 3 }
    })
    const r = route(uncaptured, 'fix the remaining router test')
    expect(r.switching?.capture).toBe('poor')
    expect(r.heldForContext).toBe(true)
    expect(r.offerHandoff).toBe(true)
    // even with a small context (moderate risk) a poorly-captured valuable session is never auto-downgraded
    const small = route({ ...uncaptured, contextUsage: exact(10) }, 'fix the remaining router test')
    expect(small.switching?.risk).not.toBe('high')
    expect(small.autoAllowed).toBe(false)
    expect(small.offerHandoff).toBe(true)
  })

  it('F — repeated failure / high-risk architecture: switching cost never blocks escalation', () => {
    const sonnet = { model: 'claude-sonnet-5', effort: 'medium' }
    const failing = { ...emptySignals(), consecutiveFailures: 4, failures: 4 }
    const r = route(
      valuableRecord(),
      'the router tests keep failing, redesign the policy architecture',
      sonnet,
      failing
    )
    expect(r.switching?.risk).toBe('high')
    expect(r.direction).toBe('escalate')
    expect(r.changes).toBe(true)
    expect(r.heldForContext).toBeUndefined()
    expect(r.autoAllowed).toBe(true)
    expect(r.target.model).toBe('fable')
  })

  it('G — missing context percentage: Unknown, never faked, and auto is not allowed', () => {
    const r = route(
      valuableRecord({
        contextUsage: undefined,
        ledger: ledger({
          editTurns: 1,
          lastCaptureAt: NOW,
          lastSubstantiveAt: NOW,
          substantiveTurnsSinceHandoff: 1
        })
      }),
      'fix the typo in the router comment'
    )
    expect(r.switching?.size).toBe('unknown')
    expect(r.switching?.sizeSource).toBe('unknown')
    expect(r.switching?.sizePct).toBeUndefined()
    expect(r.switching?.confident).toBe(false)
    expect(r.switching?.reasons[0]).toMatch(/context size unknown/)
    expect(r.autoAllowed).toBe(false)
  })

  it('H — complex task completed, then a clearly unrelated trivial task: boundary detected, router reassesses', () => {
    const done = valuableRecord({
      recaps: ['All tests pass — the switching-cost router work is complete.'],
      testStatus: { command: 'npm test', kind: 'test', outcome: 'pass', at: NOW }
    })
    const r = route(done, 'fix the typo in the footer copyright line on the marketing website')
    expect(r.switching?.boundary).toBe('strong')
    expect(['low', 'very-low']).toContain(r.switching?.continuity)
    expect(r.heldForContext).toBeUndefined()
    expect(r.changes).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('policy guards', () => {
  it('passes escalations and holds through untouched (except attaching the assessment)', () => {
    const a = assessSwitching({ record: valuableRecord(), prompt: 'x', projects: PROJECTS, now: NOW })
    const hold = recommend({ prompt: 'thanks', signals: emptySignals(), current: FABLE, now: NOW })
    const out = applySwitchingPolicy(hold, a, FABLE)
    expect(out.direction).toBe(hold.direction)
    expect(out.changes).toBe(hold.changes)
    expect(out.switching).toBe(a)
    expect(out.heldForContext).toBeUndefined()
  })
  it('low risk never auto-downgrades over an unresolved failing check', () => {
    const rec = recommend({
      prompt: 'fix the typo in the pricing page heading',
      signals: emptySignals(),
      current: FABLE,
      now: NOW
    })
    const a = assessSwitching({
      record: valuableRecord({ ledger: emptyLedger(), filesEdited: {} }),
      prompt: 'fix the typo in the pricing page heading',
      projects: PROJECTS,
      now: NOW
    })
    expect(a.risk).toBe('low')
    expect(applySwitchingPolicy(rec, a, FABLE).autoAllowed).toBe(true)
    expect(applySwitchingPolicy(rec, a, FABLE, { unresolvedFailure: true }).autoAllowed).toBe(false)
  })
  it('moderate risk keeps the suggestion but forbids auto and offers a handoff', () => {
    // 10% of the window: valuable, continuing, partly captured — but little context to lose
    const r = route(valuableRecord({ contextUsage: exact(10) }), 'fix the remaining router test')
    expect(r.switching?.risk).toBe('moderate')
    expect(r.changes).toBe(true)
    expect(r.autoAllowed).toBe(false)
    expect(r.offerHandoff).toBe(true)
    expect(r.reason).toMatch(/moderate switching risk — capture a handoff first/)
  })
  it('a held recommendation with an unknown current model still never asks for a change', () => {
    const rec = {
      ...recommend({ prompt: 'fix the typo', signals: emptySignals(), current: FABLE, now: NOW })
    }
    const a = assessSwitching({
      record: valuableRecord(),
      prompt: 'fix the remaining router test',
      projects: PROJECTS,
      now: NOW
    })
    const out = applySwitchingPolicy(rec, a, {})
    expect(out.changes).toBe(false)
    expect(out.heldForContext).toBe(true)
    expect(out.reason).toMatch(/the current model/)
  })
})

// ---------------------------------------------------------------------------
describe('board reducer accumulates the ledger incrementally', () => {
  const cwd = 'C:\\hub'
  const ctx = (now: number) => ({ projects: PROJECTS, now })
  const play = (
    events: [Record<string, unknown>, number][]
  ): { board: Board; record: SessionRecord; results: ReturnType<typeof applyHookEvent>[] } => {
    let board: Board = {}
    const results: ReturnType<typeof applyHookEvent>[] = []
    for (const [e, t] of events) {
      const r = applyHookEvent(board, { session_id: 's1', cwd, ...e }, ctx(t))
      board = r.board
      results.push(r)
    }
    return { board, record: board['s1'], results }
  }
  const tool = (tool_name: string, tool_input: Record<string, unknown>, tool_response?: unknown) => ({
    hook_event_name: 'PostToolUse',
    tool_name,
    tool_input,
    tool_response
  })

  it('counts edit turns, read-only turns, searches, passes after edits, findings and capture', () => {
    const { record } = play([
      [{ hook_event_name: 'UserPromptSubmit', prompt: 'build the switching cost module' }, NOW],
      [tool('Grep', { pattern: 'recommend' }), NOW + 1],
      [tool('Read', { file_path: 'C:\\hub\\src\\shared\\router.ts' }), NOW + 2],
      [tool('Edit', { file_path: 'C:\\hub\\src\\shared\\router.ts' }), NOW + 3],
      [tool('Bash', { command: 'npm test' }, { stdout: 'Tests: 12 passed' }), NOW + 4],
      [
        {
          hook_event_name: 'Stop',
          last_assistant_message: 'Decided to keep tiers separate; the root cause was the default tier.'
        },
        NOW + 5
      ],
      [{ hook_event_name: 'UserPromptSubmit', prompt: 'look into the transcript format' }, NOW + 6],
      [tool('Grep', { pattern: 'usage' }), NOW + 7],
      [
        {
          hook_event_name: 'Stop',
          last_assistant_message: 'Usage metadata is verified to be present on assistant records.'
        },
        NOW + 8
      ],
      [{ hook_event_name: 'PreCompact', trigger: 'auto' }, NOW + 9]
    ])
    const l = record.ledger as ContinuityLedger
    expect(l.turns).toBe(2)
    expect(l.editTurns).toBe(1)
    expect(l.readOnlyTurns).toBe(1)
    expect(l.searchCalls).toBe(3)
    expect(l.passesAfterEdit).toBe(1)
    expect(l.editsSincePass).toBe(0)
    expect(l.decisionHits).toBe(1)
    expect(l.rootCauseHits).toBe(1)
    expect(l.constraintHits).toBe(1)
    expect(l.decisionsSinceHandoff).toBe(3)
    expect(l.substantiveTurnsSinceHandoff).toBe(2)
    expect(l.editsSinceCapture).toBe(0) // captured by the first Stop recap
    expect(l.lastCaptureAt).toBe(NOW + 8)
    expect(l.lastEditAt).toBe(NOW + 3)
    expect(l.compactions).toBe(1)
  })

  it('edits after the last capture are counted until the next recap', () => {
    const { record } = play([
      [{ hook_event_name: 'UserPromptSubmit', prompt: 'wire it up' }, NOW],
      [tool('Edit', { file_path: 'C:\\hub\\a.ts' }), NOW + 1],
      [tool('Write', { file_path: 'C:\\hub\\b.ts' }), NOW + 2]
    ])
    expect(record.ledger?.editsSinceCapture).toBe(2)
    expect(record.ledger?.editsSinceHandoff).toBe(2)
  })

  it('counts approvals and subagents', () => {
    const { record } = play([
      [{ hook_event_name: 'UserPromptSubmit', prompt: 'build the router module' }, NOW],
      [{ hook_event_name: 'UserPromptSubmit', prompt: 'yes, go ahead' }, NOW + 1],
      [{ hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'Explore' }, NOW + 2],
      [{ hook_event_name: 'SubagentStart', agent_id: 'b', agent_type: 'Explore' }, NOW + 3],
      [{ hook_event_name: 'SubagentStop', agent_id: 'a' }, NOW + 4],
      [{ hook_event_name: 'SubagentStart', agent_id: 'c', agent_type: 'Plan' }, NOW + 5]
    ])
    expect(record.ledger).toMatchObject({ approvalHits: 1, agentsActive: 2, agentsPeak: 2, agentsTotal: 3 })
    const ended = applyHookEvent(
      { s1: record },
      { session_id: 's1', cwd, hook_event_name: 'SessionEnd' },
      ctx(NOW + 6)
    )
    expect(ended.record?.ledger?.agentsActive).toBe(0)
  })

  it('a strong boundary closes the old objective and reports it', () => {
    const { record, results } = play([
      [{ hook_event_name: 'UserPromptSubmit', prompt: 'build context-aware routing' }, NOW],
      [
        { hook_event_name: 'UserPromptSubmit', prompt: 'open Gnarly Nutmeg and change PLAY to START' },
        NOW + 1
      ]
    ])
    expect(results[1].boundary).toEqual({
      reason: expect.stringMatching(/Gnarly Nutmeg/),
      previousObjective: 'build context-aware routing'
    })
    expect(record.objective).toBe('open Gnarly Nutmeg and change PLAY to START')
    expect(record.ledger?.boundary).toMatchObject({ strength: 'strong', at: NOW + 1 })
    // the first prompt of a session is never a boundary
    expect(results[0].boundary).toBeUndefined()
  })

  it('an old persisted record without a ledger is upgraded transparently', () => {
    const legacy = {
      s1: {
        ...play([[{ hook_event_name: 'SessionStart', source: 'startup' }, NOW]]).record,
        ledger: undefined
      }
    }
    const r = applyHookEvent(
      legacy as Board,
      { session_id: 's1', cwd, hook_event_name: 'Stop' },
      ctx(NOW + 1)
    )
    expect(r.record?.ledger).toMatchObject({ turns: 1 })
  })
})

describe('capture helpers used by the handoff actions', () => {
  it('ledgerAfterHandoff resets every since-handoff counter and stamps the capture', async () => {
    const { ledgerAfterHandoff, ledgerAfterDecisionsRecorded } = await import('./switchingCost')
    const before = ledger({
      editTurns: 4,
      editsSinceCapture: 2,
      editsSinceHandoff: 5,
      substantiveTurnsSinceHandoff: 6,
      decisionsSinceHandoff: 3,
      lastSubstantiveAt: NOW - MIN
    })
    const after = ledgerAfterHandoff(before, NOW)
    expect(after).toMatchObject({
      editTurns: 4,
      lastHandoffAt: NOW,
      lastCaptureAt: NOW,
      editsSinceCapture: 0,
      editsSinceHandoff: 0,
      substantiveTurnsSinceHandoff: 0,
      decisionsSinceHandoff: 0
    })
    expect(assessCapture({ ledger: after, objective: 'x' }).capture).toBe('excellent')
    expect(ledgerAfterDecisionsRecorded(before).decisionsSinceHandoff).toBe(0)
    expect(ledgerAfterDecisionsRecorded(before).editsSinceHandoff).toBe(5)
    expect(ledgerAfterHandoff(undefined, NOW).lastHandoffAt).toBe(NOW)
  })
})

describe('review fixes: end-to-end through the reducer', () => {
  const cwd = 'C:\\hub'
  const run = (events: Record<string, unknown>[]): SessionRecord => {
    let board: Board = {}
    events.forEach((e, i) => {
      board = applyHookEvent(
        board,
        { session_id: 's1', cwd, ...e },
        { projects: PROJECTS, now: NOW + i * 1000 }
      ).board
    })
    return board['s1']
  }
  const editTurn = (n: number, recap: string, test?: string): Record<string, unknown>[] => [
    { hook_event_name: 'UserPromptSubmit', prompt: `implement the switching cost scoring step ${n}` },
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: `C:\\hub\\src\\shared\\switchingcost${n}.ts` }
    },
    ...(test
      ? [
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            tool_response: { stdout: test }
          }
        ]
      : []),
    { hook_event_name: 'Stop', last_assistant_message: recap }
  ]

  it('H end-to-end: a completion boundary still counts after the reducer replaced the objective', () => {
    const events = [
      ...editTurn(1, 'Wired the scoring module.', 'Tests: 40 passed'),
      ...editTurn(2, 'All tests pass — the switching cost work is complete.', 'Tests: 47 passed'),
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix the typo in the footer copyright line on the marketing website'
      }
    ]
    const record = { ...run(events), contextUsage: exact(95) }
    expect(record.objective).toBe('fix the typo in the footer copyright line on the marketing website')
    expect(record.ledger?.boundary?.strength).toBe('strong')
    const a = assessSwitching({ record, prompt: record.lastPrompt, projects: PROJECTS, now: NOW + 60_000 })
    expect(a.boundary).toBe('strong')
    expect(['low', 'very-low']).toContain(a.continuity)
  })

  it('a later prompt without a boundary does not inherit an old recorded boundary', () => {
    const events = [
      ...editTurn(1, 'All tests pass — the switching cost work is complete.', 'Tests: 40 passed'),
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix the typo in the footer copyright line on the marketing website'
      },
      { hook_event_name: 'Stop', last_assistant_message: 'Fixed the footer typo.' },
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'also fix the footer copyright typo on the pricing page'
      }
    ]
    const record = run(events)
    const a = assessSwitching({ record, prompt: record.lastPrompt, projects: PROJECTS, now: NOW + 60_000 })
    expect(a.boundary).toBe('none')
  })

  it('recap-only capture of unverified edits is partial, not good (spec: a recap is not adequate capture)', () => {
    const events = [
      ...editTurn(1, 'Changed the scoring module.'),
      ...editTurn(2, 'Changed more scoring files.'),
      { hook_event_name: 'UserPromptSubmit', prompt: 'keep going with the scoring module' }
    ]
    const record = run(events)
    expect(record.ledger?.editsSinceCapture).toBe(0) // recaps did describe the work…
    const a = assessSwitching({ record, prompt: record.lastPrompt, projects: PROJECTS, now: NOW + 60_000 })
    expect(a.capture).toBe('partial') // …but nothing verified or handed off
    expect(a.reasons.join(' ')).toMatch(/described only by recaps/)
    // a passing check after the edits removes that gap
    const verified = run([
      ...editTurn(1, 'Changed the scoring module.', 'Tests: 12 passed'),
      { hook_event_name: 'UserPromptSubmit', prompt: 'keep going with the scoring module' }
    ])
    expect(
      assessSwitching({
        record: verified,
        prompt: verified.lastPrompt,
        projects: PROJECTS,
        now: NOW + 60_000
      }).capture
    ).toBe('good')
  })
})
