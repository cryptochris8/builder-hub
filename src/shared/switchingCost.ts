// v1.1 context-aware switching cost — PURE (no node/electron), unit-tested.
//
// The router (router.ts) answers: "how capable a model does the NEXT task need?"
// This module answers the other half: "what would switching models right now
// lose?" It scores four explainable factors from data the Hub already has:
//
//   size        how much context the session holds (status line = exact,
//               transcript usage metadata = estimated, else unknown)
//   value       deterministic proxies accumulated per turn by the board reducer
//               (edits, passes after edits, decisions, root causes, constraints,
//               approvals) minus exploration, compaction and staleness
//   continuity  how much the NEXT prompt depends on this session's knowledge
//               (same files / objective / continuation language vs. another
//               project or a clear task boundary)
//   capture     how much of that value the Hub has already persisted (recaps,
//               checkpoints, handoffs) since the last substantive work
//
//   risk ≈ size × value × continuity × (1 − capture), each factor normalized to
//   a fixed weight so the product stays explainable (SWITCHING_WEIGHTS).
//
// applySwitchingPolicy() then changes ONLY downgrades: high risk holds the
// current model, moderate allows a suggestion but no auto-apply, low allows the
// normal behavior. Escalations are never blocked. No transcript content is read.

import type {
  BoundaryStrength,
  CaptureClass,
  ClaudeEffort,
  ClaudeModel,
  CommandRecord,
  ContextSizeClass,
  ContextUsage,
  ContextValueClass,
  ContinuityClass,
  ContinuityLedger,
  Project,
  RouterRecommendation,
  SessionRecord,
  SwitchingAssessment,
  SwitchingRisk
} from './types'
import { effortAlias, mentionedProjects, modelAlias, tierOf } from './router'

// ---------- limits & weights (one place, pinned by tests) ----------

export const SWITCHING_LIMITS = {
  /** context % boundaries: < low, < moderate, < high, else very-high */
  pctLow: 25,
  pctModerate: 50,
  pctHigh: 80,
  /** token boundaries used only when the window (and so the %) is unknown */
  tokensLow: 60_000,
  tokensModerate: 150_000,
  tokensHigh: 400_000,
  /** a standard context window; more tokens than this can only fit a 1M window */
  standardWindow: 200_000,
  largeWindow: 1_000_000,
  /** value score boundaries: < low, < moderate, < high, else critical */
  valueLow: 20,
  valueModerate: 40,
  valueHigh: 65,
  /** risk score boundaries: < moderate → low, < high → moderate, else high */
  riskModerate: 0.1,
  riskHigh: 0.3,
  /** word overlap (share of the prompt's significant words) for high / moderate continuity */
  overlapHigh: 0.3,
  overlapModerate: 0.12,
  /** a prompt with fewer significant words than this is too thin to judge continuity confidently */
  minPromptWords: 3,
  /** the task packet carries this many recaps — more substantive turns than this are only partially captured */
  packetRecaps: 3,
  /** status-line usage older than this is superseded by a fresher transcript estimate */
  statusLineFreshMs: 10 * 60 * 1000,
  /** value decays after this long without substantive work */
  staleAfterMs: 6 * 60 * 60 * 1000,
  veryStaleAfterMs: 24 * 60 * 60 * 1000
} as const

/** Normalized factor weights: risk = size × value × continuity × captureGap. */
export const SWITCHING_WEIGHTS = {
  size: { low: 0.25, moderate: 0.5, high: 0.8, 'very-high': 1, unknown: 0.6 } as Record<
    ContextSizeClass,
    number
  >,
  value: { low: 0.1, moderate: 0.45, high: 0.75, critical: 1 } as Record<ContextValueClass, number>,
  continuity: { 'very-low': 0.1, low: 0.3, moderate: 0.6, high: 1 } as Record<ContinuityClass, number>,
  /** 1 − capture adequacy */
  captureGap: { poor: 1, partial: 0.7, good: 0.35, excellent: 0.05 } as Record<CaptureClass, number>
} as const

// ---------- the ledger (accumulated by the board reducer) ----------

