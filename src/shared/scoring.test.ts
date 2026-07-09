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

describe('calculateFocusScore', () => {
  it('scores 5.0 when every input is unset (all default to 5)', () => {
    // 5*.30 + 5*.25 + 5*.20 + 5*.15 + (10-5)*.10 = 5.0
    expect(calculateFocusScore(proj({}))).toBe(5)
  })

  it('weights revenue highest and inverts effort', () => {
    const highRevenue = calculateFocusScore(proj({ revenueScore: 10 }))
    const lowEffort = calculateFocusScore(proj({ effortScore: 0 }))
    expect(highRevenue).toBe(6.5) // +5 * 0.30
    expect(lowEffort).toBe(5.5) // +5 * 0.10
    expect(highRevenue).toBeGreaterThan(lowEffort)
  })

  it('boosts ready-for-build by 1.10 and launch-prep by 1.15', () => {
    const base = calculateFocusScore(proj({ stage: 'building' }))
    const ready = calculateFocusScore(proj({ stage: 'ready-for-build' }))
    const launch = calculateFocusScore(proj({ stage: 'launch-prep' }))
    expect(base).toBe(5)
    expect(ready).toBe(5.5)
    expect(launch).toBeGreaterThan(ready) // 5 * 1.15, modulo float rounding
  })

  it('penalizes blocked projects by 0.8', () => {
    expect(calculateFocusScore(proj({ blockers: ['waiting on key'] }))).toBe(4)
    expect(calculateFocusScore(proj({ blockers: [] }))).toBe(5)
  })

  it('caps at 10', () => {
    const maxed = proj({
      revenueScore: 10,
      strategicScore: 10,
      excitementScore: 10,
      readinessScore: 10,
      effortScore: 0,
      stage: 'launch-prep'
    })
    expect(calculateFocusScore(maxed)).toBe(10)
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
})
