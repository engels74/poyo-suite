# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Commands

Run commands from the repository root. Bun is pinned to `1.3.14` in both `.bun-version` and
`package.json`.

| Command | Purpose |
| --- | --- |
| `bun install --frozen-lockfile` | Install exactly from `bun.lock`. |
| `bun run dev` | Start Vite at `http://127.0.0.1:5173`. |
| `bun run build` | Build the Bun-adapter application into `build/`. |
| `bun run start` | Start an existing build on loopback, default port 3000. |
| `bun run format:check` / `bun run format` | Check formatting / rewrite with Biome. |
| `bun run lint` | Run Biome's recommended lint rules. |
| `bun run check` | Run `svelte-kit sync` and strict `svelte-check`. |
| `bun run test` | Run the main non-browser unit, integration, reliability, architecture, and performance suite. |
| `bun run test:e2e` | Build, then run all browser E2E files serially. |
| `bun run test:security` | Build, then run static and browser security suites. |
| `bun run test:restart` | Run restart/recovery alone with concurrency 1. |
| `bun run test:media-tools` | Run optional real ExifTool/ImageMagick/FFmpeg/ffprobe integration coverage, skipping unavailable media-kind toolchains. |
| `bun run validate:registry` | Validate registry code, versions, evidence, and reviewed fixtures offline. |
| `bun run build && bun run test:production-smoke` | Exercise onboarding and primary routes against the packaged loopback server. |

There is no one command for every validation layer. Before a broad change, run formatting, lint,
`check`, the main tests, relevant browser/security/restart tests, registry validation when affected,
then build and production smoke. `prek run --all-files` runs the configured local hook gates when the
external `prek` tool is installed.

Target one Bun test file or case with:

```bash
bun test tests/unit/foundation.test.ts
bun test tests/unit/foundation.test.ts -t 'pins the verified runtime and dependency baseline'
```

Browser tests use Bun's test runner plus the Playwright library, not `playwright test`. To run one
browser file, preserve the repository's build-first, serial behavior:

```bash
bun run build && bun test --max-concurrency 1 tests/e2e/job-history.browser.ts
```

ExifTool 13.55+ with ImageMagick 7.1+ enables optional image metadata cleanup; ExifTool with
FFmpeg/ffprobe 8.1+ enables optional video cleanup. They are not install, startup, onboarding,
standard-test, or local-upload prerequisites. `bun run test:media-tools` exercises supported host
toolchains and intentionally skips unavailable media kinds. Normal suites isolate media-tool shims,
use loopback Poyo mocks, and require no paid request. Do not enable the `POYO_LIVE_*` variables during
routine validation; they unlock the explicitly approved paid test.

## Architecture Overview

- This is one local Bun/SvelteKit process. `src/lib/server/platform/runtime.ts` is the memoized
  composition root for paths, SQLite, settings, credentials, logging, public-IP policy, and pricing.
  Reuse these services instead of creating a second database or application-service singleton.
- `src/hooks.server.ts` starts the durable job and cleanup workers. It also gates mutating requests
  during maintenance. Production startup is deliberately loopback-only; `scripts/start.ts` rejects
  LAN, wildcard, and hostname binds.
- `src/lib/features/` contains browser-safe contracts and domain logic. `src/lib/server/` owns Bun,
  SQLite, filesystem, credentials, Poyo transport, and other private infrastructure. Svelte
  components, client hooks, and feature modules must not import server runtime code; the static
  architecture test enforces this boundary.
- SvelteKit routes are thin adapters. Server page loads compose data from platform services and
  repositories. Mutating JSON endpoints use `readSameOriginJson`; multipart source intake applies
  equivalent bounded same-origin checks in the media layer.
- Application data defaults to `./data`, or the sole override `PLS_APP_DATA_DIR`. SQLite, managed
  uploads, verified media, thumbnails, logs, temporary files, and the local credential all remain
  beneath that root.

### Generation flow

1. Registry entries drive Studio fields, validation, payload normalization, and model selection.
2. `src/lib/components/studio/StudioWorkspace.svelte` uses
   `src/lib/features/generation/studio-controller.ts` to capture one immutable preview/paid-action
   snapshot and sends it to the preview or jobs API.
3. The server revalidates against the compiled and seeded registry, resolves managed sources, adds a
   pricing estimate, and persists the job plus submission intent before dispatch.
4. `JobCoordinator` serializes submissions, claims poll/download work, and preserves ambiguous
   transmission state. Poyo access is created through `createPoyoClient`, which installs credential,
   logging, transport, and public-IPv4 policy.
5. Durable job events are exposed through `/api/events/jobs` as snapshot/replay SSE. Studio and Jobs
   merge only monotonic event IDs. Completed outputs are served only after database and filesystem
   verification.

