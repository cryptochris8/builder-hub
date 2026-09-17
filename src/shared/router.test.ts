import { describe, it, expect } from 'vitest'
import {
  AUTO_APPLY_CONFIDENCE,
  COMMON_PROJECT_WORDS,
  COUNTED_COMMAND_KINDS,
  CROSS_PROJECT_PHRASES,
  DEEP_KEYWORDS,
  EFFORT_ORDER,
  LIGHT_KEYWORDS,
  LONG_PROMPT_DEEP,
  LONG_PROMPT_STANDARD,
  MAX_CONFIDENCE,
  MAX_KEYWORDS,
  MIN_PROJECT_NAME_LENGTH,
  RISK_KEYWORDS,
  ROUTER_LIMITS,
  ROUTER_TIER_TARGETS,
  STANDARD_KEYWORDS,
  TIER_ORDER,
  UNCERTAINTY_KEYWORDS,
  classifyPrompt,
  effortAlias,
  emptySignals,
  formatRecommendation,
  mentionedProjects,
  modelAlias,
  normalizeSignals,
  recommend,
  signalsAfterCommand,
  signalsAfterPrompt,
  signalsAfterTurn,
  signalsWithCounts,
  slashCommandsFor,
  tierOf
} from './router'
import { CLAUDE_EFFORTS, CLAUDE_MODELS, ROUTER_TIERS } from './types'
import type { CommandKind, Project, RouterRecommendation, RouterSignals, RouterTier } from './types'

const proj = (name: string, extra: Partial<Project> = {}): Project =>
  ({ id: name, name, ...extra }) as Project

const tierRank = (t: RouterTier): number => TIER_ORDER.indexOf(t)

const rec = (
  prompt: string | undefined,
  overrides: Partial<Parameters<typeof recommend>[0]> = {}
): RouterRecommendation => recommend({ prompt, signals: emptySignals(), now: 1, ...overrides })

describe('tier tables', () => {
  it('maps every tier to an allowlisted model + effort', () => {
    for (const tier of ROUTER_TIERS) {
      expect(CLAUDE_MODELS).toContain(ROUTER_TIER_TARGETS[tier].model)
      expect(CLAUDE_EFFORTS).toContain(ROUTER_TIER_TARGETS[tier].effort)
    }
    expect(ROUTER_TIER_TARGETS.light).toEqual({ model: 'haiku', effort: 'low' })
    expect(ROUTER_TIER_TARGETS.standard).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(ROUTER_TIER_TARGETS.deep).toEqual({ model: 'opus', effort: 'high' })
    expect(ROUTER_TIER_TARGETS.max).toEqual({ model: 'fable', effort: 'xhigh' })
  })
  it('orders tiers cheapest → most capable and efforts low → max', () => {
    expect(TIER_ORDER).toEqual(['light', 'standard', 'deep', 'max'])
    expect([...TIER_ORDER].sort()).toEqual([...ROUTER_TIERS].sort())
    expect(EFFORT_ORDER).toEqual([...CLAUDE_EFFORTS])
  })
  it('keeps the auto-apply floor below the keyword confidence and the cap above it', () => {
    expect(AUTO_APPLY_CONFIDENCE).toBe(0.75)
    expect(MAX_CONFIDENCE).toBeGreaterThan(0.85)
    expect(MAX_CONFIDENCE).toBeLessThanOrEqual(1)
    expect(LONG_PROMPT_STANDARD).toBeLessThan(LONG_PROMPT_DEEP)
    expect(MIN_PROJECT_NAME_LENGTH).toBe(4)
    expect(COUNTED_COMMAND_KINDS).toEqual(['test', 'build', 'lint', 'typecheck'])
  })
  it('pins every ROUTER_LIMITS bound to the spec, and the named constants to it', () => {
    expect(ROUTER_LIMITS).toEqual({
      longPromptStandard: 1200,
      longPromptDeep: 2500,
      minProjectNameLength: 4,
      failuresToEscalate: 2,
      failuresToMax: 4,
      uncertaintyToEscalate: 2,
      mechanicalStreakMin: 3,
      mechanicalPromptChars: 200,
      mechanicalEdits: 2,
      confidenceKeyword: 0.85,
      confidenceLength: 0.6,
      confidenceNone: 0.5,
      confidenceStreakStep: 0.05,
      confidenceMax: 0.95,
      autoApplyConfidence: 0.75
    })
    expect(LONG_PROMPT_STANDARD).toBe(ROUTER_LIMITS.longPromptStandard)
    expect(LONG_PROMPT_DEEP).toBe(ROUTER_LIMITS.longPromptDeep)
    expect(MIN_PROJECT_NAME_LENGTH).toBe(ROUTER_LIMITS.minProjectNameLength)
    expect(MAX_CONFIDENCE).toBe(ROUTER_LIMITS.confidenceMax)
    expect(AUTO_APPLY_CONFIDENCE).toBe(ROUTER_LIMITS.autoApplyConfidence)
  })
})

describe('emptySignals', () => {
  it('is all zeros / false and a fresh object every call', () => {
    const a = emptySignals()
    expect(a).toEqual({
      consecutiveFailures: 0,
      failures: 0,
      passes: 0,
      filesEdited: 0,
      projectsTouched: 0,
      mechanicalStreak: 0,
      uncertaintyHits: 0,
      maxQualityRequested: false,
      riskHits: 0
    })
    expect(emptySignals()).not.toBe(a)
  })
})

describe('keyword classes', () => {
  const classes: [string, readonly string[]][] = [
    ['LIGHT', LIGHT_KEYWORDS],
    ['STANDARD', STANDARD_KEYWORDS],
    ['DEEP', DEEP_KEYWORDS],
    ['MAX', MAX_KEYWORDS],
    ['RISK', RISK_KEYWORDS],
    ['UNCERTAINTY', UNCERTAINTY_KEYWORDS],
    ['CROSS_PROJECT', CROSS_PROJECT_PHRASES],
    ['COMMON_PROJECT_WORDS', COMMON_PROJECT_WORDS]
  ]
  it.each(classes)('%s is a non-empty, lowercase, de-duplicated list', (_name, list) => {
    expect(list.length).toBeGreaterThan(0)
    for (const w of list) {
      expect(w).toBe(w.toLowerCase())
      expect(w.trim()).toBe(w)
      expect(w.length).toBeGreaterThan(0)
    }
    expect(new Set(list).size).toBe(list.length)
  })
  it('keeps every spec word in its class, verbatim (the lists may only grow)', () => {
    const specLight = [
      'rename',
      'typo',
      'bump',
      'docs',
      'documentation',
      'readme',
      'comment',
      'format',
      'lint',
      'copy',
      'label',
      'wording',
      'tweak',
      'chore',
      'boilerplate',
      'css',
      'color',
      'colour',
      'padding',
      'margin',
      'font',
      'spacing',
      'text change',
      'move file',
      'find the',
      'where is',
      'list the',
      'run the tests',
      'run tests',
      'run build',
      'read the logs',
      'look up',
      'what does',
      'show me'
    ]
    const specStandard = [
      'implement',
      'add',
      'feature',
      'fix',
      'bug',
      'integrate',
      'wire',
      'update',
      'endpoint',
      'component',
      'page',
      'form',
      'modal',
      'unit test',
      'tests for'
    ]
    const specDeep = [
      'architecture',
      'architect',
      'redesign',
      'migrate',
      'migration',
      'port',
      'rewrite',
      'novel',
      'complex',
      'concurrency',
      'concurrent',
      'race',
      'deadlock',
      'security',
      'audit',
      'performance',
      'optimize',
      'optimise',
      'hard bug',
      'difficult',
      'flaky',
      'intermittent',
      'across projects',
      'all projects',
      'multi-project',
      'every project',
      'large refactor',
      'big refactor',
      'plan',
      'roadmap',
      'tradeoff',
      'data model',
      'schema'
    ]
    const specMax = [
      'max quality',
      'maximum quality',
      'highest quality',
      'be thorough',
      'ultra',
      'critical',
      'do not get this wrong',
      'production incident',
      'very careful',
      'extremely careful'
    ]
    const specRisk = [
      'delete',
      'drop',
      'remove all',
      'migration',
      'migrate',
      'auth',
      'authentication',
      'payment',
      'payments',
      'stripe',
      'secret',
      'secrets',
      'api key',
      'prod',
      'production',
      'deploy',
      'rm -rf',
      'force push',
      'force-push',
      'wipe',
      'truncate',
      'credentials'
    ]
    const specUncertainty = [
      'still failing',
      'still fails',
      "didn't work",
      'did not work',
      'not working',
      "doesn't work",
      'try again',
      'no luck',
      'not sure',
      'conflicting',
      'keeps failing',
      'keep failing',
      'same error',
      'again'
    ]
    for (const w of specLight) expect(LIGHT_KEYWORDS).toContain(w)
    for (const w of specStandard) expect(STANDARD_KEYWORDS).toContain(w)
    for (const w of specDeep) expect(DEEP_KEYWORDS).toContain(w)
    for (const w of specMax) expect(MAX_KEYWORDS).toContain(w)
    for (const w of specRisk) expect(RISK_KEYWORDS).toContain(w)
    for (const w of specUncertainty) expect(UNCERTAINTY_KEYWORDS).toContain(w)
    for (const w of ['across projects', 'all projects', 'multi-project', 'every project'])
      expect(CROSS_PROJECT_PHRASES).toContain(w)
  })
  it.each(LIGHT_KEYWORDS.map((w) => [w]))('LIGHT "%s" alone classifies light', (w) => {
    expect(classifyPrompt(w).tier).toBe('light')
  })
  it.each(STANDARD_KEYWORDS.map((w) => [w]))('STANDARD "%s" alone classifies standard', (w) => {
    expect(classifyPrompt(w).tier).toBe('standard')
  })
  it.each(DEEP_KEYWORDS.map((w) => [w]))('DEEP "%s" alone classifies deep', (w) => {
    expect(classifyPrompt(w).tier).toBe('deep')
  })
  it.each(MAX_KEYWORDS.map((w) => [w]))('MAX "%s" alone classifies max', (w) => {
    const c = classifyPrompt(w)
    expect(c.tier).toBe('max')
    expect(c.maxQuality).toBe(true)
  })
  it.each(RISK_KEYWORDS.map((w) => [w]))('RISK "%s" flags risk and lifts the prompt to deep', (w) => {
    const c = classifyPrompt(`please ${w} now`)
    expect(c.risk).toBe(true)
    expect(tierRank(c.tier)).toBeGreaterThanOrEqual(tierRank('deep'))
    expect(c.reasons.some((r) => r.startsWith('risk:'))).toBe(true)
  })
  it.each(UNCERTAINTY_KEYWORDS.map((w) => [w]))('UNCERTAINTY "%s" flags uncertainty', (w) => {
    const c = classifyPrompt(`it ${w} here`)
    expect(c.uncertainty).toBe(true)
    expect(c.reasons.some((r) => r.startsWith('uncertainty:'))).toBe(true)
  })
  it.each(CROSS_PROJECT_PHRASES.map((w) => [w]))('CROSS "%s" flags cross-project and is deep', (w) => {
    const c = classifyPrompt(`do it ${w}`)
    expect(c.crossProject).toBe(true)
    expect(c.tier).toBe('deep')
    expect(c.reasons.some((r) => r.startsWith('cross-project:'))).toBe(true)
  })
})

