# Database, storage and local operations

## Verified Docker preflight

Executed before provisioning:

```sh
docker version
docker compose version
docker context show
docker image ls --digests
docker ps -a
docker volume ls
docker image inspect pgvector/pgvector:pg16-bookworm
docker run --pull=never --rm pgvector/pgvector:pg16-bookworm sh -c 'postgres --version && cat /usr/share/postgresql/16/extension/vector.control'
```

Docker Desktop **4.66.1**, Engine **29.3.1**, Compose **5.1.0**, context **default**. The only pgvector-tagged local candidate was:

| Item           | Actual value                                                              |
| -------------- | ------------------------------------------------------------------------- |
| Repository/tag | `pgvector/pgvector:pg16-bookworm`                                         |
| Image ID       | `sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a` |
| PostgreSQL     | 16.15, Debian bookworm, amd64                                             |
| pgvector       | 0.8.7                                                                     |
| Container      | `digitalarch-postgres`                                                    |
| Host bind      | **127.0.0.1:5432** → 5432                                                 |
| Named volume   | `digitalarch_pgdata` → `/var/lib/postgresql/data`                         |

`digitalarch-postgres` and `digitalarch_pgdata` did not exist, and host port 5432 was available. Existing `conmas-postgres`, `dpr-postgres`, `dpr-redis` and all unrelated volumes/images were left alone. A short-lived no-pull inspection container was automatically removed; no user container was removed.

`compose.yaml` has **`pull_policy: never`**, no version property and no build definition. `pnpm db:up` executes `docker compose up -d --pull never`. **Zero Docker image downloads.** If the configured image is absent, provisioning fails; inspect local images and stop rather than substituting/downloading one.

`.env` was created exclusively with a 36-byte cryptographically random database password and mode 0600, without overwriting a file. `.gitignore` excludes secrets. `.env.example` contains placeholders only. Another machine must repeat discovery and safely create its own `.env`, choosing an available loopback port and compatible local image. Never overwrite unrelated containers or volumes.

## Connection and migrations

`server/db.mjs` uses node-postgres, a bounded pool, UTC sessions, 3-second connect timeout, parameterized SQL and explicit transactions. `pnpm db:migrate` serializes migration runners with a transaction advisory lock, executes numbered SQL, and records SHA-256 in `schema_migrations`. Repeating it is safe; changing an applied migration is rejected. Add a new migration instead.

The first migration enables the extension; the status command verifies the installed versions:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT version();
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

The last two SELECTs are executed by `pnpm db:status` through the actual WSL Node.js client. pgvector is enabled now; there are **no embedding columns/tables and no guessed vector dimension**.

`pnpm db:down` keeps `digitalarch_pgdata`. Never delete this volume to resolve a routine startup issue. Back it up along with files. The application does not automatically migrate or fall back to JSON when PostgreSQL is unavailable.

## Schema

All entity primary keys are UUIDs. Timestamps are TIMESTAMPTZ, stored in UTC and displayed in Asia/Jakarta.

| Table                 | Important relationships / rules                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `schema_migrations`   | Checksummed version ledger                                                                                                        |
| `users`               | Case-insensitive unique username, Argon2id hash, active/forced-change flags, account version                                      |
| `roles`               | Six stable role codes                                                                                                             |
| `permissions`         | Permission codes; no implicit superuser operational privileges                                                                    |
| `user_roles`          | User ↔ role many-to-many                                                                                                          |
| `role_permissions`    | Role ↔ permission many-to-many                                                                                                    |
| `auth_sessions`       | User, token hash, CSRF hash, fixed expiry, revocation                                                                             |
| `auth_login_attempts` | Persisted per-username 15-minute failed-login window                                                                              |
| `archive_batches`     | Creator/assigned user, generated unique code, nonunique optional location, explicit status and version                            |
| `documents`           | Batch → many logical documents; unique `(batch_id,document_index)`, initially one empty placeholder                               |
| `scan_sessions`       | Batch + document + operator, sequential number, scanner snapshot/job reference, status/count/error; one running session per batch |
| `pages`               | Batch + document + session composite FK; immutable capture order/original key/hash/source; independent display order/active key   |
| `page_revisions`      | Future replacement history for a logical page; no current replacement API                                                         |
| `audit_logs`          | Actor, action, entity, optional batch, non-sensitive metadata, correlation UUID; append-only trigger                              |
| `ocr_jobs`            | Batch snapshot, persistent status/counters/configuration, unique manifest/language, lease token/expiry and version                |
| `page_ocr_results`    | Job/page/batch composite FKs, image checksum/revision/rotation, text/bounds/errors/timing, attempts and exact-result reuse link   |

