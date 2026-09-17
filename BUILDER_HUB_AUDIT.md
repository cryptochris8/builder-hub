# Builder Hub — Upgrade Audit (2026-09-16)

_Audit of the existing Builder Hub against `BUILDER_HUB_UPGRADE_SPEC.md` (efficiency · context continuity · intelligent routing), performed before any change. What existed, what was reused, what was broken, what changed, what remains._

## 1. Current architecture (as found)

Electron 33 + electron-vite · React 19 · TypeScript · Tailwind v4 · xterm.js + `@homebridge/node-pty-prebuilt-multiarch`. Local-first JSON stores in userData (`projects.json`, `settings.json`). Main process is thin glue; every piece of logic that matters lives in `src/shared/*` (pure, Vitest-tested, 172 tests at the start of the audit). Renderer talks to main over one typed preload bridge and never sends argv or paths-to-write.

Already in place before this upgrade (all verified in code, all kept):
- **Registry + hub-wide Claude context**: 125 registered projects; `~/.claude/builder-hub-projects.md` regenerated on every registry change; a marked block in `~/.claude/CLAUDE.md`; `BUILDER_HUB_PROJECTS` env in every embedded PTY; per-project `CLAUDE.md` seeding with the matching stack profile + `TOOL-STACK.md` pointer.
- **Hooks → Hub status board**: `UserPromptSubmit / PostToolUse / Stop / Notification / SessionEnd` command hooks (curl → `127.0.0.1:44711/hook`, 204-empty replies), idempotently wired into `~/.claude/settings.json`; working/waiting/done dots, Dashboard rail, OS toasts.
- **Session profiles**: deep/standard/light/custom → `--model` / `--effort` flags resolved in main (task → project → global), plus a keyword `suggestProfile()` for new tasks.
- **Permission mode** per project/global, allowlisted argv, fail-safe normalization.
- **Task worktrees + diff/merge**, **MCP manager**, **Files pane** (image/video/audio/PDF/text preview, send-to-Claude), **Viewer** (embedded Chromium `<webview>`, http/https), **focus scoring**, **handoff generator** (manual, FounderOS-style brief).

## 2. Spec requirement → what existed

| Spec section | Status before | Reused / built on |
|---|---|---|
| §2 Router (classify, escalate, de-escalate, modes) | **Partial** — a 2-class keyword `suggestProfile()` at task creation only; no session signals, no modes, no in-session recommendation | Kept `suggestProfile` + presets; new `router.ts` |
| §3 Persistent context (global / project / task / retrieval / freshness) | **Partial** — global layer existed (registry + CLAUDE.md block); no project state store, no task packet, no freshness, no injection | Kept the global layer + registry writer; new `contextLogic.ts`, `contextStore.ts`, `projectIndex.ts` |
| §4 Creator Stack registry | **Missing** — Income Kit only appears as a registry row with a stack string | New `creatorStack.ts` (+ main store), seeded from verified paths |
| §5 Efficiency (no rereads, caches, invalidation) | **Partial** — CLAUDE.md seeding + registry avoid re-explaining the stack; nothing tracked what a session already did | Context packet + fingerprint invalidation + targeted UserPromptSubmit cards |
| §6 Internal viewers | **Mostly present** — Files pane previews, Viewer for http(s); no local-file pages in the Viewer, no Markdown rendering, terminal links opened Chrome, no reopen-closed | Kept both panes; added `file:` support (contained), Markdown renderer, internal link opening, recently-closed |
| §7 Cross-terminal awareness | **Partial** — per-cwd state dots only; nothing per session, no files/commands, no conflict warning | New `sessionBoard.ts` reducer keyed by session id; PreToolUse warnings |
| §8 Status/control surface | **Partial** — tab dots + rail; no model/effort/recommendation/freshness | New `SessionBar` above every Claude tab; Dashboard rail enriched |
| §9 Failure safety | **Good** — atomic JSON writes, `.bak`, marker-based settings edits, corrupt-file recovery | Same patterns reused for every new store; everything new is rebuildable |

## 3. Claude Code capabilities verified (not assumed)

Checked against the installed `claude` **2.1.273** binary, its `--help`, the hooks + statusline docs, and two live `claude -p` probes in a scratch folder:
- Hook events available: `SessionStart` (with `source` ∈ startup/resume/clear/compact/fork and an optional `model`), `PreToolUse` (matcher + `permissionDecision` / `additionalContext`), `PreCompact`/`PostCompact`, `PreModelSwitch`/`PostModelSwitch` (`from_model`/`to_model`), `Stop` carries **`last_assistant_message`** (no transcript parsing needed), `Pre/PostToolUse` carry `effort.level`.
- Hook stdout `{…}` is parsed as hook output; `additionalContext` is honored on SessionStart / UserPromptSubmit / PreToolUse. **`http`-type hooks are not supported for SessionStart** ("Skipping HTTP hook … HTTP hooks are not supported for SessionStart" in the debug log) — so the Hub keeps the proven `command`+curl transport; the reply body reaches Claude as stdout.
- With the Hub closed, both `command` and `http` hooks fail **non-blocking** (tool still dispatched, prompt still processed). Command hooks run under **Git Bash** on Windows, so a trailing `|| cd .` makes the offline case exit 0 (a true no-op instead of a "non-blocking error" notice).
- `/model <alias>` and `/effort <level>` are argument-taking slash commands (`argumentHint: "[model]"`, `immediate: true`); `CLAUDE_CODE_EFFORT_LEVEL` is a session-scoped env override.
- Status line: `statusLine.command` receives JSON with `model.id/display_name`, `effort.level`, `context_window.used_percentage`, `prompt_cache.{warm,hit_ratio}`, `cost`, `rate_limits`; runs on every assistant message (300 ms debounce); stdout is displayed. Chris has **no** status line configured today.
- No supported API exists to change a running session's model from outside. `--model`/`--effort` at launch are supported (already used).

