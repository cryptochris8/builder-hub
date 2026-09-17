# Builder Hub (this app)

**Local-first Electron command center** — open or create a project and drop straight into an embedded Claude Code terminal. This is the clean-foundation **v2 of FounderOS**. Read **[PLAN.md](./PLAN.md)** for the locked decisions, the phased roadmap, and known debt.

> This file replaces the generic web-app profile the Hub auto-seeds. That profile recommended **Next.js** and **shadcn/ui** — both of which this project has explicitly **rejected** (see Locked decisions). Don't reintroduce them here.

## Stack (what this app actually is)
**Electron 33 + electron-vite · Vite · React 19 · TypeScript · Tailwind v4 · xterm.js + node-pty.** Data is a **local-first JSON store** in userData. No Next.js, no Firebase, no auth, no server.

## Locked decisions — don't relitigate
- **No Next.js.** Plain Vite renderer + direct IPC. (v1 served a Next static export over a loopback port; it was a mess.)
- **No shadcn/ui, no component library.** The UI is hand-rolled Tailwind — match the surrounding style rather than introducing primitives.
- **No auth, no cloud, no Firebase.** A JSON file on disk. This is a personal, single-user, local app.
- **No SQLite / heavy state libs.** `better-sqlite3` was tried and dropped (needs native compilation; ClangCL toolset missing on this machine). The crash-safe JSON store is right-sized.
- **Avoid native deps when a pure-JS option exists.** `node-pty` is the one unavoidable exception, and it's the `@homebridge/node-pty-prebuilt-multiarch` **fork** (official node-pty's winpty build is blocked by Norton's script control). **Electron is pinned to 33 because that's the ABI the prebuilt matches** — an Electron upgrade is gated on a matching prebuilt; verify in a scratch worktree first.

## Architecture & conventions
- `src/main/*` — Electron main: IPC handlers, PTY lifecycle, git, the JSON store, the hook listener. Keep it **thin**.
- `src/preload/index.ts` — the single typed IPC bridge. `contextIsolation: true`, `nodeIntegration: false`.
- `src/renderer/src/*` — React UI. Imports shared types via the `@shared/*` alias.
- **`src/shared/*` — all pure logic, with no `electron`/`fs` imports.** This is the load-bearing convention: it's the only code that can be unit-tested, so **push logic down here rather than writing it inline in main or a component.** Every bug that has bitten this project twice lived in untestable main-process code.
- **Tests: Vitest, and every piece of logic gets one.** `npm test`. Run `npm run typecheck`, `npm test`, and `npm run lint` before claiming done — all three must be green.
- **0.4 orchestration layer** (`BUILDER_HUB_ARCHITECTURE.md`): `src/shared/router.ts` (model/effort recommendation), `sessionBoard.ts` (per-session reducer over hook payloads), `contextLogic.ts` (project context, task packet, SessionStart injection), `creatorStack.ts` (shared-tools registry + prompt matching), `markdown.ts` (safe renderer). Main glue: `main/orchestrator.ts` (hook replies, IPC), `contextStore.ts`, `projectIndex.ts`, `creatorStack.ts`, `statusLine.ts`. **Hook replies are the only channel back into Claude** — SessionStart / UserPromptSubmit / PreToolUse get `additionalContext`; Stop and everything else stay empty (a Stop reply could block Claude).

