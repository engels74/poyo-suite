# Repository Guidelines

## Scope and Instruction Precedence

- Run commands from the repository root with Bun 1.3.14, pinned by `.bun-version`,
  `package.json#packageManager`, and `engines`.
- Prefer executable configuration and tests over prose when they disagree. Before UI or styling
  work, also read `.augment/rules/poyo-studio-tech-stack.md` for the enforced Svelte 5 runes,
  SvelteKit 2, UnoCSS presetWind4, and Bits UI conventions.

## Project Map and Boundaries

- `src/routes/**` owns SvelteKit pages, server loads, and HTTP endpoints. Keep routes thin: parse the
  request, call shared/domain services, and return safe DTOs.
- `src/lib/features/**` owns browser-safe contracts, registry definitions, normalization, and pure
  studio/library logic shared by client and server. It must not value-import `src/lib/server/**`.
- `src/lib/server/**` owns SQLite, filesystem access, credentials, Poyo transport, jobs, cleanup,
  diagnostics, and native actions. Reuse `getPlatformServices()` and `getJobRuntime()` rather than
  creating competing application runtimes.
- `migrations/**` contains ordered `bun:sqlite` migrations; platform schema versions live in
  `src/lib/server/platform/version.ts`.
- `src/lib/features/registry/evidence/**` is committed evidence: source and workflow fixtures are
  refreshed by scripts, while conditional vectors and conflict decisions remain reviewed inputs.
- `tests/{unit,integration,reliability,performance,security,e2e,live}` separates scope. Reuse the
  temporary directories, mock Poyo servers, job fixtures, and browser harnesses in `tests/helpers`.
- `.svelte-kit/`, `build/`, `data/`, and `test-results/` are generated or local runtime output. Edit
  source/configuration and regenerate them; do not patch their contents.

## Build, Test, and Development Commands

| Purpose | Command |
| --- | --- |
| Reproducible install | `bun install --frozen-lockfile` |
| Local development on loopback | `bun run dev` |
| Format write / check | `bun run format` / `bun run format:check` |
| Biome lint | `bun run lint` |
| SvelteKit sync and type check | `bun run check` |
| One test file | `bun test tests/unit/jobs/routes.test.ts` |
| Normal non-browser suite | `bun run test` |
| Playwright product flows | `bun run test:e2e` |
| Static plus browser security | `bun run test:security` |
| Serialized restart / performance suites | `bun run test:restart` / `bun run test:performance` |
| Registry evidence validation | `bun run validate:registry` |
| Production build / smoke test | `bun run build` / `bun run test:production-smoke` |
| All configured pre-commit gates | `prek run --all-files` |

`test:e2e` and `test:security` build first, then run their `.browser.ts` files serially through
`scripts/test-browser.ts`. Bun discovers `.test.ts`; `.browser.ts` and `.live.ts` require explicit
scripts. `bun run test:live` can spend credits when its fail-closed gates are enabled, so use mocks
unless a task explicitly authorizes a paid live probe.

## Common Change Workflows

### Add or change a page/API feature

1. Put browser-safe DTOs and validation in `src/lib/features/<domain>/`; put persistence,
   filesystem, credentials, and upstream calls in `src/lib/server/<domain>/`.
2. Load shared runtime state through `getPlatformServices()` or `getJobRuntime()` and keep the
   route handler orchestration-only.
3. For mutating JSON endpoints, call `readSameOriginJson()` with a route-appropriate byte limit;
   for uploads, use the guarded multipart path in `src/lib/server/media/source-intake.ts`. Do not
   call `request.json()` directly because origin, fetch-site, content-type, and size checks are
   centralized.
4. Map errors to safe responses using the decision table below. Never serialize a raw exception,
   local path, API key, or normalized paid-request payload.
5. Add domain unit/integration tests; add a `.browser.ts` scenario when navigation, hydration,
   accessibility, or a complete user flow changes. Run the targeted test, then the applicable
   normal/browser/security suites.

Canonical mutation shape (`src/routes/api/presets/+server.ts`):

```ts
const body = await readSameOriginJson<SavePresetRequest>(request, { maxBytes: 256 * 1024 });
const platform = await getPlatformServices();
const preset = new PresetRepository(platform.database).save(body);
return Response.json({ preset }, { status: body.id ? 200 : 201 });
```

### Change the database schema