describe('classifyPrompt', () => {
  it('is standard with no reasons for empty, blank, absent or garbage input', () => {
    const blank = {
      tier: 'standard',
      reasons: [],
      risk: false,
      uncertainty: false,
      maxQuality: false,
      crossProject: false
    }
    expect(classifyPrompt(undefined)).toEqual(blank)
    expect(classifyPrompt('')).toEqual(blank)
    expect(classifyPrompt('   \n\t ')).toEqual(blank)
    expect(classifyPrompt(42 as unknown as string)).toEqual(blank)
    expect(classifyPrompt(null as unknown as string)).toEqual(blank)
    expect(classifyPrompt('hello', 'nope' as unknown as Project[]).crossProject).toBe(false)
  })
  it('defaults to standard when nothing matches', () => {
    const c = classifyPrompt('make the thing better please')
    expect(c.tier).toBe('standard')
    expect(c.reasons).toEqual([])
  })
  it('is case-insensitive and whole-word', () => {
    expect(classifyPrompt('FIX THE TYPO').tier).toBe('light')
    expect(classifyPrompt('Redesign It').tier).toBe('deep')
    // substrings never match: report ≠ port, eslint ≠ lint, address ≠ add, against ≠ again
    expect(classifyPrompt('write a report').tier).toBe('standard')
    expect(classifyPrompt('run eslint on it').tier).toBe('standard')
    expect(classifyPrompt('the address field').tier).toBe('standard')
    expect(classifyPrompt('check it against the list').uncertainty).toBe(false)
    expect(classifyPrompt('the author field').risk).toBe(false)
    expect(classifyPrompt('the product page').risk).toBe(false)
  })
  it('accepts simple inflections of the last word', () => {
    expect(classifyPrompt('several typos').tier).toBe('light')
    expect(classifyPrompt('I renamed it').tier).toBe('light')
    expect(classifyPrompt('renaming the folder').tier).toBe('light')
    expect(classifyPrompt('the colors are off').tier).toBe('light')
    expect(classifyPrompt('we are migrating the db').risk).toBe(true)
    expect(classifyPrompt('it was deleted').risk).toBe(true)
    expect(classifyPrompt('dropped the table').risk).toBe(true) // the bare spec word inflects
    expect(classifyPrompt('dropping the index').risk).toBe(true)
    expect(classifyPrompt('drop the table').risk).toBe(true)
  })
  it('treats spaces, hyphens and underscores inside a phrase as interchangeable', () => {
    expect(classifyPrompt('a multi project change').crossProject).toBe(true)
    expect(classifyPrompt('a multi_project change').crossProject).toBe(true)
    expect(classifyPrompt('never force-push').risk).toBe(true)
    expect(classifyPrompt('ran rm -rf on it').risk).toBe(true)
    expect(classifyPrompt('the api_key leaked').risk).toBe(true)
    expect(classifyPrompt('add a unit-test').tier).toBe('standard')
  })
  it('normalizes curly apostrophes', () => {
    expect(classifyPrompt('that didn\u2019t work').uncertainty).toBe(true)
    expect(classifyPrompt('don\u2019t get this wrong').tier).toBe('max')
  })
  it('avoids the classic false positives', () => {
    expect(classifyPrompt('run the dev server on port 3000').tier).toBe('standard')
    expect(classifyPrompt('run the dev server on port 3000').reasons).toEqual([])
    expect(classifyPrompt('add drag and drop to the list').risk).toBe(false)
    expect(classifyPrompt('build a race track for the game').tier).toBe('standard')
    expect(classifyPrompt('port the game to Unreal').tier).toBe('deep')
    expect(classifyPrompt('fix the race condition').tier).toBe('deep')
  })
  it('sense guards: the bare spec words "port", "race" and "drop" route in their spec sense only', () => {
    // "port" the verb (deep) vs the network noun
    for (const p of [
      'port',
      'port Squishy Smash to Unreal',
      'port my roblox game over to hytopia',
      'I ported it last week',
      'python port of the tool',
      'the port to Unreal is half done'
    ])
      expect(classifyPrompt(p).tier, p).toBe('deep')
    for (const p of [
      'which port does it listen on',
      'the port is already in use',
      'change the port to 8080',
      'port: 8080 is busy',
      'PORT=3000 npm start',
      'open ports 80 and 443',
      'connect to port 3000',
      'the usb port',
      'listens on port 44711'
    ]) {
      expect(classifyPrompt(p).tier, p).toBe('standard')
      expect(classifyPrompt(p).reasons, p).toEqual([])
    }
    // "race" the bug (deep) vs the game/sport noun
    for (const p of [
      'race',
      'there is a race between the two writes',
      'fix the race in the loader',
      'races with the other fetch',
      'a data race in the worker'
    ])
      expect(classifyPrompt(p).tier, p).toBe('deep')
    for (const p of [
      'add a racing minigame',
      'start the race when everyone is ready',
      'the first race',
      'race results screen',
      'kart race'
    ])
      expect(
        classifyPrompt(p).reasons.some((r) => r.startsWith('deep:')),
        p
      ).toBe(false)
    // "drop" the database verb (risk) vs the UI / media senses
    for (const p of [
      'drop',
      'drop the users table',
      'drop the old columns',
      'dropping the index',
      'drop table users',
      'please drop now'
    ])
      expect(classifyPrompt(p).risk, p).toBe(true)
    for (const p of [
      'add drag and drop to the list',
      'drag-and-drop the files',
      'drag & drop support',
      'drag n drop',
      'the drop-down menu',
      'dropdown menu',
      'the frame drops when many players join',
      'dropped frames on mobile',
      'drop me a note',
      'drop support for node 18',
      'loot drop rates',
      'item drops'
    ])
      expect(classifyPrompt(p).risk, p).toBe(false)
    expect(classifyPrompt('drop in a comment').tier).toBe('light')
  })
  it('precedence: MAX > DEEP > LIGHT > STANDARD — a light word never lowers a deep ask', () => {
    expect(classifyPrompt('rename things as part of the redesign').tier).toBe('deep')
    expect(classifyPrompt('fix the typo').tier).toBe('light')
    expect(classifyPrompt('be thorough: rename the typo in the css').tier).toBe('max')
    expect(classifyPrompt('a critical redesign').tier).toBe('max')
    expect(classifyPrompt('add a form').tier).toBe('standard')
  })
  it('long prompts: >1200 chars is at least standard, >2500 is at least deep', () => {
    const light = 'fix the typo '
    const atStandard = light.repeat(Math.ceil((LONG_PROMPT_STANDARD + 1) / light.length))
    expect(atStandard.length).toBeGreaterThan(LONG_PROMPT_STANDARD)
    expect(atStandard.length).toBeLessThanOrEqual(LONG_PROMPT_DEEP)
    const c1 = classifyPrompt(atStandard)
    expect(c1.tier).toBe('standard')
    expect(c1.reasons).toContain(`long prompt: ${atStandard.trim().length} chars`)

    const atDeep = light.repeat(Math.ceil((LONG_PROMPT_DEEP + 1) / light.length))
    expect(classifyPrompt(atDeep).tier).toBe('deep')

    // exactly the threshold does not trigger; a long max ask stays max
    expect(classifyPrompt('x'.repeat(LONG_PROMPT_STANDARD)).tier).toBe('standard')
    expect(classifyPrompt('x'.repeat(LONG_PROMPT_STANDARD)).reasons).toEqual([])
    expect(classifyPrompt(`maximum quality ${'x'.repeat(LONG_PROMPT_DEEP + 1)}`).tier).toBe('max')
  })
  it('lists reasons as class labels with the words that fired', () => {
    const c = classifyPrompt('fix the typo in README')
    expect(c.tier).toBe('light')
    expect(c.reasons).toEqual(['light: typo, readme', 'standard: fix'])
    const d = classifyPrompt('delete the old auth tables and migrate payments to stripe')
    expect(d.reasons).toContain('deep: migrate')
    expect(d.reasons.find((r) => r.startsWith('risk:'))).toBe(
      'risk: delete, auth, migrate, payments, +1 more'
    )
  })
  it('reports an overlapping phrase once ("try again" is not also "again")', () => {
    const c = classifyPrompt('please try again')
    expect(c.reasons).toEqual(['uncertainty: try again'])
  })
  it('flags cross-project by two registered names, not by one', () => {
    const projects = [proj('Income Kit'), proj('Squishy Smash')]
    const both = classifyPrompt('reuse the trailer script from Income Kit in Squishy Smash', projects)
    expect(both.crossProject).toBe(true)
    expect(both.tier).toBe('deep')
    expect(both.reasons).toContain('cross-project: Income Kit, Squishy Smash')
    const one = classifyPrompt('polish the Income Kit landing wording', projects)
    expect(one.crossProject).toBe(false)
    expect(one.tier).toBe('light')
    expect(classifyPrompt('reuse it from Income Kit in Squishy Smash').crossProject).toBe(false)
  })
})

