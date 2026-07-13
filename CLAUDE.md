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
- **Tests: Vitest, and every piece of logic gets one.** `npm test` (129 tests). Run `npm run typecheck`, `npm test`, and `npm run lint` before claiming done — all three must be green.

## Gotchas learned the hard way
- **A project patch uses `null` to CLEAR a field and `undefined` to leave it alone** (`ProjectPatch` / `applyProjectPatch`). Sending `undefined` to clear is indistinguishable from "not in this patch" — that bug let `stage` be set but never unset. Preserve the distinction when adding editable fields.
- **The focus score is normalized by the max stage boost, not clamped.** The weights already sum to 10, so a `Math.min(10)` clamp tied every strong project at exactly 10.0 and the ranking silently fell through to an alphabetical tiebreak. Don't reintroduce a clamp.
- **Windows path keys must go through `normPath`** — git porcelain emits forward slashes while the Claude hooks emit backslashes; the status board keys on cwd.
- **Never `shell: true` when invoking the `claude` CLI.** It concatenates args unquoted (injection + breaks on spaces). Use `execFile` with an argv array; a `.cmd` shim routes through `cmd.exe /d /s /c`.
- **Windows can't delete a directory that is some process's cwd** — kill a worktree's PTYs before removing it.
- **Secrets never reach the renderer.** The handoff writer resolves its output path from the registry by project *id*; the renderer never sends a path. Keep it that way.

## Tools & stacks available to me
- **Full tool catalog** — every tool / service / API I use, and where each API key lives: `C:\Users\chris\TOOL-STACK.md`. Prefer tools I already have.
- **Stack profiles** (for the projects the Hub *opens*, not for the Hub itself): `C:\Users\chris\.claude\stack-profiles`.
