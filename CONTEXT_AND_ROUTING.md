# Context continuity & intelligent routing — how it works, how to use it

_Builder Hub 0.4 (2026-09), context-aware switching cost added in 0.5.0 (see section 8). Companion to `BUILDER_HUB_ARCHITECTURE.md`. Everything here runs on documented Claude Code mechanisms (hooks, slash commands, launch flags, status line); nothing depends on UI automation._

## 1. The three context layers

| Layer | Where it lives | Who writes it | When Claude sees it |
|---|---|---|---|
| **Global** — registry, Creator Stack, conventions | `~/.claude/CLAUDE.md` (marked block) → `~/.claude/builder-hub-projects.md`, `~/.claude/builder-hub/creator-stack.md` | the Hub, on every registry / stack change | every session (memory) |
| **Project** — purpose, commands, services, shared tools, decisions, tasks, known bugs, recent work, key files, fingerprint | `context.json` (userData) → rendered `~/.claude/builder-hub/context/<projectId>.md` | Reindex (auto fields, deterministic) + your notes (Context tab) + Stop-hook recaps | compact line at SessionStart; the file on demand |
| **Task packet** — objective, attempted, files changed, tests, unresolved, next action, model/effort | the session board (`board.json`) | hooks, automatically | injected at SessionStart (startup / clear / compact / fork); published to `<project>/handoffs/` on demand |

**Retrieval is progressive.** A session starts with ≤ ~2.6 k chars: one header line (project · type · stack · branch · freshness), the task packet, one line per other terminal on the same project, and three paths to read *if needed*. A prompt that names a Creator Stack capability gets that one card (≤ 900 chars). Nothing else is ever pushed; file contents are never injected.

**Freshness.** Every SessionStart and every "Check freshness" re-probes git HEAD / branch / dirty count and the CLAUDE.md + manifest mtimes. A mismatch with the fingerprint recorded at the last Reindex marks the context **STALE** and the injection says so: *"trust the files, not this summary."* Reindex records a fresh fingerprint.

## 2. The router

`src/shared/router.ts` — pure, tested, zero tokens.

**Inputs**: the latest prompt (keyword classes: light / standard / deep / max, risk words, uncertainty phrases, length, mentions of 2+ registered projects) and **session signals** accumulated from hooks: consecutive failing `test`/`build`/`lint`/`typecheck` commands, total failures/passes, distinct files edited, distinct projects touched, mechanical-turn streak, uncertainty hits, explicit max-quality asks, risk hits.

**Tiers → targets**: light = `haiku / low` · standard = `sonnet / medium` · deep = `opus / high` · max = `fable / xhigh`.

**Rules** (in order): prompt tier → max-quality ask ⇒ max → risk / cross-project ⇒ ≥ deep → ≥ 2 consecutive failures ⇒ one tier up (≥ 4 ⇒ max) → ≥ 2 uncertainty hits ⇒ one tier up → *de-escalation guard*: a lighter prompt on a session with a recent failure holds at the current tier → *no-evidence hold*: a turn with no tier keyword, no length and no signal (a "thanks, that works", a vague aside) holds at the session's current tier and shows no suggestion; only a real keyword or a clean mechanical streak moves the model. A clean mechanical streak raises confidence for de-escalation. Output: tier, target, one-sentence reason, confidence (0.5–0.95), direction (escalate / de-escalate / hold), `changes` (vs. the session's known model/effort), and the signal labels — all shown in the SessionBar.

**Modes** (`Connections → Model & effort routing`, per-project override in the project panel):
- **Manual** — nothing is recommended.
- **Suggest** (default) — the SessionBar, the Dashboard rail and (with the status line) Claude's own status bar show *"Suggested: sonnet / low — simple wording/CSS change (typo)"* with **Apply**, **At launch**, **Lock**, **✕**.
- **Auto** — a ≥ 0.75-confidence, changing recommendation is applied to an **idle** embedded session (state = done, ≥ 2 s since the user's last keystroke, not locked, not external) by typing `/model <alias>` then `/effort <level>` — the documented commands, exactly as you would. Never mid-turn.
- **Lock** — pin; no recommendations at all.

**Apply now** types the slash commands (same gates). **At launch** stores the target as the project's (or task's) custom session profile, so the next `▸ Claude` starts with `--model`/`--effort`. The existing session-profile system is untouched underneath.

