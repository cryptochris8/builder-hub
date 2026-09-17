# Creator Stack — the shared-tools & related-projects registry

_Builder Hub 0.4. Machine-readable store: `%APPDATA%\builder-hub\creator-stack.json`. What Claude reads: `~/.claude/builder-hub/creator-stack.md` (auto-rendered, linked from the marked block in `~/.claude/CLAUDE.md`). UI: Connections → Creator Stack._

## Why

"Make a trailer with our trailer kit" must resolve to the **Trailer Factory in Income Kit** — its README, its PLAYBOOK, its scripts, its per-game knobs — not to a fresh trailer generator. The project registry knows *where projects are*; the Creator Stack knows *what reusable capabilities exist, what to read first, and how to use them safely*.

## Shape

```jsonc
{
  "version": 1,
  "entries": [
    {
      "id": "income-kit",
      "name": "Income Kit",
      "aliases": ["income kit", "side income kit", "creator kit"],
      "path": "C:\\Users\\chris\\income-kit",          // discovered, never guessed: seeded only if it exists
      "projectId": "0ff571a7-…",                        // linked to the registry project (longest-prefix match)
      "kind": "shared-tool",                            // shared-tool | playbook | agent-pack | reference | catalog | profile
      "docs": ["START-HERE.md", "CLAUDE.md"],
      "capabilities": [
        {
          "id": "trailer-kit",
          "name": "Trailer Factory (audio-first game trailers)",
          "aliases": ["trailer kit", "trailer factory", "video creator", "make a trailer", "trailer", "…"],
          "purpose": "Create a 60–90 s cinematic trailer with the proven pipeline …",
          "entrypoints": ["trailer-factory/tools/build-trailer-audio.mjs", "…", "trailer-factory/package.json (npm run audio | radio | render | capture | cards | cut)"],
          "docs": ["trailer-factory/README.md", "trailer-factory/PLAYBOOK.md", "trailer-factory/template/edit.example.json"],
          "usageNotes": "Do NOT build a new trailer generator. Copy trailer-factory/tools into the game repo … change only: NARRATOR … Three.js games get the whole pipeline; HYTOPIA/Roblox swap the camera tool …",
          "worksFor": ["web-app", "hytopia", "roblox", "unreal", "mobile-app"],
          "tags": ["trailer", "video", "elevenlabs", "ffmpeg", "playwright"]
        }
      ],
      "tags": ["creator", "marketing", "video", "agents"],
      "exists": true,
      "indexedAt": 1789000000000,
      "source": "seed"                                  // seed | user | discovered
    }
  ]
}
```

## Seeded entries (verified on disk 2026-09-16; only registered when the path exists)

| Entry | Kind | Capabilities |
|---|---|---|
| `income-kit` — `C:\Users\chris\income-kit` | shared-tool | **trailer-kit** (Trailer Factory), **video-factory** (vertical social clips), **claude-agent-pack** (19 subagents), **roblox-marketing** (content engine + Metricool SOP), **freelancing-kit** |
| `game-trailer-playbook` — `~/.claude/playbooks/game-trailer-playbook.md` | playbook | trailer-method |
| `everlight-trailer-reference` — `Fable-5.1-one-shot/tools` | reference | trailer-reference-impl (the rig the factory was extracted from) |
| `subagents-repo` | agent-pack | — |
| `tool-stack` — `C:\Users\chris\TOOL-STACK.md` | catalog | tool-catalog (every tool + key locations) |
| `stack-profiles` — `~/.claude/stack-profiles` | profile | stack-profile (per-type conventions) |
| `ai-creators` — `C:\Users\chris\AI-creators` | reference | ai-content-pipelines |

## How matching works

`findCapabilities(query)` — whole-word, case-insensitive phrase matching over capability aliases/names (weight 3), entry aliases/names (weight 2) and tags (weight 1); longer phrases score higher; entries missing on disk are skipped. "create a trailer using our trailer kit" → `trailer-kit` first; "trailer" alone still matches, more weakly; "video" alone matches nothing. Try any phrase in **Connections → Creator Stack → What would Claude get?**

When a prompt matches, the Hub's `UserPromptSubmit` hook reply carries the capability **card** (≤ 900 chars):

> [Builder Hub · Creator Stack] You already have an established tool for this: **Trailer Factory (audio-first game trailers)** — `C:\Users\chris\income-kit`
> Purpose: … · Read first (minimum needed): …\trailer-factory\README.md; …\PLAYBOOK.md · Entrypoints: … · Notes: … · Works for: …
> Use this tool rather than building a new one — adapt it per its README. Reference it freely; if you must change ITS source, say so explicitly first.

The project's context then records the tool under *Shared tools used*, so later sessions on that project see it in their header line.

## Maintaining it

- **Reindex** (Connections → Creator Stack, or automatically when the project registry changes): re-verifies every path, re-links `projectId`, appends any seed entry that is missing, never overwrites your edits to seeded entries (only `exists` / `projectId` / `indexedAt` are refreshed; a moved seed path is adopted only if the stored one is gone).
- **Add entry**: name, absolute path, aliases, kind, one-sentence purpose → a user entry with one capability (docs default to `README.md`). Edit `creator-stack.json` by hand for richer capabilities (it is validated on read; bad entries are dropped, never crash).
- **Remove**: unregisters only; nothing on disk is touched. A removed *seed* entry is remembered in `removed` so Reindex does not resurrect it (re-add it by hand if you change your mind). **Add entry** never overwrites an existing id — a colliding name gets a `-2` suffix.
- Rebuildable: delete `creator-stack.json` and Reindex re-seeds.

## Cross-project guardrail (rendered at the end of `creator-stack.md`, and in the global CLAUDE.md block)

1. Read/reference any of these — and any registered project — freely.
2. Consume shared tools through their documented entrypoints; do not copy their implementation into every project.
3. Before modifying **another** project's or tool's source, say so explicitly and prefer changes in the current project. (The session board also flags a session that edits files under a different registered project: ⚠ cross-project in the SessionBar.)
