# Builder Hub — Build Plan

_Local-first command center ("FounderOS v2"): open/create projects → drop into an embedded Claude Code terminal, with focused tools per project type and a Claude that already knows the whole stack._
_Folder name `builder-hub` is a working title — rebrand freely (e.g. "FounderOS")._

## Locked decisions
- **Shell:** Electron + **Vite/React + TypeScript + Tailwind** (via `electron-vite`). No Next.js.
- **Data:** **local-first JSON store** (`projects.json` in userData). SQLite/better-sqlite3 was tried and dropped — it needs native compilation (ClangCL toolset missing here) and a JSON file is plenty for a personal registry. No login, no Firebase, no OAuth.
- **Claude:** **embedded terminal** (`xterm.js` + `node-pty`) running the real `claude` CLI in the project's folder → stays on the **Max plan**, keeps all MCP/tools.
- **Harvest ~60% of FounderOS** (`C:\Users\chris\Personal-IDE\founderos`): data model, shadcn UI + 10-tab project detail, scoring engine, handoff generator. Replace its shell/build/auth.
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
- ✅ **Connections panel** (Settings→Connections): lists MCP servers from `~/.claude.json` + each project's `.mcp.json`, explains how claude.ai connectors sync into Claude Code, GitHub-MCP add helper (copy), write-access note. GitHub already works via `gh` (authed, `repo` scope).
- ✅ **Vitest harness**: pure logic extracted to `src/shared/projectLogic.ts` (sanitizeFolder, compareProjects, envExampleFor, detectTypeFromFiles); **19 tests green** (`npm test`).
- ✅ **Packaged**: `electron-builder` → NSIS installer `dist/builder-hub-<version>-setup.exe` (~82 MB; currently 0.2.1). `node-pty` asar-unpacked so the embedded terminal works installed; Desktop + Start-menu shortcuts; `npmRebuild: false` (uses the prebuilt fork). Run `npm run build:win`.
- ✅ Custom app icon (`build/icon.ico`, generated from `build/icon.png` via `build/build-icon.cjs`).
- Optional polish (not done): code signing (avoids SmartScreen warning), "Today's Focus" ranking + dashboard KPIs, theming.

### ✅ Workspace viewer tabs (post-Phase-5)
Unified the terminal view into **Workspace** — per-project mixed tabs: Claude terminal + an **embedded Chromium browser** (`<webview>`, URL bar, back/fwd/reload, persistent `persist:hub` session). Per-type default URLs (roblox→Creator Dashboard, hytopia→play.hytopia.com, web→localhost:5173…), an **Open in Chrome** button (launches real `chrome.exe`), and **Launch Roblox Studio** (finds `RobloxStudioBeta.exe`) on roblox projects. Native apps launch externally — you can't host another app's window as a tab; Claude drives Studio via the Roblox_Studio MCP. Each project has a **URL field** + roblox projects get **▶ Play in Roblox** (launches the published game in the native Roblox Player via a `roblox://` deep link from the game's URL/place ID); the Viewer opens that URL when set.

### ✅ Tier 1+ — Cockpit foundations (2026-07-01)
Terminal clipboard (smart paste: clipboard image → temp PNG path for Claude vision; drag-drop file → quoted path), **Files pane** (in-app tree + image/video/audio/PDF/text preview via guarded `hubfile://`, "Send to Claude"), **hub-wide Claude context** (`~/.claude/builder-hub-projects.md` + marked block in global CLAUDE.md + `BUILDER_HUB_PROJECTS` env — every Claude session can resolve any project by name), embedded **Shell tabs**, git badges + Dashboard triage.

### ✅ Tier 2 — The cockpit trio (2026-07-02)
1. **Hooks → Hub**: Claude Code hooks (UserPromptSubmit/PostToolUse/Stop/Notification/SessionEnd, auto-wired idempotently into `~/.claude/settings.json`) POST to a localhost listener (port 44711, 204-empty replies so hook stdout stays silent; Origin-header spoofing rejected). Native toasts when a session needs you and the Hub is unfocused (`setAppUserModelId` for packaged builds; single-instance lock).
2. **Status board**: working/waiting/done dots on Claude tabs, amber sidebar pulse, Dashboard "Claude sessions" rail (click-to-focus, dismiss) — external sessions show too. All cwd keys normalized (`normPath`) because git porcelain emits forward slashes on Windows.
3. **Task sessions**: per-task git worktrees (`hub/<task>` branch in `<project>.worktrees/<task>`, CLAUDE.md copied in), Claude tab per task, **⇄ Diff tab** (merge-base vs main branch incl. uncommitted, untracked list, 1MB cap) with **Merge back** (MERGE_HEAD/detached-HEAD guards, abort-own-merge-only) and **Discard**; removal kills the task's PTYs first (Windows cwd lock) and retries.

### Phase 7 — Security cleanup (parallel, independent)
Rotate the hardcoded Stability AI key in `The-Classified-Files/config.js`; fix the client-exposed `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_SECRET` in old founderos.

## Run it
```
npm install      # one-time (needs NODE_OPTIONS=--use-system-ca for the Electron download)
npm run dev      # opens the Builder Hub window
npm run typecheck
```
