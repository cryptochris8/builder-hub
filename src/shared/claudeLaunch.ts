// How the Hub launches the `claude` CLI: permission mode → argv.
//
// This is the ONLY place that decides what flags follow `claude`. It's pure so it
// can be unit-tested, and — more importantly — so the argv is built from a closed
// allowlist rather than from anything the renderer sends. The renderer picks a
// MODE (one of three strings); it never supplies flags.
//
// Verified against claude 2.1.207:
//   --dangerously-skip-permissions      bypasses every permission check
//   --permission-mode <mode>            acceptEdits | auto | bypassPermissions | manual | dontAsk | plan
//   `--permission-mode bypassPermissions` == `--dangerously-skip-permissions`
//
// The first bypass session on a profile opens a DISCLAIMER, not a session: claude shows a
// "WARNING: Claude Code running in Bypass Permissions mode" confirm (default answer: "No,
// exit") and records the acceptance as `skipDangerousModePermissionPrompt` in
// ~/.claude/settings.json. This machine already has it, which is why bypass appears to
// start clean here — a fresh profile (new Windows user, installed build) will sit on that
// prompt until someone answers it. The Hub deliberately does NOT write that flag: accepting
// "turn off every safety check" is the user's call to make, in the terminal, once.

import { CLAUDE_PERMISSION_MODES, CLAUDE_MODELS, CLAUDE_EFFORTS, SESSION_PROFILES } from './types'
import type {
  ClaudeEffort,
  ClaudeModel,
  ClaudePermissionMode,
  HubSettings,
  Project,
  SessionConfig,
  SessionProfileId
} from './types'

/** Fresh default settings. Built per-call sites via normalizeSettings — never
 *  hand this object itself to a caller that might mutate it.
 *
 *  The out-of-box permission mode is `bypassPermissions`: this is a personal,
 *  single-user command center where the owner runs Claude unguarded by default and
 *  toggles individual projects back to Ask (per-project `claudePermissionMode`). Note
 *  this is only the default for a settings.json with NO recorded mode — a stored value
 *  that's PRESENT but garbage still fails safe to 'default' (see normalizeSettings). */
export const DEFAULT_SETTINGS: HubSettings = {
  claudePermissionMode: 'bypassPermissions',
  defaultSessionProfile: { profile: 'standard' }
}

/** Where a corrupt/tampered mode value lands. Deliberately NOT the fresh-install
 *  default: "skip every safety check" must never be reached by *failing open* — only
 *  by an explicit, recorded choice. A missing key is a fresh install (→ DEFAULT); a
 *  present-but-invalid key is corruption or tampering (→ here). */
const SAFE_MODE_FALLBACK: ClaudePermissionMode = 'default'

export const PERMISSION_MODE_META: Record<
  ClaudePermissionMode,
  { label: string; blurb: string; danger?: boolean }
> = {
  default: {
    label: 'Ask',
    blurb: 'Claude asks before edits and commands. Safest.'
  },
  acceptEdits: {
    label: 'Accept edits',
    blurb: 'File edits apply automatically; commands still ask.'
  },
  bypassPermissions: {
    label: 'Bypass',
    blurb:
      'Skips every permission check (--dangerously-skip-permissions). Claude can edit and run anything without asking.',
    danger: true
  }
}

export function isPermissionMode(v: unknown): v is ClaudePermissionMode {
  return typeof v === 'string' && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(v)
}

// ---------- session profiles (model + effort routing) ----------

/** What each named profile launches. 'standard' and 'custom' are absent on
 *  purpose: standard passes no flags, custom carries its own model/effort. */
export const PROFILE_PRESETS: Record<'deep' | 'light', { model: ClaudeModel; effort: ClaudeEffort }> = {
  deep: { model: 'opus', effort: 'high' },
  light: { model: 'haiku', effort: 'low' }
}

export const PROFILE_META: Record<SessionProfileId, { label: string; blurb: string }> = {
  deep: {
    label: 'Deep',
    blurb: 'Opus, high effort — architecture, complex builds, debugging, research.'
  },
  standard: {
    label: 'Standard',
    blurb: "No flags — Claude's own default model and effort."
  },
  light: {
    label: 'Light',
    blurb: 'Haiku, low effort — renames, docs, config chores, boilerplate.'
  },
  custom: {
    label: 'Custom',
    blurb: 'Hand-picked model and effort.'
  }
}

export function isModel(v: unknown): v is ClaudeModel {
  return typeof v === 'string' && (CLAUDE_MODELS as readonly string[]).includes(v)
}

export function isEffort(v: unknown): v is ClaudeEffort {
  return typeof v === 'string' && (CLAUDE_EFFORTS as readonly string[]).includes(v)
}

export function isProfileId(v: unknown): v is SessionProfileId {
  return typeof v === 'string' && (SESSION_PROFILES as readonly string[]).includes(v)
}

/** Tolerant read of a session config from disk or the renderer. Unknown shapes
 *  become undefined (= inherit the next level up); unrecognized model/effort
 *  values are DROPPED, never passed through. Always returns a fresh object. */
export function normalizeSessionConfig(raw: unknown): SessionConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as { profile?: unknown; model?: unknown; effort?: unknown }
  if (!isProfileId(o.profile)) return undefined
  const cfg: SessionConfig = { profile: o.profile }
  if (o.profile === 'custom') {
    if (isModel(o.model)) cfg.model = o.model
    if (isEffort(o.effort)) cfg.effort = o.effort
  }
  return cfg
}

