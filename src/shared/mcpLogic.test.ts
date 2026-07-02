import { describe, it, expect } from 'vitest'
import {
  MCP_CATALOG,
  catalogInstalled,
  classifyMcpStatus,
  isClaudeAiConnector,
  parseMcpList
} from './mcpLogic'

describe('classifyMcpStatus', () => {
  it('classifies by keyword regardless of glyph', () => {
    expect(classifyMcpStatus('✔ Connected')).toBe('connected')
    expect(classifyMcpStatus('! Needs authentication')).toBe('needs-auth')
    expect(classifyMcpStatus('✘ Failed to connect')).toBe('failed')
    expect(classifyMcpStatus('⏸ Pending approval')).toBe('pending')
    expect(classifyMcpStatus('! Connected · tools fetch failed')).toBe('degraded')
    expect(classifyMcpStatus('weird')).toBe('unknown')
  })
  it('is case-insensitive and glyph-free tolerant (mojibaked output)', () => {
    expect(classifyMcpStatus('connected')).toBe('connected')
    expect(classifyMcpStatus('NEEDS AUTHENTICATION')).toBe('needs-auth')
  })
})

describe('parseMcpList', () => {
  const sample = [
    'Checking MCP server health…',
    '',
    'claude.ai Vercel: https://mcp.vercel.com - ✔ Connected',
    'claude.ai Slack: https://mcp.slack.com/mcp - ! Needs authentication',
    'claude.ai Netlify: https://netlify-mcp.netlify.app/mcp - ✘ Failed to connect',
    'Roblox_Studio: cmd.exe /c %LOCALAPPDATA%\\Roblox\\mcp.bat - ! Connected · tools fetch failed'
  ].join('\n')

  it('parses names (with spaces), targets and statuses; skips the health header', () => {
    const r = parseMcpList(sample)
    expect(r).toHaveLength(4)
    expect(r[0]).toEqual({
      name: 'claude.ai Vercel',
      target: 'https://mcp.vercel.com',
      status: 'connected',
      statusText: '✔ Connected'
    })
    expect(r[1].status).toBe('needs-auth')
    expect(r[2].status).toBe('failed')
  })
  it('handles a stdio command target and a degraded status', () => {
    const r = parseMcpList(sample)
    const rbx = r.find((s) => s.name === 'Roblox_Studio')!
    expect(rbx.target).toBe('cmd.exe /c %LOCALAPPDATA%\\Roblox\\mcp.bat')
    expect(rbx.status).toBe('degraded')
  })
  it('leaves the whole rest as target when no status keyword follows the last " - "', () => {
    const r = parseMcpList('weird: some - thing without a status')
    expect(r[0].target).toBe('some - thing without a status')
    expect(r[0].status).toBe('unknown')
  })
  it('tolerates CRLF and empty input', () => {
    expect(parseMcpList('foo: https://x - ✔ Connected\r\n')[0].status).toBe('connected')
    expect(parseMcpList('')).toEqual([])
  })
  it('skips lines with no ": " separator', () => {
    expect(parseMcpList('just a banner line\nfoo: https://x - ✔ Connected')).toHaveLength(1)
  })
})

describe('MCP_CATALOG', () => {
  it('every entry has a valid https url and required fields', () => {
    for (const e of MCP_CATALOG) {
      expect(e.url).toMatch(/^https:\/\//)
      expect(e.name).toMatch(/^[a-z0-9-]+$/)
      expect(['http', 'sse', 'stdio']).toContain(e.transport)
      expect(['oauth', 'header', 'none']).toContain(e.auth)
      if (e.auth === 'header') expect(e.headerName).toBeTruthy()
    }
  })
  it('names are unique', () => {
    const names = MCP_CATALOG.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('catalogInstalled', () => {
  const github = MCP_CATALOG.find((e) => e.name === 'github')!
  it('matches by name', () => {
    expect(
      catalogInstalled(github, [{ name: 'github', target: 'x', status: 'connected', statusText: '' }])
    ).toBeTruthy()
  })
  it('matches by url ignoring a trailing slash', () => {
    const live = [
      {
        name: 'gh',
        target: 'https://api.githubcopilot.com/mcp',
        status: 'connected' as const,
        statusText: ''
      }
    ]
    expect(catalogInstalled(github, live)).toBeTruthy()
  })
  it('returns undefined when absent', () => {
    expect(
      catalogInstalled(github, [{ name: 'other', target: 'y', status: 'connected', statusText: '' }])
    ).toBeUndefined()
  })

  const vercel = MCP_CATALOG.find((e) => e.name === 'vercel')!
  it('prefers a locally-added server over a claude.ai connector on the same URL', () => {
    const live = [
      {
        name: 'claude.ai Vercel',
        target: 'https://mcp.vercel.com',
        status: 'connected' as const,
        statusText: ''
      },
      { name: 'vercel', target: 'https://mcp.vercel.com', status: 'needs-auth' as const, statusText: '' }
    ]
    expect(catalogInstalled(vercel, live)?.name).toBe('vercel')
  })
  it('falls back to a claude.ai connector when no local server matches', () => {
    const live = [
      {
        name: 'claude.ai Vercel',
        target: 'https://mcp.vercel.com',
        status: 'connected' as const,
        statusText: ''
      }
    ]
    const m = catalogInstalled(vercel, live)
    expect(m?.name).toBe('claude.ai Vercel')
    expect(isClaudeAiConnector(m!.name)).toBe(true)
  })
})

describe('isClaudeAiConnector', () => {
  it('detects the claude.ai prefix case-insensitively', () => {
    expect(isClaudeAiConnector('claude.ai Slack')).toBe(true)
    expect(isClaudeAiConnector('Claude.AI Gmail')).toBe(true)
    expect(isClaudeAiConnector('github')).toBe(false)
    expect(isClaudeAiConnector('Roblox_Studio')).toBe(false)
  })
})