describe('mentionedProjects', () => {
  const income = proj('Income Kit', { path: 'C:\\Users\\chris\\Income-Kit' })
  const squishy = proj('Squishy Smash', { path: 'C:\\Users\\chris\\squishy-smash' })
  const everlight = proj('Everlight', { path: 'C:\\Users\\chris\\Fable-5.1-one-shot' })
  const registry = [income, squishy, everlight]

  it('finds names whole-word and case-insensitively, in registry order', () => {
    expect(mentionedProjects('bring squishy smash up to the INCOME KIT standard', registry)).toEqual([
      income,
      squishy
    ])
    expect(mentionedProjects('nothing here', registry)).toEqual([])
    expect(mentionedProjects('the Income Kitchen app', registry)).toEqual([])
    expect(mentionedProjects('MyIncome Kit', registry)).toEqual([])
  })
  it('treats spaces, hyphens, underscores and dots in a name as interchangeable', () => {
    expect(mentionedProjects('see income-kit and squishy_smash', registry)).toEqual([income, squishy])
    expect(mentionedProjects('see IncomeKit', registry)).toEqual([income])
    const week = proj('Fable-5-1-week')
    expect(mentionedProjects('the Fable 5.1 week repo', [week])).toEqual([week])
    expect(mentionedProjects('the fable-5-1-week repo', [week])).toEqual([week])
  })
  it('ignores short names and names that are common words', () => {
    const hub = proj('Hub')
    const test = proj('Test')
    const demo = proj('demo')
    expect(mentionedProjects('run the test on the hub demo', [hub, test, demo])).toEqual([])
    expect(mentionedProjects('12345 please', [proj('12345')])).toEqual([])
    for (const w of COMMON_PROJECT_WORDS) expect(mentionedProjects(`the ${w} thing`, [proj(w)])).toEqual([])
  })
  it('lets the longest name claim its span first', () => {
    const pro = proj('Income Kit Pro')
    expect(mentionedProjects('work on Income Kit Pro', [income, pro])).toEqual([pro])
    expect(mentionedProjects('work on Income Kit Pro and Income Kit', [income, pro])).toEqual([income, pro])
  })
  it('counts a registered folder pasted into the prompt, with either slash style', () => {
    expect(mentionedProjects('look at C:/Users/chris/Fable-5.1-one-shot/tools/render.ts', registry)).toEqual([
      everlight
    ])
    expect(mentionedProjects('look at c:\\users\\chris\\fable-5.1-one-shot', registry)).toEqual([everlight])
    expect(mentionedProjects('look at "C:\\Users\\chris\\Fable-5.1-one-shot\\" now', registry)).toEqual([
      everlight
    ])
    // a sibling folder with the same prefix is not this project
    expect(mentionedProjects('C:\\Users\\chris\\Fable-5.1-one-shot-old\\x.ts', registry)).toEqual([])
    expect(mentionedProjects('C:\\Users\\chris\\Fable-5.1-one-shot.bak', registry)).toEqual([])
  })
  it('never double-counts a project hit by both name and path', () => {
    expect(mentionedProjects('Income Kit at C:\\Users\\chris\\Income-Kit', registry)).toEqual([income])
  })
  it('survives garbage: missing names/paths, non-string text, non-array registry', () => {
    const broken = [{ id: 'x' } as Project, null as unknown as Project, { name: 7 } as unknown as Project]
    expect(mentionedProjects('anything', broken)).toEqual([])
    expect(mentionedProjects('', registry)).toEqual([])
    expect(mentionedProjects(undefined as unknown as string, registry)).toEqual([])
    expect(mentionedProjects('x', undefined as unknown as Project[])).toEqual([])
    expect(mentionedProjects('Income Kit', [proj('   ')])).toEqual([])
  })
})

describe('modelAlias', () => {
  it('maps canonical ids and display names to the Hub alias', () => {
    expect(modelAlias('claude-opus-5')).toBe('opus')
    expect(modelAlias('opus')).toBe('opus')
    expect(modelAlias('Opus 4.7')).toBe('opus')
    expect(modelAlias('claude-haiku-4-5')).toBe('haiku')
    expect(modelAlias('Haiku')).toBe('haiku')
    expect(modelAlias('claude-sonnet-4-5-20250929')).toBe('sonnet')
    expect(modelAlias('claude-fable-5-1')).toBe('fable')
    expect(modelAlias('Fable 5.1')).toBe('fable')
  })
  it('is undefined for unknown or garbage input', () => {
    expect(modelAlias('gpt')).toBeUndefined()
    expect(modelAlias('')).toBeUndefined()
    expect(modelAlias(undefined)).toBeUndefined()
    expect(modelAlias(3 as unknown as string)).toBeUndefined()
  })
})

describe('effortAlias', () => {
  it('accepts the allowlisted levels in any case, nothing else', () => {
    expect(effortAlias('high')).toBe('high')
    expect(effortAlias(' XHigh ')).toBe('xhigh')
    expect(effortAlias('turbo')).toBeUndefined()
    expect(effortAlias(undefined)).toBeUndefined()
    expect(effortAlias(1 as unknown as string)).toBeUndefined()
  })
})