/** The --model/--effort flags for a session config. Re-validates internally, so
 *  even a config passed in un-normalized can only add allowlisted values. */
export function sessionArgs(config: SessionConfig | undefined): string[] {
  const c = normalizeSessionConfig(config)
  if (!c || c.profile === 'standard') return []
  const pick = c.profile === 'custom' ? { model: c.model, effort: c.effort } : PROFILE_PRESETS[c.profile]
  const args: string[] = []
  if (pick.model) args.push('--model', pick.model)
  if (pick.effort) args.push('--effort', pick.effort)
  return args
}

/** Which config governs a launch: task override → project → global default.
 *  Invalid/missing levels fall through to the next one. */
export function resolveSessionConfig(
  project: Project | undefined,
  task: string | undefined,
  settings: HubSettings
): SessionConfig {
  const taskCfg = task ? normalizeSessionConfig(project?.taskProfiles?.[task]) : undefined
  return (
    taskCfg ??
    normalizeSessionConfig(project?.sessionProfile) ??
    normalizeSessionConfig(settings.defaultSessionProfile) ?? { profile: 'standard' }
  )
}

// Keyword classes for the profile suggester. Word-ish boundaries, matched on
// lowercased text. Deep wins when both match — over-spending beats under-thinking.
const DEEP_WORDS =
  /\b(refactor|architect|architecture|redesign|debug|investigate|research|port|migrat\w*|rewrite|perf|performance|optimi[sz]\w*|security|audit|algorithm|concurren\w*|race)\b/
const LIGHT_WORDS =
  /\b(rename|typo|bump|docs?|documentation|readme|comment|format|lint|copy|label|wording|tweak|chore|boilerplate)\b/

/** Suggest a profile from free task text (task name, next action…). Pure
 *  heuristic — zero tokens spent deciding. Unknown → 'standard'. */
export function suggestProfile(text: string): SessionProfileId {
  const t = (text ?? '').toLowerCase()
  if (DEEP_WORDS.test(t)) return 'deep'
  if (LIGHT_WORDS.test(t)) return 'light'
  return 'standard'
}

/** Tolerant read of a persisted (or renderer-supplied) settings blob: anything
 *  unrecognized falls back to the safe default rather than throwing. Same defensive
 *  spirit as recoverRegistry() — a corrupt settings.json must never brick startup,
 *  and an unknown mode must never reach argv. */
export function normalizeSettings(raw: unknown): HubSettings {
  const o =
    !raw || typeof raw !== 'object' || Array.isArray(raw)
      ? {}
      : (raw as { claudePermissionMode?: unknown; defaultSessionProfile?: unknown })
  // Every field rebuilt fresh — never return (or nest) DEFAULT_SETTINGS itself.
  return {
    // Absent key = fresh install → the (bypass) default. Present but invalid = corruption
    // or a renderer trying to smuggle a flag → fail SAFE, never open. The security
    // property holds either way: the worst a bad value yields is an allowlisted mode, not
    // arbitrary argv. See DEFAULT_SETTINGS / SAFE_MODE_FALLBACK.
    claudePermissionMode: isPermissionMode(o.claudePermissionMode)
      ? o.claudePermissionMode
      : o.claudePermissionMode === undefined
        ? DEFAULT_SETTINGS.claudePermissionMode
        : SAFE_MODE_FALLBACK,
    defaultSessionProfile: normalizeSessionConfig(o.defaultSessionProfile) ?? { profile: 'standard' }
  }
}

/** Which permission mode governs a launch: per-project override → global default.
 *  Re-validates the stored project value with isPermissionMode, so — exactly like
 *  resolveSessionConfig — a garbage field on disk falls through to the global setting
 *  rather than reaching argv. `settings.claudePermissionMode` is itself already
 *  normalized, so the result is always an allowlisted mode. */
export function resolvePermissionMode(
  project: Project | undefined,
  settings: HubSettings
): ClaudePermissionMode {
  if (project && isPermissionMode(project.claudePermissionMode)) return project.claudePermissionMode
  return settings.claudePermissionMode
}

/** The flags appended after `claude`. 'default' passes nothing at all. */
export function claudeArgs(mode: ClaudePermissionMode): string[] {
  switch (mode) {
    case 'acceptEdits':
      return ['--permission-mode', 'acceptEdits']
    case 'bypassPermissions':
      // Canonical spelling; exactly equivalent to `--permission-mode bypassPermissions`.
      return ['--dangerously-skip-permissions']
    default:
      return []
  }
}

/** Full argv for the shell the PTY spawns. On Windows `cmd /k claude` starts Claude
 *  Code and keeps the shell alive after it exits. Non-Windows just opens a plain
 *  shell (today's behavior) — no auto-launch, so nothing to flag. */
export function claudeShellArgs(
  platform: string,
  opts: { runClaude?: boolean; mode?: ClaudePermissionMode; session?: SessionConfig }
): string[] {
  if (platform !== 'win32' || !opts.runClaude) return []
  return ['/k', 'claude', ...claudeArgs(opts.mode ?? 'default'), ...sessionArgs(opts.session)]
}
