# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is one Bun/SvelteKit package. Run commands from the repository root with Bun 1.3.14, pinned in `.bun-version` and `package.json`. Normal tests need no Poyo API key; they use mock/loopback responses.

## Essential Commands

| Purpose | Command |
| --- | --- |
| Reproducible install | `bun install --frozen-lockfile` |
| Loopback development server | `bun run dev` |
| Production build / local start | `bun run build` then `bun run start` |
| Format check / write | `bun run format:check` / `bun run format` |
| Biome lint | `bun run lint` |
| SvelteKit sync and type-check | `bun run check` |
| One test file | `bun test tests/unit/jobs/routes.test.ts` |
| One test case | `bun test tests/integration/database/migrations.test.ts -t "DB-00"` |
| Configured non-browser suite | `bun run test` |
| Production browser flows | `bun run test:e2e` |
| Static plus browser security | `bun run test:security` |
| Serialized restart / performance tests | `bun run test:restart` / `bun run test:performance` |
| Registry validation | `bun run validate:registry` |
| Registry public-source network audit | `bun run registry:audit:network` |
| Refresh registry evidence | `bun run registry:evidence:refresh` |
| Production smoke | `bun run build && bun run test:production-smoke` |
| All configured pre-commit gates | `prek run --all-files` |

`test:e2e` and `test:security` build first and run `.browser.ts` files serially through `scripts/test-browser.ts`. Bun discovers `.test.ts`; `.browser.ts` and `.live.ts` require explicit commands. `bun run test:live` is skipped by default but can spend credits when fully enabled. Prefer `tests/helpers/` mocks. Registry refresh/audit contacts public docs without credentials or credits.

## Architecture Overview

- `src/routes/**` contains SvelteKit pages, server loads, and HTTP endpoints. Keep routes focused on
  parsing, shared-service orchestration, repository/service calls, and safe DTOs.
- `src/lib/features/**` is browser-safe shared code: contracts, registry definitions and
  normalization, and pure generation/library/settings logic. The static architecture test forbids
  value imports from `src/lib/server/**` into this layer, Svelte components, or client hooks.
- `src/lib/server/**` owns SQLite, paths, credentials, filesystem operations, Poyo transport, jobs,
  cleanup, diagnostics, and verified browser media delivery.
- `getPlatformServices()` in `src/lib/server/platform/runtime.ts` is the process-wide platform
  singleton. It resolves paths, preflights/migrates SQLite, seeds registries, and configures settings,
  credentials, and redacted JSONL logging.
- `getJobRuntime()` in `src/lib/server/jobs/runtime.ts` is the process-wide job singleton. It owns the
  `JobRepository`, `JobCoordinator`, verified output downloader, and background worker.
- `src/hooks.server.ts` starts the job and cleanup workers and wraps mutating requests in the
  maintenance writer gate. Exclusive maintenance such as log clearing drains active writers first.

Generation crosses several layers:

1. Image/video loads call `loadStudioData()` for registry entries, preferences, balance, credential
   status, and optional preset/job/output reuse data.
2. `StudioWorkspace.svelte` uses pure generation modules for drafts, sizing, batches, and requests.
   Local files use `/api/sources`; normalized previews use `/api/requests/preview`.
3. `/api/jobs` revalidates and normalizes the request, persists it before any paid submission, then
   schedules `JobCoordinator.reconcile()` through the maintenance gate.
4. The coordinator submits, polls with durable leases/backoff, preserves ambiguous submissions for
   explicit review instead of automatically resubmitting, and downloads completed outputs through
   the verified media boundary.
5. `/api/events/jobs` replays SQLite-backed job events over SSE. Jobs and Library read the same
   durable records and expose only verified local media.

## Implementation Decisions

| Situation | Preferred approach | Avoid |
| --- | --- | --- |
| Logic/types needed by browser and server | `src/lib/features/**` | Value imports from `$lib/server` |
| Database, settings, credential, logger, or path access | `getPlatformServices()` | Opening another application database or singleton |
| Job repository/coordinator/worker access | `getJobRuntime()` | Constructing workers in routes |
| Mutating JSON endpoint | `readSameOriginJson()` with a bounded `maxBytes` | `request.json()` |
| Local multipart source upload | `intakeLocalSource()` plus `ManagedSourceRepository` | Retaining raw browser paths or treating uploads as JSON |
| Production Poyo calls | `createPoyoClient()` | Direct Poyo `fetch`, `new PoyoClient`, or `new PoyoTransport` |
| API errors | The matching `jobHttpError()` or `operationsHttpError()` | Returning raw errors, paths, or persisted payloads |

## Common Change Workflows

### Add or change an API-backed feature

1. Put browser-safe contracts and validation in `src/lib/features/`; put database, filesystem,
   credentials, upstream calls, and verified local media handling in `src/lib/server/`.
2. Keep routes orchestration-only. Use the canonical runtime singleton, `readSameOriginJson()` for
   JSON mutations, the guarded multipart path in `src/lib/server/media/source-intake.ts` for uploads,
   a safe DTO, and the matching domain error mapper.
