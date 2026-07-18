# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is one Bun/SvelteKit package. Run commands from the repository root with Bun 1.3.14, pinned in
`.bun-version` and `package.json`. A Poyo API key is required only for connectivity or generation;
normal automated tests use mocked or loopback Poyo responses.

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

`test:e2e` and `test:security` build first and run their `.browser.ts` files serially through
`scripts/test-browser.ts`. Bun discovers `.test.ts`; `.browser.ts` and `.live.ts` require explicit
commands. `bun run test:live` is fail-closed and skipped by default, but can spend Poyo credits when
enabled. Prefer the mock servers in `tests/helpers/` unless a live paid probe is explicitly required.

## Architecture Overview

- `src/routes/**` contains SvelteKit pages, server loads, and HTTP endpoints. Routes mainly parse
  requests, acquire shared services, call domain repositories/services, and return safe DTOs.
- `src/lib/features/**` is browser-safe shared code: contracts, registry definitions and
  normalization, and pure generation/library/settings logic. The static architecture test forbids
  value imports from `src/lib/server/**` into this layer, Svelte components, or client hooks.
- `src/lib/server/**` owns SQLite, paths, credentials, filesystem operations, Poyo transport, jobs,
  cleanup, diagnostics, and verified browser media delivery.
- `getPlatformServices()` in `src/lib/server/platform/runtime.ts` is the process-wide platform
  singleton. It selects the storage root, opens and migrates SQLite, seeds registry rows, configures
  settings, credentials, and redacted JSONL logging, and exposes effective media paths.
- `getJobRuntime()` in `src/lib/server/jobs/runtime.ts` is the process-wide job singleton. It owns the
  `JobRepository`, `JobCoordinator`, verified output downloader, and background worker.
- `src/hooks.server.ts` starts the job and cleanup workers and wraps mutating requests in the
  maintenance writer gate. Exclusive local maintenance such as log clearing drains writers first.

Generation crosses several layers:

1. Image/video page loads call `loadStudioData()` for registry entries, model preferences, balance,
   credential status, and optional preset/job/output reuse data.
2. `StudioWorkspace.svelte` uses the pure generation modules for drafts, sizing, batch state, and
   request construction. Local files go through `/api/sources`; previews go through
   `/api/requests/preview`.
3. `/api/jobs` revalidates and normalizes the request, persists it before any paid submission, then
   schedules `JobCoordinator.reconcile()` through the maintenance gate.
4. The coordinator submits, polls with leases/backoff, records ambiguous outcomes without automatic
   resubmission, and downloads completed outputs through the verified media boundary.
5. `/api/events/jobs` replays SQLite-backed job events over SSE; jobs and library routes read the same
   durable records and serve only verified local media.

## Implementation Decisions

| Situation | Use | Avoid |
| --- | --- | --- |
| Logic/types needed by browser and server | `src/lib/features/**` | Value imports from `$lib/server` |
| Database, settings, credential, logger, or path access | `getPlatformServices()` | Opening another application database or singleton |
| Job repository/coordinator/worker access | `getJobRuntime()` | Constructing workers in routes |
| Mutating JSON endpoint | `readSameOriginJson()` with an explicit size cap | `request.json()` |
| Local multipart source upload | `intakeLocalSource()` and `ManagedSourceRepository` | Treating uploads as ordinary JSON or retaining raw paths |
| Production Poyo calls | `createPoyoClient()` | Direct Poyo `fetch`, `new PoyoClient`, or `new PoyoTransport` |
| API errors | The matching `jobHttpError()` or `operationsHttpError()` | Raw errors, paths, or persisted payloads |

## Common Change Workflows

### Add or change an API-backed feature

1. Put browser-safe contracts and validation in `src/lib/features/`; put database, filesystem,
   credentials, upstream calls, and verified local media handling in `src/lib/server/`.
2. Keep routes orchestration-only. Use the canonical runtime singleton, `readSameOriginJson()` for
   JSON mutations, the guarded multipart path in `src/lib/server/media/source-intake.ts` for uploads,
   a safe DTO, and the matching domain error mapper.
3. Add the closest unit/integration test. Add a `.browser.ts` scenario when navigation, hydration,
   accessibility, production build behavior, or a complete user flow changes.

### Change the SQLite schema

1. Add a new numbered file under `migrations/`; do not edit `migrations/0001-initial.ts`, because
   applied migration names and SQL are checksummed by `migrationChecksum()`.