describe('tierOf', () => {
  it('maps models to tiers (acceptance 11)', () => {
    expect(tierOf({ model: 'claude-haiku-4-5' })).toBe('light')
    expect(tierOf({ model: 'fable' })).toBe('max')
    expect(tierOf({ model: 'claude-opus-5', effort: 'xhigh' })).toBe('max')
    expect(tierOf({ model: 'gpt' })).toBeUndefined()
  })
  it('lets effort nudge only opus, only upward', () => {
    expect(tierOf({ model: 'claude-opus-5' })).toBe('deep')
    expect(tierOf({ model: 'claude-opus-5', effort: 'high' })).toBe('deep')
    expect(tierOf({ model: 'claude-opus-5', effort: 'low' })).toBe('deep')
    expect(tierOf({ model: 'claude-opus-5', effort: 'max' })).toBe('max')
    expect(tierOf({ model: 'claude-opus-5', effort: 'MAX' })).toBe('max')
    expect(tierOf({ model: 'sonnet', effort: 'low' })).toBe('standard')
    expect(tierOf({ model: 'sonnet', effort: 'max' })).toBe('standard')
    expect(tierOf({ model: 'haiku', effort: 'xhigh' })).toBe('light')
    expect(tierOf({ model: 'fable', effort: 'low' })).toBe('max')
  })
  it('is undefined when the model is unknown or absent', () => {
    expect(tierOf(undefined)).toBeUndefined()
    expect(tierOf({})).toBeUndefined()
    expect(tierOf({ effort: 'high' })).toBeUndefined()
    expect(tierOf({ model: 'claude-opus-5', effort: 'bogus' })).toBe('deep')
  })
})

describe('recommend — acceptance examples', () => {
  it('1. a typo fix on an opus/high session de-escalates to haiku/low', () => {
    const r = recommend({
      prompt: 'fix the typo in README',
      signals: emptySignals(),
      current: { model: 'claude-opus-5', effort: 'high' },
      now: 1
    })
    expect(r.tier).toBe('light')
    expect(r.target).toEqual({ model: 'haiku', effort: 'low' })
    expect(r.direction).toBe('deescalate')
    expect(r.changes).toBe(true)
    expect(r.confidence).toBeGreaterThanOrEqual(0.85)
    expect(r.reason).toBe('simple wording/CSS change (typo, readme)')
    expect(r.signals).toEqual(['light: typo, readme', 'standard: fix'])
    expect(r.at).toBe(1)
  })
  it('2. a CSS colour change is light', () => {
    expect(rec('change the button color to blue in the css').tier).toBe('light')
  })
  it('3. a settings page with a form is standard → sonnet/medium', () => {
    const r = rec('add a settings page with a form that saves to the json store')
    expect(r.tier).toBe('standard')
    expect(r.target).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(r.reason).toBe('ordinary feature work (add, page, form)')
  })
  it('4. a store-layer redesign with a multi-project migration is deep', () => {
    const r = rec('redesign the store layer to support a multi-project migration')
    expect(r.tier).toBe('deep')
    expect(r.target).toEqual({ model: 'opus', effort: 'high' })
  })
  it('5. repeated failures plus repeated uncertainty on sonnet escalate to max', () => {
    const r = recommend({
      prompt: 'the tests keep failing, not sure why',
      signals: { ...emptySignals(), consecutiveFailures: 3, uncertaintyHits: 2, failures: 3 },
      current: { model: 'sonnet', effort: 'medium' },
      now: 1
    })
    expect(tierRank(r.tier)).toBeGreaterThanOrEqual(tierRank('deep'))
    expect(r.tier).toBe('max')
    expect(r.direction).toBe('escalate')
    expect(r.changes).toBe(true)
    expect(r.reason).toBe('3 consecutive test failures — escalating')
    expect(r.signals).toContain('failures: 3')
    expect(r.signals).toContain('uncertainty hits: 2')
    expect(r.signals).toContain('uncertainty: keep failing, not sure')
  })
  it('6. an explicit maximum-quality ask is max → fable/xhigh', () => {
    const r = rec('I want maximum quality on this, take your time')
    expect(r.tier).toBe('max')
    expect(r.target).toEqual({ model: 'fable', effort: 'xhigh' })
    expect(r.reason).toBe('you asked for maximum quality')
  })
  it('7. deleting auth tables and migrating payments is at least deep with a risk label', () => {
    const r = rec('delete the old auth tables and migrate payments to stripe')
    expect(tierRank(r.tier)).toBeGreaterThanOrEqual(tierRank('deep'))
    expect(r.signals.some((s) => s.startsWith('risk:'))).toBe(true)
    expect(r.reason).toBe('risky change (delete, auth, migrate) — use a strong model')
  })
  it('8. naming two registered projects is cross-project → deep', () => {
    const projects = [proj('Income Kit'), proj('Squishy Smash')]
    const r = rec('reuse the trailer script from Income Kit in Squishy Smash', { projects })
    expect(r.tier).toBe('deep')
    expect(r.target).toEqual({ model: 'opus', effort: 'high' })
    expect(r.signals).toContain('cross-project: Income Kit, Squishy Smash')
    expect(r.reason).toBe('cross-project work (Income Kit, Squishy Smash)')
    // verbatim: bare name-only casts, no ids
    const casts = [{ name: 'Income Kit' }, { name: 'Squishy Smash' }] as Project[]
    const c = classifyPrompt('reuse the trailer script from Income Kit in Squishy Smash', casts)
    expect(c.crossProject).toBe(true)
    expect(c.tier).toBe('deep')
    expect(rec('ship the Income Kit fix to Squishy Smash too', { projects: casts }).tier).toBe('deep')
  })
  it('9. a light prompt right after a failure holds at the current tier', () => {
    const r = recommend({
      prompt: 'fix the typo in README',
      signals: { ...emptySignals(), consecutiveFailures: 1, failures: 1 },
      current: { model: 'claude-opus-5', effort: 'high' },
      now: 1
    })
    expect(r.tier).toBe('deep')
    expect(r.direction).toBe('hold')
    expect(r.reason).toMatch(/holding/)
    expect(r.reason).toBe('recent failures — holding')
    expect(r.target).toEqual({ model: 'opus', effort: 'high' })
    expect(r.changes).toBe(false)
    expect(r.signals).toContain('holding: recent failures')
    expect(r.signals).toContain('failures: 1')
  })
  it('10. no prompt and no known session is a low-confidence standard hold', () => {
    const r = recommend({ signals: emptySignals(), now: 7 })
    expect(r.tier).toBe('standard')
    expect(r.target).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(r.confidence).toBe(0.5)
    expect(r.changes).toBe(false)
    expect(r.direction).toBe('hold')
    expect(r.reason).toBe('no task text yet')
    expect(r.signals).toEqual([])
    expect(r.at).toBe(7)
  })
})

