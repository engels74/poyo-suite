<p align="center">
  <img src="static/poyo-local-studio-logo.svg" alt="Poyo Local Studio logo" width="192" height="192">
</p>

<h1 align="center">Poyo Local Studio</h1>

<p align="center">
  <strong>A local-first image and video studio for Poyo.ai</strong>
</p>

<p align="center">
  <a href="https://github.com/engels74/poyo-suite/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0 license"></a>
  <img src="https://img.shields.io/badge/Bun-1.3.14-000000?logo=bun&logoColor=white" alt="Bun 1.3.14">
  <img src="https://img.shields.io/badge/SvelteKit-2.69-FF3E00?logo=svelte&logoColor=white" alt="SvelteKit 2.69">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5.9">
  <img src="https://img.shields.io/badge/UnoCSS-presetWind4-333333?logo=unocss&logoColor=white" alt="UnoCSS presetWind4">
</p>

Poyo Local Studio is a Bun-backed SvelteKit application for creating, monitoring, and
organising Poyo image and video generations on one machine. It combines registry-driven
model forms, persisted asynchronous jobs, immediate verified downloads, a grouped media
library, presets, balance visibility, cleanup controls, and redacted diagnostics in one
responsive light/dark interface.

The project is independent and is not an official Poyo.ai client.

## What is included

- Separate Image and Video Studios with progressive, model-specific controls and expert
  request inspection.
- A versioned capability registry covering **22 image pages / 44 public IDs / 50 workflows**
  and **35 video pages / 53 public IDs / 121 current workflows**, backed by fetched-body
  hashes, structured OpenAPI evidence, and reviewed request fixtures.
- Durable SQLite jobs that recover after restarts, preserve ambiguous submissions, poll with
  backoff, and stream safe updates to browsers with Server-Sent Events.
- Local source intake, Poyo URL/base64/stream uploads, and atomic output downloads with size,
  content-type, signature, and SHA-256 verification.
- Dashboard, Jobs, Library, Models, Presets, Settings, and redacted Diagnostics routes.
- Indefinite local retention by default; age, storage-size, and free-space cleanup remain
  opt-in, with exclusions and preview/confirmation for manual bulk cleanup.

## Quick start

### Requirements

