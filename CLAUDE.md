# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Poyo Local Studio is a single-package (no workspaces) SvelteKit 2 + Svelte 5 application running on
Bun. It generates images and video through the Poyo.ai API and stores everything locally in SQLite
plus a platform application-data directory. Bun is the only supported runtime and package manager,
pinned to `1.3.14` in `.bun-version`, `package.json#packageManager`, and `engines`. Run every
command from the repository root.

## Commands

| Task | Command |
|---|---|
| Install | `bun install --frozen-lockfile` |
| Dev server (127.0.0.1:5173) | `bun run dev` |
| Build / run production (127.0.0.1:3000) | `bun run build` then `bun run start` |
| Lint | `bun run lint` |
| Format check / write | `bun run format:check` / `bun run format` |
| Type check | `bun run check` (runs `svelte-kit sync` first) |
| Tests | `bun test` |
| One test file | `bun test tests/integration/database/migrations.test.ts` |
| One test by name | `bun test <test-file> -t "checksum"` |
| Registry validation | `bun run validate:registry` |
| All pre-commit gates | `prek run --all-files` |

Setup also needs `cp .env.example .env`, `chmod 600 .env`, and a `POYO_API_KEY` for any Poyo
connectivity. Install/build/lint/type-check and the default test suite need no key and spend no
credits.

Test-file suffixes decide what runs. Bun only auto-discovers `*.test.ts`, so the `.browser.ts` and
`.live.ts` suites are invisible to `bun test` and must be launched explicitly:

- `bun run test:e2e` / `bun run test:security` — build first, then run the Playwright browser suites
  via `scripts/test-browser.ts`.
- `bun run test:restart` / `bun run test:performance` — serialized (`--max-concurrency 1`).
- `bun run test:live` — real Poyo calls that spend credits. Skipped by default; do not run casually.

## Architecture

Execution starts at `src/hooks.server.ts`, whose `init()` starts the background job worker and
cleanup worker. Two memoized async singletons own all runtime state; call them rather than
constructing repositories or clients yourself:

- `getPlatformServices()` in `src/lib/server/platform/runtime.ts` — resolves app paths, opens and
  migrates SQLite, seeds the model registry, and exposes `database`, `settings`, `apiKey`, `logger`.
- `getJobRuntime()` in `src/lib/server/jobs/runtime.ts` — `repository`, `coordinator`, `worker` for
  the submit → poll-with-backoff → verified-download lifecycle.

Directory ownership:

- `src/lib/server/**` — server-only: `platform` (paths, database, request security), `poyo` (API
  client), `jobs`, `media`, `library`, `cleanup`, `settings` (secret store), `diagnostics`.
- `src/lib/features/**` — browser-safe shared logic and types. The model capability registry
  (`registry/image-registry.ts`, `registry/video-registry.ts`, `registry/normalize*.ts`) lives here
  because both the UI and the server normalize requests against it.
- `src/routes/api/**` — HTTP endpoints; job updates stream over SSE from
  `src/routes/api/events/jobs/+server.ts`.
- `migrations/**` — SQL migrations at the repository root, **not** under `src/`.

`tests/security/static-architecture.test.ts` statically enforces these invariants, so a violation
fails `bun test` rather than review:

- No value imports of `$lib/server` (or `lib/server`, `/server/`) from `*.svelte`,
  `src/hooks.client.ts`, or `src/lib/features/**`. `import type` is permitted.
- Svelte 5 runes only — no `export let`, no `on:` event directives.
- No `tailwindcss`, `@sveltejs/adapter-node`, `express`, `ts-node`, `jest`, or `vitest` dependency,
  and no `npm`/`pnpm`/`yarn`/`node` in any `package.json` script.

## Key workflows

### Adding a database migration

Migrations are checksummed (`migrationChecksum` in `src/lib/server/platform/database.ts`), so
editing an already-applied migration throws `no longer matches its recorded checksum`. Always add a
new file instead.

1. Create `migrations/000N-name.ts` exporting a `Migration` (`version`, `name`, `sql`, optional
   `afterSql`). Versions must be unique and strictly increasing.
