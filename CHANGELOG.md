# Changelog

## 0.5.0 — 2026-09-16 · Context-aware routing & switching cost (spec v1.1)

**Added**
- **Switching cost** (`src/shared/switchingCost.ts`, pure, 47 tests): context size (status line exact → transcript usage estimate → unknown), context value (incremental ledger of edit turns, passes after edits, decisions, root causes, constraints/negative findings, approvals, minus exploration, compaction and staleness), task continuity (files, objective overlap, continuation language, other projects), capture adequacy (edits since capture, handoff after the last substantive work, turns beyond the packet, unrecorded decisions, failing checks) → switching risk low / moderate / high.
- **Switching policy**: high risk holds a downgrade on the current model ("finish on <model> and reassess at the next task boundary"); moderate allows the suggestion but no auto; low keeps normal behavior. Escalations are never blocked. Auto mode additionally refuses downgrades that are unconfident, over a failing check, or leave valuable context poorly captured.
- **Task-boundary detection** on every prompt (another project, explicit pivot language, completion + unrelated request, weak "next"): a strong boundary closes the old objective, checkpoints it into project context, and lowers continuity.
- **Board ledger** (`ContinuityLedger` on each session record), accumulated incrementally by the reducer; old records upgrade transparently.
- **SessionBar**: exact or estimated context (`ctx 91%` / `ctx ~91%` / `ctx ~779k`), a switching-risk chip that expands into the full breakdown (task complexity, utilization, value, continuity, capture, risk, reasons), a 🛡 Stay row for held downgrades, and the actions **Stay · Handoff & switch · Reassess**.
- **Handoff & switch**: publishes the handoff, marks the session captured, then switches (typed now when safe, else saved for the next launch). **Reassess** refreshes context size and recomputes.
- **Status line on by default** (installed at startup while the setting is on; never over a user-configured status line; an explicit removal is kept). Status-line context data is now recorded as exact usage.
- **Transcript fallback** (`src/main/contextUsage.ts`): the last assistant turn's usage from a 256 KB transcript tail, only inside `~/.claude/projects`, numbers only; the percentage only when the window is known.
- **Agent concurrency foundation**: `SubagentStart` / `SubagentStop` hooks, per-session active/peak/total counts, a configurable ceiling (Connections, default 8) shown as a SessionBar warning. A v1.2 governance proposal is in `CONTEXT_AND_ROUTING.md` §8.5.

**Changed**
- `HubSettings.statusLineTelemetry` defaults to `true` (absent key only); new `agentCeiling` (1–64, default 8).
- Hub hooks now include `SubagentStart` and `SubagentStop` (11 events).
- Publishing a handoff and recording decisions in the Context tab now update the live session's capture state.

**Fixed before release (independent review of the patch)**
- A strong completion boundary was undone before scoring: the reducer had already replaced the objective with the new prompt, so re-detection compared the prompt to itself (scenario H held in the real hook flow). Scoring now uses the boundary recorded for the current prompt.
- A recap alone counted as good capture. Edits with no passing check and no handoff since are now at best partial capture.
- Handoff & switch and the SessionBar Handoff could publish another tab's session and mark the wrong session captured when two tabs share a project. Both now target the exact session.
- Stop and SessionStart re-read the session after their awaited reads, so status-line pings, subagent stops and tool events that arrive meanwhile are no longer overwritten.
- Removing the status line now reports a failed preference save instead of claiming success (it would otherwise reinstall on the next launch).

**Unchanged on purpose**
- The router's task-requirement logic and its tests (failure / uncertainty escalation, max quality, risk, cross-project, mechanical streak, no-evidence hold), locks, dismissals, manual mode, the SessionBar's existing actions, persistent context and task packets.

## 0.4.0 — 2026-09-16 · Efficiency, context continuity & intelligent routing