Foreign keys have no cascade-delete path for documents/pages. Unique indexes protect batch codes, session numbering, original storage keys and feeder order. A trigger rejects deletion or mutation of original page provenance. Application operations prohibit cancelling any batch with captured pages, including removed ones. Basic operator corrections use the existing `rotation_degrees` and `is_excluded` columns; no new migration or image rewrite is required. Page revisions and formal QC remain future work.

`PATCH /api/pages/:id` requires `batches:update`, ownership, a mutable batch, its current version, valid CSRF and no running/reconciling session. Rotation wraps in 90-degree steps; removal/restore only changes exclusion state. Changes bump the batch version and append `page.rotated`, `page.removed` or `page.restored` audit records in the same transaction. Batch counts include retained pages only; scan-session counts preserve the original feeder result. Completion requires at least one retained page and still verifies every original. Removed files remain accessible to authorized owners and recoverable through the UI.

`002_capture_order.sql` adds a session feeder-order base and observed-file count. These reserve missing/corrupt file positions so recovery cannot insert an earlier sheet after later feeder sessions or let another session take its place. Regular successful capture orders are 1,2,3… independent of filename sorting.

`003_batch_deletion.sql` adds `archive_batches.deleted_at`/`deleted_by` and the Operator-only `batches:delete` permission. Deletion locks the batch, checks assignment/version, permits only In Progress/Paused batches and rejects running/reconciling sessions. It records a tombstone and `batch.deleted` audit event without changing capture status or deleting any child/file. Deleted batches are omitted from operator/admin lists and blocked by batch/page access, editing, reassignment and reconciliation. Capture-completed batches remain locked against deletion, including direct API requests. No batch restore/purge endpoint is implemented.

`004_ocr_processing.sql` adds the OCR tables, queue/lease/page indexes, current-image checksum validation, stale-result trigger, `queue_batch_ocr` function and four OCR permissions. Capture state stays `capture_completed`; `archive_batches.ocr_status` separately records preparation/processing state without unlocking capture or adding QC transitions. Completion and enqueue share one transaction. `005_ocr_revision_generation.sql` adds monotonic image-revision generations so returning to identical bytes queues a new snapshot rather than reviving a stale job; a unique index permits only one processing page per job. Applied migrations are unchanged.

The queue locks a job using `FOR UPDATE SKIP LOCKED`, commits a UUID lease, then processes outside the transaction. Heartbeats renew live leases; expired claims are recovered with bounded attempt accounting. Result writes require the matching unexpired token. Every page result and progress update commits independently. Successful source/config identities have a partial unique index; later jobs reference an existing exact result rather than inserting another successful extraction. The identity includes SHA-256, engine/version and binary hash, language-file hashes, SDK/mode and explicit rotation. Old revision results remain stored and marked stale. There is no page replacement API in this phase; integrity/scheduling hooks support the existing revision schema and are tested via recorded revisions.

`006_ocr_profiles.sql` adds `ocr_jobs.processing_config` and an idempotent request key, extending the existing queue identity for history-preserving reprocessing. Earlier Fast results are labelled legacy, not rewritten. New configuration snapshots include profile, Best data, PSM 3/4/6, preprocessing/version and DPI. Source/job relationships, leases and the database architecture remain the same. Benchmark mode uses ordinary jobs, not a second processing service. See [OCR.md](OCR.md).

`007_ocr_engines.sql` adds a constraint for explicit `paddleocr` / `PP-OCRv6 Small` processing-version-3 configurations and insert-only triggers to snapshot the engine label on new jobs/page placeholders. It does not modify historical Tesseract rows/configuration identities. Existing queue functions, job leases, per-page results, exact-success cache, request idempotency and ownership are reused by the unified adapter. Omitting the engine retains the old Tesseract configuration identity. No new table, database, Redis or Docker image is introduced.

