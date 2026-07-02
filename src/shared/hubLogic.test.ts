import { describe, it, expect } from 'vitest'
import {
  HUB_BLOCK_END,
  HUB_BLOCK_START,
  buildGlobalClaudeBlock,
  buildRegistryMarkdown,
  classifyFile,
  isPathInside,
  upsertMarkedBlock
} from './hubLogic'
import { prettyBytes } from './projectLogic'
import type { Project } from './types'

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
  createdAt: 0,
  updatedAt: 0,
  ...over
})

describe('isPathInside', () => {
  it('accepts the root itself and children', () => {
    expect(isPathInside('C:\\Users\\chris\\proj', 'C:\\Users\\chris\\proj')).toBe(true)
    expect(isPathInside('C:\\Users\\chris\\proj\\src\\a.ts', 'C:\\Users\\chris\\proj')).toBe(true)
  })
  it('rejects siblings that share a prefix', () => {
    expect(isPathInside('C:\\Users\\chris\\proj-evil\\x', 'C:\\Users\\chris\\proj')).toBe(false)
  })
  it('rejects .. traversal escaping the root', () => {
    expect(isPathInside('C:\\Users\\chris\\proj\\..\\secrets.txt', 'C:\\Users\\chris\\proj')).toBe(false)
  })
  it('is case-insensitive by default (Windows)', () => {
    expect(isPathInside('c:\\users\\CHRIS\\proj\\a', 'C:\\Users\\chris\\proj')).toBe(true)
  })
  it('tolerates trailing separators on the root', () => {
    expect(isPathInside('C:\\a\\b', 'C:\\a\\')).toBe(true)
  })
})

describe('classifyFile', () => {
  it('classifies images, media and pdf', () => {
    expect(classifyFile('logo.PNG')).toBe('image')
    expect(classifyFile('clip.mp4')).toBe('video')
    expect(classifyFile('song.mp3')).toBe('audio')
    expect(classifyFile('doc.pdf')).toBe('pdf')
  })
  it('classifies code and config as text', () => {
    expect(classifyFile('App.tsx')).toBe('text')
    expect(classifyFile('main.luau')).toBe('text')
    expect(classifyFile('.gitignore')).toBe('text')
    expect(classifyFile('Dockerfile')).toBe('text')
    expect(classifyFile('CLAUDE.md')).toBe('text')
  })
  it('falls back to other for unknown or extensionless names', () => {
    expect(classifyFile('game.exe')).toBe('other')
    expect(classifyFile('LICENSE-APACHE2')).toBe('other')
  })
})

describe('prettyBytes', () => {
  it('formats each magnitude', () => {
    expect(prettyBytes(0)).toBe('0 B')
    expect(prettyBytes(1023)).toBe('1023 B')
    expect(prettyBytes(1536)).toBe('1.5 KB')
    expect(prettyBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
  it('rounds large values to whole numbers', () => {
    expect(prettyBytes(200 * 1024)).toBe('200 KB')
  })
})

describe('upsertMarkedBlock', () => {
  const START = HUB_BLOCK_START
  const END = HUB_BLOCK_END
  const block = `${START}\nnew content\n${END}`

  it('appends the block when markers are absent, preserving the doc', () => {
    const doc = '# My memory\n\nSome hand-written notes.\n'
    const out = upsertMarkedBlock(doc, START, END, block)
    expect(out).toBe(`# My memory\n\nSome hand-written notes.\n\n${block}\n`)
  })
  it('replaces only the marked region when present', () => {
    const doc = `# Top\n\n${START}\nold content\n${END}\n\n# Bottom stays`
    const out = upsertMarkedBlock(doc, START, END, block)
    expect(out).toBe(`# Top\n\n${block}\n\n# Bottom stays`)
    expect(out).not.toContain('old content')
  })
  it('is idempotent', () => {
    const once = upsertMarkedBlock('# Doc\n', START, END, block)
    expect(upsertMarkedBlock(once, START, END, block)).toBe(once)
  })
  it('leaves the doc untouched when only the start marker survives (never appends a second pair)', () => {
    const doc = `# Doc\n${START}\norphaned start\n\n# Hand-written section that must survive\n`
    expect(upsertMarkedBlock(doc, START, END, block)).toBe(doc)
  })
  it('leaves the doc untouched when only the end marker survives', () => {
    const doc = `# Doc\nsome text\n${END}\n# More hand-written content\n`
    expect(upsertMarkedBlock(doc, START, END, block)).toBe(doc)
  })
  it('never destroys content between an orphaned start and a later appended block (two-sync scenario)', () => {
    // The exact data-loss path: orphan start → (old code appended) → next sync would
    // pair the orphan with the appended block's end and wipe everything between.
    const doc = `# Doc\n${START}\norphan\n\n# PRECIOUS user content\n\n${block}\n`
    const out = upsertMarkedBlock(doc, START, END, block)
    expect(out).toContain('# PRECIOUS user content')
  })
  it('starts an empty doc with just the block', () => {
    expect(upsertMarkedBlock('', START, END, block)).toBe(`${block}\n`)
  })
})

describe('buildGlobalClaudeBlock', () => {
  it('wraps the pointer in both markers', () => {
    const b = buildGlobalClaudeBlock('C:\\Users\\chris\\.claude\\builder-hub-projects.md')
    expect(b.startsWith(HUB_BLOCK_START)).toBe(true)
    expect(b.endsWith(HUB_BLOCK_END)).toBe(true)
    expect(b).toContain('builder-hub-projects.md')
    expect(b).toContain('BUILDER_HUB_PROJECTS')
  })
})

describe('buildRegistryMarkdown', () => {
  it('lists every project with path, type label, stack and notes', () => {
    const md = buildRegistryMarkdown(
      [
        proj({
          name: 'Squishy',
          type: 'roblox',
          path: 'C:\\Users\\chris\\Roblox-squishy',
          stack: 'Rojo · Luau',
          notes: 'ship it'
        }),
        proj({ name: 'Hub', type: 'web-app', path: 'C:\\Users\\chris\\builder-hub' })
      ],
      '2026-07-01'
    )
    expect(md).toContain('## Squishy — Roblox')
    expect(md).toContain('`C:\\Users\\chris\\Roblox-squishy`')
    expect(md).toContain('**Stack:** Rojo · Luau')
    expect(md).toContain('**Notes:** ship it')
    expect(md).toContain('## Hub — Web app')
    expect(md).toContain('2026-07-01')
  })
  it('puts favorites first and flags them', () => {
    const md = buildRegistryMarkdown(
      [proj({ name: 'BBB' }), proj({ name: 'AAA', favorite: true })],
      '2026-07-01'
    )
    expect(md.indexOf('AAA ★')).toBeGreaterThan(-1)
    expect(md.indexOf('AAA')).toBeLessThan(md.indexOf('BBB'))
  })
  it('flattens multi-line notes onto one line', () => {
    const md = buildRegistryMarkdown([proj({ notes: 'line one\r\nline two' })], '2026-07-01')
    expect(md).toContain('line one · line two')
  })
  it('handles an empty registry', () => {
    expect(buildRegistryMarkdown([], '2026-07-01')).toContain('_No projects registered yet._')
  })
})