**Added**
- **Model + effort router** (`src/shared/router.ts`): prompt classification (light / standard / deep / max, risk, uncertainty, cross-project, length) + session signals (consecutive failing test/build/lint/typecheck runs, edits, projects touched, mechanical streak) → tier, target, reason, confidence, direction. Modes Manual / Suggest (default) / Auto / Lock, global + per-project (`Project.routingMode`). Apply now (types `/model` + `/effort` into an idle embedded session, idle-gated in main) · At launch (saves a custom session profile) · Lock · Dismiss.
- **Cross-terminal session board** (`src/shared/sessionBoard.ts`, `board.json`): one record per Claude session (model, effort, state, files read/edited, commands + pass/fail, last recap, other projects touched, shared tools used, signals, recommendation, status-line telemetry). Broadcast as `hub:board`; survives Hub restarts.
- **Persistent project context** (`src/shared/contextLogic.ts`, `context.json`, `~/.claude/builder-hub/context/<id>.md`): purpose, architecture, commands, services, shared tools, decisions, tasks, known bugs, recent work (from Stop recaps), key files (MRU), git/manifest fingerprint + freshness. **Reindex** = deterministic scan (`src/main/projectIndex.ts`, zero tokens). **Task packet** built from the live/last session; **SessionStart injection** (startup / clear / compact / fork; resume gets the freshness note only), bounded to ~2.6 k chars, never file contents. **Publish handoff** → `<project>/handoffs/<date>-handoff.md`.
- **Creator Stack registry** (`src/shared/creatorStack.ts`, `creator-stack.json`, `~/.claude/builder-hub/creator-stack.md`): seeded from verified on-disk tools (Income Kit trailer-factory / video-factory / agent pack / roblox-marketing / freelancing kit, the trailer playbook, the Everlight reference rig, subagents repo, TOOL-STACK.md, stack profiles, AI-creators). Prompt alias matching injects the capability card at `UserPromptSubmit`. Reindex, add/remove, "What would Claude get?" in Connections.
- **Conflict warnings**: `PreToolUse` on edit tools warns when another live session edited the file recently or it changed on disk after this session read it (`additionalContext` + `systemMessage`, never blocking).
- **Status line telemetry (opt-in)**: a Hub-owned `statusLine` reports model / effort / context % / prompt cache / rate limits to the Hub and shows them (plus the Hub's suggestion) in Claude's status bar. Never replaces a user-configured status line.
- **SessionBar** above every Claude tab (project · task · model/effort · state · ctx % · cache · test verdict · files · freshness · recommendation + actions · Context / Stack / Handoff / Reindex). **Context tab** (☰) per project. Dashboard rail shows model/effort/last action/suggestion. Project panel: Context action + routing-mode picker. Connections: routing settings, context toggles, status line, Creator Stack panel.
- **Internal viewers**: Viewer loads in-project `file:` pages (containment-checked via `fs:isAllowed`), copy URL, reveal, open externally, page titles, back/forward state; terminal links open in a Viewer tab (Chrome remains one click away); Files pane renders Markdown (safe renderer, `src/shared/markdown.ts`) with a Source toggle and offers **Preview ▸** for HTML; recently-closed tabs can be reopened; webview popups stay inside the same guest.
- Hooks wired: `SessionStart`, `PreToolUse` (`Edit|Write|MultiEdit|NotebookEdit`), `PreCompact`, `PostModelSwitch` (idempotent upgrade of `~/.claude/settings.json`, matchers maintained). Hook command ends with `|| cd .` so a closed Hub is a silent no-op.
- Settings: `routingMode`, `contextInjection`, `conflictWarnings`, `statusLineTelemetry` (validated in `normalizeSettings`; garbage → conservative defaults, never `auto`).
- Docs: `BUILDER_HUB_AUDIT.md`, `BUILDER_HUB_ARCHITECTURE.md`, `CONTEXT_AND_ROUTING.md`, `CREATOR_STACK.md`, this changelog.

**Fixed**
- `resolveSessionProject` resolved nested projects to whichever registry row came first; it now picks the longest matching path (and a nested project's task worktree beats its parent). Nested sessions were mislabelled and could launch with the parent's session profile / permission mode.

**Unchanged on purpose**
- Session profiles, permission modes, worktrees, MCP manager, focus scoring, the FounderOS handoff modal, the legacy per-cwd status dots.
- Electron 33 pin (top hygiene item, separate effort).

### Post-review hardening (same day)
Two adversarial review workflows (module contract/correctness, then integration) ran over the upgrade; everything confirmed was fixed:
- `classifyCommand` capped its input before the heredoc/quote scanners (a 256 KB Bash payload from any local process could stall the main thread); per-session file maps bounded (500); the board bounded (300 records) and pruned at runtime, with the newest substantial session per project kept 7 days for restart handoffs; prototype-key session ids rejected; hook body cap raised to 4 MB so PostToolUse payloads carrying file contents are not dropped.
- Embedded sessions launch with `--session-id`; `embedded`, Apply and Auto key on the session id (folder only as fallback); Apply/Auto treat "waiting on the idle prompt" as idle but never a permission prompt; a dismissed suggestion is never auto-applied; the first typed keystroke waits 400 ms for the Stop reply to flush; after an apply the target is assumed until confirmed (no re-typing); closing a tab / removing a worktree ends the record.
- SessionStart hands off only from an ENDED prior session (a live sibling terminal is listed, not impersonated); the context file is rendered before it is pointed at; capability cards inject once per session; the "What would Claude get?" probe uses the hook's limit; conflict replies are capped; a failed git probe reports freshness as unknown; long prompts reach the router uncut (4000 chars).
- Viewer: `will-navigate`/`will-redirect` containment for file: pages inside webview guests. Creator Stack: removed seeds stay removed across Reindex; Add never overwrites an existing id; Reindex no longer rewrites the store on every start.
- Renderer: SessionBar reads the live project (per-project Lock/Manual set after the tab opened applies); Context tab notes no longer remount on save; freshness from the Context tab flows to the SessionBar; no startup toasts for restored sessions; reopening a closed task tab checks the worktree still exists; Toggle hoisted out of RoutingSettings' render body.

## 0.4.1 — 2026-09-16 · Live-testing fixes (after the first reinstall)
- Router: a turn with no evidence (no tier keyword, no length, no escalation signal) no longer suggests the default tier — it holds at the session's current model/effort with no suggestion shown. Seen in the first live session: a "everything seems to be working" reply on Fable produced "Suggested: sonnet / medium — nothing specific in the request". A mechanical streak or a real keyword still moves the model.
- Board: "other terminals on this project" in a new session's context only names sessions that reported within the last hour (an external terminal killed without a SessionEnd is no longer reported as working for up to 12 h); a single path longer than 1024 characters is never recorded as a file-map key.
- Context: a failed/timed-out git probe now reads "unknown (git probe failed)" in the injected header and the rendered context file, instead of "not indexed".
- Version bumped to 0.4.1 so an installed 0.4.0 can never pass for current.