2. Register it in increasing order in `migrations/index.ts` and bump `DATABASE_SCHEMA_VERSION` in
   `src/lib/server/platform/version.ts`.
3. Extend `tests/integration/database/migrations.test.ts` for exact schema, upgrade, rollback,
   checksum, and reopen behavior. Preserve
   `tests/fixtures/database/pre-collapse-schema-signature.json`: its generator verifies a fixed hash
   and refuses to regenerate it after the legacy 0001-0004 chain was collapsed.
   Run the migration test file, affected repository tests, `bun run test`, and `bun run test:restart`.

### Change the model capability registry

1. Update `image-registry.ts` or `video-registry.ts` and the matching `normalize*.ts` path when request
   fields or payload mapping change. Advance the affected registry version.
2. Run `bun run registry:evidence:refresh`. It fetches public official documentation and rewrites the
   official source manifest plus the three reviewed workflow-fixture files.
3. Review every generated diff. Update `reviewed-conditional-vectors.json` and
   `reviewed-conflicts.json` manually when the underlying rule or source conflict changes. Change the
   hard inventory assertions in `scripts/validate-registry.ts` only for an intentional reviewed
   inventory change. Run `bun run validate:registry`, affected registry tests, and `bun run test`.

## Repository Conventions and Gotchas

- Svelte components use runes (`$props`, `$state`, `$derived`, snippets/`{@render}`) and event
  properties such as `onclick`. `tests/security/static-architecture.test.ts` rejects `export let`,
  `on:` directives, competing runtimes, and server imports across browser boundaries.
- Reuse `src/lib/components/ui/**` and UnoCSS theme tokens/shortcuts. `uno.css` is imported once from
  `src/hooks.client.ts`; do not introduce Tailwind or another adapter/runtime alongside the enforced
  Bun + adapter-bun + presetWind4 stack.
- The default application root is `./data`. `PLS_APP_DATA_DIR` is the only storage override; the
  database, media, uploads, thumbnails, logs, secrets, and temporary files remain beneath it. Paths
  are server configuration and must never be exposed through browser DTOs.
- `POYO_API_KEY` overrides the single local credential file. Keys must stay out of page data,
  browser storage, SQLite, diagnostic exports, and structured logs; use `ApiKeyManager` and existing
  redaction/safe-error paths.
- Studio drafts may persist only bounded, validated, serializable metadata. Preserve the contract in
  `studio-draft.ts`: no secrets, local filesystem paths, filenames, or browser `File` objects.
- `.svelte-kit/`, `build/`, `coverage/`, `data/`, and `test-results/` are generated or local output.
  Edit source/configuration and regenerate; do not patch these directories.

## Testing and Validation

- Unit tests mirror feature/server domains. Integration tests cover SQLite, the data root, jobs,
  credentials, and the Poyo client; reliability tests use a child worker for restart recovery.
- Browser E2E/security tests run the production build in an isolated temporary deployment and data
  root against `tests/helpers/studio-mock-poyo-server.ts`; reuse the harness instead of weakening the
  loopback-only `PLS_TEST_*` gates.
- Start with a targeted test, then run format check, lint, type-check, and `bun run test`. Add the
  registry, browser/security, restart/performance, build, and production-smoke gates when the changed
  surface requires them.

## Additional Documentation

- `README.md` — Read before setup, production exposure, storage/credential behavior, reset flows,
  privacy-sensitive changes, or live/network testing.
- `.augment/rules/poyo-studio-tech-stack.md` — Read before Svelte or UnoCSS work for project-supplied
  framework guidance. Verify examples against `package.json` and current code; the rule also contains
  optional patterns and packages not installed here.
- `tests/security/static-architecture.test.ts` — Read before changing dependencies, browser/server
  boundaries, framework configuration, or Svelte syntax.
- `src/lib/server/platform/request-security.ts` — Read before adding a mutating JSON endpoint.
- `src/lib/server/platform/database.ts` and `tests/integration/database/migrations.test.ts` — Read
  before migration, database preflight, or schema compatibility work.
- `scripts/validate-registry.ts` — Read before changing registry entries, evidence, normalization, or
  inventory counts.
- `tests/helpers/browser-app-harness.ts` — Read before modifying production-browser test
  infrastructure or its isolated environment.
- `prek.toml` — Read before changing validation tooling or preparing a commit.
