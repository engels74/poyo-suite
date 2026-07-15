# Architecture, operations, and privacy

## System boundary

Poyo Local Studio is one full-stack SvelteKit repository and one local Bun process. There is
no separate browser-only API client and no secondary Node service.

```text
Browser on this machine
  └─ same-origin SvelteKit pages and /api routes
       ├─ capability registry and request adapters
       ├─ Bun SQLite: jobs, settings, registry, presets, library, cleanup
       ├─ durable job and cleanup workers
       ├─ private local files: uploads, media, logs, secrets, reserved thumbnails
       └─ HTTPS to Poyo API
            └─ returned output URLs are downloaded to private local media storage
```

Server-only modules own credentials, Poyo transport, SQLite, filesystem access, downloads,
logging, and cleanup. Browser routes receive safe DTOs rather than credentials or local media
paths. Settings deliberately displays resolved storage paths to the local operator; copied
diagnostics omit them.

## Technology and domain boundaries

- **Runtime and package manager:** Bun 1.3.14.
- **Application framework:** Svelte 5.56.5 with runes and SvelteKit 2.69.3.
- **Production server:** `svelte-adapter-bun` 1.0.1.
- **Styling:** UnoCSS 66.7.5 with `presetWind4`; adapted Modern Minimal tokens; Bits UI
  primitives where focus management is required.
- **Persistence:** Bun's native `bun:sqlite`, schema version 3, checksum-verified migrations.
- **Feature modules:** registry/generation, Poyo transport, jobs, media/library, presets,
  settings/secrets, cleanup, and diagnostics.
- **Route modules:** thin load/API boundaries that validate same-origin input and delegate to
  server services.

The local capability registry—not a generic form and not Poyo's generic OpenAPI schema—owns
workflow roles, conditional controls, validation, exact payload normalization, provenance,
and limitations.

## Durable generation lifecycle

1. The guided request is normalized and validated against one registry workflow adapter.
2. SQLite stores the local job, request fingerprint, guided values, normalized Poyo payload,
   source roles, and a prepared submission intent before the paid network call.
3. A transactional submission claim and owner token allow only one worker to transmit the
   paid request.
4. A successful response persists the Poyo task ID immediately.
5. A timeout or network/provider failure after possible transmission becomes an ambiguous
   submission requiring attention. It is not automatically resubmitted.
6. The worker polls the authoritative status endpoint. Failed polls record local uncertainty;
   they do not mark the remote generation failed.
7. Poyo's real progress is persisted when present. No interpolated or continuously increasing
   progress is generated locally.
8. By default, `finished` outputs are downloaded, verified, and recorded independently of
   remote success. If automatic downloads are disabled, outputs remain available for a manual
   retry without paying for another generation.
9. Nonterminal jobs and expired worker claims are reconciled on application startup.

Submission, poll, and download work use bounded leases. Repository transactions reject stale
claim completion, which allows recovery after crashes without permitting two workers to own
the same operation.

### Retry behavior

- Balance and status reads may retry safe network/provider/rate-limit failures up to three
  attempts with bounded exponential backoff, jitter, and an observed `Retry-After` value.
- Paid generation submission and upload requests are not transport-retried after ambiguity.
- Polling defaults to five seconds and marks prolonged uncertainty stale after 15 minutes;
  validated Settings changes are read by the worker, and stale remains distinct from failed.

## SQLite and application data

Migrations run transactionally at startup and record a checksum. Startup fails if an applied
migration's content changes or the database contains an unknown migration version. Foreign
keys are enabled.

Persisted data includes:

- public application settings and secret-source metadata (never the secret value);
- registry versions, current/excluded/audit entries, favorites, and recents;
- jobs, Poyo task IDs, request payloads, inputs, outputs, events, progress, error history,
  credit observations, and balance snapshots;
- download attempts, checksums, signatures, sizes, and availability;
- presets, favorites, pins, and tags;
- local cleanup policies, previews, durable actions, claims, and results.

Default data roots are documented in the README. All application directories are created
privately (`0700` on POSIX). Output and secret files use private permissions (`0600` on POSIX).
Paths are normalized, null bytes and traversal are rejected, and local deletion refuses
symbolic links.

Back up the SQLite database and media/upload directories together while the application is
stopped if a consistent portable snapshot is required.

## Browser live updates

`GET /api/events/jobs` exposes a one-way Server-Sent Events stream. Initial connection sends a
SQLite snapshot with an event watermark. Reconnection with a valid `Last-Event-ID` replays
unseen durable events; invalid or compacted cursors receive a fresh snapshot. The stream polls
the database for new events and never becomes the source of truth.