- [Bun 1.3.14](https://bun.sh/) — pinned in `.bun-version` and `package.json`.
- A Poyo API key for connectivity or generation. No paid request is needed to install, build,
  or run the automated test suite.

### Development

```bash
git clone https://github.com/engels74/poyo-suite.git
cd poyo-suite
bun install --frozen-lockfile
cp .env.example .env
chmod 600 .env
# Optionally set POYO_API_KEY in .env, or add a local key during onboarding.
# Never commit .env.
bun run dev
```

Open <http://localhost:5173>.

### Production build

```bash
bun run build
bun run start
```

The supported production command runs `build/index.js` with Bun and binds to
<http://127.0.0.1:3000> by default. `PORT` may be changed in the environment. Deliberate
network exposure requires running the adapter with a different `HOST`; review the privacy and
cross-origin implications first.

## Credentials, storage, and privacy

`POYO_API_KEY` always wins over a locally stored key. When it is active, the Settings UI keeps
the local selection visible but cannot replace, move, or remove it. Without that override, the
default backend is the permission-protected `<selected-root>/secrets/poyo-api-key` file. Its
directory uses mode `0700` and the key file uses mode `0600` on supported non-Windows systems. The
operating-system credential store—macOS Keychain when supported—is available only after an explicit
choice in onboarding or Settings. Unselected Keychain content is ignored and cannot silently
complete onboarding. Keys never enter page data, browser storage, SQLite, diagnostic exports, or
structured logs.

Application data defaults to the repository's `./data` directory. The SQLite database is
`./data/poyo-studio.sqlite`; the same root also contains retained uploads, verified media, logs,
temporary files, thumbnails, root-transition metadata, and the file credential when selected. The
platform application-data directory is an explicit onboarding/Settings choice:

| Platform | Optional platform application-data root |
| --- | --- |
| macOS | `~/Library/Application Support/Poyo Local Studio` |
| Windows | `%LOCALAPPDATA%\Poyo Local Studio` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/poyo-local-studio` |

Changing between the project and platform roots copies and verifies the complete managed root,
freezes further writes, and requires a process restart before the selected root becomes effective.
The source is retained until restart verification succeeds. The application never silently imports
a markerless legacy root. `PLS_APP_DATA_DIR` remains an authoritative root override; the narrower
`PLS_DATABASE_PATH`, `PLS_MEDIA_DIR`, and `PLS_LOG_DIR` overrides remain authoritative for their
individual locations. Environment-managed controls stay visible but disabled in the UI.

### Reset all local application state

This reset affects local files and credentials only. It does not delete Poyo tasks, uploads, or
outputs held remotely.

1. Stop the Studio completely. Do not remove or copy an active SQLite database, WAL, or SHM file.
2. If the selected credential backend is the operating-system store, use **Settings → Remove local
   key** before deleting the data root. On macOS, an already-orphaned item can instead be removed in
   Keychain Access by finding the `ai.poyo.local-studio` service. Deleting a data directory does not
   delete an operating-system credential.
3. Delete the selected data root:
   - project default: `rm -rf ./data`
   - macOS platform opt-in: `rm -rf ~/Library/Application\ Support/Poyo\ Local\ Studio`
   - Windows/Linux platform opt-in: remove the matching optional root from the table above
   - `PLS_APP_DATA_DIR`: remove the configured directory instead
4. If `PLS_DATABASE_PATH`, `PLS_MEDIA_DIR`, or `PLS_LOG_DIR` pointed outside that root, remove those
   operator-managed locations separately if a complete local wipe is intended.
5. Clear `POYO_API_KEY` everywhere it may be inherited—not only `.env`—then start a new shell or run
   `unset POYO_API_KEY`. The environment value remains authoritative while present.
6. Start the Studio. A fresh root opens `/welcome`, defaults to `./data` plus the file credential,
   and does not adopt stale markerless Application Support or Keychain content.

The application is unreleased and now has one version-1 initial database migration. Databases from
earlier development builds that recorded migration versions 2–4 are intentionally unsupported:
they are rejected read-only and are not imported, rewritten, or upgraded. Delete the old local data
root and start fresh rather than editing `schema_migrations`.

## Important upstream limitations

- Poyo documents no task cancellation, task/file/upload deletion, task-history API,
  submission-idempotency mechanism, dynamic model/capability listing, or pricing-estimate API.
- Remote cleanup is therefore unavailable; local deletion is never presented as remote
  deletion.
- Poyo's output-retention documentation conflicts between 24 hours and three days. The studio
  downloads completed outputs immediately and treats 24 hours as the safe floor.
- For every audited model that supports `enable_safety_checker`, the project deliberately
  sends `false` by default and exposes an opt-in control.
- Kling Avatar 2.0 is recorded but excluded from current selectors because avatars and
  audio-driven avatar generation are outside the initial scope.

## Quality commands

```bash
bun run format:check
bun run lint
bun run check
bun test
bun run test:e2e
bun run test:restart
bun run test:security
bun run test:performance
bun run validate:registry
bun run registry:audit:network
bun run build
bun run test:production-smoke
prek run --all-files
```

Normal tests use mocked/loopback Poyo responses and do not spend credits. The paid live test is
fail-closed and skipped by default. The registry network audit fetches only public official
documentation, sends no credentials, and spends zero credits:

The optional production-download probe exercises Bun's real pinned HTTP/HTTPS transport
against public `example.com` without authentication, Poyo traffic, or credits. It is disabled
unless explicitly enabled:

```bash
env -u POYO_API_KEY PLS_RUN_PUBLIC_DOWNLOAD_TEST=1 \
  bun test ./tests/live/public-download.live.ts
```

## License

Poyo Local Studio is licensed under the [GNU Affero General Public License v3.0](LICENSE).
