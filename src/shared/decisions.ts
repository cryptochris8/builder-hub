// Founder decisions: canon with a status, proof and history. This module is PURE
// (no fs, no electron).
//
// The problem it solves: decisions used to be plain strings in the Context tab.
// They had no status and no proof, and in practice none were ever recorded (0 of
// 35 projects had one on 2026-11-04). Now a decision is a record:
//   proposed  -> anyone (Claude included) may record it; it binds nothing.
//   approved  -> needs EVIDENCE: either the founder's own words, found in a prompt
//                or AskUserQuestion answer the Hub received through hooks, or a
//                click in the Hub UI. Claude cannot approve on its own say-so: an
//                approval whose quote is not found is stored as `proposed`.
//   rejected  -> a founder-rejected approach; it needs evidence too.
//   superseded-> replaced by a later approved decision that names it in
//                `supersedes`. An approved decision on a topic that already has
//                an active approved one is REFUSED unless it supersedes that one,
//                so canon is never silently rewritten.
//
// The records live in a central git repo (the "canon repo", open-claw/knowledge),
// one folder per project. The main process does the IO (main/canonStore.ts).

// ---------- types ----------

export const DECISION_STATUSES = ['proposed', 'approved', 'rejected', 'superseded'] as const
export type DecisionStatus = (typeof DECISION_STATUSES)[number]

export type EvidenceKind = 'prompt' | 'answer' | 'hub-ui'

export interface DecisionEvidence {
  kind: EvidenceKind
  /** the founder's words that carry the approval (redacted) */
  quote: string
  /** a little surrounding text from the same prompt/answer (redacted, bounded) */
  excerpt?: string
  /** when the founder said it */
  at: number
  sessionId?: string
}

export type DecisionActor = 'chris' | 'claude'

export interface DecisionHistoryEntry {
  at: number
  action: DecisionStatus | 'edited'
  by: DecisionActor
  note?: string
}

export interface Decision {
  id: string
  projectId: string
  /** short kebab-case subject; one active approved decision per topic */
  topic: string
  statement: string
  status: DecisionStatus
  proposer: DecisionActor
  rationale?: string
  alternatives: string[]
  evidence?: DecisionEvidence
  affectedFiles: string[]
  supersedes?: string
  supersededBy?: string
  /** optional YYYY-MM-DD to revisit */
  reviewDate?: string
  createdAt: number
  updatedAt: number
  history: DecisionHistoryEntry[]
}

/** Something the founder typed (a prompt) or picked (an AskUserQuestion answer). */
export interface FounderInput {
  at: number
  kind: 'prompt' | 'answer'
  /** redacted, bounded */
  text: string
  sessionId: string
}

export type DecisionAction = 'propose' | 'approve' | 'reject'

/** A request to change canon. It comes from the CLI (Claude) or the Hub UI (Chris). */
export interface DecisionRequest {
  action: DecisionAction
  /** act on an existing decision (approve/reject a proposal) */
  id?: string
  topic?: string
  statement?: string
  rationale?: string
  alternatives?: string[]
  /** the founder's words that approve/reject this (CLI) */
  quote?: string
  supersedes?: string
  affectedFiles?: string[]
  reviewDate?: string
}

export type DecisionOutcome = 'proposed' | 'approved' | 'rejected' | 'refused'

export interface DecisionResult {
  ok: boolean
  outcome: DecisionOutcome
  message: string
  decisions: Decision[]
  decision?: Decision
}

// ---------- limits ----------

export const DECISION_LIMITS = {
  topicChars: 60,
  statementChars: 500,
  rationaleChars: 800,
  alternatives: 8,
  alternativeChars: 200,
  affectedFiles: 20,
  fileChars: 260,
  quoteChars: 300,
  excerptChars: 400,
  founderInputs: 20,
  founderInputChars: 2000,
  /** how far back evidence is searched */
  evidenceWindowMs: 48 * 60 * 60 * 1000,
  historyEntries: 30,
  injectionChars: 3000
} as const

// ---------- small helpers ----------

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const cap = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function isoDay(ms: number): string {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

function cleanList(v: unknown, limit: number, chars: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    const s = cap(oneLine(str(item)), chars)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= limit) break
  }
  return out
}

// ---------- secret redaction ----------