describe('recommend — escalation rules', () => {
  it('sticky maxQualityRequested forces max even without a prompt', () => {
    const r = recommend({ signals: { ...emptySignals(), maxQualityRequested: true }, now: 1 })
    expect(r.tier).toBe('max')
    expect(r.reason).toBe('you asked for maximum quality')
    expect(r.signals).toEqual(['max quality requested'])
    expect(r.confidence).toBe(0.85)
  })
  it('projectsTouched > 1 lifts to deep', () => {
    const r = recommend({
      prompt: 'fix the typo',
      signals: { ...emptySignals(), projectsTouched: 2 },
      now: 1
    })
    expect(r.tier).toBe('deep')
    expect(r.signals).toContain('projects touched: 2')
    expect(r.reason).toBe('edits already span 2 projects')
    expect(
      recommend({ prompt: 'fix the typo', signals: { ...emptySignals(), projectsTouched: 1 }, now: 1 }).tier
    ).toBe('light')
  })
  it('consecutiveFailures: 1 changes nothing, 2–3 go one tier up, 4+ jump to max', () => {
    const at = (n: number): RouterRecommendation =>
      recommend({ prompt: 'add a form', signals: { ...emptySignals(), consecutiveFailures: n }, now: 1 })
    expect(at(0).tier).toBe('standard')
    expect(at(1).tier).toBe('standard')
    expect(at(2).tier).toBe('deep')
    expect(at(2).reason).toBe('2 consecutive test failures — escalating')
    expect(at(3).tier).toBe('deep')
    expect(at(4).tier).toBe('max')
    expect(at(9).tier).toBe('max')
    expect(at(4).reason).toBe('4 consecutive test failures — escalating')
  })
  it('uncertaintyHits ≥ 2 goes one tier up; escalations stack but never exceed max', () => {
    const base = { prompt: 'fix the typo', now: 1 }
    expect(recommend({ ...base, signals: { ...emptySignals(), uncertaintyHits: 1 } }).tier).toBe('light')
    const u = recommend({ ...base, signals: { ...emptySignals(), uncertaintyHits: 2 } })
    expect(u.tier).toBe('standard')
    expect(u.reason).toBe('2 unsure/retry prompts — escalating')
    expect(u.signals).toContain('uncertainty hits: 2')
    const both = recommend({
      ...base,
      signals: { ...emptySignals(), uncertaintyHits: 2, consecutiveFailures: 2 }
    })
    expect(both.tier).toBe('deep')
    const capped = recommend({
      prompt: 'redesign the architecture',
      signals: { ...emptySignals(), uncertaintyHits: 5, consecutiveFailures: 3 },
      now: 1
    })
    expect(capped.tier).toBe('max')
    expect(capped.target).toEqual(ROUTER_TIER_TARGETS.max)
  })
  it('the failure hold compares the escalated result, so light + 2 failures still holds under deep', () => {
    const r = recommend({
      prompt: 'fix the typo',
      signals: { ...emptySignals(), consecutiveFailures: 2 },
      current: { model: 'opus', effort: 'high' },
      now: 1
    })
    expect(r.tier).toBe('deep')
    expect(r.direction).toBe('hold')
    expect(r.reason).toBe('recent failures — holding')
  })
  it('a hold under an unknown effort falls back to the tier target without demanding a switch', () => {
    const r = recommend({
      prompt: 'fix the typo',
      signals: { ...emptySignals(), consecutiveFailures: 1 },
      current: { model: 'claude-opus-5' },
      now: 1
    })
    expect(r.tier).toBe('deep')
    expect(r.target).toEqual(ROUTER_TIER_TARGETS.deep)
    expect(r.changes).toBe(false)
  })
  it('a hold under opus/xhigh keeps that pair rather than asking for fable', () => {
    const r = recommend({
      prompt: 'fix the typo',
      signals: { ...emptySignals(), consecutiveFailures: 1 },
      current: { model: 'claude-opus-5', effort: 'xhigh' },
      now: 1
    })
    expect(r.tier).toBe('max')
    expect(r.target).toEqual({ model: 'opus', effort: 'xhigh' })
    expect(r.changes).toBe(false)
    expect(r.direction).toBe('hold')
  })
  it('never holds when the prompt tier is at or above the current tier', () => {
    const r = recommend({
      prompt: 'redesign the architecture',
      signals: { ...emptySignals(), consecutiveFailures: 1 },
      current: { model: 'sonnet', effort: 'medium' },
      now: 1
    })
    expect(r.tier).toBe('deep')
    expect(r.direction).toBe('escalate')
    expect(r.reason).toBe('architecture-level change (redesign, architecture)')
  })
  it('a clearly light prompt on a clean expensive session steps down at once (Test D)', () => {
    const r = recommend({
      prompt: 'bump the version in the readme',
      signals: emptySignals(),
      current: { model: 'fable', effort: 'xhigh' },
      now: 1
    })
    expect(r.tier).toBe('light')
    expect(r.direction).toBe('deescalate')
    expect(r.changes).toBe(true)
  })
  it('risk in the prompt wins over a light word and names the risk', () => {
    const r = rec('rename the payment table')
    expect(r.tier).toBe('deep')
    expect(r.reason).toBe('risky change (payment) — use a strong model')
    expect(r.signals).toEqual(['light: rename', 'risk: payment'])
  })
  it('a cross-project phrase without names reads as cross-project work', () => {
    const r = rec('apply this across all projects')
    expect(r.tier).toBe('deep')
    expect(r.reason).toBe('cross-project work (across all projects)')
  })
})

describe('recommend — confidence', () => {
  it('is 0.85 for keyword hits, 0.6 for length only, 0.5 for nothing', () => {
    expect(rec('fix the typo').confidence).toBe(0.85)
    expect(rec('add a form').confidence).toBe(0.85)
    expect(rec('redesign it').confidence).toBe(0.85)
    expect(rec('make it nicer somehow').confidence).toBe(0.5)
    const long = rec('lorem ipsum '.repeat(120))
    expect(long.tier).toBe('standard')
    expect(long.confidence).toBe(0.6)
    expect(long.reason).toBe('long, multi-part request')
    const veryLong = rec('lorem ipsum '.repeat(250))
    expect(veryLong.tier).toBe('deep')
    expect(veryLong.confidence).toBe(0.6)
  })
  it('a long prompt with keyword hits is still 0.85, and a light prompt over 1200 chars becomes standard', () => {
    const r = rec('fix the typo '.repeat(100))
    expect(r.tier).toBe('standard')
    expect(r.confidence).toBe(0.85)
    expect(r.reason).toBe('long, multi-part request')
    expect(r.signals.some((s) => s.startsWith('long prompt: '))).toBe(true)
  })
  it('signals alone (no prompt) are confident', () => {
    expect(recommend({ signals: { ...emptySignals(), consecutiveFailures: 2 }, now: 1 }).confidence).toBe(
      0.85
    )
    expect(recommend({ signals: { ...emptySignals(), projectsTouched: 3 }, now: 1 }).confidence).toBe(0.85)
  })
  it('a lone uncertainty phrase does not raise confidence on its own', () => {
    const r = rec('not sure about this one')
    expect(r.tier).toBe('standard')
    expect(r.confidence).toBe(0.5)
    expect(r.signals).toEqual(['uncertainty: not sure'])
  })
  it('a mechanical streak with no failures adds 0.05 per step from 3, capped at 0.95', () => {
    const at = (streak: number, cf = 0): RouterRecommendation =>
      recommend({
        prompt: 'fix the typo',
        signals: { ...emptySignals(), mechanicalStreak: streak, consecutiveFailures: cf },
        now: 1
      })
    expect(at(2).confidence).toBe(0.85)
    expect(at(3).confidence).toBe(0.9)
    expect(at(3).signals).toContain('mechanical streak: 3')
    expect(at(4).confidence).toBe(0.95)
    expect(at(10).confidence).toBe(MAX_CONFIDENCE)
    // a red check disables the bonus; a deep prompt never gets it
    expect(at(5, 1).confidence).toBe(0.85)
    expect(
      recommend({ prompt: 'redesign it', signals: { ...emptySignals(), mechanicalStreak: 5 }, now: 1 })
        .confidence
    ).toBe(0.85)
  })
  it('never exceeds MAX_CONFIDENCE', () => {
    const r = recommend({
      prompt: 'fix the typo',
      signals: { ...emptySignals(), mechanicalStreak: 50 },
      now: 1
    })
    expect(r.confidence).toBeLessThanOrEqual(MAX_CONFIDENCE)
  })
})

describe('recommend — direction and changes', () => {
  it('compares the tier against the current session', () => {
    const cur = { model: 'sonnet', effort: 'medium' }
    expect(rec('redesign it', { current: cur }).direction).toBe('escalate')
    expect(rec('fix the typo', { current: cur }).direction).toBe('deescalate')
    expect(rec('add a form', { current: cur }).direction).toBe('hold')
    expect(rec('add a form', { current: cur }).changes).toBe(false)
  })
  it('is a no-change hold when the current model is unknown, whatever the effort says', () => {
    const r = rec('redesign it', { current: { model: 'gpt-5', effort: 'low' } })
    expect(r.direction).toBe('hold')
    expect(r.changes).toBe(false)
    expect(rec('redesign it', { current: {} }).changes).toBe(false)
  })
  it('flags an effort-only difference within the same tier', () => {
    const r = rec('redesign it', { current: { model: 'claude-opus-5', effort: 'medium' } })
    expect(r.direction).toBe('hold')
    expect(r.changes).toBe(true)
    expect(r.target).toEqual({ model: 'opus', effort: 'high' })
  })
  it('ignores an unknown current effort when the model already matches', () => {
    const r = rec('redesign it', { current: { model: 'claude-opus-5', effort: 'bogus' } })
    expect(r.changes).toBe(false)
    expect(rec('redesign it', { current: { model: 'claude-opus-5' } }).changes).toBe(false)
  })
  it('uses the model alias for the comparison (canonical id vs alias)', () => {
    expect(rec('fix the typo', { current: { model: 'claude-haiku-4-5', effort: 'low' } }).changes).toBe(false)
    expect(rec('fix the typo', { current: { model: 'claude-haiku-4-5', effort: 'high' } }).changes).toBe(true)
  })
})

describe('recommend — robustness', () => {
  it('tolerates missing, partial or garbage signals', () => {
    const r = recommend({ prompt: 'fix the typo', signals: undefined as unknown as RouterSignals, now: 1 })
    expect(r.tier).toBe('light')
    const g = recommend({
      prompt: 'fix the typo',
      signals: {
        consecutiveFailures: -3,
        uncertaintyHits: NaN,
        maxQualityRequested: 'yes'
      } as unknown as RouterSignals,
      now: 1
    })
    expect(g.tier).toBe('light')
    expect(g.signals).toEqual(['light: typo', 'standard: fix'])
  })
  it('falls back to a real timestamp when now is not a number', () => {
    const before = Date.now()
    const r = recommend({ prompt: 'x', signals: emptySignals(), now: NaN })
    expect(r.at).toBeGreaterThanOrEqual(before)
  })
  it('only ever recommends allowlisted models and efforts', () => {
    const prompts = ['fix the typo', 'add a form', 'redesign it', 'maximum quality', undefined]
    for (const p of prompts) {
      for (const cf of [0, 1, 2, 4]) {
        const r = recommend({
          prompt: p,
          signals: { ...emptySignals(), consecutiveFailures: cf },
          current: { model: 'claude-opus-5', effort: 'xhigh' },
          now: 1
        })
        expect(CLAUDE_MODELS).toContain(r.target.model)
        expect(CLAUDE_EFFORTS).toContain(r.target.effort)
        expect(ROUTER_TIERS).toContain(r.tier)
        expect(r.reason.endsWith('.')).toBe(false)
      }
    }
  })
})

