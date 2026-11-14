# DigitalArch — engineering report

## Current handoff addendum — shared worklists, URLs and documentation (2026-11-14)

- Repository handoff: the user explicitly authorized committing/pushing the current source and documentation to the existing public `ravhirizaldi/digitalarch` repository. Earlier statements about uncommitted local work describe their historical checkpoints. Private `.env`, `.local` scans/models/backups and generated local evidence remain excluded. README is now a short overview; detailed installation and the full documentation index live in [SETUP.md](SETUP.md).
- QC now has Shared/Claimed tabs, combined search/metadata/OCR filters, allowlisted server sorting, queue-wide counts, filtered totals and compact batch info/copy controls. `src/WorklistTable.jsx` shares the bounded table, icon headings, totals and right-aligned pagination with operator Capture Workspace/My Batches and administrator batch assignments. Batch sorting now also applies server-side across the full filtered result.
- `src/useUrlState.js` and the existing route guard preserve QC/operator list state and document inspector/page/session/revision/preview/disclosure choices. Returning from a document restores a supported originating list. Draft/private document text is not serialized; queue search terms remain visible in URL history. Other OCR/admin/scanner controls are not all URL-backed.
- **Verification boundary:** the later queue/shared-component/URL changes were not test-, browser-, build- or OCR-verified at the user's request. Targeted ESLint, source formatting and `git diff --check` passed; the static UI detector reported no findings. New/extended regression cases were written but not executed. The 80/80 result below belongs to the earlier approved checkpoint, not these later changes.
- Added [DND.md](DND.md), [ERD.md](ERD.md), [DFD.md](DFD.md) and the proposed [APPROVAL.md](APPROVAL.md) handoff; linked the documentation from README and updated source/schema/verification boundaries. Mermaid diagrams describe the implemented schema/flows or are explicitly labelled proposals. Documentation work did not change runtime behavior, apply migrations or authorize new verification.
- The documentation pass used static source/migration inspection, formatting and relative-file-link checks. No Mermaid rendering, runtime tests, browser checks, OCR inference, scanning or live-schema queries were performed during this pass.
- Remaining requested workflow is Approval Level 1 → Approval Level 2 → a basic authenticated read-only viewer. Seeded roles/permissions and the locked QC snapshot are reusable foundations, not working approval/archive features. Rejection routing, historical actor separation, snapshot-bound reads and extending current L1-only locks are the principal remaining correctness work. No new scanner/OCR pipeline is proposed.

## Phase 4 — document metadata, QC and operator rework (2026-11-14)

This section records the earlier Phase 4 delivery/approved verification checkpoint. Later refinements and their unverified scope are listed above.

### A. Outcome and scope

Implemented the PostgreSQL-backed QC queue, shared document workstation, persistent exclusive claims, document metadata verification, non-destructive corrections and same-batch return/resubmission. QC Pass stops at **Awaiting Approval Level 1** and locks the reviewed revision. No approval, publication, search, PDF, AI classifier, new recognition engine or queue service was added. Changes remain local and uncommitted; no push/publication was performed.

### B. Audit and reused architecture

Inspected capture/session reconciliation, original/derivative storage, authentication/RBAC, existing migrations, PostgreSQL OCR queue/leases/cache, metadata extraction, browser routes and the compact Ant Design workstation. The earlier global JSON QC implementation had already been removed; no competing registry was extended or restored. Reused `documents`, `pages`, `page_revisions`, `archive_batches`, the scanner provider and existing metadata/parser/viewer components. The new modules are `server/workflow.mjs`, `server/qc-metadata.mjs`, `server/qc.mjs` and `src/QcWorkspace.jsx`.

### C. Database and upgrade

- Migration 009 stores the earlier per-run metadata snapshots.
- Migration 010 adds document workflow/version/revision, QC cycles/claims, findings/page reviews, append-only metadata/text correction history, insertion/replacement provenance, reserved display positions and passed-page protection. It was applied locally after diagnosing the user's generic database error: PostgreSQL was healthy, but the running backend expected the missing `workflow_status` column. The batch-list and QC-queue queries succeeded after migration. Applied migration 010 is not rewritten.
- Migration 011 adopts the latest saved per-run metadata while preserving newer manual document edits and the original run rows; empty legacy snapshots are covered. Initial document metadata status becomes `not_extracted`. It is applied locally, with a private pre-migration metadata snapshot saved under ignored `.local/backups` (not a full database/files backup). Batch-list and QC-queue queries succeed against the application schema. New test schemas are created from all migrations in isolation.
- No database reset, original deletion, new service, Redis, Docker image or dependency was required. Apply migrations before loading updated backend code. See [DATABASE.md](DATABASE.md).

