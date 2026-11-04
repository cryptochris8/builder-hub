#!/usr/bin/env node
// decide — record a founder decision in the canon repo through Builder Hub.
//
//   node decide.mjs propose --topic canon-home --statement "Keep canon in open-claw" [--rationale ..] [--alt ..]
//   node decide.mjs approve --topic canon-home --statement "..." --quote "Chris's exact words"
//   node decide.mjs approve --id D-20261104-ab12 --quote "yes, do that"
//   node decide.mjs reject  --topic pi-openclaw --statement "Install OpenClaw on the Pi" --quote "lets scrap openclaw"
//   node decide.mjs list
//
// Builder Hub (127.0.0.1:44711) checks the quote against the prompts and answers it
// received from Chris; an approval without his words is stored as a proposal. The
// project is the one containing the current folder (or --cwd). Stdlib only.

import { pathToFileURL } from 'node:url'

export const HUB_URL = 'http://127.0.0.1:44711/decision'
const ACTIONS = new Set(['propose', 'approve', 'reject', 'list'])
const VALUE_FLAGS = new Set([
  'id',
  'topic',
  'statement',
  'quote',
  'rationale',
  'alt',
  'supersedes',
  'files',
  'review',
  'cwd'
])

/** argv (without node + script) -> { action, flags } or { error }. */
export function parseArgs(argv) {
  const [action, ...rest] = argv
  if (!action || !ACTIONS.has(action)) {
    return { error: `First argument must be one of: ${[...ACTIONS].join(', ')}` }
  }
  const flags = { alt: [] }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) return { error: `Unexpected argument: ${a}` }
    const name = a.slice(2)
    if (!VALUE_FLAGS.has(name)) return { error: `Unknown flag --${name}` }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) return { error: `--${name} needs a value` }
    i++
    if (name === 'alt') flags.alt.push(value)
    else flags[name] = value
  }
  return { action, flags }
}

/** The JSON body the Hub expects. */
export function buildPayload(action, flags, cwd) {
  const body = { action, cwd: flags.cwd || cwd }
  if (flags.id) body.id = flags.id
  if (flags.topic) body.topic = flags.topic
  if (flags.statement) body.statement = flags.statement
  if (flags.quote) body.quote = flags.quote
  if (flags.rationale) body.rationale = flags.rationale
  if (flags.alt?.length) body.alternatives = flags.alt
  if (flags.supersedes) body.supersedes = flags.supersedes
  if (flags.files)
    body.affectedFiles = flags.files
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  if (flags.review) body.reviewDate = flags.review
  return body
}

/** Human-readable lines for a Hub reply. */
export function formatReply(action, reply) {
  if (!reply || typeof reply !== 'object') return ['The Hub sent an unreadable reply.']
  if (action === 'list') {
    if (!reply.ok) return [`Could not list: ${reply.message ?? 'unknown error'}`]
    const ds = Array.isArray(reply.decisions) ? reply.decisions : []
    const lines = [`${reply.project}: ${ds.length} decision(s)${reply.file ? ` — ${reply.file}` : ''}`]
    for (const d of ds) lines.push(`- ${String(d.status).toUpperCase()} ${d.id} [${d.topic}] ${d.statement}`)
    return lines
  }
  const lines = [`${reply.ok ? String(reply.outcome ?? 'ok').toUpperCase() : 'NOT RECORDED'}: ${reply.message ?? ''}`]
  if (reply.decision?.evidence?.quote) lines.push(`Evidence: "${reply.decision.evidence.quote}"`)
  if (reply.file) lines.push(`File: ${reply.file}${reply.committed ? ' (committed)' : ' (not committed)'}`)
  if (reply.warning) lines.push(`Warning: ${reply.warning}`)
  return lines
}

/** 0 = recorded as asked, 1 = refused or downgraded to a proposal, 2 = Hub unreachable/outdated. */
export function exitCodeFor(action, reply) {
  if (!reply?.ok) return 1
  if (action === 'approve' && reply.outcome !== 'approved') return 1
  if (action === 'reject' && reply.outcome !== 'rejected') return 1
  return 0
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    console.error('Usage: decide.mjs propose|approve|reject|list [--id] [--topic] [--statement] [--quote] [--rationale] [--alt] [--supersedes] [--files a,b] [--review YYYY-MM-DD] [--cwd]')
    process.exit(2)
  }
  const { action, flags } = parsed
  let res
  try {
    res = await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(action, flags, process.cwd())),
      signal: AbortSignal.timeout(8000)
    })
  } catch {
    console.error('NOT RECORDED: Builder Hub is not running (127.0.0.1:44711). Tell Chris; do not write decision files by hand.')
    process.exit(2)
  }
  if (res.status === 404) {
    console.error('NOT RECORDED: this Builder Hub build has no /decision endpoint yet. Chris needs to install the updated Hub.')
    process.exit(2)
  }
  let reply
  try {
    reply = await res.json()
  } catch {
    reply = undefined
  }
  for (const line of formatReply(action, reply)) console.log(line)
  process.exit(exitCodeFor(action, reply))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