describe('formatRecommendation', () => {
  it('renders "Suggested: model / effort — reason"', () => {
    const r = rec('fix the typo in README')
    expect(formatRecommendation(r)).toBe('Suggested: haiku / low — simple wording/CSS change (typo, readme)')
    expect(formatRecommendation(rec('add a settings page with a form'))).toBe(
      'Suggested: sonnet / medium — ordinary feature work (add, page, form)'
    )
  })
})

describe('slashCommandsFor', () => {
  it('emits the documented /model and /effort commands (acceptance 12)', () => {
    expect(slashCommandsFor({ model: 'sonnet', effort: 'low' })).toEqual(['/model sonnet', '/effort low'])
    for (const tier of ROUTER_TIERS) {
      const t = ROUTER_TIER_TARGETS[tier]
      expect(slashCommandsFor(t)).toEqual([`/model ${t.model}`, `/effort ${t.effort}`])
    }
  })
  it('drops anything that is not an allowlisted alias or level — nothing else reaches the PTY', () => {
    expect(slashCommandsFor({ model: 'claude-opus-5; rm -rf', effort: 'low' } as never)).toEqual([
      '/effort low'
    ])
    expect(slashCommandsFor({ model: 'opus', effort: 'turbo\n' } as never)).toEqual(['/model opus'])
    expect(slashCommandsFor({} as never)).toEqual([])
    expect(slashCommandsFor(undefined as never)).toEqual([])
  })
})

describe('signalsAfterPrompt', () => {
  it('bumps uncertainty and risk counters and makes max-quality sticky', () => {
    let s = signalsAfterPrompt(emptySignals(), 'it still fails, try again')
    expect(s.uncertaintyHits).toBe(1) // one prompt = one hit, however many phrases
    expect(s.riskHits).toBe(0)
    expect(s.maxQualityRequested).toBe(false)
    s = signalsAfterPrompt(s, 'delete the prod secrets')
    expect(s.riskHits).toBe(1)
    expect(s.uncertaintyHits).toBe(1)
    s = signalsAfterPrompt(s, 'be thorough here')
    expect(s.maxQualityRequested).toBe(true)
    s = signalsAfterPrompt(s, 'fix the typo')
    expect(s.maxQualityRequested).toBe(true)
    expect(s).toMatchObject({ uncertaintyHits: 1, riskHits: 1 })
  })
  it('leaves the other counters alone and returns a new object', () => {
    const before = { ...emptySignals(), consecutiveFailures: 2, mechanicalStreak: 4 }
    const after = signalsAfterPrompt(before, 'not sure')
    expect(after).not.toBe(before)
    expect(after.consecutiveFailures).toBe(2)
    expect(after.mechanicalStreak).toBe(4)
    expect(before.uncertaintyHits).toBe(0)
  })
  it('handles empty or garbage prompts and signals', () => {
    expect(signalsAfterPrompt(emptySignals(), '')).toEqual(emptySignals())
    expect(signalsAfterPrompt(emptySignals(), undefined as unknown as string)).toEqual(emptySignals())
    expect(signalsAfterPrompt(undefined as unknown as RouterSignals, 'not sure')).toEqual({
      ...emptySignals(),
      uncertaintyHits: 1
    })
  })
})

describe('signalsAfterCommand', () => {
  it('counts failures, resets the streak on a pass, ignores unknown outcomes (acceptance 13)', () => {
    let s = signalsAfterCommand(emptySignals(), 'test', 'fail')
    s = signalsAfterCommand(s, 'build', 'fail')
    expect(s).toMatchObject({ failures: 2, consecutiveFailures: 2, passes: 0 })
    s = signalsAfterCommand(s, 'typecheck', 'unknown')
    expect(s).toMatchObject({ failures: 2, consecutiveFailures: 2, passes: 0 })
    s = signalsAfterCommand(s, 'lint', 'pass')
    expect(s).toMatchObject({ failures: 2, consecutiveFailures: 0, passes: 1 })
    s = signalsAfterCommand(s, 'test', 'fail')
    expect(s).toMatchObject({ failures: 3, consecutiveFailures: 1, passes: 1 })
  })
  it('ignores git / install / other kinds entirely', () => {
    const before = { ...emptySignals(), consecutiveFailures: 2, failures: 2 }
    for (const kind of ['git', 'install', 'other'] as CommandKind[]) {
      expect(signalsAfterCommand(before, kind, 'fail')).toEqual(before)
      expect(signalsAfterCommand(before, kind, 'pass')).toEqual(before)
    }
    expect(signalsAfterCommand(before, 'bogus' as CommandKind, 'fail')).toEqual(before)
  })
  it('does not mutate its input', () => {
    const before = emptySignals()
    signalsAfterCommand(before, 'test', 'fail')
    expect(before.failures).toBe(0)
  })
})

describe('signalsAfterTurn', () => {
  it('counts mechanical turns and resets on a non-mechanical one (acceptance 14)', () => {
    const mech = { promptLength: 40, editsThisTurn: 1, failuresThisTurn: 0 }
    let s = signalsAfterTurn(emptySignals(), mech)
    s = signalsAfterTurn(s, mech)
    s = signalsAfterTurn(s, mech)
    expect(s.mechanicalStreak).toBe(3)
    s = signalsAfterTurn(s, { ...mech, failuresThisTurn: 1 })
    expect(s.mechanicalStreak).toBe(0)
  })
  it('uses the exact bounds: ≤200 chars, ≤2 edits, 0 failures', () => {
    const at = (t: { promptLength: number; editsThisTurn: number; failuresThisTurn: number }): number =>
      signalsAfterTurn({ ...emptySignals(), mechanicalStreak: 1 }, t).mechanicalStreak
    expect(at({ promptLength: 200, editsThisTurn: 2, failuresThisTurn: 0 })).toBe(2)
    expect(at({ promptLength: 201, editsThisTurn: 2, failuresThisTurn: 0 })).toBe(0)
    expect(at({ promptLength: 200, editsThisTurn: 3, failuresThisTurn: 0 })).toBe(0)
    expect(at({ promptLength: 0, editsThisTurn: 0, failuresThisTurn: 1 })).toBe(0)
  })
  it('treats garbage turn data as a mechanical no-op turn', () => {
    expect(signalsAfterTurn(emptySignals(), undefined as never).mechanicalStreak).toBe(1)
    expect(
      signalsAfterTurn(emptySignals(), { promptLength: NaN, editsThisTurn: -1, failuresThisTurn: 0 })
        .mechanicalStreak
    ).toBe(1)
  })
})

describe('signalsWithCounts', () => {
  it('overwrites the set-size counters and nothing else', () => {
    const before = { ...emptySignals(), failures: 2, filesEdited: 9, projectsTouched: 9 }
    const after = signalsWithCounts(before, { filesEdited: 3, projectsTouched: 1 })
    expect(after).toEqual({ ...before, filesEdited: 3, projectsTouched: 1 })
    expect(before.filesEdited).toBe(9)
  })
  it('coerces garbage counts to 0', () => {
    expect(signalsWithCounts(emptySignals(), { filesEdited: -1, projectsTouched: NaN })).toEqual(
      emptySignals()
    )
    expect(signalsWithCounts(emptySignals(), undefined as never)).toEqual(emptySignals())
  })
})