### D. Lifecycle and review history

One batch is one logical document across all feeder sessions. Capture status remains separate from `documents.workflow_status`: `capturing → preparing → qc_waiting → qc_in_review → awaiting_approval_l1`, or `qc_in_review → rework → preparing` on return/resubmission. Completion and OCR enqueue retain their transaction boundary. Terminal OCR enables rule extraction and queue eligibility; failed pages remain explicit review work. Returning pauses the same assigned batch. Resubmission creates another review cycle and preserves previous decisions, findings, metadata/image revisions and machine results. Decision snapshots record ordered pages, metadata, findings, page-review statuses and effective OCR/correction identities.

### E. Metadata ownership, continuity and validation

Current fields live on `documents.metadata_json`, not sessions or OCR jobs. Operators can save before OCR and while preparing/waiting, with independent metadata version checks. A live QC claim exclusively controls verification during review. Rules add candidates and source links without replacing human values. Original suggestions, available bounds, editor/verifier names and times, stale-source flags and candidate provenance remain visible. No invented confidence or source regions are shown. Dates and explicitly NIK-/NPWP-labelled identifiers are validated. Administrators configure required field types per document before review; metadata is not mandatory to start capture. Historical OCR-run endpoints remain readable but reject mutations with a document-workspace link/message.

### F. Claims, permissions and concurrent edits

Claims are persisted, exclusive and renewed for 30 minutes on successful edits or an active visible workstation heartbeat. Expired claims can be reclaimed; administrators can release a claim with a reason. Batch → document → review locks, optimistic versions, live claim ownership and CSRF checks protect mutations and decisions. The batch creator, assigned operator and every session creator are denied self-QC, including combined Administrator/Operator/QC roles. Administrator-only accounts have oversight/configuration/release, not QC decisions. Lost ownership or stale versions fail instead of silently overwriting another tab.

### G. Pages, findings and safe rework

QC supports rotation/reset, reorder, exclude/restore, per-page/bulk review, categorized/severity findings, resolution/waiver justification and separate human OCR text correction. Operators insert before/after a selected logical page or capture replacement candidates in the same batch. Replacement requires explicit selection/preview/confirmation; cancellation leaves the active image untouched. Unselected successful candidates and all originals remain retained. Original checksum/session/capture order are immutable; active references and recorded page revisions identify replacements. History image endpoints verify authorization and hashes. Capture/reconciliation/pending replacement blocks decisions.

### H. OCR integration and pass invariants

The existing PostgreSQL queue, UUID leases/fencing, retries, per-page commits and exact-success cache remain authoritative, with page concurrency **1**. Changed images/rotation invalidate old results; completed QC edits use the existing enqueue/invalidation path, and operator rework queues on resubmission. Metadata/order-only edits do not launch inference. Exact unchanged results are reused. Same-page/image/config reuse retains that page's human text correction, never another page's correction. Machine text is unchanged.

Pass validates the current independent claim/version, saved ordering/completeness/metadata checklists, included pages, required/verified metadata, critical findings, needs-correction flags and original/active file integrity. Outstanding queued/running/paused OCR blocks pass even with an exception; terminal failed/missing OCR needs an explicit saved exception. The reviewed snapshot is locked against ordinary page, metadata and OCR mutations afterward. There is no administrative self-QC or approval/unlock bypass.

### I. Workstation and performance scope

Reused compact Ant Design and PageViewer rather than introducing a new design system. QC Queue has pagination/search/status filters. The document workstation has a 40-thumbnail window, central preview and internally scrolling Metadata/OCR Text/Page Properties/Issues/History inspector. Source links use current logical page numbers; preview supports fit-width/fit-page, zoom and fullscreen. Dirty drafts warn before navigation. Rapid page requests are fenced so an old response cannot replace another page's OCR inspector.