## Gotchas learned the hard way
- **A project patch uses `null` to CLEAR a field and `undefined` to leave it alone** (`ProjectPatch` / `applyProjectPatch`). Sending `undefined` to clear is indistinguishable from "not in this patch" — that bug let `stage` be set but never unset. Preserve the distinction when adding editable fields.
- **The focus score is normalized by the max stage boost, not clamped.** The weights already sum to 10, so a `Math.min(10)` clamp tied every strong project at exactly 10.0 and the ranking silently fell through to an alphabetical tiebreak. Don't reintroduce a clamp.
- **Windows path keys must go through `normPath`** — git porcelain emits forward slashes while the Claude hooks emit backslashes; the status board keys on cwd.
- **Never `shell: true` when invoking the `claude` CLI.** It concatenates args unquoted (injection + breaks on spaces). Use `execFile` with an argv array; a `.cmd` shim routes through `cmd.exe /d /s /c`.
- **Windows can't delete a directory that is some process's cwd** — kill a worktree's PTYs before removing it.
- **Secrets never reach the renderer.** The handoff writer resolves its output path from the registry by project *id*; the renderer never sends a path. Keep it that way.
- **The renderer never passes argv into `pty:create`.** It picks a *permission mode* (one of three allowlisted strings); **main** resolves that into `claude` flags via `claudeArgs()` in `src/shared/claudeLaunch.ts`. The mode itself comes from `resolvePermissionMode(project, settings)` — **per-project `Project.claudePermissionMode` override → global `settings.claudePermissionMode`** — re-validated with `isPermissionMode`, so a garbage stored value falls through rather than reaching argv. `normalizeSettings()` is the global choke point. Don't add a mode (or any argv) field to `PtyCreateOptions`.
- **Bypass is the out-of-box default, but only for a *fresh* install.** `DEFAULT_SETTINGS.claudePermissionMode` is `bypassPermissions` (this is a personal, single-user cockpit; projects opt *out* per-project). Crucially, that default is reached only when the mode key is **absent**. A key that's **present but invalid** fails SAFE to `default` (`SAFE_MODE_FALLBACK` in `normalizeSettings`) — corruption/tampering must never *fail open* into "skip every safety check". Keep those two paths distinct.
- **The first `bypassPermissions` session on a machine opens a disclaimer, not a session.** `claude` gates bypass behind a one-time *"WARNING: Claude Code running in Bypass Permissions mode"* confirm (default answer: **No, exit**) and remembers it as `skipDangerousModePermissionPrompt` in `~/.claude/settings.json`. This machine already has that flag, so bypass looks like it starts clean — **don't conclude the prompt doesn't exist** (a docs check and a subagent both got that wrong; only reading the installed binary caught it). A fresh profile sits on the prompt until it's answered. The Hub must **not** write that flag on the user's behalf.
- **A failed `settings.json` write must never report success.** `setSettings()` returns `SettingsSaveResult { ok, settings }` — the mode applies in-memory regardless, but `ok: false` means it never hit disk. Collapse that back to a bare `HubSettings` and a Bypass→Ask downgrade whose write failed will toast *"saved"* and then come back up **in bypass** next launch. This is the one setting where failing open is dangerous.
- **`resolveSessionProject` is LONGEST-prefix.** The registry nests projects (`Fable-5-1-week` ⊃ `projects/leaguecast`); a first-match resolver mislabelled nested sessions and launched them with the parent's profile/mode. Keep the longest match.
- **Hook commands end with `|| cd .`** so a closed Hub is a silent no-op (hooks run under Git Bash; `cd .` also succeeds in cmd). `ensureHubHooks` maintains per-event matchers (`HUB_HOOK_SPECS`) — PreToolUse is narrowed to edit tools on purpose.
- **`http`-type hooks cannot serve SessionStart** (verified 2.1.273) — don't "modernize" the transport; the curl reply body is what carries context back.
- **Apply/Auto routing types `/model` + `/effort` into the PTY** — only via `applyRecommendationToPty` (allowlisted commands, idle gate, Claude PTYs only). Never write anything else into a PTY from main.
- **The Hub was running during the 0.4 build** (`BUILDER_HUB=1` in the session) — main-process changes were verified by tests/typecheck/lint/build only; a live pass through `CONTEXT_AND_ROUTING.md` §5 after a restart is the remaining verification.
- **Switching cost only ever affects DOWNGRADES** (`applySwitchingPolicy` in `src/shared/switchingCost.ts`). Never let it hold an escalation, and never let auto mode downgrade when `autoAllowed === false`. Context size is exact only from the status line; a transcript estimate may show a percentage only when the window is known (`inferContextWindow`) — never compute % against a guessed window.
- **`bypassPermissions` mostly kills the amber "waiting" dot.** The cockpit's `waiting` state is fed by Claude's Notification hook, and in bypass mode the `permission_prompt` notification no longer fires (only `idle_prompt` does) — because there are no permission prompts. So a bypass session looks like it goes `working` → `done` with nothing in between. That's expected, not a broken hook; don't "fix" the status board for it.

## Tools & stacks available to me
- **Full tool catalog** — every tool / service / API I use, and where each API key lives: `C:\Users\chris\TOOL-STACK.md`. Prefer tools I already have.
- **Stack profiles** (for the projects the Hub *opens*, not for the Hub itself): `C:\Users\chris\.claude\stack-profiles`.
