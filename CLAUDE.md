# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Baseline

- Use Bun 1.3.14, pinned by `.bun-version` and `package.json`. Do not substitute npm, pnpm, Yarn, Node launchers, Vitest, or Jest; `tests/security/static-architecture.test.ts` enforces this stack.
- This is a SvelteKit 2 application compiled in Svelte 5 runes mode, styled with UnoCSS `presetWind4`, and built for `svelte-adapter-bun`.
- Runtime/generated paths are ignored: `data/`, `build/`, `.svelte-kit/`, `test-results/`, `coverage/`, and `node_modules/`. Change their source inputs instead of editing their contents.

## Essential Commands

Run all commands from the repository root.

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `bun install --frozen-lockfile` | Uses the committed Bun lockfile. |
| Develop | `bun run dev` | Binds to `127.0.0.1`; defaults to port 5173. |
| Build | `bun run build` | Produces the Bun adapter output in `build/`. |
| Run production | `bun run start` | Requires a build; accepts only `HOST=127.0.0.1` or `HOST=::1` and defaults to port 3000. |
| Format check / write | `bun run format:check` / `bun run format` | Biome; the second command modifies files. |
| Lint | `bun run lint` | Biome recommended rules. |
| Type/Svelte check | `bun run check` | Runs `svelte-kit sync` before `svelte-check`. |
| Core automated suite | `bun run test` | Unit, integration, reliability, static architecture, and performance tests; excludes browser, live, and host-tool suites. |
| One test file | `bun test tests/unit/jobs/create-request.test.ts` | Fastest validation for a focused change. |
| One test case | `bun test tests/unit/platform/start.test.ts -t 'rejects hostnames, wildcard, mapped, and LAN addresses'` | Use the exact `describe`/`test` name. |
| Browser E2E | `bun run test:e2e` | Builds first, then runs browser files serially. |
| Security suite | `bun run test:security` | Builds first; runs static and browser security tests. |
| Restart recovery | `bun run test:restart` | Serial durable-job restart test. |
| Registry validation | `bun run validate:registry` | Verifies registry manifests, source evidence, normalization, and reviewed fixtures. |
| Production smoke | `bun run build && bun run test:production-smoke` | Uses an isolated temporary data root and loopback mock Poyo service. |
| Schema compatibility | `bun scripts/check-pre-collapse-schema-signature.ts` | Checks the fresh version-1 schema against the immutable historical fixture. |
| Pre-commit-stage hooks | `prek run --all-files` | External `prek` command; may rewrite whitespace/line endings and runs formatting, lint, checks, tests, registry validation, build, secret scanning, and branch policy. |

`bun run test:media-tools` is optional and tests installed ExifTool/ImageMagick/FFmpeg/ffprobe combinations. The paid `bun run test:live` Poyo suite is fail-closed and excluded from normal validation; do not enable it unless the task explicitly requires live Poyo traffic. `README.md` documents a separate opt-in, unauthenticated public-download transport probe.

## Architecture Overview

1. **Process startup and platform services.** `src/hooks.server.ts` starts the job and cleanup workers. `src/lib/server/platform/runtime.ts` lazily creates the singleton service graph: validated app paths, SQLite, registry seeding, settings, secrets, logging, public-IPv4 policy, pricing, and media-tool readiness.
2. **Page and API boundary.** Page loads under `src/routes/**/+page.server.ts` compose browser-safe data from `$lib/server`. `src/routes/+layout.server.ts` gates browser navigation on onboarding and supplies shell summaries; API routes do not execute layout loads. JSON mutation routes use server security/validation helpers and return explicit DTOs.
3. **Generation request flow.** Studio UI/domain logic in `src/lib/features/generation/` builds registry-keyed requests. `src/lib/server/jobs/create-request.ts` is the canonical server validation, registry normalization, and managed-source resolution boundary. `src/routes/api/jobs/+server.ts` adds pricing, persists through `JobRepository`, then starts detached reconciliation.
4. **Durable jobs.** `src/lib/server/jobs/runtime.ts` composes `JobRepository`, `JobCoordinator`, `OutputDownloader`, the guarded Poyo client, and the worker. The coordinator owns submission leases, polling/backoff, and verified downloads. `src/lib/server/jobs/events.ts` sanitizes snapshot/replay data before `src/routes/api/events/jobs/+server.ts` exposes it over SSE.
5. **Registry-driven models.** Typed image/video capabilities live in `src/lib/features/registry/`; reviewed provenance and request fixtures live in `src/lib/features/registry/evidence/`. Startup seeds those registries into SQLite. Studios, request validation, pricing matching, and selectors all depend on the same entry keys and workflows.
6. **Local data and media.** `PLS_APP_DATA_DIR` or the default `data/` root contains all application-owned SQLite, sources, outputs, thumbnails, logs, temp files, and local credentials. `src/lib/server/media/` validates source intake, optional sanitization, managed-source retention, and verified output publication beneath that root.

## Project Boundaries and Decisions