A disconnected or suspended browser therefore loses only live presentation. Page loads and
reconnection synchronize from SQLite.

## Source uploads and output downloads

### Inputs

- Remote URL input must use HTTP(S), cannot contain embedded credentials, and cannot target
  local/private address ranges when passed through the Poyo URL-upload endpoint.
- Local source intake requires a same-origin multipart request, validates size, MIME type, and
  file signature, bounds aggregate request bytes while the body stream is consumed, accepts
  exactly one file and one media-kind field, then streams the validated file to retained
  private upload storage. The configured upload and temporary roots, the monthly upload
  bucket, and the published file are canonicalized independently. Root leaves and managed
  children must be real directories rather than symbolic links; an existing symbolic-link
  ancestor such as a macOS path alias is accepted only when its canonical target remains
  inside the configured root. Temporary files use exclusive/no-follow creation, are synced,
  and are published by a no-overwrite hard link after the directories are rechecked.
- The server streams that retained source to Poyo. Image formats are JPEG, PNG, GIF, and WebP;
  video formats are MP4, WebM, MOV, AVI, and MKV. Poyo's streaming video limit is 100 MiB.
- Base64 is accepted only for image sources up to 5 MiB by the server client. Large files and
  video are never converted to base64.

Managed-source registration, restart reconciliation, legacy-reference adoption, and deletion
all use the same canonical containment boundary. A swapped parent link cannot make an outside
same-size file look present or eligible for deletion. Unsafe or missing legacy absolute
references are deliberately left unadopted for operator review rather than being rewritten as
trusted managed sources. Moving files outside the managed directories cannot affect retained
uploads, but deleting the managed upload directory removes the local source copy. Poyo upload
expiration is stored when returned. Poyo documents no upload-deletion endpoint.

### Outputs

Downloads use a private per-job directory and an unpredictable `.partial` filename. The
downloader:

1. accepts only credential-free HTTP(S), resolves every DNS answer, normalizes IPv4-mapped
   IPv6, rejects any non-public or unknown IPv4/IPv6 address, and installs a lookup callback
   that can return only the selected validated address while preserving the original Host and
   TLS server name;
2. refuses redirects and compressed transfer encodings; limits response headers to 16 KiB;
   bounds connect/TLS/header waiting at 30 seconds, each idle body read at 30 seconds, the
   entire operation—including DNS resolution—at 30 minutes, and local output at 2 GiB;
3. streams bytes directly to disk while computing SHA-256;
4. rejects empty files and mismatched declared/Poyo lengths;
5. derives PNG/JPEG/GIF/WebP/MP4/MOV/WebM type from a strict signature allowlist and rejects
   unsupported, generic-with-unknown-signature, mismatched, or wrong-kind bytes;
6. flushes and syncs the temporary file;
7. rejects symlinked roots/parents, opens the partial leaf with exclusive/no-follow flags, and
   publishes it with a no-overwrite hard link to a sanitized destination;
8. durably records an output-specific publication receipt before the link, syncs the containing
   directory, and then records verification metadata in SQLite. After a crash in that window,
   restart recovery re-hashes and signature-checks the exact receipt target before adoption. A
   changed collision is preserved and a collision-safe alternate name is used instead.

Poyo documents no stable output-host allowlist. The downloader therefore trusts the operating
system's DNS result only after validating every returned address. Production requests retain
the original hostname but replace the request resolver with an exact, one-address lookup, so
Bun cannot perform a second system DNS query or select a different family address. The request
does not depend on Bun exposing `socket.remoteAddress`, which is absent in the supported Bun
runtime. This closes the normal DNS-rebinding interval while still relying on Bun's documented
`node:http`/`node:https` compatibility and the operator's OS resolver. Portable JavaScript
exposes no cross-platform `openat`-style directory descriptor API, so a malicious same-account
filesystem actor could still race the final parent check; private `0700` application
directories, repeated canonical checks, no-follow temporary creation, durable receipts, and
collision-safe publication make that residual local race substantially narrower.

A generation may therefore be remotely successful while one or more local downloads require
attention. The states are intentionally separate.

## Local and remote cleanup