describe('regressions — adversarial review', () => {
  it('an e-dropped stem never matches on its own ("wip" is not "wipe", "strip" is not "stripe")', () => {
    expect(classifyPrompt('commit the wip').risk).toBe(false)
    expect(classifyPrompt('commit the wip').tier).toBe('standard')
    expect(classifyPrompt('strip trailing whitespace').risk).toBe(false)
    expect(classifyPrompt('strip trailing whitespace').tier).toBe('light')
    expect(classifyPrompt('stripping the whitespace').risk).toBe(false)
    expect(classifyPrompt('stripped the prefix').risk).toBe(false)
    // the real inflections still land
    expect(classifyPrompt('wiped the table').risk).toBe(true)
    expect(classifyPrompt('wiping the table').risk).toBe(true)
    expect(classifyPrompt('it wipes the table').risk).toBe(true)
    expect(classifyPrompt('move to stripe checkout').risk).toBe(true)
    expect(classifyPrompt('stripe webhooks').reasons).toContain('risk: stripe')
  })
  it('"es" is only a plural after a sibilant ("fixes", not "planes")', () => {
    const planes = classifyPrompt('add planes to the game')
    expect(planes.tier).toBe('standard')
    expect(planes.reasons).toEqual(['standard: add'])
    expect(classifyPrompt('the plans').tier).toBe('deep')
    expect(classifyPrompt('planning the rollout').tier).toBe('deep')
    expect(classifyPrompt('we planned it').tier).toBe('deep')
    expect(classifyPrompt('it fixes the crash').reasons).toEqual(['standard: fix, crash'])
    expect(classifyPrompt('the bugs').reasons).toEqual(['standard: bug'])
  })
  it('accepts an -ly adverb of the last word ("very carefully", "intermittently")', () => {
    expect(classifyPrompt('handle this very carefully').tier).toBe('max')
    expect(classifyPrompt('be extremely careful').tier).toBe('max')
    expect(classifyPrompt('this is critically important').tier).toBe('max')
    expect(classifyPrompt('the test fails intermittently').tier).toBe('deep')
    expect(classifyPrompt('they run concurrently').tier).toBe('deep')
  })
  it('CRLF prompts classify like LF prompts', () => {
    expect(classifyPrompt('fix the typo\r\nin the readme').reasons).toEqual([
      'light: typo, readme',
      'standard: fix'
    ])
    expect(classifyPrompt('it is\r\nstill failing').uncertainty).toBe(true)
  })
  it('treats dots inside a registered NAME as separators too', () => {
    const fable = proj('Fable 5.1')
    expect(mentionedProjects('the fable-5-1 repo', [fable])).toEqual([fable])
    expect(mentionedProjects('the Fable 5.1 repo', [fable])).toEqual([fable])
    expect(mentionedProjects('the fable_5_1 repo', [fable])).toEqual([fable])
    expect(mentionedProjects('the Fable 5.10 repo', [fable])).toEqual([])
    const node = proj('Node.js App')
    expect(mentionedProjects('open the nodejs app', [node])).toEqual([node])
    expect(mentionedProjects('open the node.js app', [node])).toEqual([node])
    // keyword phrases keep their dots: ".env" is a risk word, a bare "env" is not
    expect(classifyPrompt('read the .env file').risk).toBe(true)
    expect(classifyPrompt('read the env file').risk).toBe(false)
  })
  it('ignores a name with fewer than 4 letters/digits ("a---" must not hit every "a")', () => {
    expect(mentionedProjects('give me a list', [proj('a---')])).toEqual([])
    expect(mentionedProjects('go go go', [proj('Go!!')])).toEqual([])
    expect(mentionedProjects('the r2-d2 unit', [proj('R2-D2')])).toEqual([proj('R2-D2')])
  })
  it('does not crash on a registry entry with a path but no usable name', () => {
    const nameless = { id: 'x', path: 'C:\\Users\\chris\\Income-Kit' } as Project
    const blank = { id: 'y', name: '   ', path: 'C:\\Users\\chris\\Income-Kit' } as Project
    const squishy = proj('Squishy Smash')
    const text = 'Squishy Smash at C:\\Users\\chris\\Income-Kit'
    expect(mentionedProjects(text, [nameless, squishy])).toEqual([nameless, squishy])
    const c = classifyPrompt(text, [nameless, squishy])
    expect(c.crossProject).toBe(true)
    expect(c.tier).toBe('deep')
    expect(c.reasons).toContain('cross-project: Income-Kit, Squishy Smash')
    expect(classifyPrompt(text, [blank, squishy]).reasons).toContain(
      'cross-project: Income-Kit, Squishy Smash'
    )
    const r = rec(text, { projects: [nameless, squishy] })
    expect(r.reason).toBe('cross-project work (Income-Kit, Squishy Smash)')
  })
  it('counts a pasted folder followed by sentence punctuation, but not a longer sibling', () => {
    const everlight = proj('Everlight', { path: 'C:\\Users\\chris\\Fable-5.1-one-shot' })
    const reg = [everlight]
    expect(mentionedProjects('look at C:\\Users\\chris\\Fable-5.1-one-shot.', reg)).toEqual([everlight])
    expect(mentionedProjects('look at C:\\Users\\chris\\Fable-5.1-one-shot. Then stop', reg)).toEqual([
      everlight
    ])
    expect(mentionedProjects('look at C:\\Users\\chris\\Fable-5.1-one-shot, please', reg)).toEqual([
      everlight
    ])
    expect(mentionedProjects('(C:\\Users\\chris\\Fable-5.1-one-shot)', reg)).toEqual([everlight])
    expect(mentionedProjects('C:/Users/chris/Fable-5.1-one-shot\r\nnext line', reg)).toEqual([everlight])
    expect(mentionedProjects('C:\\Users\\chris\\Fable-5.1-one-shot.bak', reg)).toEqual([])
    expect(mentionedProjects('C:\\Users\\chris\\Fable-5.1-one-shot-old', reg)).toEqual([])
    expect(mentionedProjects('C:\\Users\\chris\\Fable-5.1-one-shot2', reg)).toEqual([])
    expect(mentionedProjects('C:\\Users\\chris\\Fable-5.1-one-shot_v2', reg)).toEqual([])
    expect(mentionedProjects('xC:\\Users\\chris\\Fable-5.1-one-shot', reg)).toEqual([])
  })
  it('never mutates the signals, projects or current it is given', () => {
    const signals = { ...emptySignals(), consecutiveFailures: 2 }
    const frozenSignals = Object.freeze({ ...signals })
    const projects = Object.freeze([proj('Income Kit'), proj('Squishy Smash')]) as unknown as Project[]
    const current = Object.freeze({ model: 'claude-opus-5', effort: 'high' })
    const r = recommend({
      prompt: 'reuse the trailer script from Income Kit in Squishy Smash',
      signals: frozenSignals as RouterSignals,
      current,
      projects,
      now: 1
    })
    expect(r.tier).toBe('max')
    expect(frozenSignals).toEqual(signals)
    expect(mentionedProjects('Income Kit and Squishy Smash', projects).map((p) => p.name)).toEqual([
      'Income Kit',
      'Squishy Smash'
    ])
    expect(signalsAfterPrompt(frozenSignals as RouterSignals, 'not sure').uncertaintyHits).toBe(1)
    expect(signalsAfterCommand(frozenSignals as RouterSignals, 'test', 'pass').consecutiveFailures).toBe(0)
    expect(
      signalsAfterTurn(frozenSignals as RouterSignals, {
        promptLength: 1,
        editsThisTurn: 0,
        failuresThisTurn: 0
      }).mechanicalStreak
    ).toBe(1)
  })
  it('keeps the keyword regexes stateless across calls', () => {
    for (let i = 0; i < 3; i++) {
      expect(classifyPrompt('fix the typo, fix the typo').reasons).toEqual(['light: typo', 'standard: fix'])
      expect(classifyPrompt('typo').tier).toBe('light')
    }
  })
})

describe('normalizeSignals', () => {
  it('passes valid signals through unchanged', () => {
    const s = { ...emptySignals(), consecutiveFailures: 2, maxQualityRequested: true }
    expect(normalizeSignals(s)).toEqual(s)
  })
  it('coerces anything else into a valid, non-negative integer record', () => {
    expect(normalizeSignals(undefined)).toEqual(emptySignals())
    expect(normalizeSignals(null)).toEqual(emptySignals())
    expect(normalizeSignals('nope')).toEqual(emptySignals())
    expect(
      normalizeSignals({
        consecutiveFailures: 2.9,
        failures: '3',
        passes: -1,
        maxQualityRequested: 1,
        extra: true
      })
    ).toEqual({ ...emptySignals(), consecutiveFailures: 2 })
  })
})