3. Add the closest unit/integration test. Add a `.browser.ts` scenario when navigation, hydration,
   accessibility, production-build behavior, or a complete user flow changes.

### Change the SQLite schema

1. Add a new numbered file under `migrations/`; do not edit `migrations/0001-initial.ts`, because
   applied migration names and SQL are checksummed by `migrationChecksum()`.
2. Register it in increasing order in `migrations/index.ts` and bump `DATABASE_SCHEMA_VERSION` in
   `src/lib/server/platform/version.ts`.
3. Extend `tests/integration/database/migrations.test.ts` for exact schema, upgrade, rollback,
   checksum, and reopen behavior. Do not regenerate
   `tests/fixtures/database/pre-collapse-schema-signature.json`; its generator verifies a fixed hash
   and refuses to derive it from the collapsed migration.
4. Run the migration test file, affected repository tests, `bun run test`, and `bun run test:restart`.

### Change the model capability registry

1. Update `image-registry.ts` or `video-registry.ts` and the matching `normalize*.ts` path when request
   fields or payload mapping change. Advance the affected registry version.
2. Run `bun run registry:evidence:refresh`. It fetches public official documentation and rewrites the
   official source manifest plus the three reviewed workflow-fixture files.
3. Review every generated diff. Update `reviewed-conditional-vectors.json` and
   `reviewed-conflicts.json` manually when the underlying rule or source conflict changes. Change the
   hard inventory assertions in `scripts/validate-registry.ts` only for an intentional reviewed
   inventory change.
4. Run `bun run validate:registry`, affected registry tests, and `bun run test`.

## Repository Conventions and Gotchas

- Svelte components use runes (`$props`, `$state`, `$derived`, snippets/`{@render}`) and event
  properties such as `onclick`. `tests/security/static-architecture.test.ts` rejects `export let`,
  `on:` directives, competing runtimes, and server imports across browser boundaries.
- Reuse `src/lib/components/ui/**` and UnoCSS theme tokens/shortcuts. `uno.css` is imported once from
  `src/hooks.client.ts`; do not introduce Tailwind or another adapter/runtime alongside the enforced
  Bun + adapter-bun + presetWind4 stack.
- The production launcher is loopback-only: `scripts/start.ts` accepts `127.0.0.1` or `::1` and
  rejects LAN, wildcard, and hostname binds. Do not bypass it by importing `build/index.js` directly.
- The default application root is `./data`. `PLS_APP_DATA_DIR` is the only storage override; the
  database, media, uploads, thumbnails, logs, secrets, and temporary files remain beneath it. Paths
  are server configuration and must never be exposed through browser DTOs.
- `POYO_API_KEY` overrides the single local credential file. Keys must stay out of page data,
  browser storage, SQLite, diagnostic exports, and structured logs; use `ApiKeyManager` and existing
  redaction/safe-error paths.
- Studio drafts and batches may persist only bounded, validated, serializable metadata. Preserve the
  contracts in `studio-draft.ts` and `studio-batch.ts`: no secrets, local paths, raw filenames, or
  browser `File` objects.
- `.svelte-kit/`, `build/`, `coverage/`, `data/`, and `test-results/` are generated or local output. Edit source/configuration and regenerate; do not patch them.

## Testing and Validation

- `bun run test` covers unit, integration, reliability, static-architecture, and performance tests. Integration tests exercise SQLite, durable jobs, credentials, and the Poyo client; restart recovery uses a separate Bun worker process.
- Browser E2E/security tests run the production build in an isolated temporary deployment and data root against `tests/helpers/studio-mock-poyo-server.ts`. Reuse the harness instead of weakening the loopback-only `PLS_TEST_*` gates.
- Start with a targeted test, then run format check, lint, type-check, and `bun run test`. Add the
  registry, browser/security, restart/performance, build, and production-smoke gates when the changed
  surface requires them.

## Additional Documentation

- `README.md` — Read before setup, production exposure, storage/credential behavior, reset flows, privacy-sensitive changes, or live/network testing.
- `.augment/rules/poyo-studio-tech-stack.md` — Read before Svelte or UnoCSS work. Verify its optional examples and packages against current code and `package.json`.
- `tests/security/static-architecture.test.ts` — Read before changing dependencies, browser/server boundaries, framework configuration, or Svelte syntax.
- `src/lib/server/platform/request-security.ts` — Read before adding a mutating JSON endpoint.
- `src/lib/server/platform/database.ts` and `tests/integration/database/migrations.test.ts` — Read before migration, database preflight, or schema compatibility work.
- `scripts/validate-registry.ts` — Read before changing registry entries, evidence, normalization, or inventory counts.
- `tests/helpers/browser-app-harness.ts` — Read before modifying production-browser test infrastructure or its isolated environment.
- `prek.toml` — Read before changing validation tooling or preparing a commit.
