import { describe, it, expect } from 'vitest'
import { calculateFocusScore, calculateHealth, rankByFocus } from './scoring'
import type { Project } from './types'

const NOW = new Date('2026-07-08T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000

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
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})

/** Every score is normalized by the largest stage boost (1.15) so a boosted
 *  project can't overshoot 10 — see the MAX_BOOST comment in scoring.ts. */
const N = 1.15
const norm = (raw: number): number => Math.round((raw / N) * 10) / 10

describe('calculateFocusScore', () => {
  it('scores the plain weighted average when every input is unset (all default to 5)', () => {
    // 5*.30 + 5*.25 + 5*.20 + 5*.15 + (10-5)*.10 = 5.0, normalized
    expect(calculateFocusScore(proj({}))).toBe(norm(5))
  })

  it('weights revenue highest and inverts effort', () => {
    const highRevenue = calculateFocusScore(proj({ revenueScore: 10 }))
    const lowEffort = calculateFocusScore(proj({ effortScore: 0 }))
    expect(highRevenue).toBe(norm(6.5)) // +5 * 0.30
    expect(lowEffort).toBe(norm(5.5)) // +5 * 0.10
    expect(highRevenue).toBeGreaterThan(lowEffort)
  })

  it('boosts ready-for-build by 1.10 and launch-prep by 1.15', () => {
    const base = calculateFocusScore(proj({ stage: 'building' }))
    const ready = calculateFocusScore(proj({ stage: 'ready-for-build' }))
    const launch = calculateFocusScore(proj({ stage: 'launch-prep' }))
    expect(base).toBe(norm(5))
    expect(ready).toBe(norm(5 * 1.1))
    expect(launch).toBe(norm(5 * 1.15))
    expect(launch).toBeGreaterThan(ready)
    expect(ready).toBeGreaterThan(base)
  })

  it('penalizes blocked projects by 0.8', () => {
    expect(calculateFocusScore(proj({ blockers: ['waiting on key'] }))).toBe(norm(4))
    expect(calculateFocusScore(proj({ blockers: [] }))).toBe(norm(5))
  })

  it('reaches 10.0 only for a perfect, unblocked, launch-prep project', () => {
    const perfect = {
      revenueScore: 10,
      strategicScore: 10,
      excitementScore: 10,
      readinessScore: 10,
      effortScore: 0
    }
    expect(calculateFocusScore(proj({ ...perfect, stage: 'launch-prep' }))).toBe(10)
    // and nothing ever exceeds 10
    expect(calculateFocusScore(proj({ ...perfect, stage: 'launch-prep' }))).toBeLessThanOrEqual(10)
  })

  it('does NOT flatten high scorers into a tie (regression: the old Math.min(10) clamp)', () => {
    // The weights already sum to a max of 10, so any stage boost overshot the
    // old clamp and every strong project collapsed onto exactly 10.0.
    const perfect = proj({
      id: 'perfect',
      revenueScore: 10,
      strategicScore: 10,
      excitementScore: 10,
      readinessScore: 10,
      effortScore: 0,
      stage: 'launch-prep'
    })
    const nearlyPerfect = proj({
      id: 'nearly',
      revenueScore: 9,
      strategicScore: 9,
      excitementScore: 9,
      readinessScore: 9,
      effortScore: 1,
      stage: 'launch-prep'
    })
    expect(calculateFocusScore(perfect)).toBeGreaterThan(calculateFocusScore(nearlyPerfect))
  })

  it('treats a NaN or out-of-range stored score as the 5 default instead of poisoning the math', () => {
    // A hand-edited projects.json used to make the whole score NaN, which then
    // rendered as "NaN" and sorted unpredictably.
    expect(calculateFocusScore(proj({ revenueScore: NaN }))).toBe(norm(5))
    expect(calculateFocusScore(proj({ revenueScore: 999 }))).toBe(norm(6.5)) // clamped to 10
    expect(calculateFocusScore(proj({ revenueScore: -50 }))).toBe(norm(3.5)) // clamped to 0
  })
})