const REDACTED = '[REDACTED]'

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, `$1 ${REDACTED}`],
  // NAME_KEY=value / "api_token": "value" — keep the name, drop the value
  [
    /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?[A-Za-z0-9_]*)(["']?\s*[=:]\s*["']?)([^\s"',;]{6,})/gi,
    `$1$2${REDACTED}`
  ],
  // user:password@host in URLs
  [/(\/\/[^\s:/@]+:)[^\s@/]{3,}@/g, `$1${REDACTED}@`],
  // long mixed-case+digit blobs (API keys of unknown shape). Hex shas / UUIDs are
  // single-case, so commit ids and session ids survive.
  [/\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g, REDACTED]
]

/** Mask credentials before anything is stored or shown. Deterministic; never throws. */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || !text) return ''
  let out = text
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement)
  return out
}

// ---------- founder input (evidence source) ----------

/** Prompts that arrive through UserPromptSubmit but were written by a machine:
 *  other Claude sessions (cross-session messages), task notifications, teammates. */
const MACHINE_PROMPT =
  /^\s*<(cross-session-message|task-notification|teammate-message|system-reminder|local-command-stdout|command-name)\b/i

export function isFounderPrompt(prompt: string): boolean {
  const p = str(prompt)
  if (!p) return false
  if (p.startsWith('/')) return false
  return !MACHINE_PROMPT.test(p)
}

/** Answers from an AskUserQuestion tool call (PostToolUse), as one line of
 *  "question → answer" pairs. The answers map may sit on tool_input or tool_response;
 *  both are accepted. Undefined when nothing usable is found. */
export function answersFromAskUserQuestion(toolInput: unknown, toolResponse: unknown): string | undefined {
  const pick = (o: unknown): Record<string, unknown> | undefined => {
    if (!isObj(o)) return undefined
    if (isObj(o.answers)) return o.answers
    return undefined
  }
  const answers = pick(toolResponse) ?? pick(toolInput)
  if (!answers) return undefined
  const parts: string[] = []
  for (const [q, a] of Object.entries(answers)) {
    const answer = Array.isArray(a) ? a.map(str).filter(Boolean).join(', ') : str(a)
    if (answer) parts.push(`${oneLine(q)} → ${oneLine(answer)}`)
  }
  return parts.length ? parts.join(' | ') : undefined
}

/** Keep the start AND the end of a long input: the founder's own words usually sit
 *  before or after a pasted document, rarely in its middle. */
function headTail(s: string, max: number): string {
  if (s.length <= max) return s
  const sep = ' … '
  const head = Math.floor((max - sep.length) / 2)
  const tail = max - sep.length - head
  return s.slice(0, head) + sep + s.slice(s.length - tail)
}

/** The founder input carried by one hook payload, if any: a UserPromptSubmit prompt
 *  he typed, or the answers he picked in an AskUserQuestion (PostToolUse). */
export function founderInputFromHook(
  input: {
    hook_event_name?: unknown
    prompt?: unknown
    tool_name?: unknown
    tool_input?: unknown
    tool_response?: unknown
  },
  sessionId: string,
  now: number
): FounderInput | undefined {
  if (!isObj(input) || !str(sessionId)) return undefined
  if (input.hook_event_name === 'UserPromptSubmit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    return isFounderPrompt(prompt) ? { at: now, kind: 'prompt', text: prompt, sessionId } : undefined
  }
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'AskUserQuestion') {
    const answers = answersFromAskUserQuestion(input.tool_input, input.tool_response)
    return answers ? { at: now, kind: 'answer', text: answers, sessionId } : undefined
  }
  return undefined
}

/** Append one founder input (redacted, bounded), keeping the newest `limit`. */
export function pushFounderInput(
  list: FounderInput[] | undefined,
  input: FounderInput,
  limit: number = DECISION_LIMITS.founderInputs
): FounderInput[] {
  const text = headTail(redactSecrets(str(input.text)), DECISION_LIMITS.founderInputChars)
  const prior = Array.isArray(list) ? list.filter(isFounderInput) : []
  if (!text) return prior
  return [...prior, { at: input.at, kind: input.kind, text, sessionId: input.sessionId }].slice(-limit)
}

