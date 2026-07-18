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

Clone the repository, install with `bun install --frozen-lockfile`, and create a private `.env`
from `.env.example` if environment configuration is needed. Never commit `.env`. Start the local
development server with `bun run dev`.

Open <http://127.0.0.1:5173>.

### Production build

```bash
bun run build
bun run start
```

The supported production command validates the bind address before importing the built server.
It binds to <http://127.0.0.1:3000> by default; `PORT` may be changed. `HOST` may be
`127.0.0.1` or `::1` only. Wildcard, LAN, and hostname binds fail closed so the backend remains a
private loopback service.

## Credentials, storage, and privacy

`POYO_API_KEY` always wins over a locally stored key. When it is active, browser configuration
cannot replace or remove it. Without that override, the loopback server stores the key in the
managed `secrets/poyo-api-key` file using exclusive atomic publication, private requested modes,
readback verification, and durable deletion. Keys never enter page data, browser storage, SQLite,
diagnostic exports, structured logs, or HTTP error bodies.

Application data defaults to the repository's `./data` directory. It contains the SQLite database,
retained uploads, verified media, bounded logs, temporary files, thumbnails, and the local
credential. `PLS_APP_DATA_DIR` is the single authoritative root override; every application-owned
resource remains beneath it. This server setting is never returned to the browser, diagnostics, or
logs, and the application never scans alternative locations.

The application has no telemetry or analytics. Runtime network traffic is limited to explicit
Poyo connectivity, upload, generation, status, balance, and download operations initiated by the
user or required to finish a durable job. Active jobs are checked every ten seconds by default;
unchanged status observations advance the durable poll clock without creating repetitive lifecycle
history entries.

### Delete local data

Deletion is explicit and browser-based:

- Each verified output can remove its local file, local metadata, or both from its job/library view.
- Settings can preview and confirm bounded bulk cleanup, with favorites and pinned outputs excluded
  by default.
- Settings can clear the entire application-owned structured-log directory after queued writes
  drain. The directory is atomically captured before deletion so replacing the `logs` entry with a
  link cannot redirect deletion.
- Settings can remove the locally stored API key when `POYO_API_KEY` is not authoritative.

These actions affect local data only. They never claim to delete Poyo tasks, uploads, or outputs
held remotely. The application does not expose file-manager integrations, local filesystem
commands, or server paths through the browser.

The selected application root and its ancestors are a local trust boundary. Poyo Local Studio
rejects a linked root at startup and creates validated application-owned children, but it does not
claim to isolate data from another process running as the same account that can replace the
configured root itself.

The application is unreleased and has one version-1 initial database migration. Databases from
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
