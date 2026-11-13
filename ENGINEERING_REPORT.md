# DigitalArch Enterprise Foundation — engineering report

**Delivered locally on 2026-11-13.** Authentication, administration and persistent batch capture replace the former global capture/JSON-QC workflow. The user-authorized physical test succeeded. No commits, pushes or publication were performed; this workspace is not a Git repository.

The foundation sections below retain their historical test/feature scope. **Phase 3A and its accuracy update are documented in [OCR.md](OCR.md)**; no physical scans or browser tests were run for those updates.

## Phase 3A addendum — OCR and accuracy

- Kept PostgreSQL/Node queue ownership, short row-lock claims, UUID lease fencing, per-page commits, retries and recovery. Automatic enqueue is atomic with capture completion; old completed captures have explicit backfill. Concurrency is fixed at **1** for the accuracy phase.
- Inspected and exercised **NAPS2.Sdk 1.6.0** (assembly 8.6.0.0) against installed **Tesseract 5.5.1** and the existing **Best Indonesian/English data**. `OcrParams` has no PSM setting: a minimal .NET adapter forwards supported CLI arguments through `TesseractOcrEngine.Custom`, while NAPS2 continues processing/parsing OCR. No scanner/WIA behavior or resolution was changed.
- Added `standard`, `enhanced`, `high-accuracy`; configurable grayscale/contrast/±3° deskew/light denoise/optional adaptive thresholding run only on disposable derived PNGs at 300 DPI. Persisted configuration includes resources/binaries, PSM, preprocessing/version and transforms. There is no invented confidence metric.
- Applied new migrations `004`, `005`, `006` without altering already-applied migrations. Reprocess snapshots profile/PSM settings, preserves old jobs/text, and reuses exact successes rather than duplicating extracted content. Authentication, ownership, CSRF, managed paths and source-checksum validation remain enforced.
- Added sequential benchmark CLI and profile/PSM reprocessing controls. OCR detail now places the original source beside text, with a narrow page rail and compact/collapsed metadata; unrelated UI and QC were not changed by the accuracy work.
- Actual benchmark: nine combinations × three real retained pages completed. Seven reviewed page-1 excerpts (205 characters) had **9 Fast-baseline errors**, **7 Best/standard/PSM-3 errors**, and **5 Best/high-accuracy/PSM-6 errors**. Enhanced preprocessing worsened these excerpts. This does not establish whole-page or corpus-wide accuracy. Timing/memory numbers, private local evidence locations and limitations are in [OCR.md](OCR.md).

Main OCR files: `server/ocr.mjs`, `server/ocr-provider.mjs`, `server/ocr-profiles.mjs`, `server/ocr-preprocess.mjs`, `server/ocr-pixels.mjs`, `DigitalArch.Service/Ocr.cs`, `DigitalArch.Ocr/`, `scripts/ocr-benchmark.mjs`, `migrations/004_ocr_processing.sql` through `006_ocr_profiles.sql`, `src/OcrWorkspace.jsx`, and OCR test/runtime sample files. Integration extends existing `bridge.mjs`, `server/windows-helper.ps1`, `server/batches.mjs`, `server/enterprise.mjs`, `server.mjs`, capture storage/routes and documentation. Exact API contracts, sample outputs and verification limits are centralized in [OCR.md](OCR.md).

The subsequent layout experiment adds `server/ocr-layout.mjs`, geometry-based region recognition with conservative full-page fallbacks, experimental opt-in line cleanup and global full-page scoring. It uses no hardcoded document wording/field values/crop coordinates. On the newly supplied sample, 1,064 manually transcribed page-1 characters had **84 errors before** and **39 errors with adaptive regions**; exact numeric-token matches rose from 3/6 to 4/6. Line removal performed worse than uncleaned regions and remains off. Other document types are covered only by synthetic layout/fallback tests, not a real-document accuracy corpus. No scanner, resolution, database architecture, QC or unrelated UI change was made for this experiment; whole-page defaults remain unchanged. See [OCR.md](OCR.md) for all variants, scope and remaining risks.

The alternative-engine integration adds `server/ocr-engines.mjs`, `server/ocr-paddle.mjs`, the explicit isolated CPU setup/one-page runner in `scripts/paddle/`, insert-only engine labels/configuration validation in migration 007, engine/model controls in the existing OCR view, and engine comparison mode in the existing benchmark CLI. Official Small model names, Indonesian/English support, Python-3.12 CPU wheels, archive sizes and published Apache-2.0 licenses were verified before installation. The same PostgreSQL queue, leases, per-page commits and retained originals/history are used; scanner/WIA/NAPS2 and Tesseract remain intact and Tesseract remains default. No new service or Docker image was introduced. On three saved pages (2,655 normalized reference characters), Enhanced Small achieved 2.90% CER and exact matches for 2/2 document numbers and 3/3 dates, at approximately 952 MiB native peak RAM. This is one document family, not a default-migration decision. Detailed CER/WER, timing/memory methodology, installation size, compatibility workaround and remaining limitations are in [OCR.md](OCR.md).