export function isFounderInput(v: unknown): v is FounderInput {
  return (
    isObj(v) &&
    typeof v.at === 'number' &&
    (v.kind === 'prompt' || v.kind === 'answer') &&
    typeof v.text === 'string' &&
    typeof v.sessionId === 'string'
  )
}

/** Lowercase, straight quotes, letters/digits/spaces only, single spaces. */
export function normalizeForMatch(s: string): string {
  return str(s)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Find the founder's words for an approval: the NEWEST founder input within the
 * window whose normalized text contains the normalized quote. Returns evidence with
 * a short excerpt around the match, or undefined (then no approval happens).
 */
export function findEvidence(
  quote: string,
  inputs: FounderInput[],
  now: number,
  windowMs: number = DECISION_LIMITS.evidenceWindowMs
): DecisionEvidence | undefined {
  const needle = normalizeForMatch(redactSecrets(quote))
  if (needle.length < 2) return undefined
  const candidates = (Array.isArray(inputs) ? inputs : [])
    .filter(isFounderInput)
    .filter((i) => now - i.at <= windowMs && i.at <= now + 60_000)
    .sort((a, b) => b.at - a.at)
  for (const input of candidates) {
    const hay = normalizeForMatch(input.text)
    // whole-word match: a quote of "no" must not match inside "know"
    const at = ` ${hay} `.indexOf(` ${needle} `)
    if (at === -1) continue
    return {
      kind: input.kind,
      quote: cap(oneLine(redactSecrets(str(quote))), DECISION_LIMITS.quoteChars),
      excerpt: excerptAround(input.text, quote),
      at: input.at,
      sessionId: input.sessionId
    }
  }
  return undefined
}

/** ~400 chars of the original text around the quote (best effort; falls back to the start). */
function excerptAround(text: string, quote: string): string {
  const flat = oneLine(text)
  const max = DECISION_LIMITS.excerptChars
  if (flat.length <= max) return flat
  const i = flat.toLowerCase().indexOf(oneLine(quote).toLowerCase())
  if (i === -1) return cap(flat, max)
  const start = Math.max(0, i - Math.floor((max - quote.length) / 2))
  const slice = flat.slice(start, start + max)
  return `${start > 0 ? '…' : ''}${slice}${start + max < flat.length ? '…' : ''}`
}

// ---------- ids, topics ----------

export function normalizeTopic(s: string): string {
  return str(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, DECISION_LIMITS.topicChars)
    .replace(/-+$/g, '')
}

/** D-YYYYMMDD-xxxx; `rand` is 4 lowercase hex chars (injected for tests). */
export function newDecisionId(now: number, rand: string): string {
  const day = isoDay(now).replace(/-/g, '') || '00000000'
  const tail = (
    str(rand)
      .toLowerCase()
      .replace(/[^0-9a-f]/g, '') + '0000'
  ).slice(0, 4)
  return `D-${day}-${tail}`
}

const DECISION_ID_RE = /^D-\d{8}-[0-9a-f]{4}$/

// ---------- normalize / parse / serialize ----------

export function normalizeDecision(raw: unknown, projectId: string): Decision | undefined {
  if (!isObj(raw)) return undefined
  const id = str(raw.id)
  const topic = normalizeTopic(str(raw.topic))
  const statement = cap(oneLine(str(raw.statement)), DECISION_LIMITS.statementChars)
  const status = DECISION_STATUSES.includes(raw.status as DecisionStatus)
    ? (raw.status as DecisionStatus)
    : undefined
  const createdAt = num(raw.createdAt)
  if (!DECISION_ID_RE.test(id) || !topic || !statement || !status || createdAt === undefined) return undefined
  const proposer: DecisionActor = raw.proposer === 'chris' ? 'chris' : 'claude'
  let evidence: DecisionEvidence | undefined
  if (isObj(raw.evidence)) {
    const e = raw.evidence
    const kind = e.kind === 'prompt' || e.kind === 'answer' || e.kind === 'hub-ui' ? e.kind : undefined
    const at = num(e.at)
    const quote = cap(oneLine(redactSecrets(str(e.quote))), DECISION_LIMITS.quoteChars)
    if (kind && at !== undefined && quote) {
      evidence = { kind, quote, at }
      const excerpt = cap(oneLine(redactSecrets(str(e.excerpt))), DECISION_LIMITS.excerptChars + 2)
      if (excerpt) evidence.excerpt = excerpt
      const sid = str(e.sessionId)
      if (sid) evidence.sessionId = sid
    }
  }
  // Integrity: an approved/rejected record without evidence is demoted, never trusted.
  const trusted = status === 'proposed' || status === 'superseded' || !!evidence
  const history: DecisionHistoryEntry[] = Array.isArray(raw.history)
    ? raw.history
        .filter(isObj)
        .map((h) => ({
          at: num(h.at) ?? createdAt,
          action: (DECISION_STATUSES.includes(h.action as DecisionStatus) || h.action === 'edited'
            ? h.action
            : 'edited') as DecisionHistoryEntry['action'],
          by: (h.by === 'chris' ? 'chris' : 'claude') as DecisionActor,
          ...(str(h.note) ? { note: cap(oneLine(str(h.note)), 200) } : {})
        }))
        .slice(-DECISION_LIMITS.historyEntries)
    : []
  const d: Decision = {
    id,
    projectId,
    topic,
    statement,
    status: trusted ? status : 'proposed',
    proposer,
    alternatives: cleanList(raw.alternatives, DECISION_LIMITS.alternatives, DECISION_LIMITS.alternativeChars),
    affectedFiles: cleanList(raw.affectedFiles, DECISION_LIMITS.affectedFiles, DECISION_LIMITS.fileChars),
    createdAt,
    updatedAt: num(raw.updatedAt) ?? createdAt,
    history
  }
  const rationale = cap(oneLine(str(raw.rationale)), DECISION_LIMITS.rationaleChars)
  if (rationale) d.rationale = rationale
  if (evidence) d.evidence = evidence
  const supersedes = str(raw.supersedes)
  if (DECISION_ID_RE.test(supersedes)) d.supersedes = supersedes
  const supersededBy = str(raw.supersededBy)
  if (DECISION_ID_RE.test(supersededBy)) d.supersededBy = supersededBy
  const review = str(raw.reviewDate)
  if (/^\d{4}-\d{2}-\d{2}$/.test(review)) d.reviewDate = review
  if (!trusted) {
    const demoted: DecisionHistoryEntry = {
      at: d.updatedAt,
      action: 'proposed',
      by: 'claude',
      note: `stored as ${status} without evidence; demoted`
    }
    d.history = [...d.history, demoted].slice(-DECISION_LIMITS.historyEntries)
  }
  return d
}

/** One JSON object per line. Bad lines and duplicate ids (first wins) are skipped. */
export function parseDecisionsJsonl(text: string, projectId: string): Decision[] {
  const out: Decision[] = []
  const seen = new Set<string>()
  for (const line of str(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const d = normalizeDecision(raw, projectId)
    if (d && !seen.has(d.id)) {
      seen.add(d.id)
      out.push(d)
    }
  }
  return out
}

/** Stable order (createdAt, then id) so git diffs stay small. */
export function serializeDecisionsJsonl(decisions: Decision[]): string {
  const sorted = [...decisions].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  return sorted.map((d) => JSON.stringify(d)).join('\n') + (sorted.length ? '\n' : '')
}

// ---------- the state machine ----------

export interface DecisionContext {
  projectId: string
  now: number
  /** who is asking: the Hub UI (Chris) or the CLI (Claude) */
  by: 'hub-ui' | 'cli'
  /** fresh id factory */
  newId: () => string
  /** the founder inputs to search for a CLI quote (ignored for hub-ui) */
  founderInputs: FounderInput[]
}

function withHistory(d: Decision, entry: DecisionHistoryEntry): Decision {
  return { ...d, updatedAt: entry.at, history: [...d.history, entry].slice(-DECISION_LIMITS.historyEntries) }
}

function activeOnTopic(decisions: Decision[], topic: string, exceptId?: string): Decision | undefined {
  return decisions.find((d) => d.status === 'approved' && d.topic === topic && d.id !== exceptId)
}

function refuse(decisions: Decision[], message: string): DecisionResult {
  return { ok: false, outcome: 'refused', message, decisions }
}

/**
 * Apply one request. Pure: returns the new list. The rules are listed at the top of
 * this file. Evidence: the hub-ui (Chris clicking) is evidence in itself; a CLI
 * request must carry a quote that is found in the founder's recent inputs.
 */
export function applyDecisionRequest(
  decisions: Decision[],
  req: DecisionRequest,
  ctx: DecisionContext
): DecisionResult {
  const list = Array.isArray(decisions) ? decisions : []
  if (!isObj(req) || !['propose', 'approve', 'reject'].includes(req.action as string)) {
    return refuse(list, 'Unknown action. Use propose, approve or reject.')
  }
  const now = ctx.now
  const actor: DecisionActor = ctx.by === 'hub-ui' ? 'chris' : 'claude'

  // evidence (only needed for approve/reject)
  let evidence: DecisionEvidence | undefined
  let evidenceProblem = ''
  if (req.action !== 'propose') {
    if (ctx.by === 'hub-ui') {
      evidence = {
        kind: 'hub-ui',
        quote: `${req.action === 'approve' ? 'Approved' : 'Rejected'} in Builder Hub`,
        at: now
      }
    } else {
      const quote = str(req.quote)
      if (!quote) evidenceProblem = "No quote given: pass the founder's exact words with --quote."
      else {
        evidence = findEvidence(quote, ctx.founderInputs, now)
        if (!evidence)
          evidenceProblem = `The quote "${cap(oneLine(quote), 80)}" was not found in Chris's prompts or answers from the last 48 hours on this project.`
      }
    }
  }

  // ---- acting on an existing decision ----
  if (str(req.id)) {
    const id = str(req.id)
    const target = list.find((d) => d.id === id)
    if (!target) return refuse(list, `No decision ${id} in this project.`)
    if (req.action === 'propose') return refuse(list, `${id} already exists (status ${target.status}).`)
    if (!evidence) return refuse(list, `${id} was not changed. ${evidenceProblem}`)
    if (req.action === 'approve') {
      if (target.status !== 'proposed')
        return refuse(list, `${id} is ${target.status}; only a proposal can be approved.`)
      return approveInto(list, target, req, evidence, actor, now, false)
    }
    // reject
    if (target.status === 'rejected' || target.status === 'superseded')
      return refuse(list, `${id} is already ${target.status}.`)
    const rejected = withHistory(
      { ...target, status: 'rejected', evidence },
      { at: now, action: 'rejected', by: actor }
    )
    return {
      ok: true,
      outcome: 'rejected',
      message: `${id} rejected.`,
      decisions: list.map((d) => (d.id === id ? rejected : d)),
      decision: rejected
    }
  }

  // ---- a new decision ----
  const topic = normalizeTopic(str(req.topic))
  const statement = cap(oneLine(str(req.statement)), DECISION_LIMITS.statementChars)
  if (!topic || !statement) return refuse(list, 'A new decision needs --topic and --statement.')
  const base: Decision = {
    id: ctx.newId(),
    projectId: ctx.projectId,
    topic,
    statement,
    status: 'proposed',
    proposer: actor,
    alternatives: cleanList(req.alternatives, DECISION_LIMITS.alternatives, DECISION_LIMITS.alternativeChars),
    affectedFiles: cleanList(req.affectedFiles, DECISION_LIMITS.affectedFiles, DECISION_LIMITS.fileChars),
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, action: 'proposed', by: actor }]
  }
  if (list.some((d) => d.id === base.id)) return refuse(list, 'Id collision; try again.')
  const rationale = cap(oneLine(str(req.rationale)), DECISION_LIMITS.rationaleChars)
  if (rationale) base.rationale = rationale
  const review = str(req.reviewDate)
  if (/^\d{4}-\d{2}-\d{2}$/.test(review)) base.reviewDate = review
  const sup = str(req.supersedes)
  if (sup) base.supersedes = sup

  if (req.action === 'propose') {
    const clash = activeOnTopic(list, topic)
    const note = clash
      ? ` It conflicts with approved ${clash.id} ("${cap(clash.statement, 80)}"); adopting it needs Chris's approval with --supersedes ${clash.id}.`
      : ''
    return {
      ok: true,
      outcome: 'proposed',
      message: `${base.id} recorded as a proposal.${note}`,
      decisions: [...list, base],
      decision: base
    }
  }

  if (!evidence) {
    // Never approve without proof — keep it as a proposal so nothing is lost.
    const kept = withHistory(base, {
      at: now,
      action: 'edited',
      by: actor,
      note: `${req.action} requested; ${evidenceProblem}`
    })
    return {
      ok: true,
      outcome: 'proposed',
      message: `${base.id} recorded as a PROPOSAL, not ${req.action === 'approve' ? 'approved' : 'rejected'}. ${evidenceProblem} Ask Chris to confirm, then approve it by id with his words.`,
      decisions: [...list, kept],
      decision: kept
    }
  }

  if (req.action === 'reject') {
    const rejected = withHistory(
      { ...base, status: 'rejected', evidence },
      { at: now, action: 'rejected', by: actor }
    )
    return {
      ok: true,
      outcome: 'rejected',
      message: `${rejected.id} recorded as a rejected approach.`,
      decisions: [...list, rejected],
      decision: rejected
    }
  }
  return approveInto([...list, base], base, req, evidence, actor, now, true)
}

