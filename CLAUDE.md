# Builder Hub (this app)

Web app project. Stack: Electron · Vite · React. _(stack context wired by Builder Hub, 2026-06-25)_

_Claude Code reads this file automatically._

## Tools & stacks available to me
- **Full tool catalog** — every tool / service / API / app I use, with versions and where each API key lives: `C:\Users\chris\TOOL-STACK.md`. Read it before choosing a tool or scoping work, and **prefer tools I already have**.
- **Stack profiles** — focused tool set + conventions per project type: `C:\Users\chris\.claude\stack-profiles`.
- This project's type is **Web app** — its profile is inlined below.

---

# Profile: Web app / SaaS / dashboard

**Use when:** building a web app, SaaS, dashboard, or content site that needs a build step.

## Default stack (focused)
- **Framework:** **Next.js** (App Router) for full-stack/SSR SaaS; **Vite + React** for SPAs and 3D/game UIs.
- **UI:** React 19, TypeScript, **Tailwind + shadcn/ui** (Radix primitives). Icons `lucide-react`, charts `Recharts`.
- **State/forms:** Zustand; `react-hook-form` + **Zod**.

## Backend / data (pick per need)
- **Supabase** (Postgres + Auth + Storage) — fastest all-in-one.
- **Neon** (serverless Postgres) + **Prisma** or **Drizzle** — when you want your own ORM.
- **Firebase** — when you need realtime + tight mobile integration.
- **Upstash Redis** — rate-limiting / caching. **Inngest** — background jobs / cron / events.

## Cross-cutting services
- **Auth:** Clerk (orgs/MFA/RBAC) · or Supabase/Firebase Auth.
- **Payments:** Stripe (web). **Email:** Resend. **SMS:** Twilio. **Video:** Daily.co.
- **Monitoring:** Sentry. **Hosting:** Vercel (Next SaaS) or Netlify (static/SSR).

## Conventions (learned the hard way)
- **Never** put a secret in a `NEXT_PUBLIC_*` var — it's inlined into the client bundle. Secrets are server-only. (This bit FounderOS — see security TODOs.)
- **pnpm** for monorepos (workspaces). Tests: **Vitest** (+ Testing Library); E2E: **Playwright**.

## Reference projects on disk
`New-apps/*` (building-compliance-os, cashpilot, freight-verify — modern Next 16 + shadcn + Stripe + Sentry) · `Overtime-Care` (HIPAA pnpm monorepo, Prisma/AWS/Terraform) · `MA-Training` (Vite SPA).

---

## This project
Existing project, opened via Builder Hub. Work within the stack above; check TOOL-STACK.md for anything else available.