Local retention defaults to `never`. Opt-in policies can select files by age, total indexed
media size, or minimum free space and can exclude favorites, pins, and tags. Manual bulk
cleanup requires a persisted preview token and explicit confirmation; the preview lists
candidate filenames, bytes, and reasons. Once an operator saves a non-`never` automatic
policy, the durable cleanup worker re-evaluates it on startup and every 15 minutes, persists a
snapshot before scheduling candidates, and avoids duplicate pending actions for the same
policy and consequence.

Deletion consequences remain distinct:

- **File:** delete the local file and retain history marked unavailable.
- **Metadata:** delete the output record and leave an untracked local file.
- **Both:** delete the local file and its output record.

Scheduled actions and worker leases are stored in SQLite. Overdue actions reconcile on the
next application start; the application cannot run cleanup while it is closed.

Poyo exposes no verified task, upload, or generated-file deletion endpoint. Remote cleanup is
therefore unavailable. The application never hides a local record and labels that remote
deletion.

## Credentials

Credential precedence is strict:

1. A non-empty `POYO_API_KEY` environment value is authoritative.
2. Otherwise, the server checks Bun's operating-system secret service.
3. If unavailable on a supported non-Windows system, it may use an atomic permission-restricted
   local secret file.
4. If neither store is safe, local onboarding is unavailable and the application requires an
   environment key.

An environment key cannot be overridden or removed by the UI. A locally entered key is sent
once over the same-origin loopback request, cleared from the field, and returned only as source
and status metadata. SQLite records connectivity time/status and secret-source metadata, not
key material.

## Logging and diagnostics

Structured JSONL logs contain timestamps, levels, event names, correlation IDs, local job IDs,
Poyo task IDs, and redacted metadata. They never intentionally contain authorization headers,
API keys, cookies, credentials, long base64 values, or raw secret-bearing payloads. Recursive
redaction also sanitizes bearer strings, secret query values, data URIs, and Poyo-style keys.

Default rotation is 5 MiB or 24 hours, with 14-day retention, at most ten rotated files, and a
separate error stream. Validated Settings changes are applied to the active logger.

Diagnostics reports application/schema versions, loopback policy, SQLite status, credential
source/status, connectivity freshness, registry versions, aggregate storage, cleanup-worker
state, and log health. Copied reports exclude API keys and local filesystem paths. Raw stack
traces are not rendered in the browser.

### Temporary production-dependency audit exception

As of 2026-07-15, `bun audit --production` reports low-severity advisory
`GHSA-pxg6-pf52-xh8x` for transitive `cookie@0.6.0`, required by the pinned SvelteKit 2.69.3.
The advisory concerns out-of-bounds characters in cookie names, paths, or domains. This
application does not construct those values from attacker-controlled input, so the observed
exposure is low. The project tracks a compatible upstream SvelteKit update rather than forcing
an unrelated dependency override; the exception must be removed or re-reviewed when the
framework dependency changes.

## What leaves the machine

Application runtime traffic is limited to operator-requested Poyo work and returned output
downloads. There is no analytics, advertising, third-party telemetry, or remote font request.

| Destination | Data sent | When |
| --- | --- | --- |
| `https://api.poyo.ai` | Bearer API key in the authorization header; model ID; prompt and normalized parameters; referenced remote URLs; selected local media bytes for stream upload; balance/status task identifiers. | Connectivity test, balance refresh, source upload, generation submit, or status polling. |
| Public URL supplied by the operator | The application sends the URL to Poyo's URL-upload service; Poyo may fetch that resource. | Only when URL upload is selected. |
| Public output host returned by Poyo | A credential-free GET pinned to a validated public address. Redirects and local/private/reserved destinations are refused. | After a successful task or a manual download retry. |
| `docs.poyo.ai` | Standard documentation HTTP requests; no API key, prompt, media, or generation request. | Only when a developer deliberately runs `bun run registry:audit:network`. |

The local browser communicates with the loopback SvelteKit server. Those same-origin requests
do not leave the machine. Viewing the GitHub README may load badge images from `img.shields.io`;
that is repository presentation, not application runtime behavior.

## Network exposure

`bun run start` forces `HOST=127.0.0.1`. Same-origin JSON and multipart mutation routes reject
missing/mismatched origins and cross-site requests. Private media routes enforce same-origin
access, safe path resolution, and range bounds.

Changing the adapter host to a non-loopback address is an explicit operator action and is not a
supported secure multi-user deployment. Before doing so, add an authenticated reverse proxy,
TLS, host/origin policy, filesystem-user isolation, and a threat review. Poyo webhooks are not
enabled automatically; they require a public HTTPS endpoint and would change the privacy and
attack surface materially.