| Situation | Preferred approach | Avoid |
| --- | --- | --- |
| Browser-safe state, contracts, reducers, or presentation logic | `src/lib/features/<area>/` | Importing runtime values from `$lib/server` into `.svelte`, client hooks, or feature modules. |
| Filesystem, SQLite, credentials, Poyo, or background work | A focused module/repository under `src/lib/server/<area>/`, reached from server loads or API routes | Putting private infrastructure in components or browser bundles. |
| Poyo API access | `createPoyoClient` from `src/lib/server/poyo/factory.ts` with `publicIpv4Guard: platform.publicIpv4` | Constructing `PoyoClient`/`PoyoTransport` directly or fetching the API base URL. |
| Initial route data | A `+page.server.ts` load, usually delegating to a server service such as `generation/studio-data.ts` | Client-only fetches for data already available during SSR. |
| Pure behavior or repository logic | Bun unit/integration tests near the matching area under `tests/unit/` or `tests/integration/` | Adding a browser test for behavior that does not require a real DOM/runtime boundary. |
| User flows, accessibility, real media, or lifecycle edges | A registered `tests/e2e/*.browser.ts` suite and shared helpers under `tests/helpers/` | Shipping test harness routes or harness labels under `src/`. |

## Common Change Workflows

### Change a model capability or workflow

1. Update the typed image/video registry and its normalization/selection logic as applicable.
2. For an intentional upstream evidence refresh, run `bun run registry:evidence:refresh`; it overwrites `official-source-manifest.json` and the generated reviewed image/video fixture files. Review that network-backed diff. Keep the separate hand-reviewed conditional/conflict evidence synchronized manually.
3. Update focused tests under `tests/unit/registry/`.
4. Run `bun run validate:registry`, the focused tests, then `bun run check` and `bun run build`.

### Change job creation or lifecycle data

1. Keep browser request construction in `src/lib/features/generation/` and authoritative acceptance/normalization in `src/lib/server/jobs/create-request.ts`.
2. Persist lifecycle changes through `JobRepository`/`JobCoordinator`; do not bypass durable leases or write ad hoc in route handlers.
3. Deliberately update `safeJobDto` and durable event sanitization when a field may cross the HTTP/SSE boundary.
4. Cover the pure path with unit/integration tests and add browser coverage only when observable user behavior changes.

### Change pricing fixtures

1. Read `tests/fixtures/pricing/README.md` first.
2. Treat the sanitized corpus, inventory hash, row counts, supported signatures, and unsupported rows as one reviewed set.
3. Keep published credits authoritative; do not derive billing from displayed USD values or combine ambiguous matching tiers.

## Repository Conventions

- Use Svelte runes (`$state`, `$derived`, `$effect`, `$props`) and property event handlers such as `onclick`; legacy `export let` and `on:click` syntax fail the static architecture test.
- Keep the global `uno.css` import in `src/hooks.client.ts`, not a root layout script; the active `.augment` rule records the Safari/runic initialization constraint.
- Keep TypeScript compatible with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `useUnknownInCatchVariables`.
- Biome formats with 2 spaces, 100 columns, single quotes, semicolons, and no trailing commas.
- API/browser payloads must remain redacted and path-free. Reuse existing safe DTO, event sanitizer, diagnostics redaction, and request-security helpers instead of returning database records or caught errors directly.
- The supported production service is loopback-only. Preserve the host validation in `scripts/start.ts`; do not add LAN/wildcard binding paths.
- Once media sanitization starts, failures reject intake rather than falling back to unsanitized bytes. Preserve this fail-closed boundary in `source-intake.ts` and `media-sanitizer.ts`.

## Database and Generated Evidence

- `migrations/index.ts` registers only `migrations/0001-initial.ts`. Database startup verifies migration identity/checksum, integrity, foreign keys, and the canonical schema signature in `src/lib/server/platform/database.ts`.
- Databases from abandoned schema versions 2–4 are intentionally unsupported. Do not edit `schema_migrations` or add an in-place compatibility path; use a fresh data root as documented in `README.md`.
- Before changing schema/migration behavior, read the database preflight and migration tests under `tests/integration/database/` and the immutable historical schema check in `scripts/check-pre-collapse-schema-signature.ts`. The fixture's source metadata is provenance only, not an upgrade path or regeneration input.
- Registry evidence and pricing fixtures are committed, reviewed inputs—not disposable build output. Use their validation/refresh scripts and keep hashes/manifests synchronized.

## Testing and Validation

- Start with the smallest affected Bun test file, then run `bun run check`, `bun run lint`, and `bun run format:check`.
- Run `bun run test` for the non-browser regression suite. Browser/security runners build first and execute each file serially through `scripts/test-browser.ts`; register new browser suites there or they will not run via package scripts.
- Use `bun run test:production-smoke` only after a successful build. It validates the produced Bun server, not source-mode behavior.
- Real media-tool tests depend on supported binaries on the current `PATH`; restart the Studio process after installing or upgrading those tools.
- No repository CI workflow exists. Local commands and `prek.toml` are the only checked-in validation pipeline.

## Critical Gotchas

- API routes bypass `+layout.server.ts`; onboarding redirects and shell loads are not API authorization or request validation.
- Browser storage holds studio drafts/batches, but durable jobs live in server-side SQLite. Never make completion/recovery depend on localStorage.
- Registry entry keys connect UI forms, normalization, persisted jobs, pricing, and DB seeding. A registry edit is incomplete until evidence and validation pass.
- The app-data root is a filesystem trust boundary. Use `resolveAppPaths`, managed-source helpers, and verified-output helpers rather than accepting or exposing arbitrary local paths.

## Additional Documentation

- `README.md` — Read for runtime privacy guarantees, environment variables, optional media tools, current Poyo limitations, and the full operator-facing command list.
- `.augment/rules/poyo-studio-tech-stack.md` — Read before Svelte/UI work for the active runes, SvelteKit, Bun, and UnoCSS rules; verify examples against current repository config before applying them.
- `tests/fixtures/pricing/README.md` — Read before changing pricing normalization, reviewed pricing data, fixture hashes, or tier matching.