**Which PTY gets the keystrokes.** Every embedded Claude session is launched with `--session-id <uuid>` (a documented flag), so the board knows exactly which Hub terminal a session id belongs to: `embedded` is decided by session id first (folder match is only the fallback after a `/clear`, and then only when exactly one Hub Claude terminal runs in that folder). An external `claude` started in the same folder is never typed into. "Idle" means the turn is over or Claude is waiting on its idle prompt — never while a permission prompt is on screen — and a dismissed suggestion is never auto-applied. After an apply the board assumes the new model/effort until the next hook confirms it, so nothing is re-typed on every turn.

## 3. Cross-terminal board

One `SessionRecord` per Claude `session_id` (embedded or external), fed only by hook payloads: state, model (SessionStart / PostModelSwitch / status line), effort (`effort.level`), files read/edited (normalized paths), commands with pass/fail detection, last test verdict, the last assistant recap, other projects touched, Creator Stack tools used, signals + recommendation. Broadcast to the UI as `hub:board`; persisted to `board.json` so the last session's packet survives a Hub restart.

**Conflict warnings** (`PreToolUse` on Edit/Write/MultiEdit/NotebookEdit): if another live session edited the same file in the last 15 minutes, or the file changed on disk after this session last read it, Claude receives one line of `additionalContext` (and you see a `systemMessage`). At most three terminals are named (labels capped at 60 chars). Never blocks — Claude Code's own "modified since read" guard still applies.

**Bounds.** The board keeps at most 300 records; ended sessions age out after 30 minutes, silent ones after 12 hours, and file maps hold the 500 most recent paths per session — except that the newest substantial session per project is kept for 7 days so the "last session" packet survives a Hub restart. Closing a Hub tab (or removing its worktree) ends its record immediately. The "other terminals on this project" lines in a new session's context only name sessions that reported within the last hour, and a single path longer than 1024 characters is never recorded. Session ids that are not well-formed (including prototype keys) are ignored. Hook bodies up to 4 MB are accepted (a Read's full content rides along in PostToolUse).

## 4. How Chris uses this

- **Starting a project**: `▸ Claude` as before. The first session gets the header line + freshness ("not indexed" until you Reindex). Open **☰ Context** → **⟳ Reindex** once: commands, services, README purpose, git fingerprint are filled deterministically. Add decisions / tasks / known bugs in the tab as they happen.
- **Using a shared tool from Income Kit**: just ask — *"create a trailer using our trailer kit"*. The prompt matches the `trailer-kit` capability; Claude receives the Trailer Factory card (path, README + PLAYBOOK to read first, entrypoints, what to change per game, "do not build a new one"). Check what any phrase would inject with **Connections → Creator Stack → What would Claude get?**
- **Switching models**: in-session `/model` keeps the conversation (nothing to do). To change for a *new* session, click **At launch** on the suggestion or set the project's session profile; the new session starts from the task packet, not from zero.
- **Clearing context**: `/clear` (or a compaction) fires SessionStart with `source: clear|compact` → the packet (objective, attempted, files changed, tests, unresolved, next) is injected. Deeper reading happens only if Claude decides it needs the context file or source.
- **Manually refreshing context**: **⟳ Reindex** (SessionBar / Context tab / project panel) for a full deterministic rescan; **Check freshness** to re-probe without rescanning.
- **Overriding / locking routing**: **Lock** on a session, **Lock** mode on a project (project panel), or **Manual** globally. **✕** dismisses one suggestion; a different target brings it back.
- **Publishing a handoff**: **⇥ Handoff** writes `<project>/handoffs/<date>-handoff.md` from the live/last session + your notes (the FounderOS-style manual brief in the project panel still exists as **⇥ Handoff** there).

## 5. Acceptance tests (spec §11) — how each is satisfied

| Test | Mechanism | Verified by |
|---|---|---|
| A — Trailer Kit discovery | UserPromptSubmit alias match → capability card injected | `creatorStack.test.ts` (ranking, card content ≤ 900 chars), Creator Stack "What would Claude get?" |
| B — Model switch continuity | `At launch` → `--model/--effort`; SessionStart packet from the last session; in-session `/model` keeps context | `contextLogic.test.ts` (packet + injection), `claudeLaunch.test.ts` |
| C — Context clear | SessionStart `source: clear|compact` → packet injection; pointers to deeper files | `contextLogic.test.ts` (resume omits packet; bounded), live `claude -p` probe of the reply path |
| D — Easy task routing | light prompt on opus/high → `haiku / low`, direction de-escalate, shown without interrupting | `router.test.ts` acceptance #1–2 |
| E — Escalation | ≥ 2 consecutive failing test commands / uncertainty → tier up; ≥ 4 → max | `router.test.ts` #5, `sessionBoard.test.ts` (fail detection) |
| F — Internal preview | Viewer loads in-project `file:` pages (containment-checked) and localhost; terminal links open in a Viewer tab; **Open ↗ / Chrome ↗** fallbacks | manual (needs the running Hub) |
| G — Parallel terminals | board keyed by session id; PreToolUse conflict warning; `otherSessionsSummary` in the injection | `sessionBoard.test.ts` (conflicts, other-sessions lines) |
| H — Stale cache | fingerprint probe at SessionStart → STALE note; `staleAfterRead` per file | `contextLogic.test.ts` (freshness reasons), `sessionBoard.test.ts` |