/** Approve `target` (already in `list`), enforcing the one-active-per-topic rule. */
function approveInto(
  list: Decision[],
  target: Decision,
  req: DecisionRequest,
  evidence: DecisionEvidence,
  actor: DecisionActor,
  now: number,
  isNew: boolean
): DecisionResult {
  // a refused NEW decision is dropped again (it was appended optimistically)
  const without = (): Decision[] => (isNew ? list.filter((d) => d.id !== target.id) : list)
  const supersedes = str(req.supersedes) || target.supersedes || ''
  let old: Decision | undefined
  if (supersedes) {
    old = list.find((d) => d.id === supersedes)
    if (!old) return refuse(without(), `Cannot supersede ${supersedes}: no such decision.`)
    if (old.status !== 'approved')
      return refuse(without(), `Cannot supersede ${supersedes}: it is ${old.status}, not approved.`)
  }
  const clash = activeOnTopic(list, target.topic, target.id)
  if (clash && clash.id !== old?.id) {
    return refuse(
      without(),
      `Conflict: approved ${clash.id} already covers topic "${target.topic}" ("${cap(clash.statement, 120)}"). Canon is not rewritten silently: approve with --supersedes ${clash.id} if Chris is replacing it, or propose instead.`
    )
  }
  const approved = withHistory(
    { ...target, status: 'approved', evidence, ...(old ? { supersedes: old.id } : {}) },
    { at: now, action: 'approved', by: actor }
  )
  const next = list.map((d) => {
    if (d.id === target.id) return approved
    if (old && d.id === old.id)
      return withHistory(
        { ...d, status: 'superseded' as const, supersededBy: approved.id },
        { at: now, action: 'superseded', by: actor, note: `by ${approved.id}` }
      )
    return d
  })
  return {
    ok: true,
    outcome: 'approved',
    message: `${approved.id} approved${old ? ` (supersedes ${old.id})` : ''}.`,
    decisions: next,
    decision: approved
  }
}

