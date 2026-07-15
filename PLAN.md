# Builder Hub — Build Plan

_Local-first command center ("FounderOS v2"): open/create projects → drop into an embedded Claude Code terminal, with focused tools per project type and a Claude that already knows the whole stack._
_Folder name `builder-hub` is a working title — rebrand freely (e.g. "FounderOS")._

## Locked decisions
- **Shell:** Electron + **Vite/React + TypeScript + Tailwind** (via `electron-vite`). No Next.js.
- **Data:** **local-first JSON store** (`projects.json` in userData; app preferences alongside it in `settings.json`). SQLite/better-sqlite3 was tried and dropped — it needs native compilation (ClangCL toolset missing here) and a JSON file is plenty for a personal registry. No login, no Firebase, no OAuth.
- **Claude:** **embedded terminal** (`xterm.js` + `node-pty`) running the real `claude` CLI in the project's folder → stays on the **Max plan**, keeps all MCP/tools.
- **Harvest FounderOS's brains** (`C:\Users\chris\Personal-IDE\founderos`): data model, scoring engine, handoff generator. Replace its shell/build/auth. (Its shadcn UI + 10-tab project detail were evaluated and **deliberately skipped** in Tier 4 — the Hub keeps its hand-rolled Tailwind UI.)
- **Stack awareness** is wired globally: `~/.claude/CLAUDE.md` + `~/.claude/stack-profiles/*` + `C:\Users\chris\TOOL-STACK.md`.

## Why this won't repeat v1's pain
| v1 (FounderOS) pain | v2 fix |
|---|---|
| Google OAuth inside Electron (fragile, leaked secret) | No auth at all — local-first |
| Next.js static-export served over a loopback port | Plain Vite renderer + direct IPC |
| Firebase cloud-coupling | A JSON file on disk |
| Bleeding-edge Next 16 | Stable Vite/React |

## Build-environment gotchas (this machine)
Native modules + this machine's proxy/AV make installs finicky. See the full playbook in memory `reference_node_tls_proxy`. Short version:
- **Installs that download binaries** (Electron): run with `NODE_OPTIONS=--use-system-ca` (TLS-inspecting proxy).
- **node-gyp builds**: need `setuptools` (distutils shim for Python 3.13) and `npm_config_python=C:\Python313\python.exe`; `better-sqlite3` also wanted the missing ClangCL toolset → we avoided it.
- **Norton EBUSY** locks on fresh Electron files are transient → kill `electron`, clear `node_modules\.electron-*`, retry.
- **Rule of thumb:** avoid native deps when a pure-JS option exists. The only unavoidable one is `node-pty` (Phase 3).

## Phased roadmap (each phase ends at something you can SEE)

### ✅ Phase 0 — Stack-awareness layer
Two layers, so **any project opened in the Hub knows the full toolbox + its focused stack**:
1. **Global** — `~/.claude/CLAUDE.md` (user memory, loads in every Claude session) points at `TOOL-STACK.md` + the 8 `stack-profiles`.
2. **Per-project (Hub-guaranteed)** — opening ▸ Claude runs `ensureStackAware`: if the project has no `CLAUDE.md`, the Hub seeds one pointing at `TOOL-STACK.md` and inlining the matching stack-profile (never overwrites an existing one). The wizard seeds the same for new projects. **Done.**

### ✅ Phase 1 — Shell that runs
`electron-vite` app with the dashboard layout + verified renderer↔main IPC bridge. **Done.**

### ✅ Phase 2 — Local-first project registry
JSON store; first-run **auto-seed** of ~33 real projects (existing dirs only) from a curated list; folder-based type detection; **Add Project** (folder picker) + **Rescan home**; Projects grid (filter / search / favorite), Dashboard (counts / recent / favorites), detail slide-over (edit type/status/stack/notes); **launch buttons** — Open Folder, Editor (Cursor→VS Code), Terminal, and Claude (opens Claude Code in a `wt` terminal at the folder). **Done.**

### ✅ Phase 3 — Embedded Claude Code terminal ⭐
`xterm.js` pane + **@homebridge/node-pty-prebuilt-multiarch** spawning `cmd /k claude` in the selected project's cwd, inside the hub (per-project tabs, resize/fit). The ▸ Claude button now opens an in-app session instead of an external terminal. **Done & verified** — pty loads under Electron 33 (abi 130) and spawns. (Used the prebuilt fork because official node-pty's winpty build is blocked by Norton's script control.)

### ✅ Phase 4 — New-project wizard
**＋ New Project** modal (name · type grid · location/Browse · git + open-Claude toggles) → scaffolds the folder with a `CLAUDE.md` seeded from the matching `stack-profile` + `.env.example` (per-type key names) + `README.md` + `.gitignore` + `git init`, adds it to the registry, and drops you into an embedded Claude session. "Add existing" / "Rescan home" moved to the Projects toolbar. **Done** (typecheck + build green).