## 4. Problems found during the audit

1. **`resolveSessionProject` was first-match, not longest-prefix** (`src/shared/sessionLogic.ts`). With 125 projects including nested ones (`Fable-5-1-week` ⊃ `projects/leaguecast`, `App-store` ⊃ `slice-game`, `Laugh-shot` ⊃ `LaughShot`…), a session in a nested project could be labelled with its parent AND launched with the parent's session profile / permission mode, depending on registry order. **Fixed** (longest matching path wins; worktrees of nested projects too) + tests.
2. **`TYPE_META[type].label` without `?.` in `handoff.ts`** — an out-of-enum type on disk would throw in the HandoffModal. Low severity; left as is (the save path is guarded) and noted.
3. Two pre-existing lint warnings (react-refresh export rule) — unchanged.
4. `BUILDER_HUB=1`: this audit itself ran inside a Hub terminal, so **the Hub was running during the upgrade** — main-process changes could not be runtime-verified from inside the session (single-instance lock; restarting the Hub would kill the session). See §7.

## 5. Changes made (summary — details in `BUILDER_HUB_ARCHITECTURE.md`, `CONTEXT_AND_ROUTING.md`, `CREATOR_STACK.md`, `CHANGELOG.md`)

- **Shared (pure, tested)**: `router.ts`, `sessionBoard.ts`, `contextLogic.ts`, `creatorStack.ts`, `markdown.ts`; `sessionLogic.ts` (hook specs with matchers, fail-silent command, status line install/remove, longest-prefix resolution); `claudeLaunch.ts` (routing mode + 3 toggles in settings, `resolveRoutingMode`, `ROUTING_MODE_META`); `hubLogic.ts` (global block points at the Creator Stack + context dir + cross-project guardrail); `types.ts` (all new contracts).
- **Main**: `orchestrator.ts` (board, hook replies, recommendations, context updates, IPC), `contextStore.ts`, `projectIndex.ts`, `creatorStack.ts`, `statusLine.ts`, `fsAtomic.ts`; `hookServer.ts` (JSON replies + `/statusline`), `pty.ts` (idle-gated `/model` + `/effort` typing, embedded cwd registry), `files.ts` (`fs:isAllowed`), `index.ts` (webview popups stay in the guest).
- **Renderer**: `SessionBar`, `ContextPane`, `CreatorStackPanel`, `RoutingSettings`; `WorkspaceView` (context tabs, recently closed), `ViewerPane` (file: pages, copy/reveal/open, titles), `FilesPane` (rendered Markdown, Preview-in-Viewer), `TerminalPane` (links open internally), `Dashboard` (model/effort/suggestion), `ProjectDetail` (Context action, per-project routing mode), `ConnectionsView` (new sections).
- **Hooks wired** (idempotent upgrade of `~/.claude/settings.json`): + `SessionStart`, `PreToolUse` (edit tools), `PreCompact`, `PostModelSwitch`; existing five re-pointed at the fail-silent command.

## 6. What is deliberately NOT done

- **No auto model switching through undocumented means.** Auto mode types the documented slash commands into an idle embedded session, with hard gates; it is off by default.
- **No transcript mining.** The board uses hook payloads (+ `last_assistant_message`) and the optional status line only.
- **No rewrite of working panes**; the FounderOS handoff modal, session profiles, permission modes, worktrees, MCP manager are untouched in behavior.
- **No Electron upgrade** (still the top hygiene item in PLAN.md; out of scope here).

## 7. Remaining limitations / follow-ups

- **Runtime verification of the main-process path needs a Hub restart by Chris** (the upgrade was built from inside a running Hub). Unit tests, typecheck, lint and a production bundle build are green; the hook JSON reply contract was validated against the docs + a live `claude -p` probe, not against the running Hub.
- The status line is opt-in and replaces Claude's footer hints while installed (Claude Code behavior).
- Recommendations are heuristic (keywords + counters). They are explainable (`signals[]`, `reason`) and overridable (Manual/Lock/Dismiss), never silent.
- `PostModelSwitch` reports model changes; effort changes are learned from the next tool call's `effort.level` or the status line.
- Cross-terminal conflict warnings need hooks from both terminals (external sessions count as long as they run with the user's `~/.claude/settings.json`).
