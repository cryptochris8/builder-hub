---
name: decide
description: Record founder decisions (approved, rejected, or proposed) in the canon repo through Builder Hub, so they survive compaction and new sessions. Use whenever Chris approves or rejects a direction, architecture, creative choice, tool, or approach, or says "remember this", "that's decided", "go with X", "scrap Y". Also use to list a project's decisions, and when a request seems to conflict with an approved decision.
---

# decide: founder decisions with proof

Chris asked for this on 2026-11-04. His biggest pain is losing creative direction and architectural decisions when a session compacts or ends. Builder Hub injects each project's approved decisions and rejected approaches at session start. This skill is how they get recorded.

## When to record
- **Chris approves something.** Examples: "yes", "go with X", "let's do that", a choice in an AskUserQuestion, "that's the plan". Record an `approve` with his exact words.
- **Chris rejects an approach.** Examples: "no", "scrap that", "don't use X". Record a `reject`, so no later session proposes it again.
- **You recommend a significant direction and he hasn't answered yet.** Record a `propose`. It binds nothing, but the Hub shows it to him.
- Don't record small implementation details. Only record what a future session must not get wrong: architecture, stack, creative and visual direction, workflow rules, budgets, and what's in or out of scope.

## How
Run from inside the project folder (the project is resolved from the folder):

```
node "C:/Users/chris/.claude/skills/decide/decide.mjs" approve --topic <kebab-topic> --statement "<the decision, one sentence>" --quote "<Chris's exact words>" [--rationale "<why>"] [--alt "<option not chosen>"]... [--files a.ts,b.ts]
node "C:/Users/chris/.claude/skills/decide/decide.mjs" reject  --topic <kebab-topic> --statement "<the approach he rejected>" --quote "<his words>"
node "C:/Users/chris/.claude/skills/decide/decide.mjs" propose --topic <kebab-topic> --statement "<your recommendation>" [--rationale ..]
node "C:/Users/chris/.claude/skills/decide/decide.mjs" approve --id D-YYYYMMDD-xxxx --quote "<his words>"      # approve an earlier proposal
node "C:/Users/chris/.claude/skills/decide/decide.mjs" approve ... --supersedes D-YYYYMMDD-xxxx               # he changed his mind
node "C:/Users/chris/.claude/skills/decide/decide.mjs" list
```

## Rules
- **`--quote` must be Chris's exact words** from a prompt, or the label he picked in an AskUserQuestion, from the last 48 hours. Copy them verbatim; don't paraphrase or fix his spelling. If the Hub can't find them, it stores the decision as a **proposal** and the command exits 1. Tell Chris it's waiting for his approval. Never retry with invented words.
- **One active approved decision per topic.** If he changes his mind, approve the new one with `--supersedes <old id>`. If the Hub reports a conflict, don't work around it: tell Chris which approved decision the request conflicts with, and ask.
- **Before you act against an approved decision or a rejected approach** in the session-start list, say so and ask first.
- Exit code 2 means the Hub is down or outdated. The decision was not recorded, so tell Chris. Never write `decisions.jsonl` by hand: the Hub demotes hand-written approvals to proposals.
- Never put secrets in a statement or quote. The Hub redacts them, but keep them out anyway.

## Where it lives
- The canon repo is `C:\Users\chris\open-claw\knowledge\<project>\`. `decisions.jsonl` is the source; `DECISIONS.md` is the readable view; `index.json` maps projects to folders.
- Every change is committed by file name.
- Chris can also approve or reject in the Hub: Context tab, then Decisions.
- Source of the Hub side: `C:\Users\chris\builder-hub\src\shared\decisions.ts`.