### ✅ Phase 5 — Polish, tests & package (core done)
- ✅ **Connections panel** (Settings→Connections): originally a read-only list of MCP servers from `~/.claude.json` + each project's `.mcp.json`. **Superseded by Tier 3 below** — it's a full MCP manager now.
- ✅ **Vitest harness**: pure logic lives in `src/shared/*` (no electron/fs imports) so it's unit-testable — `projectLogic`, `hubLogic`, `sessionLogic`, `mcpLogic`, `scoring`, `handoff`, `claudeLaunch`. **144 tests green** (`npm test`).
- ✅ **ESLint (flat config) + Prettier**: `npm run lint` / `npm run format`. The React-Compiler rules from react-hooks v7 and `no-unescaped-entities` are disabled deliberately.
- ✅ **Packaged**: `electron-builder` → NSIS installer `dist/builder-hub-<version>-setup.exe` (~82 MB; version follows package.json). `node-pty` asar-unpacked so the embedded terminal works installed; Desktop + Start-menu shortcuts; `npmRebuild: false` (uses the prebuilt fork). Run `npm run build:win`.
- ✅ Custom app icon (`build/icon.ico`, generated from `build/icon.png` via `build/build-icon.cjs`).
- Optional polish (not done): code signing (avoids SmartScreen warning), theming.

