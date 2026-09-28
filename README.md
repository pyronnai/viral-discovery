# viral-discovery

Viral/funny short-form video **intelligence** agent: discover → normalize → dedupe →
track engagement → score → categorize → human review. Links to and analyzes public
metadata only; never downloads third-party media.

**Status: Phase 1 — foundations only.** No platform adapters, no discovery, no UI.
See [`docs/architecture.md`](docs/architecture.md).

## Requirements

Node.js ≥ 22, pnpm 9, PostgreSQL ≥ 13 (uses `gen_random_uuid()`).

## Setup

```bash
pnpm install
cp .env.example .env        # then edit DATABASE_URL
pnpm db:migrate             # apply Drizzle migrations
pnpm cli health             # config + database + schema + job-queue checks
pnpm worker                 # start the pg-boss worker (Ctrl+C to stop)
```

## Scripts

| Command                                              | What it does                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm lint`                                          | ESLint (strict, type-aware)                                       |
| `pnpm format` / `pnpm format:check`                  | Prettier                                                          |
| `pnpm typecheck`                                     | `tsc` per workspace package                                       |
| `pnpm test`                                          | Vitest. Set `TEST_DATABASE_URL` to also run DB integration tests. |
| `pnpm db:generate`                                   | Generate a migration from `packages/db/src/schema.ts`             |
| `pnpm db:migrate`                                    | Apply migrations                                                  |
| `pnpm cli <health\|config-check\|db-check> [--json]` | Infrastructure checks                                             |
| `pnpm worker`                                        | Run the worker                                                    |

## Layout

```
apps/worker            pg-boss runtime (queues, handler registration, adapter wiring)
apps/cli               infrastructure CLI
packages/config        env validation (Zod) + logger (Pino)
packages/core          domain types, metric model, job contracts
packages/db            Drizzle schema, migrations, health check
packages/adapters/contract   SourceAdapter contract, registry, contract test kit
docs/                  architecture + per-source access/compliance notes
```
