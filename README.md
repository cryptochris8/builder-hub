# Builder Hub

A local-first desktop **command center** for my dev business: open or create a project and drop straight into an **embedded Claude Code terminal**, with focused tools loaded per project type and a Claude that already knows my whole stack.

This is the clean-foundation **v2 of FounderOS**. See **[PLAN.md](./PLAN.md)** for architecture, decisions, and the phased roadmap.

## Stack
Electron · Vite · React 19 · TypeScript · Tailwind v4 · (SQLite + xterm/node-pty coming in Phases 2–3).

## Develop
```bash
npm install
npm run dev        # launch the app (dev, with HMR)
npm run typecheck  # type-check
npm run build      # production build
```

> Stack awareness lives in `~/.claude/CLAUDE.md`, `~/.claude/stack-profiles/`, and `C:\Users\chris\TOOL-STACK.md`.