export function emptyLedger(): ContinuityLedger {
  return {
    turns: 0,
    editTurns: 0,
    readOnlyTurns: 0,
    searchCalls: 0,
    turnSearches: 0,
    passesAfterEdit: 0,
    editsSincePass: 0,
    decisionHits: 0,
    rootCauseHits: 0,
    constraintHits: 0,
    approvalHits: 0,
    compactions: 0,
    editsSinceCapture: 0,
    editsSinceHandoff: 0,
    substantiveTurnsSinceHandoff: 0,
    decisionsSinceHandoff: 0,
    agentsActive: 0,
    agentsPeak: 0,
    agentsTotal: 0
  }
}

const COUNT_KEYS = [
  'turns',
  'editTurns',
  'readOnlyTurns',
  'searchCalls',
  'turnSearches',
  'passesAfterEdit',
  'editsSincePass',
  'decisionHits',
  'rootCauseHits',
  'constraintHits',
  'approvalHits',
  'compactions',
  'editsSinceCapture',
  'editsSinceHandoff',
  'substantiveTurnsSinceHandoff',
  'decisionsSinceHandoff',
  'agentsActive',
  'agentsPeak',
  'agentsTotal'
] as const

const TIME_KEYS = ['lastEditAt', 'lastSubstantiveAt', 'lastCaptureAt', 'lastHandoffAt'] as const

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
const time = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Tolerant read of a persisted/hand-edited ledger: bad fields reset, never throw. */
export function normalizeLedger(raw: unknown): ContinuityLedger {
  const out = emptyLedger()
  if (!isObj(raw)) return out
  for (const k of COUNT_KEYS) out[k] = count(raw[k])
  for (const k of TIME_KEYS) {
    const t = time(raw[k])
    if (t !== undefined) out[k] = t
  }
  const b = raw.boundary
  if (isObj(b) && (b.strength === 'weak' || b.strength === 'strong') && typeof b.reason === 'string') {
    const at = time(b.at)
    if (at !== undefined) out.boundary = { at, strength: b.strength, reason: b.reason.slice(0, 200) }
  }
  return out
}

// ---------- language proxies (recaps + prompts) ----------