describe('calculateHealth', () => {
  const healthy = proj({
    nextAction: 'ship it',
    currentFocus: 'launch',
    updatedAt: NOW - DAY
  })

  it('is green with a next action, focus, recent activity, and no blockers', () => {
    expect(calculateHealth(healthy, NOW)).toEqual({ status: 'green', reasons: ['On track'] })
  })

  it('is yellow with 1-2 issues', () => {
    const h = calculateHealth(proj({ currentFocus: 'x', updatedAt: NOW }), NOW)
    expect(h.status).toBe('yellow')
    expect(h.reasons).toEqual(['No next action set'])
  })

  it('is red with 3+ issues', () => {
    const h = calculateHealth(proj({ blockers: ['a', 'b'], updatedAt: NOW - 20 * DAY }), NOW)
    expect(h.status).toBe('red')
    expect(h.reasons).toContain('No next action set')
    expect(h.reasons).toContain('2 blocker(s)')
    expect(h.reasons).toContain('Not touched in 2+ weeks')
    expect(h.reasons).toContain('No focus or MVP defined')
  })

  it('counts a recent open as activity even when the record is stale', () => {
    const p = proj({ ...healthy, updatedAt: NOW - 30 * DAY, lastOpenedAt: NOW - DAY })
    expect(calculateHealth(p, NOW).status).toBe('green')
  })

  it('accepts mvpDefinition in place of currentFocus', () => {
    const p = proj({ nextAction: 'x', mvpDefinition: 'the MVP', updatedAt: NOW })
    expect(calculateHealth(p, NOW).status).toBe('green')
  })

  it('still flags staleness when updatedAt is missing (regression: Math.max(undefined) === NaN)', () => {
    // A legacy/hand-edited row with no updatedAt made lastActivity NaN, and
    // every comparison against NaN is false — so it never read as stale.
    const p = proj({ ...healthy, updatedAt: undefined as unknown as number })
    expect(calculateHealth(p, NOW).reasons).toContain('Not touched in 2+ weeks')
  })
})

describe('rankByFocus', () => {
  it('ranks active projects by score, descending', () => {
    const low = proj({ id: 'low', name: 'Low', revenueScore: 1 })
    const high = proj({ id: 'high', name: 'High', revenueScore: 10, stage: 'launch-prep' })
    const mid = proj({ id: 'mid', name: 'Mid' })
    expect(rankByFocus([low, mid, high]).map((p) => p.id)).toEqual(['high', 'mid', 'low'])
  })

  it('excludes archived and idea projects', () => {
    const archived = proj({ id: 'a', status: 'archived', revenueScore: 10 })
    const idea = proj({ id: 'i', status: 'idea', revenueScore: 10 })
    const active = proj({ id: 'x' })
    expect(rankByFocus([archived, idea, active]).map((p) => p.id)).toEqual(['x'])
  })

  it('breaks score ties by name', () => {
    const b = proj({ id: 'b', name: 'Beta' })
    const a = proj({ id: 'a', name: 'Alpha' })
    expect(rankByFocus([b, a]).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('ranks a better project above a worse one even at the top of the scale', () => {
    // Regression: both saturated at exactly 10.0 under the old clamp, so the
    // name tiebreak decided the head of the rail — "Alpha" beat a perfect "Zeta".
    const zeta = proj({
      id: 'zeta',
      name: 'Zeta',
      revenueScore: 10,
      strategicScore: 10,
      excitementScore: 10,
      readinessScore: 10,
      effortScore: 0,
      stage: 'launch-prep'
    })
    const alpha = proj({
      id: 'alpha',
      name: 'Alpha',
      revenueScore: 9,
      strategicScore: 9,
      excitementScore: 9,
      readinessScore: 9,
      effortScore: 1,
      stage: 'launch-prep'
    })
    expect(rankByFocus([alpha, zeta]).map((p) => p.id)).toEqual(['zeta', 'alpha'])
  })
})
