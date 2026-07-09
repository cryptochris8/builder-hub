import type { HandoffInput, Project } from './types'
import { STAGE_LABELS, TYPE_META } from './types'

// Claude Code handoff + spec generators — harvested from FounderOS.
// Pure string builders (no electron/fs) so they're unit-testable with Vitest.
// FounderOS's global-toolchain section is dropped: the Hub already injects the
// tool catalog + stack profile through each project's seeded CLAUDE.md.

const DEFAULT_CONSTRAINTS = [
  'Do not rebuild from scratch unless explicitly instructed.',
  'Preserve existing architecture.',
  'Make incremental safe changes.',
  'Add tests where useful.'
]

const DEFAULT_IMPLEMENTATION_STEPS = [
  'Inspect existing structure.',
  'Identify relevant files.',
  'Implement changes.',
  'Run checks/build.',
  'Report changed files and next steps.'
]

function bulletLines(input: string, prefix = '- '): string {
  return input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `${prefix}${l}`)
    .join('\n')
}

function checkboxLines(input: string): string {
  return input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `- [ ] ${l}`)
    .join('\n')
}

export function slugifyForFilename(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  )
}

export function defaultHandoffFilename(taskTitle: string, today = new Date()): string {
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}-${slugifyForFilename(taskTitle)}.md`
}

/** Squeeze runs of blank lines and end with exactly one newline. */
function tidy(lines: string[]): string {
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  )
}

/** The project-context block shared by the handoff + spec generators. */
function projectContextLines(p: Project): string[] {
  const lines: string[] = []
  if (p.shortDescription) lines.push(p.shortDescription, '')
  if (p.problemSolved) lines.push(`**Problem solved:** ${p.problemSolved}`)
  if (p.targetAudience) lines.push(`**Target audience:** ${p.targetAudience}`)
  if (p.monetizationModel) lines.push(`**Monetization:** ${p.monetizationModel}`)
  if (p.mvpDefinition) lines.push('', '### MVP definition', p.mvpDefinition)
  if (p.currentFocus) lines.push('', `**Current focus:** ${p.currentFocus}`)
  if (p.nextAction) lines.push(`**Next action:** ${p.nextAction}`)
  if (p.blockers?.length) {
    lines.push('', '### Blockers')
    for (const b of p.blockers) lines.push(`- ${b}`)
  }
  if (p.notes) lines.push('', '### Notes', p.notes)
  return lines
}

/** A ready-to-paste Claude Code task handoff for one project. */
export function generateHandoff(project: Project, input: HandoffInput): string {
  const lines: string[] = []

  lines.push(`# Claude Code Handoff: ${input.taskTitle || '(untitled)'}`)
  if (input.taskType) {
    lines.push('', `**Task type:** ${input.taskType}`)
  }
  lines.push('')

  lines.push('## Project')
  lines.push(`- Name: ${project.name}`)
  lines.push(`- Type: ${TYPE_META[project.type].label}${project.stack ? ` (${project.stack})` : ''}`)
  if (project.stage) lines.push(`- Stage: ${STAGE_LABELS[project.stage]}`)
  lines.push(`- Local path: ${project.path}`)
  if (project.url) lines.push(`- URL: ${project.url}`)
  lines.push('')

  if (input.includeProjectContext) {
    const ctx = projectContextLines(project)
    if (ctx.length > 0) {
      lines.push('## Project Context')
      lines.push(...ctx)
      lines.push('')
    }
  }

  lines.push('## Objective')
  lines.push(input.objective || '(none provided)')
  lines.push('')

  lines.push('## Constraints')
  const extraConstraints = input.constraints
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (const c of [...DEFAULT_CONSTRAINTS, ...extraConstraints]) {
    lines.push(`- ${c}`)
  }
  lines.push('')

  lines.push('## Implementation Steps')
  DEFAULT_IMPLEMENTATION_STEPS.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  lines.push('')

  lines.push('## Important Files/Folders')
  lines.push(bulletLines(input.importantFiles) || '- (none specified)')
  lines.push('')

  lines.push('## Acceptance Criteria')
  lines.push(checkboxLines(input.acceptanceCriteria) || '- [ ] (none specified)')

  return tidy(lines)
}

/** A build-prompt spec for starting (or restarting) implementation work. */
export function buildClaudeBuildPrompt(project: Project, today = new Date()): string {
  const lines: string[] = []
  lines.push(`# Claude Code Build Prompt: ${project.name}`, '')
  lines.push('## Project Context')
  lines.push(`- **Name:** ${project.name}`)
  lines.push(`- **Type:** ${TYPE_META[project.type].label}`)
  if (project.stack) lines.push(`- **Stack:** ${project.stack}`)
  if (project.stage) lines.push(`- **Stage:** ${STAGE_LABELS[project.stage]}`)
  lines.push(`- **Path:** ${project.path}`)
  lines.push('')
  lines.push(...projectContextLines(project))
  lines.push('', '---', `*Generated by Builder Hub on ${today.toLocaleDateString()}*`)
  return tidy(lines)
}

/** An MVP-planning prompt built from the project brief. */
export function buildMvpPlanPrompt(project: Project, today = new Date()): string {
  const lines: string[] = []
  lines.push(`# MVP Plan: ${project.name}`, '')
  lines.push(`## What We're Building`)
  lines.push(project.shortDescription || project.notes || '(no description yet)')
  lines.push('')
  if (project.targetAudience) lines.push(`## Who It's For`, project.targetAudience, '')
  if (project.problemSolved) lines.push('## Problem', project.problemSolved, '')
  if (project.mvpDefinition) lines.push('## MVP Scope', project.mvpDefinition, '')
  if (project.monetizationModel) lines.push('## Monetization', project.monetizationModel, '')
  if (project.stack) lines.push('## Tech Stack', bulletLines(project.stack.replace(/\s*·\s*/g, '\n')), '')
  lines.push('## Next Steps')
  lines.push(project.nextAction ? `1. ${project.nextAction}` : '1. Define the next concrete action.')
  lines.push('', '---', `*Generated by Builder Hub on ${today.toLocaleDateString()}*`)
  return tidy(lines)
}
