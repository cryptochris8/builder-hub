# Builder Hub — Architecture (v0.4, efficiency / context / routing upgrade)

_Companion to [PLAN.md](./PLAN.md) (history, locked decisions) and [BUILDER_HUB_AUDIT.md](./BUILDER_HUB_AUDIT.md) (what existed before this upgrade). This file describes how the app is put together **now**._

## 1. Shape of the app

```
Electron 33 (main)  ──IPC (typed preload bridge)──  Vite/React 19 renderer
   │
   ├─ JSON stores in userData      projects.json · settings.json · context.json · creator-stack.json
   ├─ localhost hook listener      127.0.0.1:44711  (Claude Code hooks POST here; replies carry hook output)
   ├─ node-pty                     embedded Claude Code / shell sessions (cmd /k claude <flags>)
   └─ ~/.claude writers            builder-hub-projects.md · builder-hub/creator-stack.md ·
                                   builder-hub/context/<id>.md · marked block in ~/.claude/CLAUDE.md ·
                                   hooks (+ optional statusLine) in ~/.claude/settings.json
```

**Convention that everything hangs on:** `src/shared/*` is pure (no `electron`/`fs`) and unit-tested; `src/main/*` is thin glue (IPC, files, processes); the renderer only ever sends *ids and enum strings*, never paths-to-write or argv.

## 2. Modules

| Layer | File | Responsibility |
|---|---|---|
| shared | `types.ts` | every contract (Project, HubSettings, SessionRecord, ProjectContext, CreatorStack, RouterRecommendation…) |
| shared | `claudeLaunch.ts` | argv allowlists (permission mode, session profile), `normalizeSettings`, `resolveRoutingMode` |
| shared | `sessionLogic.ts` | hook wiring (`ensureHubHooks`), `resolveSessionProject` (longest-prefix), worktree/diff parsing, `normPath` |
| shared | `router.ts` | **model + effort router**: prompt classification, escalation/de-escalation signals, recommendation, slash commands to apply |
| shared | `switchingCost.ts` | **switching cost (0.5.0)**: context size / value / continuity / capture → risk; task boundaries; the downgrade policy (hold · suggest · allow) |
| shared | `sessionBoard.ts` | **cross-terminal board**: pure reducer over hook payloads → `SessionRecord`s; edit-conflict detection; command outcome detection |
| shared | `contextLogic.ts` | **persistent context**: project context normalization/patching, deterministic scan merge, freshness, handoff packet, SessionStart injection text, markdown renderers |
| shared | `creatorStack.ts` | **Creator Stack registry**: seed (verified on disk), normalize/merge, alias matching (`findCapabilities`), capability card + markdown renderers |
| shared | `markdown.ts` | safe Markdown → HTML for the in-app viewer |
| shared | `hubLogic.ts` | registry markdown, marked-block upsert, file classification, path containment |
| main | `hookServer.ts` | listener: validates payloads, feeds the board, answers SessionStart/UserPromptSubmit/PreToolUse with hook JSON, `/statusline` endpoint, OS toasts |
| main | `orchestrator.ts` | glue: board state, context store, creator stack, router; broadcasts `hub:board`; IPC for context/board/creator-stack |
| main | `contextStore.ts` | `context.json` (atomic, .bak) + `~/.claude/builder-hub/context/<id>.md` renders |
| main | `creatorStack.ts` | `creator-stack.json` (atomic) + seed/reindex + `~/.claude/builder-hub/creator-stack.md` |
| main | `projectIndex.ts` | deterministic project scan (manifest scripts/deps, README first paragraph, env key NAMES, git head/branch/dirty, mtimes) |
| main | `contextUsage.ts` | transcript-tail usage fallback for context size (numbers only, `~/.claude/projects` only) |
| main | `statusLine.ts` | opt-in Hub-owned `statusLine` in `~/.claude/settings.json` (never replaces a foreign one) |
| main | `pty.ts` | PTY lifecycle; resolves mode/profile in main; exports `BUILDER_HUB*` env |
| renderer | `WorkspaceView` + `SessionBar` | per-tab status/control strip: project · task · model · effort · state · context% · freshness · recommendation (Apply / Lock / Dismiss) · Refresh context · Open context · Creator Stack · Publish handoff · Reindex |
| renderer | `ViewerPane` | embedded browser: http(s) **and** in-project `file:` pages; back/forward/reload, copy URL, open externally |
| renderer | `FilesPane` | in-app file browser; Markdown rendered; copy path / reveal / open externally |
| renderer | `ConnectionsView` | settings: permission mode, session profile, **routing mode**, **context & conflict toggles**, **status line opt-in**, **Creator Stack** panel, MCP manager |

## 3. Data flows

### 3.1 Hooks → board → UI (and back into Claude)
Claude Code (embedded or external) runs one `curl` per hook event that POSTs the hook's stdin JSON to `/hook`. Events wired: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `Edit|Write|MultiEdit|NotebookEdit`), `PostToolUse`, `Stop`, `Notification`, `PreCompact`, `PostModelSwitch`, `SessionEnd`.