## A. Architecture

- Preserved React, Ant Design, pnpm, Node ES modules and the existing Windows bridge → .NET 8 console helper → NAPS2 SDK → WIA scanner path. No new backend framework or microservice.
- `server/db.mjs`: node-postgres pool, transactions and checksummed migrations. `server/auth.mjs`: authentication, RBAC and administration. `server/batches.mjs`: workflow/ownership/concurrency/reconciliation. `server/capture-storage.mjs`: validated immutable PNG finalization and disposable derivatives. `server/enterprise.mjs`: protected routes and runtime recovery.
- PostgreSQL owns all new metadata. Filesystem owns originals. A committed scan session precedes physical feeding; provider output survives finalization or database failures. No JSON fallback.
- One application runtime per database/schema, enforced with a PostgreSQL advisory lock; one active scanner job globally. This is a local workstation deployment, not a distributed scanner service.

## B. Docker and database

Completed Docker version/context/image/container/volume/port inspection before provisioning. Reused the existing **`pgvector/pgvector:pg16-bookworm`**, image **`sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a`**. Runtime versions verified from WSL Node: **PostgreSQL 16.15 / pgvector 0.8.7**.

Container **`digitalarch-postgres`**, loopback binding **127.0.0.1:5432**, persistent named volume **`digitalarch_pgdata`**. Compose explicitly refuses pulls; no image was built or downloaded. No unrelated container, volume or image was changed or removed. Database credentials were generated into an exclusively created, ignored mode-0600 `.env`; example configuration contains no real secret.

`db:up`, `db:down`, `db:status`, `db:migrate` and `db:reconcile` are documented in [DATABASE.md](DATABASE.md). Down preserves the volume. No destructive reset command was added.

## C. Schema

Applied `001_foundation.sql` and `002_capture_order.sql`; migrations are checksummed, serialized and idempotent. Tables:

- Security: `users`, `roles`, `permissions`, `user_roles`, `role_permissions`, `auth_sessions`, `auth_login_attempts`.
- Workflow: `archive_batches`, `documents`, `scan_sessions`, `pages`, `page_revisions`.
- Governance: `audit_logs`, `schema_migrations`.

UUIDs identify entities. Batch codes are generated from Jakarta time plus random suffix, not user metadata. Optional location is nonunique. Composite foreign keys prevent cross-batch document/session/page references. Batch versions, row locks, unique sequential session numbers and a partial one-running-session index prevent conflicting captures.

Original storage key, checksum, byte count, source and capture order cannot be changed through ordinary page updates/deletes; audit records reject updates/deletes. Original files are exclusively finalized, read-only to ordinary application writes and never overwritten by reconciliation. This protects application operations, not against a privileged filesystem/database administrator. Display order/active assets are independent future-QC concepts.

pgvector is enabled **without embedding columns or arbitrary dimensions**. A batch initially contains one placeholder document; the model permits future multiple logical documents and page revisions without implementing those workflows now.

## D. Authentication and RBAC

Implemented Argon2id passwords, random temporary credentials shown once, forced password changes, sign-in throttling, opaque hashed server sessions, expiry/revocation, HttpOnly/SameSite=Strict cookies, same-origin checks and CSRF validation. No authentication tokens in localStorage. Protected routes fail closed when persistence is unavailable.

All six roles are seeded: Operator, QC Officer, Approver Level 1, Approver Level 2, Archive Viewer and System Administrator. Permissions are checked in the backend. Administrator has **no inherited scanner/QC/approval authority**. Explicit Administrator + Operator is supported; capture/QC cannot combine with approval, and L1 cannot combine with L2.

User administration supports creation/search/editing, role assignment, disable/enable and temporary-password reset. Account/role edits revoke sessions; self-administrative access and the last active administrator are protected. Audit/system views expose no password, cookie, database secret or absolute storage path. Batch reassignment requires an active operator and mutable batch.

Fresh installations have no default accounts and require administrator bootstrap. Existing installations must preserve their accounts and rotate any demonstration credentials before deployment. Automated regression accounts remain confined to isolated test schemas.

## E. Capture workflow and recovery

