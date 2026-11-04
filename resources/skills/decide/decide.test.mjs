import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPayload, exitCodeFor, formatReply, parseArgs } from './decide.mjs'

test('parseArgs reads the action and flags', () => {
  const r = parseArgs(['approve', '--topic', 'canon-home', '--statement', 'Central repo', '--quote', 'yes', '--alt', 'A', '--alt', 'B'])
  assert.equal(r.action, 'approve')
  assert.deepEqual(r.flags, { alt: ['A', 'B'], topic: 'canon-home', statement: 'Central repo', quote: 'yes' })
})

test('parseArgs rejects bad input', () => {
  assert.match(parseArgs([]).error, /First argument/)
  assert.match(parseArgs(['delete']).error, /First argument/)
  assert.match(parseArgs(['propose', 'topic']).error, /Unexpected/)
  assert.match(parseArgs(['propose', '--nope', 'x']).error, /Unknown flag/)
  assert.match(parseArgs(['propose', '--topic']).error, /needs a value/)
  assert.match(parseArgs(['propose', '--topic', '--statement', 'x']).error, /needs a value/)
})

test('buildPayload maps flags to the Hub body', () => {
  const body = buildPayload('propose', { alt: ['x'], topic: 't', statement: 's', files: 'a.ts, b.ts,', review: '2026-12-01' }, 'C:/p')
  assert.deepEqual(body, {
    action: 'propose',
    cwd: 'C:/p',
    topic: 't',
    statement: 's',
    alternatives: ['x'],
    affectedFiles: ['a.ts', 'b.ts'],
    reviewDate: '2026-12-01'
  })
  assert.equal(buildPayload('list', { alt: [], cwd: 'D:/x' }, 'C:/p').cwd, 'D:/x')
})

test('formatReply and exitCodeFor report honestly', () => {
  const approved = { ok: true, outcome: 'approved', message: 'D-1 approved.', decision: { evidence: { quote: 'yes' } }, file: 'K/DECISIONS.md', committed: true }
  assert.deepEqual(formatReply('approve', approved), ['APPROVED: D-1 approved.', 'Evidence: "yes"', 'File: K/DECISIONS.md (committed)'])
  assert.equal(exitCodeFor('approve', approved), 0)
  const downgraded = { ok: true, outcome: 'proposed', message: 'recorded as a PROPOSAL' }
  assert.equal(exitCodeFor('approve', downgraded), 1)
  assert.equal(exitCodeFor('propose', downgraded), 0)
  assert.equal(exitCodeFor('reject', { ok: false }), 1)
  assert.deepEqual(formatReply('reject', { ok: false, message: 'Conflict' }), ['NOT RECORDED: Conflict'])
  assert.deepEqual(formatReply('list', { ok: true, project: 'p', decisions: [{ status: 'approved', id: 'D-1', topic: 't', statement: 's' }] }), ['p: 1 decision(s)', '- APPROVED D-1 [t] s'])
  assert.deepEqual(formatReply('approve', null), ['The Hub sent an unreadable reply.'])
})