Browser drafts and batches are best-effort local state. Jobs, paid-action truth, events, and outputs
are durable SQLite state; do not make browser storage authoritative for them.

## Implementation Decisions

| Situation | Preferred approach | Avoid |
| --- | --- | --- |
| Logic shared with Svelte/browser code | Put contracts and pure transformations in `src/lib/features/`. | Runtime imports from `src/lib/server/`. |
| Server persistence or infrastructure | Use the platform composition root and the existing repository/service for that subsystem. | Opening another SQLite connection or duplicating a singleton in a route. |
| Poyo API traffic | Use `createPoyoClient` with `platform.publicIpv4`; keep transport paths under `/api/`. | Instantiating `PoyoClient`/`PoyoTransport` in shipped callers or using raw Poyo `fetch`. |
| JSON mutation endpoint | Use bounded `readSameOriginJson` and the subsystem's safe HTTP error mapper. | Unbounded `request.json()` or returning raw internal errors. |
| Browser-level regression | Use the fixed Bun/Playwright harness and loopback mocks. | Adding Playwright Test/Vitest or bypassing the production build. |

## Common Change Workflows

### Add or change a model workflow

1. Update the relevant image/video registry version and entry, plus its normalizer, types, selection,
   or conditional validation when the request shape changes.
2. Run `bun run registry:evidence:refresh`. It fetches public official sources and rewrites only the
   source manifest and three generated workflow-fixture files; review every diff. Update the manually
   reviewed conditional/conflict evidence only when applicable.
3. Update focused registry/normalizer tests. If the Studio surface changes, update its controller and
   browser flow tests; if pricing changes, follow `tests/fixtures/pricing/README.md`.
4. Run `bun run validate:registry`, the focused tests, `bun run test:e2e`, and the build.

### Change paid submission or job state

Keep all layers synchronized: browser snapshot and ambiguity handling, server request preparation,
repository transitions/claims, coordinator recovery, safe DTO/SSE projection, shared session merge
logic, and restart/browser tests. Never convert an unknown transmission into an automatic retry; the
explicit duplicate-spend acknowledgement is intentional.

## Repository Conventions and Gotchas

- Use Svelte 5 runes, typed `$props()`, snippet children, and DOM event properties. `export let` and
  `on:event` are rejected by `tests/security/static-architecture.test.ts`.
- Keep `uno.css` imported from `src/hooks.client.ts`. UnoCSS uses presetWind4, scans Svelte and TS/JS,
  and maps application tokens from `src/app.css`; use the existing UI primitives and tokens rather
  than introducing Tailwind or a second styling system.
- Test-only Poyo origins, public-IP endpoints, and shortened job timings are accepted only with
  `PLS_TEST_MODE=1` and loopback URLs. Keep that fail-closed boundary.
- Migration checksums and the canonical schema signature make schema changes compatibility-sensitive.
  Express changes in `migrations/` and update the registered version and migration tests; never edit a
  local database's `schema_migrations` or replace the immutable pre-collapse fixture to force a pass.
  The repository does not yet define whether its next pre-release schema change edits v1 or adds v2.
- Do not expose secrets, original local filenames, or server filesystem paths in page data, DTOs,
  SSE payloads, diagnostics, logs, or browser persistence. Use the existing safe DTO, redaction, and
  managed-media helpers.
- Do not edit ignored generated/runtime areas such as `.svelte-kit/`, `build/`, `data/`, or
  `test-results/`. No vendored source tree is tracked.

## Additional References

- `README.md` — Read before changing runtime prerequisites, storage/privacy behavior, environment
  variables, production binding, or the full quality-command matrix.
- `.augment/rules/poyo-studio-tech-stack.md` — Read before Svelte/UnoCSS UI work. It is a broad stack
  reference; current `package.json`, configs, and tests override its generic command examples.
- `tests/security/static-architecture.test.ts` — Read before changing dependencies, client/server
  boundaries, Poyo access, or host integration.
- `tests/fixtures/pricing/README.md` — Read before changing pricing normalization or its reviewed
  corpus; published credits, not derived USD conversion, are authoritative.
- `scripts/validate-registry.ts` — Read before changing registry definitions or reviewed evidence to
  understand the enforced hashes, provenance, fixture, conditional-rule, and inventory coupling.
- `tests/integration/database/migrations.test.ts` — Read before any SQLite schema or compatibility
  change; the next pre-release migration strategy is not otherwise documented.
- `scripts/test-browser.ts` and `tests/helpers/browser-app-harness.ts` — Read before changing browser
  test infrastructure; the fixed suites build first and use isolated loopback mocks.