// ---------- views ----------

export function decisionsByStatus(decisions: Decision[]): Record<DecisionStatus, Decision[]> {
  const out: Record<DecisionStatus, Decision[]> = { proposed: [], approved: [], rejected: [], superseded: [] }
  for (const d of Array.isArray(decisions) ? decisions : []) out[d.status]?.push(d)
  for (const k of DECISION_STATUSES) out[k].sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

function evidenceLine(e: DecisionEvidence | undefined): string {
  if (!e) return ''
  const how = e.kind === 'hub-ui' ? 'in Builder Hub' : e.kind === 'answer' ? 'answer' : 'prompt'
  return `${isoDay(e.at)}, ${how}: "${e.quote}"`
}

/** DECISIONS.md: human-readable view of decisions.jsonl (the jsonl is the source). */
export function renderDecisionsMarkdown(projectName: string, decisions: Decision[]): string {
  const g = decisionsByStatus(decisions)
  const lines: string[] = [
    `# ${oneLine(projectName)} — decisions`,
    '',
    '_Generated by Builder Hub from `decisions.jsonl` (the source). Do not edit by hand: approve, reject or supersede through the Hub or `decide`._',
    ''
  ]
  const section = (title: string, items: Decision[], withEvidence: boolean): void => {
    lines.push(`## ${title} (${items.length})`, '')
    if (!items.length) {
      lines.push('_None._', '')
      return
    }
    for (const d of items) {
      lines.push(`### ${d.id} · ${d.topic}`, '', d.statement, '')
      if (d.rationale) lines.push(`- **Why:** ${d.rationale}`)
      if (d.alternatives.length) lines.push(`- **Alternatives considered:** ${d.alternatives.join('; ')}`)
      if (withEvidence && d.evidence) lines.push(`- **Evidence:** ${evidenceLine(d.evidence)}`)
      if (d.supersedes) lines.push(`- **Supersedes:** ${d.supersedes}`)
      if (d.supersededBy) lines.push(`- **Superseded by:** ${d.supersededBy}`)
      if (d.affectedFiles.length) lines.push(`- **Affects:** ${d.affectedFiles.join(', ')}`)
      if (d.reviewDate) lines.push(`- **Review:** ${d.reviewDate}`)
      lines.push(`- **Proposed by:** ${d.proposer} · ${isoDay(d.createdAt)}`, '')
    }
  }
  section('Approved', g.approved, true)
  section('Rejected approaches', g.rejected, true)
  section('Proposed (not binding until Chris approves)', g.proposed, false)
  section('Superseded', g.superseded, true)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

export interface DecisionContextInput {
  decisions: Decision[]
  /** first part of VISION.md, if the project has one */
  vision?: string
  /** how Claude records decisions (the CLI command prefix) */
  cliCommand: string
  /** where the full record lives */
  decisionsFile?: string
  maxChars?: number
}

/**
 * The SessionStart block: approved decisions are binding, rejected approaches stay
 * rejected, and here is how to record new ones. Always present (even with no
 * decisions) so every session knows the tool exists. Bounded: the newest decisions
 * are kept and the rest are summarized as "+N more in <file>".
 */
export function buildDecisionContext(input: DecisionContextInput): string {
  const max = num(input.maxChars) ?? DECISION_LIMITS.injectionChars
  const g = decisionsByStatus(input.decisions)
  const head: string[] = []
  const tail: string[] = []
  const vision = oneLine(str(input.vision))
  if (vision) head.push(`Founder vision: ${cap(vision, 600)}`)
  if (g.approved.length || g.rejected.length) {
    head.push(
      `Founder decisions (canon): ${g.approved.length} approved, ${g.rejected.length} rejected, ${g.proposed.length} proposed. Approved ones are binding and rejected ones stay rejected: if a request conflicts with one, say so and ask Chris before acting.`
    )
  } else if (g.proposed.length) {
    head.push(`Founder decisions (canon): none approved yet; ${g.proposed.length} proposed (not binding).`)
  }
  tail.push(
    `Record decisions as they happen (skill: decide): \`${input.cliCommand} propose|approve|reject --topic <kebab> --statement "<what>" [--quote "<Chris's exact words>"] [--supersedes <id>]\`. Approval needs Chris's own words; without them it is stored as a proposal.`
  )
  if (input.decisionsFile) tail.push(`Full record: ${input.decisionsFile}`)

  const items: string[] = [
    ...g.approved.map((d) => `- APPROVED ${d.id} [${d.topic}] ${cap(d.statement, 220)}`),
    ...g.rejected.map((d) => `- REJECTED ${d.id} [${d.topic}] ${cap(d.statement, 160)}`),
    ...(g.proposed.length
      ? [
          `- ${g.proposed.length} proposal(s) await Chris: ${g.proposed
            .slice(0, 5)
            .map((d) => d.id)
            .join(', ')}`
        ]
      : [])
  ]
  const size = (ls: string[]): number => ls.reduce((n, l) => n + l.length + 1, 0)
  const fixed = size(head) + size(tail)
  const kept: string[] = []
  let used = fixed
  for (const line of items) {
    if (used + line.length + 1 > max - 40) break
    kept.push(line)
    used += line.length + 1
  }
  const dropped = items.length - kept.length
  if (dropped > 0) kept.push(`- +${dropped} more in the full record`)
  return [...head, ...kept, ...tail].join('\n')
}

/** Folder name for a project in the canon repo: a slug of its name. */
export function canonFolderSlug(projectName: string): string {
  return normalizeTopic(projectName) || 'project'
}