describe('contract fit — output formats and limits', () => {
  it('uses the spec reason templates literally', () => {
    expect(rec('fix the typo in the css').reason).toBe('simple wording/CSS change (typo, css)')
    expect(rec('add a form').reason).toBe('ordinary feature work (add, form)')
    expect(rec('redesign it').reason).toBe('architecture-level change (redesign)')
    expect(rec('migrate the payment flow').reason).toBe(
      'risky change (migrate, payment) — use a strong model'
    )
    expect(rec('max quality please').reason).toBe('you asked for maximum quality')
    expect(rec('lorem '.repeat(500)).reason).toBe('long, multi-part request')
    expect(rec(undefined).reason).toBe('no task text yet')
    expect(
      recommend({ prompt: 'add a form', signals: { ...emptySignals(), consecutiveFailures: 3 }, now: 1 })
        .reason
    ).toBe('3 consecutive test failures — escalating')
    expect(
      recommend({
        prompt: 'fix the typo',
        signals: { ...emptySignals(), consecutiveFailures: 1 },
        current: { model: 'opus', effort: 'high' },
        now: 1
      }).reason
    ).toBe('recent failures — holding')
  })
  it('names a lone unsure/retry phrase as the signal it is, without raising confidence', () => {
    const r = rec('not sure about this one')
    expect(r.tier).toBe('standard')
    expect(r.reason).toBe('unsure/retry language (not sure) — standard until it repeats')
    expect(r.confidence).toBe(ROUTER_LIMITS.confidenceNone)
    expect(rec('the tests keep failing, not sure why').reason).toBe(
      'unsure/retry language (keep failing, not sure) — standard until it repeats'
    )
    // a tier keyword outranks it
    expect(rec('fix the bug, still failing').reason).toBe('ordinary feature work (fix, bug)')
    expect(rec('make it nicer somehow').reason).toBe('nothing specific in the request — standard by default')
  })
  it('every keyword in every class yields a one-line reason with no trailing period', () => {
    const all = [
      ...LIGHT_KEYWORDS,
      ...STANDARD_KEYWORDS,
      ...DEEP_KEYWORDS,
      ...MAX_KEYWORDS,
      ...RISK_KEYWORDS,
      ...UNCERTAINTY_KEYWORDS,
      ...CROSS_PROJECT_PHRASES
    ]
    for (const w of all) {
      const r = rec(`please ${w} now`)
      expect(r.reason.length, w).toBeGreaterThan(0)
      expect(r.reason.endsWith('.'), w).toBe(false)
      expect(r.reason.includes('\n'), w).toBe(false)
      expect(formatRecommendation(r), w).toBe(
        `Suggested: ${r.target.model} / ${r.target.effort} — ${r.reason}`
      )
      expect(r.signals.length, w).toBeGreaterThan(0)
      for (const s of r.signals) expect(s, w).toMatch(/^[a-z -]+: .+$/)
    }
  })
  it('the signal labels use the "<class>: <words>" and "<counter>: <n>" shapes from the spec', () => {
    const r = recommend({
      prompt: 'fix the payment typo',
      signals: { ...emptySignals(), consecutiveFailures: 3, uncertaintyHits: 2, projectsTouched: 2 },
      now: 1
    })
    expect(r.signals).toEqual([
      'light: typo',
      'standard: fix',
      'risk: payment',
      'projects touched: 2',
      'failures: 3',
      'uncertainty hits: 2'
    ])
  })
  it('escalation and hold thresholds come from ROUTER_LIMITS', () => {
    const L = ROUTER_LIMITS
    const at = (cf: number, uh = 0): RouterTier =>
      recommend({
        prompt: 'add a form',
        signals: { ...emptySignals(), consecutiveFailures: cf, uncertaintyHits: uh },
        now: 1
      }).tier
    expect(at(L.failuresToEscalate - 1)).toBe('standard')
    expect(at(L.failuresToEscalate)).toBe('deep')
    expect(at(L.failuresToMax - 1)).toBe('deep')
    expect(at(L.failuresToMax)).toBe('max')
    expect(at(0, L.uncertaintyToEscalate - 1)).toBe('standard')
    expect(at(0, L.uncertaintyToEscalate)).toBe('deep')
  })
  it('confidence values and the mechanical-streak step come from ROUTER_LIMITS', () => {
    const L = ROUTER_LIMITS
    expect(rec('fix the typo').confidence).toBe(L.confidenceKeyword)
    expect(rec('lorem ipsum '.repeat(120)).confidence).toBe(L.confidenceLength)
    expect(rec('make it nicer somehow').confidence).toBe(L.confidenceNone)
    const streak = (n: number): number =>
      recommend({ prompt: 'fix the typo', signals: { ...emptySignals(), mechanicalStreak: n }, now: 1 })
        .confidence
    expect(streak(L.mechanicalStreakMin - 1)).toBe(L.confidenceKeyword)
    expect(streak(L.mechanicalStreakMin)).toBe(
      Math.round((L.confidenceKeyword + L.confidenceStreakStep) * 100) / 100
    )
    expect(streak(50)).toBe(L.confidenceMax)
  })
  it('the mechanical-turn bounds come from ROUTER_LIMITS', () => {
    const L = ROUTER_LIMITS
    const turn = (promptLength: number, editsThisTurn: number, failuresThisTurn = 0): number =>
      signalsAfterTurn(emptySignals(), { promptLength, editsThisTurn, failuresThisTurn }).mechanicalStreak
    expect(turn(L.mechanicalPromptChars, L.mechanicalEdits)).toBe(1)
    expect(turn(L.mechanicalPromptChars + 1, L.mechanicalEdits)).toBe(0)
    expect(turn(L.mechanicalPromptChars, L.mechanicalEdits + 1)).toBe(0)
    expect(turn(L.mechanicalPromptChars, L.mechanicalEdits, 1)).toBe(0)
  })
  it('the long-prompt bounds come from ROUTER_LIMITS', () => {
    const L = ROUTER_LIMITS
    expect(classifyPrompt('x'.repeat(L.longPromptStandard)).tier).toBe('standard')
    expect(classifyPrompt('x'.repeat(L.longPromptStandard)).reasons).toEqual([])
    expect(classifyPrompt('x'.repeat(L.longPromptStandard + 1)).reasons).toEqual([
      `long prompt: ${L.longPromptStandard + 1} chars`
    ])
    expect(classifyPrompt('x'.repeat(L.longPromptDeep)).tier).toBe('standard')
    expect(classifyPrompt('x'.repeat(L.longPromptDeep + 1)).tier).toBe('deep')
  })
  it('the recommendation shape matches RouterRecommendation exactly (no extra or missing keys)', () => {
    const r = rec('fix the typo', { current: { model: 'claude-opus-5', effort: 'high' } })
    expect(Object.keys(r).sort()).toEqual(
      ['at', 'changes', 'confidence', 'direction', 'reason', 'signals', 'target', 'tier'].sort()
    )
    expect(typeof r.confidence).toBe('number')
    expect(r.confidence).toBeGreaterThanOrEqual(0)
    expect(r.confidence).toBeLessThanOrEqual(1)
    expect(['escalate', 'deescalate', 'hold']).toContain(r.direction)
    expect(Object.keys(r.target).sort()).toEqual(['effort', 'model'])
  })
})

describe('no-evidence turns hold the current model (found in live testing)', () => {
  const base = { signals: emptySignals(), now: 1 }
  const fable = { model: 'claude-fable-5-1', effort: 'xhigh' }
  it('a conversational turn on an expensive session does not suggest a downgrade', () => {
    const r = recommend({
      ...base,
      prompt: 'Everything seems to be working well, even in this terminal',
      current: fable
    })
    expect(r.direction).toBe('hold')
    expect(r.changes).toBe(false)
    expect(r.tier).toBe('max')
    expect(r.target).toEqual({ model: 'fable', effort: 'xhigh' })
    expect(r.reason).toBe('nothing specific in the request — keeping the current model')
    expect(r.confidence).toBe(ROUTER_LIMITS.confidenceNone)
    expect(r.signals).toContain('no task evidence: holding')
  })
  it('nor an upgrade on a cheap session', () => {
    const r = recommend({
      ...base,
      prompt: 'ok thanks, looks good',
      current: { model: 'haiku', effort: 'low' }
    })
    expect(r.direction).toBe('hold')
    expect(r.changes).toBe(false)
    expect(r.tier).toBe('light')
  })
  it('a lone unsure phrase holds too, and says why', () => {
    const r = recommend({
      ...base,
      prompt: 'not sure about this one',
      current: { model: 'opus', effort: 'high' }
    })
    expect(r.direction).toBe('hold')
    expect(r.changes).toBe(false)
    expect(r.reason).toBe('unsure/retry language (not sure) — holding until it repeats')
  })
  it('a mechanical streak is evidence: the same vague turn then steps down to standard', () => {
    const r = recommend({
      ...base,
      signals: { ...emptySignals(), mechanicalStreak: 3 },
      prompt: 'ok next one please',
      current: fable
    })
    expect(r.tier).toBe('standard')
    expect(r.direction).toBe('deescalate')
    expect(r.changes).toBe(true)
  })
  it('a real keyword still moves at once (Test D unchanged)', () => {
    const r = recommend({ ...base, prompt: 'fix the typo in README', current: fable })
    expect(r.tier).toBe('light')
    expect(r.direction).toBe('deescalate')
    expect(r.changes).toBe(true)
  })
  it('without a known current model the default stays standard with changes=false', () => {
    const r = recommend({ ...base, prompt: 'looks good' })
    expect(r.tier).toBe('standard')
    expect(r.changes).toBe(false)
    expect(r.reason).toBe('nothing specific in the request — standard by default')
  })
})