## 6. Limitations that depend on Claude Code

- There is no API to change a *running* session's model or effort from outside. Auto/Apply type the documented `/model` and `/effort` commands into an idle embedded PTY; external terminals must type them themselves. `At launch` is the fully supported path.
- `http`-type hooks cannot serve SessionStart, so the Hub keeps `command` hooks (curl) for every event; the reply body becomes hook stdout. Offline, the trailing `|| cd .` makes every hook a silent no-op.
- Effort changes are not announced by a hook; the board learns them from the next tool call's `effort.level` or the status line.
- The status line is the only EXACT source for context-window %, prompt-cache state and rate-limit usage. Since 0.5.0 it is installed by default (section 8.1); while it is installed Claude Code replaces its footer hints with it. The Hub never overwrites a status line you configured yourself, and without it context size is estimated from transcript usage metadata or shown as unknown.
- Switching cost is a deterministic heuristic over hook-derived counters and recap language. It cannot see what the model actually understood; it is explainable (the breakdown lists every factor and reason) and overridable (Apply, Lock, Handoff & switch).
- A capability card is injected once per session per capability (the first prompt that names it); later prompts rely on Claude having read it, and the SessionStart header names the tools already used on the project.
- Freshness is reported as **unknown** (not fresh) when the git probe fails or times out (900 ms per call), so a slow repo never passes for verified.
- Hook `additionalContext` is visible to Claude, not printed to you; `systemMessage` (conflict warnings) is.
- Keyword routing is a heuristic. It is explainable and overridable; it is not a judgment of the code.

## 7. Configuration — defaults and where things live

**`%APPDATA%\builder-hub\settings.json`** (validated on every read by `normalizeSettings`; unknown values fall back to these, never to `auto`):

```jsonc
{
  "claudePermissionMode": "bypassPermissions",   // existing (fresh-install default; present-but-invalid → "default")
  "defaultSessionProfile": { "profile": "standard" },
  "routingMode": "suggest",                       // manual | suggest | auto | lock
  "contextInjection": true,                       // SessionStart packet injection
  "conflictWarnings": true,                       // PreToolUse cross-terminal warnings
  "statusLineTelemetry": false                    // mirrors whether the Hub's statusLine is installed
}
```

Per project (registry `projects.json`, editable in the project panel): `routingMode` (absent = global), `sessionProfile` / `taskProfiles` (what **At launch** writes), `claudePermissionMode`.

**Stores** (all atomic tmp+rename with `.bak`, all rebuildable — delete any of them and the Hub regenerates):
- `%APPDATA%\builder-hub\context.json` — `{ version: 1, projects: { "<projectId>": ProjectContext } }`
- `%APPDATA%\builder-hub\board.json` — `{ version: 1, sessions: { "<sessionId>": SessionRecord } }` (live entries are marked ended on load)
- `%APPDATA%\builder-hub\creator-stack.json` — `{ version: 1, entries: [...] }` (see `CREATOR_STACK.md`)

**Rendered for Claude** (regenerated on change; safe to delete): `~/.claude/builder-hub-projects.md`, `~/.claude/builder-hub/creator-stack.md`, `~/.claude/builder-hub/context/<projectId>.md`, and the marked block in `~/.claude/CLAUDE.md`.

**`~/.claude/settings.json`** — the Hub maintains only (a) hook entries whose command contains `http://127.0.0.1:44711/hook` and (b) a `statusLine` whose command contains `/statusline` (opt-in). Everything else in that file is left byte-for-byte; a file that does not parse is left untouched and reported in Connections.

**Hook table the Hub wires** (`HUB_HOOK_SPECS`): SessionStart · UserPromptSubmit · PreToolUse (`Edit|Write|MultiEdit|NotebookEdit`) · PostToolUse · Stop · Notification · PreCompact · PostModelSwitch · SessionEnd — each `curl -s --noproxy 127.0.0.1 --connect-timeout 0.3 -m 2 -X POST http://127.0.0.1:44711/hook --data-binary @- || cd .`

