# Builder Hub

A local-first desktop **command center** for my dev business: open or create a project and drop straight into an **embedded Claude Code terminal**, with focused tools loaded per project type and a Claude that already knows my whole stack.

This is the clean-foundation **v2 of FounderOS**. See **[PLAN.md](./PLAN.md)** for architecture, decisions, and the phased roadmap.

## What it does
Per-project tabs for an **embedded Claude Code terminal**, a shell, a file browser with previews, an embedded browser, and a git **diff review**. Plus a triage dashboard (git badges, focus scores, health), a **status board** fed by Claude Code hooks so you can see which sessions are working / waiting on you, per-task **git worktrees**, a one-click **MCP manager**, and a **handoff generator**.

## Stack
Electron 33 · Vite · React 19 · TypeScript · Tailwind v4 · xterm.js + [`@homebridge/node-pty-prebuilt-multiarch`](https://www.npmjs.com/package/@homebridge/node-pty-prebuilt-multiarch) (embedded terminal) · local-first JSON store · Vitest · ESLint + Prettier · electron-builder (NSIS).

> The node-pty **fork** is deliberate — official node-pty's winpty build is blocked by Norton's script control. Electron is pinned to **33** because that's the ABI (130) the prebuilt matches; see *Known debt* in PLAN.md.

## Develop
```bash
npm install        # one-time (needs NODE_OPTIONS=--use-system-ca — TLS-inspecting proxy)
npm run dev        # launch the app (dev, with HMR)
npm run typecheck  # type-check
npm test           # Vitest (129 tests)
npm run lint       # ESLint
npm run format     # Prettier
npm run build      # production build
npm run build:win  # NSIS installer → dist/
```

**Where the logic lives:** anything pure goes in `src/shared/*` (no electron/fs imports) so it's unit-testable — that's the convention, and it's why the main process stays thin.

> Stack awareness lives in `~/.claude/CLAUDE.md`, `~/.claude/stack-profiles/`, and `C:\Users\chris\TOOL-STACK.md`.