### ✅ Workspace viewer tabs (post-Phase-5)
Unified the terminal view into **Workspace** — per-project mixed tabs: Claude terminal + an **embedded Chromium browser** (`<webview>`, URL bar, back/fwd/reload, persistent `persist:hub` session). Per-type default URLs (roblox→Creator Dashboard, hytopia→play.hytopia.com, web→localhost:5173…), an **Open in Chrome** button (launches real `chrome.exe`), and **Launch Roblox Studio** (finds `RobloxStudioBeta.exe`) on roblox projects. Native apps launch externally — you can't host another app's window as a tab; Claude drives Studio via the Roblox_Studio MCP. Each project has a **URL field** + roblox projects get **▶ Play in Roblox** (launches the published game in the native Roblox Player via a `roblox://` deep link from the game's URL/place ID); the Viewer opens that URL when set.

### ✅ Tier 1+ — Cockpit foundations (2026-07-01)
Terminal clipboard (smart paste: clipboard image → temp PNG path for Claude vision; drag-drop file → quoted path), **Files pane** (in-app tree + image/video/audio/PDF/text preview via guarded `hubfile://`, "Send to Claude"), **hub-wide Claude context** (`~/.claude/builder-hub-projects.md` + marked block in global CLAUDE.md + `BUILDER_HUB_PROJECTS` env — every Claude session can resolve any project by name), embedded **Shell tabs**, git badges + Dashboard triage.

### ✅ Tier 2 — The cockpit trio (2026-07-02)
1. **Hooks → Hub**: Claude Code hooks (UserPromptSubmit/PostToolUse/Stop/Notification/SessionEnd, auto-wired idempotently into `~/.claude/settings.json`) POST to a localhost listener (port 44711, 204-empty replies so hook stdout stays silent; Origin-header spoofing rejected). Native toasts when a session needs you and the Hub is unfocused (`setAppUserModelId` for packaged builds; single-instance lock).
2. **Status board**: working/waiting/done dots on Claude tabs, amber sidebar pulse, Dashboard "Claude sessions" rail (click-to-focus, dismiss) — external sessions show too. All cwd keys normalized (`normPath`) because git porcelain emits forward slashes on Windows.
3. **Task sessions**: per-task git worktrees (`hub/<task>` branch in `<project>.worktrees/<task>`, CLAUDE.md copied in), Claude tab per task, **⇄ Diff tab** (merge-base vs main branch incl. uncommitted, untracked list, 1MB cap) with **Merge back** (MERGE_HEAD/detached-HEAD guards, abort-own-merge-only) and **Discard**; removal kills the task's PTYs first (Windows cwd lock) and retries.

### ✅ Tier 3 — MCP manager + punch-list (2026-07-02)
Connections graduated from a read-only lister into a **live one-click MCP manager** wrapping the real `claude` CLI (`src/main/mcp.ts`, `ConnectionsView.tsx`, `src/shared/mcpLogic.ts`):
1. **Live status** — `mcp:live` runs `claude mcp list` and parses it with `parseMcpList`, which is deliberately **glyph-agnostic** (it classifies on status *text*, because ✔/✘ mojibake through Windows codepages). Add / remove / sign-in / sign-out per server.
2. **Curated catalog** — one-click add for github, context7, sentry, linear, notion, vercel, netlify, stripe (every URL verified against the live CLI, none guessed) + custom add-by-URL. claude.ai-synced connectors are bucketed separately: no Remove/Sign-out (they're managed on claude.ai), Sign in kept.
3. **CLI exec safety** — `runClaude` resolves the native `claude.exe` and `execFile`s it with **`shell: false`** (argv array → no injection, spaces safe). A `.cmd`/`.bat` shim routes through `cmd.exe /d /s /c`. `shell: true` is never used: it concatenates args unquoted.
4. **Punch-list cleared** — status filter chips + archived projects dimmed/sunk in `compareProjects` (#7); rescan descends one level into grouping folders like `New-apps/*` (#8); ESLint + Prettier adopted (#9).

### ✅ Tier 4 — FounderOS harvest: focus scoring + handoffs (2026-07-08)
The lean port of FounderOS's remaining brains (full 10-tab detail + shadcn deliberately skipped — the Hub keeps its hand-rolled UI):
1. **Scoring engine** (`src/shared/scoring.ts`): `calculateFocusScore` (FounderOS weights — revenue 30 / strategic 25 / excitement 20 / readiness 15 / inverted effort 10; ready-for-build ×1.10, launch-prep ×1.15, blockers ×0.8) + `calculateHealth` (green/yellow/red with reasons; activity = max(updatedAt, lastOpenedAt)) + `rankByFocus`.
2. **Data model**: optional `stage` (8 stages) + 5 score inputs + `blockers`/`nextAction`/`currentFocus` + brief fields (`shortDescription`, `problemSolved`, `targetAudience`, `monetizationModel`, `mvpDefinition`) on `Project` — no migration needed, editable whitelist extended.
3. **Handoff generator** (`src/shared/handoff.ts`): `generateHandoff` + `buildClaudeBuildPrompt` + `buildMvpPlanPrompt` (FounderOS's toolchain section dropped — CLAUDE.md seeding already covers it). `handoff:save` IPC writes `<project>/handoffs/<date>-<slug>.md` (path resolved from the registry, never from the renderer; suffixed -2/-3 rather than overwriting).
4. **UI**: Dashboard "Today's Focus" rail (top 5 active by score, health dots, next actions) + Blocked stat; ProjectDetail "Focus & health" section (stage, score inputs, next action, blockers) + collapsible Brief + ⇥ Handoff modal (live preview, copy / save-to-project).

**Reviewed 2026-07-13 (`6e6c2fe`) — this port shipped with 5 bugs, all now fixed.** Worth knowing because two of them shaped the design:
- **The focus score is normalized, not clamped.** The 5 weights already sum to a max of 10, so *any* stage boost overshot a `Math.min(10)` clamp — every project with a base ≥8.7 tied at exactly 10.0 and `rankByFocus`'s alphabetical tiebreak then ranked a **worse** project first. It now divides by `MAX_BOOST` (1.15), which preserves the true ordering. Consequence: **10.0 is reserved for a perfect, unblocked, launch-prep project**, and unboosted scores read ~13% lower than a plain weighted average (all-5s = 4.3, not 5.0).
- **A patch uses `null` to clear a field, `undefined` to leave it alone** (`ProjectPatch` in `types.ts`, applied by `applyProjectPatch` in `projectLogic.ts`). Before this, an optional field like `stage` could be *set but never unset* — "clear" arrived as `undefined`, indistinguishable from "not in this patch". Keep the distinction when adding editable fields.

### ✅ Claude permission mode (2026-07-13)
Embedded sessions can now launch with permission checks relaxed or fully bypassed — "the dangerously-skip-permissions thing", built as a real **mode** rather than a binary toggle.
1. **Settings store** (`src/main/settings.ts`): `settings.json` in userData, same atomic write pattern as `db.ts` (tmp + rename, `.bak`). First app preference; add future ones to `HubSettings`. A failed write does **not** throw, but it does return `{ ok: false }` — see the trap below.
2. **The mapping is pure and allowlisted** (`src/shared/claudeLaunch.ts`): `default` → no flag · `acceptEdits` → `--permission-mode acceptEdits` · `bypassPermissions` → `--dangerously-skip-permissions` (verified against claude 2.1.207; equivalent to `--permission-mode bypassPermissions`). Both the embedded PTY and the external `wt`/`start` launcher build their argv from it, so they can't drift.
3. **Security:** the renderer picks a mode *string*; **main** turns it into flags. `normalizeSettings()` validates on every read and every write, so an unknown value can never reach argv. `PtyCreateOptions` deliberately has **no** mode/argv field.
4. **UI:** Connections → "Claude sessions" segmented control (amber for Bypass + a warning); Workspace Claude tabs opened in bypass carry a `⚠ bypass` chip. The mode applies at launch — running sessions keep the mode they started with.

**Trap 1 — a lost save must not read as success.** `settings.json` is what gates `--dangerously-skip-permissions`, so `setSettings()` returns `SettingsSaveResult { ok, settings }`: the mode always applies in-memory, but `ok: false` means it never reached disk. Without that split, a Bypass→Ask downgrade whose write failed (AV lock, read-only, full disk) would toast "saved" and then come back up **in bypass** on the next launch. Don't collapse it back to a bare `HubSettings`.

**Trap 2 — the first bypass session shows a disclaimer, not a session.** claude gates bypass behind a one-time "WARNING: Claude Code running in Bypass Permissions mode" confirm (default: *No, exit*), then records `skipDangerousModePermissionPrompt` in `~/.claude/settings.json`. Chris's machine already has that flag, which is why bypass starts clean here — a fresh profile will sit on the prompt until it's answered. The Hub **does not** write that flag for the user; accepting "disable every safety check" is theirs to do, once, in the terminal.

**Trap 3 — bypass mostly kills the amber dot.** In bypass mode Claude's Notification hook stops emitting `permission_prompt` (no prompts exist), so the cockpit's **waiting** state largely disappears for those sessions — they read `working` → `done`. Expected, not a broken hook.

### ✅ Session profiles — model + effort routing (2026-07-15)
Route each Claude session to the right model at the right effort, so Max-plan usage goes to the work that needs it: **Deep** (`--model opus --effort high`), **Standard** (no flags — Claude's own default), **Light** (`--model haiku --effort low`), or **Custom** (model/effort hand-picked from closed allowlists). Flags verified against claude 2.1.210: `--model` aliases fable/opus/sonnet from `--help`, `haiku` confirmed from the installed binary's model picker; `--effort` levels low|medium|high|xhigh|max.
1. **Resolution happens in main, not the renderer:** task override → project `sessionProfile` → global `defaultSessionProfile` → standard (`resolveSessionConfig` + `sessionArgs` in `claudeLaunch.ts`, both pure and tested). The embedded PTY and the external `wt`/`start` launcher compose these with the permission-mode flags from the same choke point, so the paths can't drift. The renderer still never sends argv — per-project/per-task choices are registry fields (through `EDITABLE_FIELDS`), and `normalizeSessionConfig` re-validates at launch time, so a garbage value on disk can never reach argv.
2. **Auto-suggest** (`suggestProfile`): a pure keyword heuristic (refactor/debug/port/research… → Deep; typo/rename/docs/bump… → Light) defaults the task-creation picker. Zero tokens spent deciding; an Auto pick that suggests Standard stores nothing, so the task inherits the project/global profile.
3. **UI:** Connections → default profile picker (with custom model/effort selects); ProjectDetail → per-project picker + per-task Auto picker at task creation + profile tag on task rows; Workspace Claude tabs carry a profile chip (label-only — same caveat as the ⚠ bypass chip).
4. Removing a task deliberately keeps its `taskProfiles` entry — recreating the same task name keeps its profile.

### Phase 7 — Security cleanup (code done; **rotation still pending — user action**)
The **code** fixes have shipped in those repos: `The-Classified-Files/config.js` reads `process.env.STABILITY_API_KEY`, and old founderos's `useAuth.tsx` reads the server-only `GOOGLE_OAUTH_CLIENT_SECRET` (no `NEXT_PUBLIC_*` secret remains). What's left is **provider-side key rotation**: rotate the Stability AI key at platform.stability.ai, and the OAuth client secret in Google Cloud Console.

## Known debt
- **Electron is pinned to 33 (33.4.11); current is 43.** Out of Electron's 3-major support window → no security backports, in an app that renders remote content in `<webview>` tabs. **Top hygiene item.** The upgrade is gated on a matching `node-pty` prebuilt ABI (33 = abi 130) — verify in a scratch worktree first.
- `sandbox: false` in the main window (`src/main/index.ts`) — punch-list #5, never flipped. The `will-attach-webview` / `will-navigate` guards are in place around it.
- Tier 5 (headless `claude -p` dispatch, morning briefing) is **gated** on confirming whether non-interactive `claude -p` draws from a metered credit pool rather than the Max plan.

## Run it
```
npm install        # one-time (needs NODE_OPTIONS=--use-system-ca for the Electron download)
npm run dev        # opens the Builder Hub window
npm run typecheck
npm test           # Vitest — 167 tests
npm run lint       # ESLint
npm run build:win  # NSIS installer → dist/
```