**Router tiers** (`ROUTER_TIER_TARGETS`, allowlisted): light `haiku/low` · standard `sonnet/medium` · deep `opus/high` · max `fable/xhigh`. Auto-apply threshold `AUTO_APPLY_CONFIDENCE = 0.75`; idle gate 2 s; conflict window 15 min; injection cap 2600 chars; capability card cap 900 chars.

## 8. Context-aware switching cost (0.5.0 · spec v1.1)

The router still answers **"how capable a model does the next task need?"** (sections 2–3, unchanged). Since 0.5.0 a separate, deterministic calculation answers **"what would switching right now lose?"**, and only that second answer can hold back a downgrade. It never blocks an escalation.

### 8.1 The four factors (`src/shared/switchingCost.ts`)

**Context size** — how much the session holds.
- *Exact*: Claude Code's status line (`context_window.used_percentage`, `context_window_size`, `current_usage`). The Hub's status line is now **installed by default** at startup so this does not depend on remembering a setup step. It is never installed over a status line you configured yourself, and removing it in Connections keeps it removed (the setting is stored as `false`). Deleting it by hand from `~/.claude/settings.json` is not an opt-out: the next launch reinstalls it. Use the Connections toggle.
- *Estimated*: when the status line has not reported in the last 10 minutes, the Hub reads the **tail** (256 KB) of the session transcript at the end of each turn and sums the last main-thread assistant turn's usage metadata (input + cache creation + cache read + output tokens). Only numbers are read, only inside `~/.claude/projects`, and never the whole transcript. The percentage is computed only when the window is actually known: a `[1m]` model id, or more tokens than a 200k window can hold. Otherwise the token count is shown without a percentage.
- *Unknown*: neither source available. Shown as unknown, treated as a middling size in the score, and auto mode will not downgrade.
- Classes: Low < 25% ≤ Moderate < 50% ≤ High < 80% ≤ Very High (token-only estimates: 60k / 150k / 400k).

**Context value** — large is not the same as valuable. A 0–100 score from counters the board reducer accumulates **incrementally** from hooks (the `ContinuityLedger` on each session record; no transcript content):

| Raises value | Lowers value |
|---|---|
| turns that edited files (6 each, max 30) | exploration-heavy sessions: read/search-only turns > 2× edit turns with no constraint found (−12) |
| passing test/build/lint/typecheck after edits (5 each, max 10) | compactions (−10 each, max −20): that context is already summarized |
| recaps recording a decision (5, max 20) or a root cause (8, max 16) | no substantive work for 6 h (×0.5) or 24 h (×0.25) |
| recaps establishing a constraint or negative finding (4, max 12) — research without edits still counts | |
| 3+ files changed (+8; 8+ files +12), cross-project changes (+8) | |
| a fix in progress: last check failing after edits (+12) | |
| approved implementation choices ("go ahead", "yes, do it") (3, max 6) | |

Classes: Low < 20 ≤ Moderate < 40 ≤ High < 65 ≤ Critical.

**Task continuity** — how much the next task depends on this session. Judged from the latest prompt against the session's objective, last recaps and the files it changed:
- *Very Low*: the prompt names another registered project ("open Gnarly Nutmeg and …").
- *Low*: a strong task boundary (below), or a request that shares little with the objective.
- *Moderate*: partial word overlap, a weak boundary ("next, …"), or a prompt too short to judge (marked **not confident**, so auto never acts on it).
- *High*: the prompt touches a file this session changed, uses continuation language ("the remaining test", "keep going", "fix that"), or overlaps the objective strongly.

**Task boundaries** are detected on every prompt. *Strong*: another project named; explicit "that's done / new task / moving on" language; or the last recap reported completion with checks green and the new request is unrelated. *Weak*: "next / now let's" with limited overlap. At a strong boundary the Hub closes the old objective (the next prompt becomes the new objective), checkpoints the closed objective into project context, lowers continuity, and reassesses.

**Capture adequacy** — how much of that value the Hub has already persisted. A recap existing is not enough:
- *Poor*: edits not yet followed by a capture, or nothing captured at all.
- *Partial*: a failing check that lives only in the session; more substantive turns since the last handoff than the task packet carries (3 recaps); decision/finding recaps not recorded as decisions; no objective.
- *Good*: recent work is covered by the task packet.
- *Excellent*: a handoff was published after the last substantive work and nothing is failing.
Publishing a handoff (SessionBar ⇥ Handoff, the Context tab, or **Handoff & switch**) resets the since-handoff counters; recording decisions in the Context tab clears the "decisions only in recaps" gap.