`008_ocr_global_settings.sql` adds the single-row `ocr_defaults` table (language, processing JSON, optimistic-concurrency version, updated time/actor), System Administrator `settings:read` / `settings:manage` permissions, and validation for processing-version-4 PaddleOCR budgets of 1/2/4 CPU threads. Existing version-3 jobs retain an implicit one-thread budget. `queue_batch_ocr` resolves omitted language/configuration from the singleton row in the enqueue transaction; explicit snapshots are unchanged. The backend seeds the row from existing environment settings only when no row exists. Changing defaults does not update, restart or reprocess old jobs. Saves are version-checked and audited as `ocr.settings_updated`. No additional database/service/image is introduced.

## Authentication and permission policy

Passwords: Argon2id, 65536KiB memory, three iterations, parallelism one, generated salt. Temporary passwords: 24 random bytes, displayed once by CLI/UI and never written to logs/audit/plaintext database fields. Sign-in verifies dummy hashes for unknown accounts and throttles repeated failures (five per username per 15 minutes; four concurrent verifications per process).

Session tokens: 32 random bytes in an HttpOnly, SameSite=Strict cookie; database contains SHA-256 only. A session-specific CSRF value is returned by login/me and kept in React memory; the database stores its hash. Login is protected by same-origin checks; other mutations also require the CSRF header. Expired, revoked or disabled-account sessions are rejected. Password changes rotate the current session and revoke all others. Account/role changes, disables and resets revoke every account session.

| Role             | Granted permission groups                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `operator`       | Assigned-batch create/read/update/resume/pause/complete/delete; scanner read/scan/configure; assigned OCR read/manage        |
| `qc_officer`     | QC read/review/submit/return + scanner capabilities for the future phase; no current batch-capture ownership bypass          |
| `approver_l1`    | L1 review/approve/reject, future only                                                                                        |
| `approver_l2`    | L2 review/approve/reject, future only                                                                                        |
| `archive_viewer` | Archive read/search, future only                                                                                             |
| `system_admin`   | Users, roles, batch read-all/reassign, audit, system info and explicit OCR read/manage-all; **no scanner/QC/approval grant** |

Role assignment prevents combining L1/L2, or either approval role with Operator/QC. Administrator and explicit operational roles may coexist. Formal per-document approval/creator separation must be added with the actual future workflows; no approval/QC bypass exists now because those APIs do not exist.

`pnpm admin:bootstrap` refuses if any administrator role assignment exists, even if disabled. Preserve existing installation accounts; never reset them as part of setup. A fresh installation has no built-in default login and must bootstrap interactively. Rotate demonstration credentials before deployment.

## Transaction and recovery boundaries

Batch creation plus placeholder document, user-role changes, state changes and session allocation are atomic. Batch mutations lock the row and compare its required version. Sessions have a partial unique index for `status='running'`. Global provider locking additionally prevents feeding the physical scanner twice across different batches.

One Node runtime holds a PostgreSQL advisory lock. A second runtime stays API-blocked and cannot start recovery/capture. Development uses an ephemeral private backend and the same origin-preserving proxy at localhost:3000.

Frontend history URLs reload the HTML shell, then authenticate and reload the batch by UUID. A running batch is read without creating a new session or pausing the current one; provider jobs and reconciliation run independently of browser connections. Browser Back/Forward cannot navigate away during a busy scanner operation. A browser refresh is safe, but stopping/restarting the backend remains an interrupted-capture recovery event.

New capture:

1. Validate permissions, assignment, batch status/version and scanner options.
2. Lock the batch, allocate session number/UUID, snapshot settings/device/profile, commit the session and audit before feeding.
3. Existing provider publishes unique complete PNGs into its trusted spool. Incomplete outputs are ignored.
4. Node fully decodes each nonempty PNG (max 200MB/100 million pixels), fingerprints it, exclusively finalizes a managed original and syncs file contents. Source remains in the recovery spool.
5. Transactionally register each successful page with original session/feeder position; update count/status/audit. Preview assets are separate and disposable.

The 500ms background reconciliation loop catches completed pages while scanning. Scanner errors yield partial/failed sessions accurately. A failed database transaction does not delete generated/finalized files. Outstanding running sessions retry when the database is available. After restart, sessions without live in-memory jobs become interrupted; completed PNGs are registered idempotently. A reconnect within the same live process preserves genuinely running sessions rather than prematurely unlocking them.

