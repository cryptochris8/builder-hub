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

import { CLAUDE_PERMISSION_MODES } from './types'
import type { ClaudePermissionMode, HubSettings } from './types'

export const DEFAULT_SETTINGS: HubSettings = { claudePermissionMode: 'default' }

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

/** Tolerant read of a persisted (or renderer-supplied) settings blob: anything
 *  unrecognized falls back to the safe default rather than throwing. Same defensive
 *  spirit as recoverRegistry() — a corrupt settings.json must never brick startup,
 *  and an unknown mode must never reach argv. */
export function normalizeSettings(raw: unknown): HubSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SETTINGS }
  const mode = (raw as { claudePermissionMode?: unknown }).claudePermissionMode
  return {
    claudePermissionMode: isPermissionMode(mode) ? mode : DEFAULT_SETTINGS.claudePermissionMode
  }
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
  opts: { runClaude?: boolean; mode?: ClaudePermissionMode }
): string[] {
  if (platform !== 'win32' || !opts.runClaude) return []
  return ['/k', 'claude', ...claudeArgs(opts.mode ?? 'default')]
}