### 8.2 Switching risk and policy

`risk = size × value × continuity × (1 − capture)` with fixed weights (`SWITCHING_WEIGHTS`): size .25/.5/.8/1 (unknown .6), value .1/.45/.75/1, continuity .1/.3/.6/1, capture gap 1/.7/.35/.05. **High ≥ 0.30 > Moderate ≥ 0.10 > Low.**

Only a real downgrade is affected (`applySwitchingPolicy`):
- **High** → *hold*. The current model stays; the cheaper target is kept as the deferred target; no auto; the SessionBar shows 🛡 **Stay on <model> — valuable context** with **Stay · Handoff & switch · Reassess · Lock**. Reason: "finish on <model> and reassess at the next task boundary".
- **Unknown** → the same hold as High. Risk is unknown when context is high or very high but the ledger has observed fewer than `SWITCHING_LIMITS.minHistoryTurns` (5) turns, which is too little history to judge its value (e.g. a session that predates the ledger). Value shows as *unknown (insufficient context history)*, the assessment is not confident, and the Stay row reads "not enough context history to judge this context's value". Unknown size never triggers it.
- **Moderate** → the suggestion is shown, auto is forbidden, and **Handoff & switch** is offered.
- **Low** → normal behavior, labeled "low switching risk". Auto may apply it only if the assessment is confident, nothing is failing, and valuable context is not poorly captured.

Escalations (repeated failures, risk words, architecture, cross-project, explicit max quality) pass through untouched. Locks, dismissals, manual mode and the existing auto gates all still apply first.

**Handoff & switch** publishes the handoff (objective, decisions, files changed, tests, unresolved issues, next action — the packet, never the transcript), marks the session captured, then switches to the deferred target: typed into the idle embedded session when that is safe, otherwise saved as the project's or task's profile for the next launch. **Reassess** re-reads the context size and recomputes. The risk chip expands into the full breakdown: task complexity, context utilization, value, continuity, capture, risk and the reasons behind each.

### 8.3 Acceptance scenarios (all are unit tests in `switchingCost.test.ts`)

| | Scenario | Result |
|---|---|---|
| A | valuable 95% context, next prompt continues the work | hold on the premium model, risk **high** |
| B | exploratory 95% context, simple task | value low, risk low, downgrade recommended (auto allowed) |
| C | valuable 95% context, prompt opens another project | continuity very low, strong boundary, downgrade allowed |
| D | valuable context after a published handoff | capture excellent, risk low, switch allowed |
| E | valuable context with uncaptured edits | capture poor, held; small-context variant never auto-downgrades and offers a handoff |
| F | repeated failures + architecture on a cheaper model | escalates to max despite high switching risk |
| G | no context data | size **unknown**, no fake percentage, not confident, auto forbidden |
| H | objective completed, unrelated trivial request | strong boundary, continuity low, downgrade allowed |

### 8.4 Agent concurrency (minimal foundation)

`SubagentStart` / `SubagentStop` hooks now count agents per session (active, peak, total). The SessionBar shows `agents N` and turns amber above the configurable **Agent concurrency ceiling** (Connections, default 8). This is a warning only.

### 8.5 v1.2 proposal — agent, concurrency and projected-cost governance (not built)

What a real governor needs and why it was left out of v1.1:
1. **Approval before a large premium swarm.** Needs an interception point *before* agents start. `SubagentStart` fires after launch and cannot block. The candidates are a `PreToolUse` hook on the `Agent`/`Workflow` tools returning `permissionDecision: "ask"`, which must first be verified to prompt at all under `bypassPermissions` (the Hub's default mode), and a way to read the planned agent count from a Workflow script before it runs.
2. **Premium versus cheaper workers.** `SubagentStart` carries `agent_type` but not the model. Distinguishing them needs the agent definition's `model` (resolvable for named agent types from `.claude/agents/*.md`) or the model on the subagent transcript's first assistant record (`agent_transcript_path` on `SubagentStop`, i.e. after the fact).
3. **Projected cost.** Combine model × effort × planned agents × expected turns with the status line's `rate_limits` and `cost` fields into a pre-launch estimate, and route "justified parallelism" through the same explainable score style as switching cost.
4. **Policy.** Per-project ceilings, a premium-agent sub-ceiling, and an approval card in the SessionBar, with the same never-block-quality rule: a ceiling may ask, not silently refuse.