Stop the backend before `pnpm db:reconcile`. The command enforces the same runtime lock, retries persisted partial/failed/interrupted groups only, and never reopens a completed batch. It cannot guess an original relationship if the session row is lost, overwrite conflicting originals, prove mechanical feeder readiness or restore deleted files. Restore PostgreSQL and assets together from backup. `.partial` files and unregistered originals are never treated as valid pages or automatically deleted.

## Environment variables

Node loads `.env` with its built-in loader; explicitly supplied process variables take precedence. Secrets are backend-only, never Vite-prefixed.

| Variable                     | Purpose / default                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `PGVECTOR_IMAGE`             | Exact existing local Compose image, currently `pgvector/pgvector:pg16-bookworm`                  |
| `POSTGRES_DB`                | Database name, `digitalarch`                                                                     |
| `POSTGRES_USER`              | Database owner/app login, `digitalarch`                                                          |
| `POSTGRES_PASSWORD`          | Required strong local secret; no documented real credential                                      |
| `POSTGRES_HOST_PORT`         | Loopback host port, `5432`                                                                       |
| `PGHOST`                     | Node database host, `127.0.0.1`                                                                  |
| `SESSION_HOURS`              | Fixed session lifetime, default 12; greater than zero, max 168                                   |
| `COOKIE_SECURE`              | `false` for local HTTP; `true` only with actual HTTPS                                            |
| `DIGITALARCH_DATA_DIR`       | Trusted local app root, `.local`                                                                 |
| `DIGITALARCH_STORAGE_ROOT`   | Managed-original/cache root, `<data root>/managed`                                               |
| `DIGITALARCH_FIXTURES`       | Optional trusted flat PNG simulator source directory                                             |
| `DIGITALARCH_NAPS2_PROFILES` | Optional Windows path to native NAPS2 XML                                                        |
| `CHROMIUM_EXECUTABLE`        | Existing browser executable for browser tests                                                    |
| `PLAYWRIGHT_BROWSERS_PATH`   | Existing browser cache location for browser tests                                                |
| `OCR_WORKER_CONCURRENCY`     | Fixed at 1 in this accuracy phase; one page at a time                                            |
| `OCR_LANGUAGE`               | `ind+eng`; accepts `ind`, `eng`, `ind+eng`, `eng+ind`, without fallback                          |
| `OCR_PRIORITY`               | `low` only; Windows BelowNormal through verified NAPS2/process APIs                              |
| `OCR_TIMEOUT_SECONDS`        | 120 by default, 1–600 per page; Windows wrapper also bounds/kills the process tree               |
| `OCR_MAX_ATTEMPTS`           | 3 by default, 1–5; explicit retry resets only failed page budgets                                |
| `OCR_TESSERACT_PATH`         | Trusted Windows executable path; defaults to installed NAPS2 `lib\_win64\tesseract.exe`          |
| `OCR_TESSDATA_PATH`          | Trusted parent containing `best/` and `fast/`; defaults to NAPS2 roaming `components\tesseract4` |
| `OCR_PROFILE`                | `standard` default; also `enhanced`, `high-accuracy`                                             |
| `OCR_ENGINE`                 | `tesseract` default; explicit `paddleocr` alternative for future capture jobs                    |
| `OCR_PADDLE_PYTHON`          | Trusted Linux/WSL CPU Python executable; default `.local/paddleocr/venv/bin/python`              |
| `OCR_PADDLE_MODELS`          | Trusted local Small model directory; default `.local/paddleocr/models`                           |
| `OCR_PSM`                    | 3 default; accepts only 3, 4, 6                                                                  |

Compose sets PostgreSQL TZ/PGTZ to UTC. Database tests create random isolated `test_<UUID>` schemas in this database, migrate them, and drop **only their own schemas** afterward. Tests never clear the application schema or private images. Run database tests against a dedicated local database, not a production service.

## Current deployment limits

Local HTTP only, one application process/scanner; no remote deployment claim. The Docker-created local database login owns the schema/extensions. A production deployment should separate migration ownership from a least-privilege runtime login, add HTTPS, backup/restore drills, bounded retention and monitoring. Session/login/audit retention and spool/preview cleanup are not automated. Do not publish ports, remove originals to save space, or expose the maintenance CLIs to untrusted users.
