import type { McpCatalogEntry, McpLiveServer, McpStatus } from './types'

// Pure logic for the MCP manager: parse `claude mcp list` output and hold the
// curated catalog. NO node imports — shared by main + renderer, unit-tested.

// ---------- live status parsing ----------

/** Classify a status tail from `claude mcp list` by keyword (glyph-agnostic —
 *  the ✔/✘/! glyphs can mojibake through a Windows code page, the text won't). */
export function classifyMcpStatus(statusText: string): McpStatus {
  const s = statusText.toLowerCase()
  if (s.includes('needs authentication')) return 'needs-auth'
  if (s.includes('failed to connect')) return 'failed'
  if (s.includes('pending')) return 'pending'
  if (s.includes('connected') && (s.includes('failed') || s.includes('tools fetch failed'))) return 'degraded'
  if (s.includes('connected')) return 'connected'
  return 'unknown'
}

const STATUS_KEYWORDS = /connected|needs authentication|failed to connect|pending/i

/**
 * Parse `claude mcp list` stdout into live server entries. Each server line is
 * `<name>: <target> - <status>`; names and commands can contain spaces, so we
 * split the name at the first ": " and the status at the LAST " - " (guarding
 * that the tail actually looks like a status). Header/blank lines are skipped.
 */
export function parseMcpList(stdout: string): McpLiveServer[] {
  const out: McpLiveServer[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (!line || /^checking mcp server health/i.test(line)) continue
    const colon = line.indexOf(': ')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim()
    const rest = line.slice(colon + 2).trim()
    if (!name) continue

    let target = rest
    let statusText = ''
    const dash = rest.lastIndexOf(' - ')
    if (dash !== -1 && STATUS_KEYWORDS.test(rest.slice(dash + 3))) {
      target = rest.slice(0, dash).trim()
      statusText = rest.slice(dash + 3).trim()
    }
    out.push({ name, target, status: classifyMcpStatus(statusText), statusText })
  }
  return out
}

// ---------- curated catalog (all URLs confirmed 2026-07) ----------

// Only servers whose remote endpoint is verified go here (from the Claude Code
// CLI help, this machine's live list, the project's own code, or vendor docs).
// Anything else is added via the custom form so we never ship a wrong URL.
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    name: 'github',
    label: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http',
    blurb: 'PRs, issues, code review, Actions — read/write across your repos.',
    auth: 'oauth',
    warn: 'Write access: can push branches, open PRs, edit issues. Claude asks before each action.'
  },
  {
    name: 'context7',
    label: 'Context7',
    url: 'https://mcp.context7.com/mcp',
    transport: 'http',
    blurb: 'Version-correct library docs pulled into context — fewer stale-API mistakes.',
    auth: 'header',
    headerName: 'CONTEXT7_API_KEY',
    tokenHint: 'Optional — works without a key; a free key at context7.com/dashboard raises rate limits.'
  },
  {
    name: 'sentry',
    label: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    transport: 'http',
    blurb: 'Pull error/issue details and stack traces into a session for debugging.',
    auth: 'oauth'
  },
  {
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'http',
    blurb: 'Read and manage Linear issues and projects.',
    auth: 'oauth'
  },
  {
    name: 'notion',
    label: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    transport: 'http',
    blurb: 'Search and edit Notion pages and databases.',
    auth: 'oauth'
  },
  {
    name: 'vercel',
    label: 'Vercel',
    url: 'https://mcp.vercel.com',
    transport: 'http',
    blurb: 'Inspect deployments, logs, and projects on Vercel.',
    auth: 'oauth'
  },
  {
    name: 'netlify',
    label: 'Netlify',
    url: 'https://netlify-mcp.netlify.app/mcp',
    transport: 'http',
    blurb: 'Manage Netlify sites, deploys, and env — for your static/SSR hosting.',
    auth: 'oauth'
  },
  {
    name: 'stripe',
    label: 'Stripe',
    url: 'https://mcp.stripe.com',
    transport: 'http',
    blurb: 'Query the Stripe API and search Stripe docs from a session.',
    auth: 'oauth',
    warn: 'Acts on your Stripe account — use a RESTRICTED key, and prefer test mode for anything mutating.'
  }
]

/** Connectors synced from claude.ai (name prefixed "claude.ai ") are managed
 *  there, not via `claude mcp add/login` — treat them separately from the catalog. */
export function isClaudeAiConnector(name: string): boolean {
  return name.toLowerCase().startsWith('claude.ai ')
}

/**
 * The live server that represents this catalog entry, if any. A LOCALLY-added
 * server (matched by name or URL) wins; only if none exists do we report a
 * claude.ai-synced connector on the same URL (so the card can show "synced via
 * claude.ai" instead of an Add button). Returns undefined when neither exists.
 */
export function catalogInstalled(entry: McpCatalogEntry, live: McpLiveServer[]): McpLiveServer | undefined {
  const n = entry.name.toLowerCase()
  const url = entry.url.toLowerCase().replace(/\/$/, '')
  const matches = (s: McpLiveServer): boolean =>
    s.name.toLowerCase() === n || s.target.toLowerCase().replace(/\/$/, '') === url
  return live.find((s) => matches(s) && !isClaudeAiConnector(s.name)) ?? live.find(matches)
}
