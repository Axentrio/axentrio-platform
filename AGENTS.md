# Axentrio Platform

## Agent skills

### Issue tracker

GitHub Issues on `Axentrio/axentrio-platform`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, label strings equal to their names. Note none of them exist on the
repo yet — GitHub has only the stock labels, so `/triage` will need to create them.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Booking rules

Auto-book / Request / chips / hours / named hour. Read `docs/booking-rules.md` before
changing booking tools, the slot engine, SERVICES prompt copy, or chip guards.

## Tests

Run them SERIALLY. `api/src/__tests__/worker-database.ts` derives ONE template database name from
`DATABASE_URL`, so two concurrent `vitest` processes drop each other's template and report
failures that belong to no test. Commands: `npm run test:unit` and `npm run test:integration`
in `api/`. Integration fixtures are truncated in an `afterEach` (`api/src/__tests__/setup.ts`),
so build them per test, never in `beforeAll`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