Scan New Batch creates the batch and first logical document transactionally with no required title, type, archive number or location. Each feeder operation adds a sequential session to the active batch. Registered pages become visible progressively and retain checksum, dimensions/DPI, source, device/profile/session context and feeder order.

Save & Exit pauses and clears context. My Batches reconstructs paused work from PostgreSQL. Switching batches never merges pages. Complete Capture requires valid originals and no running/reconciling session, explicitly acknowledges partial/interrupted sessions, then locks ordinary capture. It is **not** QC approval. Empty batches can be soft-cancelled; captured batches/pages cannot be deleted through the application.

On driver or feeder failure, valid pages survive and session status is partial/failed, not a false success. Database failures retain source/managed PNGs. Startup reconciliation registers complete orphaned outputs using persisted job/session relationships and marks missing live jobs interrupted. Reconnect within a live process preserves genuinely running jobs. Offline reconciliation retries interrupted/partial/failed groups idempotently and does not reopen completed batches. Reserved feeder positions preserve ordering when a damaged earlier file is repaired after another session.

Managed originals: `.local/managed/batches/<batch UUID>/sessions/<session UUID>/page-0001.png`. Simulator spool: `.local/capture-spool`; real spool: existing Windows DigitalArch scan directory. Derivatives are separate/regenerable. Source spools are deliberately retained, not garbage-collected.

## F. UI

Delivered sign-in/forced-password-change screens, permission-derived navigation, Operator Capture Workspace/My Batches, active batch context, optional Batch Info/location, session filtering, session outcome/retry controls, Save & Exit, completion confirmation and completed read-only detail. An inactive scanner shows **No active batch**, without stale pages.

Preserved simulator/real selection, device/profile controls, capability evidence, scanner settings, resizable page rail and PageViewer fit/zoom/pan/fullscreen/original download. Added authenticated thumbnail/preview URLs rather than public scan directories. Future-only roles receive an informational empty workspace, not fake QC/approval/search features.

Administration includes Users, Batch assignments, Audit Logs and sanitized System information. Compact navy/white workstation styling remains. Browser checks and inspected screenshots cover 1920×1080, 1366×768 and 1280×720 without document-level scrolling. Production CSP retains nonce-based Ant Design styles; no unsafe-inline relaxation. Fresh sign-in no longer falsely reports an expired session.

## G. Changed and deleted files

Major additions:

- `compose.yaml`, `.env.example`, `migrations/001_foundation.sql`, `migrations/002_capture_order.sql`.
- `server/db.mjs`, `server/auth.mjs`, `server/batches.mjs`, `server/capture-storage.mjs`, `server/enterprise.mjs`.
- `src/api.js`, `src/AuthScreen.jsx`, `src/Administration.jsx`, `src/BatchList.jsx`.
- `scripts/db.mjs`, `scripts/bootstrap.mjs`, `scripts/reconcile.mjs`, `scripts/verify-hardware.mjs`, `test/support.mjs`.
- `DATABASE.md`, `ENGINEERING_REPORT.md`; private ignored `.env` and generated local storage/database volume.

Updated integration/configuration: `server.mjs`, `server/http.mjs`, `server/errors.mjs`, `server/storage.mjs`, scanner service integration, `src/main.jsx`, `src/ScannerWorkspace.jsx`, `src/PageViewer.jsx`, `src/ui.jsx`, `src/style.css`, `scripts/dev.mjs`, fixture generation, `package.json`, `pnpm-lock.yaml`, `.gitignore`, API/dev/scanner/browser tests and `README.md`/`PRODUCT.md`/`DESIGN.md`. Generated synthetic visual evidence is in `.impeccable/review`.

Removed at the user's subsequent **remove all legacy** instruction: `src/Documents.jsx`, `src/QcWorkspace.jsx`, `src/CaptureDialog.jsx`, all four modules under `server/qc/`, `test/qc.test.mjs`, unauthenticated/global capture-history APIs, legacy static scan paths/dev proxies, JSON workflow persistence and obsolete QC styles/classes. No compatibility/import route was retained.

The user also authorized removal of historical stored data, but the inspected scan/QC locations were empty: **no historical PNG or QC manifest was found or deleted**. `.local/storage.json` remains trusted scanner-directory configuration, not legacy workflow metadata. The subsequently captured real documents were expressly retained and are not legacy data.

## H. Verification