Browser checks exposed and fixed a null source-highlight crash, inaccessible icon-inflated action names, asynchronous capture-completion races in verification, hidden inspector panes remaining visible and fixture cleanup racing preview generation. A reconciliation regression was fixed by reserving display positions independently from capture order. The 500-page check confirms bounded image rendering/navigation, not measured feeder or installed-OCR throughput.

### J. Verification evidence

Verification was explicitly limited to generated Simulator pages, isolated PostgreSQL schemas, mock OCR and cached Chromium. The final full suite passed **80/80**, with no failures (104.15 seconds). Additional guards cover outstanding-OCR pass protection, same-page correction reuse, combined-role self-QC and empty legacy-metadata adoption. `pnpm lint`, `pnpm format:check`, `pnpm build` and `git diff --check` passed. The mechanical UI detector returned an empty findings list. Vite retains its upstream Ant Design directive/chunk-size warnings, not build errors.

Browser scenarios completed:

| Scenario | Executed evidence                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| A        | Normal ten-page capture, document navigation, claim, verification and pass                                         |
| B        | Two 100-page feeder sessions remain one document; switching/reload preserves identity/order                        |
| C        | Return findings, target-page navigation, previewed/confirmed replacement, insertion and second-cycle pass          |
| D        | Human metadata entered before OCR remains after extraction; document verification and saved reload                 |
| E        | Two browser sessions conflict on claim, release/reclaim works, backend stale/ownership checks remain authoritative |

Additional checks cover a five-session/500-page document, tab visibility, historical metadata versus current editing, administration, password changes, capture isolation/recovery, viewport containment at **1920×1080, 1366×768 and 1280×720**, and browser/CSP errors. Synthetic screenshots and test logs live under `/tmp/opencode`, outside the repository. `pnpm test` bounds test-file concurrency at two to avoid PostgreSQL pool exhaustion. Exact commands and approval boundaries are in [QC.md](QC.md).

At that approved checkpoint, final executions of `node test/qc-browser.check.mjs` and `node test/browser.mjs` passed after the checkpoint's fixes. `node test/metadata-browser.check.mjs` also passed against the document-owned metadata UI. The rendered 1280/1366/1920 QC layouts and 500-page screenshot were inspected; browser document scrolling and hidden-tab leakage were absent in the exercised layouts. These results do not verify subsequent UI/URL/shared-worklist changes.

### K. Documentation, limitations and handoff

Updated README, PRODUCT, DESIGN and DATABASE; added [QC.md](QC.md). Preserved WIA, Simulator, NAPS2 SDK 1.6.0, 300 DPI, scanner profiles, both OCR engines and historical results. No manual restart of the user's development app, physical scan, installed-engine inference or benchmark resume was performed during Phase 4 verification. No new OCR accuracy/thread-speed claim is made.

This remains a single-runtime local workstation, not an internet-hardened/distributed deployment. Metadata extraction is rule-based and bounded to 200 current fields; removing a field is not a permanent suppression rule for future extraction. Completeness is an explicit officer checklist, not a forced click on every page. Physical feeder/jam/duplex behavior, production backup/restore drills, accessibility beyond the exercised keyboard/semantic controls, full mobile operation and real 500-page OCR throughput remain unverified. Apply migrations before backend updates and back up database plus managed files together. Approval/publish/search/PDF and multi-document splitting remain intentionally unimplemented.

---

## Historical foundation report

**Delivered locally on 2026-11-13.** Authentication, administration and persistent batch capture replace the former global capture/JSON-QC workflow. The user-authorized physical test succeeded. The statements below describe that earlier delivery; the current workspace is a Git repository, and Phase 4 has not been committed or pushed.

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
- At foundation delivery, table sorting was on the loaded server-paginated page; later QC/operator batch lists now use server sorting. No global sorted export, backup automation, account recovery email or multi-factor authentication was added by the foundation.
- At initial foundation delivery, QC, approval, publication, OCR, embeddings and archive search were absent. Later Phase 3A added OCR and Phase 4 added metadata/QC/rework; the current status is at the top of this report. Approval, publication, embeddings and a final archive-viewer/search workflow remain unimplemented.

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

Open **http://localhost:3000**. `pnpm start` requires the completed build; `pnpm dev` is the alternative, not a second simultaneous backend. Full operating instructions: [SETUP.md](SETUP.md). Database/security/recovery details: [DATABASE.md](DATABASE.md).