The listener replies:
- **empty 204** for everything that must stay silent (Stop/Notification/PostToolUse/SessionEnd/PreCompact/PostModelSwitch) — a Stop-hook stdout JSON could block Claude, so silence there is a safety property;
- **JSON hook output** (`hookSpecificOutput`) only where it is useful and cheap:
  - `SessionStart` (`startup` / `clear` / `compact` / `resume` / `fork`) → `additionalContext` = the compact project + task packet (§3.2). This is the Test B/C mechanism: a cleared/compacted/restarted session starts from the packet, not from zero.
  - `UserPromptSubmit` → when the prompt names a Creator Stack capability (e.g. "trailer kit") → `additionalContext` = that capability's card (path, docs to read first, entrypoints, usage notes). Targeted retrieval on demand, a few hundred tokens, only when relevant (Test A).
  - `PreToolUse` on edit tools → when another live session edited the same file recently, or the file changed on disk after this session last read it → `additionalContext` + `systemMessage` warning (Test G/H). Never blocks.

`curl` output becomes hook stdout; Claude Code parses `{…}` as hook JSON. When the Hub is closed, curl fails and every hook is a no-op (verified: `command` and `http` hooks both degrade non-blocking; `http` hooks are additionally **not supported for SessionStart**, which is why the transport stays `command`+curl).

The board (`SessionRecord` per Claude `session_id`) is broadcast to the renderer as `hub:board`; the legacy `claude:status` (per cwd) stays for the existing dots/rail.

### 3.2 Persistent context (Hub-owned, model-independent)
Three layers, retrieved progressively — nothing is stuffed into every prompt:
1. **Global** — `~/.claude/CLAUDE.md` marked block → registry (`builder-hub-projects.md`) + Creator Stack (`builder-hub/creator-stack.md`). Loaded by every Claude session as memory (already true before this upgrade).
2. **Project** — `context.json` per project (purpose, commands, services, shared tools, decisions, tasks, known bugs, recent work, key files, fingerprint). Rendered to `~/.claude/builder-hub/context/<projectId>.md` so a session can read *more* on demand. Auto fields come from `projectIndex.ts` (deterministic, zero tokens); notes are user-edited or accumulated from Stop recaps.
3. **Task packet** — built from the live/last `SessionRecord`: objective (first prompt), attempted (recaps), files changed, test status, unresolved (last failure), next action, model/effort. Published to `<project>/handoffs/` on demand and injected at SessionStart.

**Freshness:** a `ContextFingerprint` (git HEAD/branch/dirty count, CLAUDE.md + manifest mtimes) is recomputed at every SessionStart and Refresh; a mismatch marks the context **stale** and the injection says so ("source moved since this context was indexed — trust the files"). A summary never overrides source.

### 3.3 Router
Pure `router.ts`: `classifyPrompt` (keyword classes + length + risk + uncertainty + cross-project mentions) → base tier; `RouterSignals` accumulated from hooks (consecutive failing test/build/lint commands, edits, projects touched, mechanical streak) escalate or de-escalate; `recommend()` returns tier + `{model, effort}` + reason + confidence + direction. Tiers: light = haiku/low, standard = sonnet/medium, deep = opus/high, max = fable/xhigh.

Modes (`settings.routingMode`, per-project override): **manual** (nothing) · **suggest** (default: shown in the SessionBar, in the Dashboard rail, and — with the opt-in status line — inside Claude's own status bar) · **auto** (a ≥0.75-confidence recommendation is applied to an **idle** session by typing the documented `/model <alias>` and `/effort <level>` slash commands, only after 2 s with no user keystrokes) · **lock** (pin). Apply-now types the same slash commands; "Apply at next launch" writes the project/task session profile instead. Nothing ever changes mid-turn.

### 3.4 Creator Stack
`creator-stack.json` seeded from entries verified on disk (Income Kit's trailer-factory, video-factory, claude-agent-pack, roblox-marketing, freelancing-kit; the game-trailer playbook; the subagents repo; TOOL-STACK.md; stack profiles; the Everlight trailer reference implementation). Entries carry aliases, capabilities (each with docs-to-read-first, entrypoints, usage notes, worksFor), dependencies, tags, `exists`. **Reindex** re-verifies paths and refreshes docs/entrypoints from README/package.json scripts. Rendered for Claude at `~/.claude/builder-hub/creator-stack.md` with the **cross-project guardrail**: reference freely, consume through stable interfaces, and announce before modifying another project's source.

## 4. Security properties kept
- Renderer never sends argv, paths-to-write, or hook output. Model/effort/mode/routing choices are enum strings validated in main (`normalizeSettings`, `resolve*`).
- Hook listener accepts only loopback POSTs without an `Origin` header; payloads are untrusted and type-checked; bodies capped at 256 KB.
- Hook replies never contain `decision`/`continue` fields — only `additionalContext`/`systemMessage` (and never on Stop).
- `~/.claude/settings.json` edits are marker-based, idempotent, atomic (tmp+rename, .bak); a foreign `statusLine` is never replaced; a malformed file is left untouched.
- Webview guards: the existing `will-attach-webview` containment check, plus (0.4) a `will-navigate`/`will-redirect` guard on every guest so an in-project page cannot navigate the Viewer to a `file:` outside registered projects, and `window.open` from a guest loads in the same guest (web URLs only).
- Embedded Claude sessions launch with `--session-id <uuid>` minted in main; the board's `embedded` flag and the Apply/Auto PTY lookup use that id (folder match only as a fallback), so keystrokes can never land in a different session's terminal.
- All Hub data (`context.json`, `creator-stack.json`, rendered markdown) is rebuildable; deleting it is safe.