/** A recap that recorded a design or implementation decision. */
export const DECISION_PATTERN =
  /\b(decided|decision|chose|opted|went with|settled on|locked in|instead of|trade-?offs?|we(?:'ll| will) (?:use|keep|go with))\b/i
/** A recap that named a bug's root cause. */
export const ROOT_CAUSE_PATTERN =
  /\b(root cause|caused by|the (?:bug|issue|problem|crash|failure) (?:was|is)|turned out|the fix (?:was|is))\b/i
/** A recap that established a constraint or a negative finding — valuable research even without edits. */
export const CONSTRAINT_PATTERN =
  /\b(not supported|unsupported|does(?:n't| not) support|cannot|can't|no (?:api|way) to|is(?:n't| not) possible|must not|must be|verified|confirmed|ruled out|dead end|won't work|does(?:n't| not) work)\b/i
/** A prompt approving an implementation choice. */
export const APPROVAL_PATTERN =
  /^\s*(?:yes|yep|yeah|ok(?:ay)?|sounds good|perfect|great|lgtm|approved|go (?:ahead|for it)|do it|ship it)\b|\b(?:go ahead|approved|sounds good|do it)\b/i

export function recapLanguage(recap: string | undefined): {
  decision: boolean
  rootCause: boolean
  constraint: boolean
} {
  const t = typeof recap === 'string' ? recap : ''
  return {
    decision: DECISION_PATTERN.test(t),
    rootCause: ROOT_CAUSE_PATTERN.test(t),
    constraint: CONSTRAINT_PATTERN.test(t)
  }
}

export function isApproval(prompt: string | undefined): boolean {
  return typeof prompt === 'string' && prompt.length <= 400 && APPROVAL_PATTERN.test(prompt)
}

/** Read-only / search tools whose calls count as exploration. */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebSearch',
  'WebFetch'
])

// ---------- context size ----------

/**
 * The context window, only when it is actually known: the model id says 1M
 * (`[1m]`), or the session already holds more tokens than a standard window can
 * fit. Otherwise undefined — the percentage then stays unknown rather than being
 * computed against a guessed window.
 */
export function inferContextWindow(
  modelId: string | undefined,
  tokens: number | undefined
): number | undefined {
  if (typeof modelId === 'string' && /\[1m\]/i.test(modelId)) return SWITCHING_LIMITS.largeWindow
  if (typeof tokens === 'number' && tokens > SWITCHING_LIMITS.standardWindow)
    return SWITCHING_LIMITS.largeWindow
  return undefined
}

/**
 * Context tokens from the TAIL of a Claude Code transcript (JSONL): the last
 * main-thread assistant turn's usage metadata — input + cache creation + cache
 * read + output (that output is in context for the next turn). Sidechain
 * (subagent) records are skipped. Only numbers are read; no message content.
 */
export function usageFromTranscriptTail(text: string): { tokens: number; model?: string } | undefined {
  if (typeof text !== 'string' || !text) return undefined
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{') || !line.includes('"usage"')) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue // the first line of a tail read is usually cut mid-record
    }
    if (!isObj(o) || o.type !== 'assistant' || o.isSidechain === true || !isObj(o.message)) continue
    const u = o.message.usage
    if (!isObj(u)) continue
    const tokens =
      count(u.input_tokens) +
      count(u.cache_creation_input_tokens) +
      count(u.cache_read_input_tokens) +
      count(u.output_tokens)
    if (tokens <= 0) continue
    return { tokens, model: typeof o.message.model === 'string' ? o.message.model : undefined }
  }
  return undefined
}

/** Build a ContextUsage from a transcript estimate. The % exists only if the window is known. */
export function transcriptUsage(tokens: number, modelId: string | undefined, now: number): ContextUsage {
  const windowSize = inferContextWindow(modelId, tokens)
  const pct = windowSize ? Math.min(100, Math.round((tokens / windowSize) * 1000) / 10) : undefined
  return { tokens, windowSize, pct, source: 'transcript', at: now }
}

/** Prefer an exact status-line reading while it is fresh; otherwise the newer reading wins. */
export function mergeContextUsage(
  prev: ContextUsage | undefined,
  next: ContextUsage | undefined
): ContextUsage | undefined {
  if (!next) return prev
  if (!prev) return next
  if (
    prev.source === 'statusline' &&
    next.source !== 'statusline' &&
    next.at - prev.at < SWITCHING_LIMITS.statusLineFreshMs
  ) {
    return prev
  }
  return next.at >= prev.at ? next : prev
}

export function assessSize(usage: ContextUsage | undefined): {
  size: ContextSizeClass
  source: SwitchingAssessment['sizeSource']
  pct?: number
  tokens?: number
} {
  const L = SWITCHING_LIMITS
  if (!usage || usage.source === 'unknown') return { size: 'unknown', source: 'unknown' }
  const source = usage.source === 'statusline' ? 'exact' : 'estimated'
  const pct = typeof usage.pct === 'number' && Number.isFinite(usage.pct) ? usage.pct : undefined
  const tokens = typeof usage.tokens === 'number' && Number.isFinite(usage.tokens) ? usage.tokens : undefined
  if (pct !== undefined) {
    const size: ContextSizeClass =
      pct < L.pctLow ? 'low' : pct < L.pctModerate ? 'moderate' : pct < L.pctHigh ? 'high' : 'very-high'
    return { size, source, pct, tokens }
  }
  if (tokens !== undefined) {
    const size: ContextSizeClass =
      tokens < L.tokensLow
        ? 'low'
        : tokens < L.tokensModerate
          ? 'moderate'
          : tokens < L.tokensHigh
            ? 'high'
            : 'very-high'
    return { size, source: 'estimated', tokens }
  }
  return { size: 'unknown', source: 'unknown' }
}

// ---------- context value ----------

export interface ValueInput {
  ledger: ContinuityLedger
  filesEdited: number
  projectsTouched: number
  testStatus?: CommandRecord
  now: number
}

export function scoreContextValue(input: ValueInput): {
  score: number
  value: ContextValueClass
  reasons: string[]
} {
  const L = normalizeLedger(input.ledger)
  const reasons: string[] = []
  const add = (points: number, reason: string): number => {
    if (points > 0) reasons.push(reason)
    return points
  }
  let positive = 0
  positive += add(Math.min(30, L.editTurns * 6), `${L.editTurns} turn(s) with edits`)
  positive += add(Math.min(10, L.passesAfterEdit * 5), `${L.passesAfterEdit} passing check(s) after changes`)
  positive += add(Math.min(20, L.decisionHits * 5), `${L.decisionHits} decision(s)`)
  positive += add(Math.min(16, L.rootCauseHits * 8), `${L.rootCauseHits} root cause(s) found`)
  positive += add(
    Math.min(12, L.constraintHits * 4),
    `${L.constraintHits} constraint(s) / negative finding(s)`
  )
  positive += add(
    input.filesEdited >= 8 ? 12 : input.filesEdited >= 3 ? 8 : 0,
    `${input.filesEdited} files changed`
  )
  positive += add(input.projectsTouched > 1 ? 8 : 0, 'cross-project changes')
  const activeFix = input.testStatus?.outcome === 'fail' && L.editTurns > 0
  positive += add(activeFix ? 12 : 0, 'a fix is in progress (last check failing)')
  positive += add(Math.min(6, L.approvalHits * 3), 'user-approved choices')

  const since = L.lastSubstantiveAt !== undefined ? input.now - L.lastSubstantiveAt : undefined
  if (since !== undefined && since > SWITCHING_LIMITS.veryStaleAfterMs) {
    positive *= 0.25
    reasons.push('no substantive work for over a day')
  } else if (since !== undefined && since > SWITCHING_LIMITS.staleAfterMs) {
    positive *= 0.5
    reasons.push('no substantive work for hours')
  }

  let penalty = 0
  if (L.readOnlyTurns > 2 * Math.max(1, L.editTurns) && L.constraintHits === 0) {
    penalty += 12
    reasons.push(`${L.readOnlyTurns} exploratory turn(s) with no lasting finding`)
  }
  if (L.compactions > 0) {
    penalty += Math.min(20, L.compactions * 10)
    reasons.push(`compacted ${L.compactions}× (older context already summarized)`)
  }

  const score = Math.max(0, Math.min(100, Math.round(positive - penalty)))
  const S = SWITCHING_LIMITS
  const value: ContextValueClass =
    score < S.valueLow
      ? 'low'
      : score < S.valueModerate
        ? 'moderate'
        : score < S.valueHigh
          ? 'high'
          : 'critical'
  return { score, value, reasons }
}

// ---------- task boundary & continuity ----------

const STOPWORDS = new Set(
  (
    'this that with from have will would could should about into then than them they their there what when where which ' +
    'while your yours please make sure just also like some more most other only same such very want need does done ' +
    'into onto over under again here were been being because before after these those each every help thing things ' +
    'okay yeah sure right well going gonna let lets file files code change changes work working'
  ).split(/\s+/)
)

/** Significant lowercase words (4+ chars, not stopwords). */
export function significantWords(text: string | undefined): Set<string> {
  const out = new Set<string>()
  if (typeof text !== 'string') return out
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []) if (!STOPWORDS.has(w)) out.add(w)
  return out
}

/** Explicit "that task is over / new task" language. */
export const PIVOT_PATTERN =
  /\b(?:that(?:'s| is) (?:done|finished|complete|all)|(?:we're|we are|i'm|i am) done with|new task|different (?:task|topic|project)|moving on|move on to|let's move on|switch(?:ing)? (?:over )?to (?:another|a different|the other|my)|now let's work on|unrelated|separate (?:thing|question|task))\b/i
/** Softer "next" language — a boundary only if the prompt also drifts from the objective. */
export const NEXT_PATTERN =
  /^\s*(?:ok(?:ay)?[,.]?\s+)?(?:next|now let's|now,? can you|another thing|one more thing)\b/i
/** "Open <project>" style requests. */
export const OPEN_PROJECT_PATTERN = /\b(?:open|switch to|go to|jump to|work on)\b/i
/** Continuation language — the next task leans on the current one. */
export const CONTINUATION_PATTERN =
  /\b(?:continue|keep going|carry on|the remaining|remaining (?:test|tests|work|items?|issues?)|finish (?:it|that|this|the)|same (?:file|bug|issue|test|error|function)|(?:this|that|the failing) (?:test|bug|error|failure|fix)|fix (?:it|that|this)|try again|still failing|as (?:we|you) (?:discussed|planned|decided))\b/i
/** A recap that says the objective was completed. */
export const COMPLETION_PATTERN =
  /\b(?:all (?:tests|checks|gates) (?:pass|passing|green)|(?:is|are|now) (?:complete|done|finished)|completed|shipped|task (?:is )?done)\b/i

export interface ContinuityInput {
  prompt?: string
  objective?: string
  recaps: string[]
  /** normPath keys of files this session edited */
  filesEdited: string[]
  testStatus?: CommandRecord
  sessionProjectId?: string
  projects: Project[]
}

const basenameWord = (key: string): string | undefined => {
  const base = key.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.[^.]+$/, '').toLowerCase()
  return stem.length >= 4 ? stem : undefined
}

function overlapRatio(prompt: string | undefined, input: ContinuityInput): number {
  const words = significantWords(prompt)
  if (words.size === 0) return 0
  const ctx = significantWords([input.objective ?? '', ...input.recaps.slice(-2)].join(' '))
  for (const f of input.filesEdited) {
    const w = basenameWord(f)
    if (w) for (const part of w.split(/[^a-z0-9]+/)) if (part.length >= 4) ctx.add(part)
  }
  let hit = 0
  for (const w of words) if (ctx.has(w)) hit++
  return hit / words.size
}

/** Registered projects the prompt names that are NOT this session's project. */
function otherProjectsNamed(input: ContinuityInput): Project[] {
  if (!input.prompt) return []
  return mentionedProjects(input.prompt, input.projects).filter((p) => p.id !== input.sessionProjectId)
}

/**
 * Is this prompt the start of a different task? Strong: it names another
 * registered project, or says outright that the task is over / a new one starts,
 * or the last recap reported completion (checks green) and the prompt shares
 * little with the objective. Weak: "next / now let's" with limited overlap.
 */
export function detectTaskBoundary(input: ContinuityInput): { strength: BoundaryStrength; reason: string } {
  const prompt = input.prompt ?? ''
  if (!prompt.trim()) return { strength: 'none', reason: '' }
  const others = otherProjectsNamed(input)
  if (others.length > 0) {
    return {
      strength: 'strong',
      reason: `moves to another project (${others.map((p) => p.name).join(', ')})`
    }
  }
  if (PIVOT_PATTERN.test(prompt)) return { strength: 'strong', reason: 'says the previous task is over' }
  const overlap = overlapRatio(prompt, input)
  const lastRecap = input.recaps[input.recaps.length - 1] ?? ''
  const completed = COMPLETION_PATTERN.test(lastRecap) && input.testStatus?.outcome !== 'fail'
  if (
    completed &&
    overlap < SWITCHING_LIMITS.overlapModerate &&
    significantWords(prompt).size >= SWITCHING_LIMITS.minPromptWords
  ) {
    return { strength: 'strong', reason: 'previous objective completed and the new request is unrelated' }
  }
  if (NEXT_PATTERN.test(prompt) && overlap < SWITCHING_LIMITS.overlapHigh) {
    return { strength: 'weak', reason: 'moves on to a next item' }
  }
  return { strength: 'none', reason: '' }
}

export function assessContinuity(
  input: ContinuityInput,
  boundary: { strength: BoundaryStrength; reason: string }
): { continuity: ContinuityClass; confident: boolean; reasons: string[] } {
  const L = SWITCHING_LIMITS
  const prompt = input.prompt ?? ''
  if (otherProjectsNamed(input).length > 0) {
    return {
      continuity: 'very-low',
      confident: true,
      reasons: [`next task ${boundary.reason || 'is in another project'}`]
    }
  }
  if (boundary.strength === 'strong') {
    return { continuity: 'low', confident: true, reasons: [`task boundary: ${boundary.reason}`] }
  }
  const promptWords = significantWords(prompt)
  const lower = prompt.toLowerCase()
  const fileHit = input.filesEdited.map(basenameWord).find((w) => w && lower.includes(w))
  let result: { continuity: ContinuityClass; confident: boolean; reasons: string[] }
  if (fileHit) {
    result = {
      continuity: 'high',
      confident: true,
      reasons: [`next task touches a file this session changed (${fileHit})`]
    }
  } else if (CONTINUATION_PATTERN.test(prompt)) {
    result = { continuity: 'high', confident: true, reasons: ['next task continues the current work'] }
  } else {
    const overlap = overlapRatio(prompt, input)
    if (overlap >= L.overlapHigh) {
      result = { continuity: 'high', confident: true, reasons: ['next task overlaps the current objective'] }
    } else if (overlap >= L.overlapModerate) {
      result = {
        continuity: 'moderate',
        confident: true,
        reasons: ['next task partly overlaps the current objective']
      }
    } else if (promptWords.size < L.minPromptWords) {
      // Too little text to tell — assume it continues, and never let auto act on it.
      result = {
        continuity: 'moderate',
        confident: false,
        reasons: ['too little in the request to judge continuity']
      }
    } else {
      result = {
        continuity: 'low',
        confident: true,
        reasons: ['next task shares little with the current objective']
      }
    }
  }
  if (boundary.strength === 'weak' && (result.continuity === 'high' || result.continuity === 'moderate')) {
    result = {
      ...result,
      continuity: 'moderate',
      reasons: [...result.reasons, `possible boundary: ${boundary.reason}`]
    }
  }
  return result
}

// ---------- capture adequacy ----------

export function assessCapture(input: {
  ledger: ContinuityLedger
  objective?: string
  testStatus?: CommandRecord
}): { capture: CaptureClass; reasons: string[] } {
  const L = normalizeLedger(input.ledger)
  const substance = L.editTurns > 0 || L.decisionHits + L.rootCauseHits + L.constraintHits > 0
  if (!substance && L.editsSinceCapture === 0) {
    return { capture: 'good', reasons: ['nothing substantive to lose yet'] }
  }
  if (L.editsSinceCapture > 0) {
    return { capture: 'poor', reasons: [`${L.editsSinceCapture} edit(s) not yet captured`] }
  }
  if (L.lastCaptureAt === undefined && L.lastHandoffAt === undefined) {
    return { capture: 'poor', reasons: ['nothing from this session has been captured'] }
  }
  const failing = input.testStatus?.outcome === 'fail'
  const handoffCurrent =
    L.lastHandoffAt !== undefined &&
    L.lastHandoffAt >= (L.lastSubstantiveAt ?? 0) &&
    L.editsSinceHandoff === 0
  if (handoffCurrent && !failing) {
    return { capture: 'excellent', reasons: ['a handoff was published after the last substantive work'] }
  }
  const reasons: string[] = []
  if (failing) reasons.push('an unresolved failure lives only in this session')
  if (L.substantiveTurnsSinceHandoff > SWITCHING_LIMITS.packetRecaps) {
    reasons.push(
      `${L.substantiveTurnsSinceHandoff} substantive turns since the last handoff; the packet carries only the last ${SWITCHING_LIMITS.packetRecaps}`
    )
  }
  if (L.decisionsSinceHandoff > 0)
    reasons.push(`${L.decisionsSinceHandoff} decision/finding recap(s) not recorded as decisions`)
  // A recap describes changes; it does not preserve them. Edits with no passing
  // check and no handoff since are known only through that description.
  if (L.editsSinceHandoff > 0 && L.editsSincePass > 0) {
    reasons.push(`${L.editsSincePass} edit(s) described only by recaps (no passing check or handoff since)`)
  }
  if (!input.objective) reasons.push('no objective recorded')
  if (reasons.length > 0) return { capture: 'partial', reasons }
  return { capture: 'good', reasons: ['recent work is captured in the task packet'] }
}

// ---------- the assessment ----------

export interface SwitchingInput {
  record: Pick<
    SessionRecord,
    | 'ledger'
    | 'contextUsage'
    | 'objective'
    | 'recaps'
    | 'filesEdited'
    | 'testStatus'
    | 'projectId'
    | 'otherProjectsTouched'
    | 'signals'
    | 'lastPromptAt'
  >
  /** the next task's text (normally the session's latest prompt) */
  prompt?: string
  projects: Project[]
  now: number
}

export function assessSwitching(input: SwitchingInput): SwitchingAssessment {
  const r = input.record
  const ledger = normalizeLedger(r.ledger)
  const files = Object.keys(r.filesEdited ?? {})
  const size = assessSize(r.contextUsage)
  const value = scoreContextValue({
    ledger,
    filesEdited: files.length,
    projectsTouched: Math.max(
      r.signals?.projectsTouched ?? 0,
      (r.otherProjectsTouched?.length ?? 0) > 0 ? 2 : 0
    ),
    testStatus: r.testStatus,
    now: input.now
  })
  const cInput: ContinuityInput = {
    prompt: input.prompt,
    objective: r.objective,
    recaps: Array.isArray(r.recaps) ? r.recaps : [],
    filesEdited: files,
    testStatus: r.testStatus,
    sessionProjectId: r.projectId,
    projects: input.projects
  }
  // A strong boundary detected on THIS prompt already replaced the objective with
  // the prompt itself (reducer), so re-detecting now would compare the prompt to
  // itself. The boundary the reducer recorded for this prompt is authoritative.
  const detected = detectTaskBoundary(cInput)
  const recorded =
    ledger.boundary && r.lastPromptAt !== undefined && ledger.boundary.at === r.lastPromptAt
      ? ledger.boundary
      : undefined
  const boundary: { strength: BoundaryStrength; reason: string } =
    recorded && (recorded.strength === 'strong' || detected.strength === 'none')
      ? { strength: recorded.strength, reason: recorded.reason }
      : detected
  const continuity = assessContinuity(cInput, boundary)
  const capture = assessCapture({ ledger, objective: r.objective, testStatus: r.testStatus })

  const W = SWITCHING_WEIGHTS
  const riskScore =
    Math.round(
      W.size[size.size] *
        W.value[value.value] *
        W.continuity[continuity.continuity] *
        W.captureGap[capture.capture] *
        100
    ) / 100
  const risk: SwitchingRisk =
    riskScore >= SWITCHING_LIMITS.riskHigh
      ? 'high'
      : riskScore >= SWITCHING_LIMITS.riskModerate
        ? 'moderate'
        : 'low'

  const sizeReason =
    size.source === 'unknown'
      ? 'context size unknown (no status line data or transcript usage yet)'
      : size.pct !== undefined
        ? `context ${Math.round(size.pct)}% full${size.source === 'estimated' ? ' (estimated)' : ''}`
        : `context ~${Math.round((size.tokens ?? 0) / 1000)}k tokens (estimated, window unknown)`
  return {
    size: size.size,
    sizeSource: size.source,
    sizePct: size.pct,
    sizeTokens: size.tokens,
    value: value.value,
    valueScore: value.score,
    continuity: continuity.continuity,
    capture: capture.capture,
    risk,
    riskScore,
    boundary: boundary.strength,
    confident: continuity.confident && size.source !== 'unknown',
    reasons: [sizeReason, ...value.reasons.slice(0, 3), ...continuity.reasons, ...capture.reasons]
  }
}

// ---------- policy ----------

const RISK_LABEL: Record<SwitchingRisk, string> = { low: 'low', moderate: 'moderate', high: 'high' }

/** "value critical · continuity high · capture partial" */
export function switchingWhy(a: SwitchingAssessment): string {
  return `value ${a.value} · continuity ${a.continuity} · capture ${a.capture}`
}

/**
 * Fold the switching assessment into a task-based recommendation. Only a real
 * DOWNGRADE (direction 'deescalate' with changes) is affected:
 *  - high risk     → hold the current model; the downgrade becomes deferredTarget;
 *                    no auto; offer "Prepare handoff & switch"
 *  - moderate risk → suggestion stays; no auto; offer a handoff first
 *  - low risk      → normal behavior; auto only when the assessment is confident
 * Escalations and holds pass through untouched (switching cost never blocks
 * moving to a more capable model). Guards that forbid unattended downgrades
 * regardless of the score: poor capture of high/critical value, an unresolved
 * failing check, or low confidence.
 */
export function applySwitchingPolicy(
  rec: RouterRecommendation,
  a: SwitchingAssessment,
  current: { model?: string; effort?: string },
  guards: { unresolvedFailure?: boolean } = {}
): RouterRecommendation {
  const base: RouterRecommendation = { ...rec, taskTier: rec.tier, switching: a }
  if (rec.direction !== 'deescalate' || !rec.changes) {
    return { ...base, autoAllowed: rec.direction === 'escalate' || rec.changes ? true : undefined }
  }
  const curModel: ClaudeModel | undefined = modelAlias(current.model)
  const curEffort: ClaudeEffort | undefined = effortAlias(current.effort)
  const why = switchingWhy(a)

  if (a.risk === 'high') {
    const stay = curModel ?? 'the current model'
    return {
      ...base,
      tier: tierOf(current) ?? rec.tier,
      target: curModel ? { model: curModel, effort: curEffort ?? rec.target.effort } : rec.target,
      deferredTarget: rec.target,
      heldForContext: true,
      changes: false,
      direction: 'hold',
      autoAllowed: false,
      offerHandoff: true,
      reason: `valuable context — finish on ${stay} and reassess at the next task boundary (${why})`,
      signals: [...rec.signals, `switching risk: ${RISK_LABEL.high}`]
    }
  }

  const poorValuable = a.capture === 'poor' && (a.value === 'high' || a.value === 'critical')
  if (a.risk === 'moderate') {
    return {
      ...base,
      autoAllowed: false,
      offerHandoff: true,
      reason: `${rec.reason} · moderate switching risk — capture a handoff first (${why})`,
      signals: [...rec.signals, `switching risk: ${RISK_LABEL.moderate}`]
    }
  }
  return {
    ...base,
    autoAllowed: a.confident && !poorValuable && !guards.unresolvedFailure,
    offerHandoff: poorValuable,
    reason: `${rec.reason} · low switching risk`,
    signals: [...rec.signals, `switching risk: ${RISK_LABEL.low}`]
  }
}

/** Rows for the SessionBar's expandable breakdown. */
export function describeSwitching(
  a: SwitchingAssessment,
  taskTier?: string
): { label: string; value: string }[] {
  const size =
    a.sizeSource === 'unknown'
      ? 'unknown'
      : a.sizePct !== undefined
        ? `${Math.round(a.sizePct)}% · ${a.size}${a.sizeSource === 'estimated' ? ' (estimated)' : ''}`
        : `~${Math.round((a.sizeTokens ?? 0) / 1000)}k tokens · ${a.size} (estimated)`
  const rows = [
    { label: 'Context utilization', value: size },
    { label: 'Context value', value: `${a.value} (${a.valueScore}/100)` },
    {
      label: 'Task continuity',
      value: a.continuity + (a.boundary !== 'none' ? ` · ${a.boundary} boundary` : '')
    },
    { label: 'Capture adequacy', value: a.capture },
    {
      label: 'Switching risk',
      value: `${a.risk} (${a.riskScore.toFixed(2)})${a.confident ? '' : ' · low confidence'}`
    }
  ]
  return taskTier ? [{ label: 'Task complexity', value: taskTier }, ...rows] : rows
}

/** The ledger after a handoff was published: everything substantive so far is
 *  now captured in a file the next model or session can read. */
export function ledgerAfterHandoff(raw: ContinuityLedger | undefined, now: number): ContinuityLedger {
  return {
    ...normalizeLedger(raw),
    lastHandoffAt: now,
    lastCaptureAt: now,
    editsSinceCapture: 0,
    editsSinceHandoff: 0,
    substantiveTurnsSinceHandoff: 0,
    decisionsSinceHandoff: 0
  }
}

/** The ledger after the user recorded decisions in the project context (Context tab). */
export function ledgerAfterDecisionsRecorded(raw: ContinuityLedger | undefined): ContinuityLedger {
  return { ...normalizeLedger(raw), decisionsSinceHandoff: 0 }
}