1. Preserve `migrations/0001-initial.ts` and
   `tests/fixtures/database/pre-collapse-schema-signature.json` as the locked version-1 baseline;
   add a forward `migrations/000N-name.ts` instead of changing a recorded checksum.
2. Register the migration in increasing order in `migrations/index.ts` and bump
   `DATABASE_SCHEMA_VERSION` in `src/lib/server/platform/version.ts`.
3. Extend `tests/integration/database/migrations.test.ts` for exact tables/columns, upgrade,
   rollback, checksum, and reopen behavior. Keep its immutable v1 compatibility assertion rather
   than rewriting the fixture to match new schema.
4. Run `bun test tests/integration/database/migrations.test.ts`, relevant repository tests, then
   `bun run test` and `bun run test:restart` for lifecycle-sensitive changes.

### Change the model registry

1. Update `image-registry.ts` or `video-registry.ts` together with `normalize.ts`,
   `normalize-video.ts`, or `normalize-registry.ts` as applicable; bump the affected registry
   version.
2. Run `bun run registry:evidence:refresh` to refetch public official documentation and regenerate
   workflow fixtures. Review every evidence diff; update reviewed conditional/conflict records when
   the change affects those decisions.
3. Update intentional inventory assertions in `scripts/validate-registry.ts`; do not weaken the
   source hashes, per-workflow fixtures, invalid conditional vectors, or inventory gate merely to
   make validation pass.
4. Run `bun run validate:registry`, targeted `tests/unit/registry/**` tests, and `bun run test`.

## Decision Guide

| Situation | Use | Avoid |
| --- | --- | --- |
| Logic/types needed by browser and server | `src/lib/features/**` | Value imports from `$lib/server` |
| Database/settings/logger/credential access | `getPlatformServices()` | A second database or service singleton |
| Job repository/coordinator/worker access | `getJobRuntime()` | Constructing runtime workers in routes |
| Job submit/retry/rerun errors | `jobHttpError()` | Leaking registry/Poyo internals |
| Cleanup/settings/key/balance errors | `operationsHttpError()` | Duplicating mapper branches |
| Domain-specific API error | Inline safe mapper including `RequestSecurityError` | Returning `String(error)` indiscriminately |

## Coding Conventions and Definition of Done

- Biome enforces 2 spaces, 100 columns, single quotes, semicolons, and no trailing commas. Use
  `import type`; strict TypeScript enables unchecked-index, exact-optional, and unknown-catch checks.
- Svelte components use `$props`, `$state`, `$derived`, snippets/`{@render}`, and event properties
  such as `onclick`. Do not use `export let`, slots for new composition, or `on:` directives; the
  static architecture test rejects legacy syntax.
- Reuse UI primitives in `src/lib/components/ui/**`, UnoCSS theme tokens/shortcuts from
  `uno.config.ts`, and the `$lib` alias. Import `uno.css` only through `src/hooks.client.ts`.
- Create production Poyo clients with `createPoyoClient()` to retain credential resolution,
  loopback test origins, retry/backoff, and redacted logging. Use the mock Poyo helper in tests.
- Before finishing: run format check, lint, check, targeted tests, `bun run test`, then registry,
  browser/security, restart/performance, build, and smoke gates when the changed surface requires
  them. Report any deliberately unrun paid or network probe.

## Commit and Pull Request Expectations

`prek.toml` blocks direct commits to `main`, scans secrets, and enforces Conventional Commits.
Recent history uses subjects such as `feat(studio): ... (#6)`, `feat(storage): ... (#5)`,
`docs: ...`, and `chore(cleanup): ...`. There is no repository PR template or CI workflow; state
the validations actually run rather than inventing approval, screenshot, or issue-link rules.

## Reference Documentation

- `README.md` — Read before setup, production exposure, storage, credentials, privacy, reset,
  upstream-limitation, or live-network changes.
- `.augment/rules/poyo-studio-tech-stack.md` — Read before Svelte, runes, UnoCSS, or Bits UI work.
- `tests/security/static-architecture.test.ts` — Read before changing dependencies, boundaries,
  framework configuration, or Svelte syntax.
- `src/lib/server/platform/request-security.ts` — Read before adding a mutating JSON endpoint.
- `src/lib/server/platform/database.ts` and `tests/integration/database/migrations.test.ts` — Read
  before database, migration, preflight, or schema-signature work.
- `scripts/validate-registry.ts` — Read before changing registry entries, evidence, counts, or
  normalization rules.
- `prek.toml` — Read before changing validation tooling or preparing a commit.