| Check                                | Result                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                          | **28 passed**, no skips: database/migrations, auth, six roles, admin safeguards, ownership, lifecycle, concurrent session/version conflicts, simulator failures, API/file security, database-unavailable behavior, restart recovery, integrity and reserved feeder order |
| `pnpm lint`                          | Passed                                                                                                                                                                                                                                                                   |
| `pnpm format:check`                  | Passed after final formatting                                                                                                                                                                                                                                            |
| `pnpm build`                         | Passed; Ant Design use-client notices and bundle-size warning remain                                                                                                                                                                                                     |
| `pnpm test:browser`                  | Passed real PostgreSQL + cached Chromium + simulator: onboarding/admin, switching/multiple sessions, partial acknowledgement, completion lock, empty scanner, failure feedback, desktop containment, no browser exceptions/CSP violations                                |
| `pnpm test:profiles`                 | **26 assertions passed**, no hardware                                                                                                                                                                                                                                    |
| `.NET Release build`                 | Passed, **0 warnings / 0 errors**                                                                                                                                                                                                                                        |
| `pnpm db:status` / Compose status    | Node connectivity verified; PostgreSQL 16.15/vector 0.8.7; dedicated container healthy                                                                                                                                                                                   |
| User-authorized physical feeder test | **Passed**, details below                                                                                                                                                                                                                                                |

Physical verification used the unchanged Windows bridge/.NET/NAPS2/WIA path and **Brother ADS-2400N (Default)**: feeder, Letter, color, 300 dpi, right alignment. Exactly **one feeder attempt**, no automatic retry or simulator fallback, produced **3 pages**, each **2550×3300**. Every managed PNG decoded and passed SHA-256 validation; session status **completed**, no error.

Retained batch: **`B-20261113-115334-FB68BC7B`**, UUID **`c95dc4c9-89a9-4a28-8d78-75b91ccd6012`**, status **paused**. Session UUID **`f732a250-482a-4524-8105-69e5ae6139b9`**. Originals and recovery spool remain. Verification operator is disabled; bootstrap an administrator, create an operator and reassign the batch to inspect/resume it. Real document contents were not added to fixtures/screenshots.

Database/browser tests create and remove only their own random schemas/temp directories. No browser/Docker image download, paper consumption by automated tests, or application-schema wipe. A deliberate container restart/power-loss/backup-restore exercise was **not** performed; restart reconciliation was tested using separate application instances and isolated schemas.

## I. Compatibility

Existing .NET helper/profile/capability logic and Windows bridge were retained and the real physical path was exercised. Simulator remains the safe startup default and cannot prepare or invoke Windows hardware. Native profile XML remains read-only; unsupported processing settings are not silently applied. .NET and profile checks still pass.

The prior global history/JSON QC behavior is intentionally **not backward compatible**, following the user's revised instruction. Old routes are denied, not aliased. There was no historical content to migrate. Trusted Windows scanner-output configuration is retained so existing hardware setup continues to work.

## J. Limitations and operational risks

- Local workstation, loopback HTTP/database only. Before remote deployment: HTTPS, deployment review, separate migration/runtime database privileges, backup/restore drills, monitoring and retention policies.
- Originals are immutable through application behavior, checksums, exclusive writes and database triggers—not WORM media. Privileged administrators can still tamper with storage/database. Back up metadata, managed assets and source spools consistently.
- No automatic spool/preview/session/audit cleanup; monitor disk space. Missing/corrupt originals require restoration, not silent replacement. Process interruption does not establish mechanical feeder readiness.
- Physically tested default simplex capture only. Duplex, physical jam/disconnect, repeated long batches, Windows process termination and scanner sharing across different database installations remain unverified.
- Desktop acceptance target only; no full mobile or high-load benchmark claim. Large-page image work is serialized and thumbnail generation coalesced to reduce memory pressure, but production-scale capacity is unmeasured.
- Table sorting is on the loaded server-paginated page. No global sorted export, backup automation, account recovery email or multi-factor authentication.
- At initial foundation delivery, QC, approval, publication, OCR, embeddings and archive search were absent. Phase 3A adds OCR only; see [OCR.md](OCR.md). QC, approval, publication, embeddings and archive search remain absent.

## K. Next-phase readiness and handoff

Batch/document/session/page identity, immutable source provenance, revision schema, role/permission scaffolding and append-only auditing are ready for a separately scoped metadata/QC/approval phase. pgvector is available, but embedding schema/dimensions should follow the actual model/search design. The current completion transition is capture-only; future approval gates must not be inferred from it.

To use the delivered app:

```sh
pnpm db:status
pnpm admin:bootstrap
# Sign in with the one-time temporary password; change it.
# Create an Operator; optionally reassign the retained physical batch.
pnpm start
```

Open **http://localhost:3000**. `pnpm start` requires the completed build; `pnpm dev` is the alternative, not a second simultaneous backend. Full operating instructions: [README.md](README.md). Database/security/recovery details: [DATABASE.md](DATABASE.md).