2. Register it in the `migrations` array in `migrations/index.ts`.
3. Bump `DATABASE_SCHEMA_VERSION` in `src/lib/server/platform/version.ts` — `migrateDatabase`
   throws if the applied max version and this constant disagree.
4. Add any new table to `expectedTables` in `tests/integration/database/migrations.test.ts`, which
   asserts an exact sorted table list.
5. Verify: `bun test tests/integration/database/migrations.test.ts`.

### Changing the model registry

`scripts/validate-registry.ts` is an evidence gate, not a formality: it recomputes the source-corpus
hash, requires a reviewed request fixture per workflow and an invalid fixture per conditional rule,
and hard-asserts inventory counts (22 image pages / 44 public IDs / 50 workflows; 35 video pages /
53 public IDs / 121 current workflows). Changing entries without refreshing evidence fails with
`inventory changed without reviewed evidence`.

1. Edit `src/lib/features/registry/image-registry.ts` or `video-registry.ts`, plus the matching
   validation in `normalize.ts` / `normalize-video.ts`.
2. Refresh the evidence in `src/lib/features/registry/evidence/` with
   `bun run registry:evidence:refresh` (network fetch of public docs only — no credentials, no
   credits).
3. Update the hardcoded counts and `registryVersion` expectations in `scripts/validate-registry.ts`.
4. Verify: `bun run validate:registry`, then `bun test`.

### Adding an API route

Mutating JSON routes must read the body through `readSameOriginJson` from
`$lib/server/platform/request-security` — it enforces the Origin check, `sec-fetch-site`, content
type, and a body-size cap. No route calls `request.json()` directly.

```ts
// src/routes/api/presets/+server.ts
export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<SavePresetRequest>(request, { maxBytes: 256 * 1024 });
    const platform = await getPlatformServices();
    const preset = new PresetRepository(platform.database).save(body);
    return Response.json({ preset }, { status: body.id ? 200 : 201 });
  } catch (error) {
    /* map to a safe error response — see the table below */
  }
};
```

### Choosing an error mapper

| Route surface | Mapper |
|---|:---:|
| Job submit/retry/rerun/refresh — needs `RegistryValidationError` issue lists | `jobHttpError` (`$lib/server/jobs/http`) |
| Cleanup, settings, api-key, balance — needs `CleanupValidationError` / `EnvironmentKeyActiveError` | `operationsHttpError` (`$lib/server/operations/http`) |
| Neither category applies | Inline `catch` that still special-cases `RequestSecurityError` |

## Repository-specific rules

- Build the Poyo client with `createPoyoClient` from `$lib/server/poyo/factory`; never construct
  `new PoyoClient`/`PoyoTransport` or raw `fetch` calls to Poyo. The factory resolves the API key,
  applies retry/backoff, pins the base URL, and attaches the redacting metadata logger.
- Never surface a raw `PoyoError`; return `error.toSafeDto()`. API keys must not reach page data,
  browser storage, SQLite, diagnostics exports, or logs — `POYO_API_KEY` from
  `$env/dynamic/private` always wins over the local secret store (`ApiKeyManager.resolve`).
- `PLS_TEST_POYO_BASE_URL` and the job-timing overrides throw unless `PLS_TEST_MODE=1`, and the test
  origin must be loopback HTTP. Point tests at `tests/helpers/mock-poyo-server.ts` rather than
  loosening these gates.
- `prek.toml` blocks direct commits to `main` and enforces Conventional Commits, gitleaks, format,
  lint, `svelte-check`, `bun test`, registry validation, and a production build. Work on a branch.
- `.svelte-kit/` and `build/` are generated; `bun run check` runs `svelte-kit sync` for you when
  `./$types` imports look unresolved.

## References

- `.augment/rules/poyo-studio-tech-stack.md` — the authoritative Bun / Svelte 5 runes / SvelteKit 2
  / UnoCSS `presetWind4` / shadcn-svelte coding guide. Read before writing components or styles.
- `README.md` — user-facing setup, privacy model, and known Poyo upstream limitations (no
  cancellation, no remote deletion, conflicting retention docs).
</content>
</invoke>
