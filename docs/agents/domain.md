# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is **single-context**: one glossary and one ADR set at the root, covering every
package. It is a workspace monorepo (`api`, `portal`, `mobile`, `packages/*`) but the domain
language is cross-cutting — a `Tenant` or a `ChatSession` means the same thing in all of
them — so the vocabulary is not split per package.

```
/
├── CONTEXT.md                          ← the glossary (Tenant, Agent, ChatSession, …)
├── docs/adr/                           ← system-wide decisions (0001…)
├── api/src/                            ← Express API, booking engine, agent runtime
├── portal/src/                         ← React admin portal
├── mobile/                             ← Expo admin app
└── packages/                           ← shared: api-client, contracts, i18n
```

Note there is **no top-level `src/`** — each app owns its own. When an ADR is genuinely
scoped to one package rather than the system, put it in `docs/adr/` anyway and say so in
the title; a second ADR directory would fragment a set that is currently easy to read
end to end.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

**Known divergence — read this before trusting the glossary blindly.** `CONTEXT.md` defines
the configured AI as **Agent** and lists "bot" under _avoid_. The code says `Bot` almost
everywhere: the `Bot` entity, `botId`, the `chatbot_bots` table, `/bots` routes. Prose should
follow the glossary; code identifiers follow the code. Don't "fix" one to match the other as a
drive-by — that is a rename with real blast radius, and it needs a decision (and an ADR)
first. The same tension exists for `KnowledgeBase` vs the `Gap`/`Insight` naming.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
