# Document metadata, QC and rework

Current source behavior is diagrammed in [DND.md](DND.md) and [DFD.md](DFD.md), with database relationships in [ERD.md](ERD.md). QC stops at locked **Awaiting Approval Level 1**. [APPROVAL.md](APPROVAL.md) describes the proposed next steps; it does not add an approval or unlock operation. Later UI/queue/URL changes remain runtime-unverified; earlier verification results are checkpointed in [ENGINEERING_REPORT.md](ENGINEERING_REPORT.md).

## Operator workflow

1. Start or resume a batch. It is **one logical document**, not one document per feeder session.
2. Open **Document / Metadata / QC** at any time to add optional document fields. No OCR or metadata is required to start capture. Save before navigating away.
3. Capture additional sessions into that same batch; Save & Exit pauses it. Logical order is separate from immutable feeder/capture order.
4. **Complete Capture** verifies originals, acknowledges partial sessions and atomically queues the existing OCR worker. The document enters `preparing`. Terminal OCR triggers rule-based candidate extraction and `qc_waiting`, including documents with failed pages that need review.
5. If QC returns the document, resume the same paused batch. Inspect the return reason and findings in the document workstation, correct metadata/pages, then **Resubmit to QC**. A new review cycle retains prior decisions, findings, images and OCR history.

## QC workflow

- Open **QC Queue → Shared QC queue** and filter waiting, in-review, returned, passed/history or OCR-incomplete documents. **Claimed documents** lists your own claims and saved QC drafts; open one to continue. Saving a draft does not release the claim, so it no longer appears in Waiting for QC. Both tables support combined metadata/OCR filters and search by batch, title, type, number, location or operator. Sortable headings include creation/activity dates, page/session counts and statuses; sorting applies to the full server-side result, not just the visible page.
- Hover over a row's **(i)** to read its batch ID; click to copy. The footer keeps filtered document/page/session totals on the left and pagination/page size on the right. Queue status counts summarize the whole queue, independent of the active search/filters.
- QC queue tabs, search, filters, sort and pagination are encoded in the URL. Document inspector tabs, page/session/window selection, excluded/original/revision views, zoom/fit/fullscreen and expanded processing/source details are also restored on reload. Back/Forward restores navigation state, and returning from a document retains the originating queue view. URLs contain navigation IDs/options and the requested queue search, never OCR text, metadata values, review notes or unsaved form edits. Search terms remain in browser history: do not share a URL containing a sensitive search.
- **Claim** before editing. Claims persist for 30 minutes and renew on successful edits. Opening your own claimed document automatically renews the claim, so **Continue review** resumes your saved draft without another Claim click—even if its lease expired, provided nobody else has taken over. The visible workstation sends periodic heartbeats while recently active; an abandoned/hidden tab does not hold a claim indefinitely. Expired claims can be claimed by another independent officer. Administrators can release a claim with a reason, not decide QC without the explicit operational role.
- A creator, currently assigned operator or any session's capture operator cannot QC that document—even with Administrator/QC roles. This is enforced in the backend, independently of menu visibility.
- Inspect pages across sessions using the bounded thumbnail rail, page number navigation, previous/next, session filter and issue links. Review statuses are per cycle and image generation. Bulk review is explicit, never implied by opening a thumbnail.
- Use **Page Properties** for non-destructive rotation/reset, order and exclusion/restore. Use **OCR Text** for separate human text corrections and confirmed reprocessing with global defaults. Machine results are never overwritten. An unchanged same-page/image/config reuse retains its human correction; a different page cannot inherit that correction.
- Use **Metadata** to compare candidates and source pages, correct values and verify fields. Source boxes appear only when actual bounds/page dimensions exist. Verify against the image, not the OCR suggestion alone.
- Record findings with category, severity, page range or field link. Resolution and waiver require a justification. Save Draft preserves checklist/notes; it is not a QC decision.
- **Return to Operator** requires a reason and retains this cycle. **Pass QC** advances only to **Awaiting Approval Level 1** and locks the reviewed revision; it is not approval/publication.

## Metadata rules and provenance

Current metadata lives on the document, not on a scan session or OCR job. Supported rule extraction includes names, organizations, identifiers, document number/title/date, address and other labelled values. Document type and physical location can also be entered manually. Rules are not an AI classifier or a promise of recognition accuracy.

Fields retain source page/result, available bounds, original candidate, human editor/time, verification actor/time and refreshed candidates. Automatic refresh preserves human values, flags stale sources and never silently substitutes a new machine value. Selecting a candidate records its provenance. Metadata saves are independently version-checked; stale tabs must reload instead of overwriting newer edits. Invalid dates, NIK-labelled identity numbers and NPWP-labelled tax numbers are rejected with actionable errors; candidates remain in history.

An administrator can configure **Required field types** per document before QC begins. Default is no mandatory types, preserving metadata-free capture. Passing still requires the officer's metadata checklist and verification of every present field. Required types must have nonempty verified values. OCR-run metadata is read-only history; migration 011 adopts the latest saved run values while preserving newer human document edits and old run rows.

## Non-destructive replacement and insertion

In capture/rework, choose an insertion anchor and before/after placement or select a replacement target. Each feeder run is still an ordinary persisted scan session. Replacement output is stored as excluded candidates; choose and preview one, then explicitly **Confirm replacement**. Multiple outputs never silently replace multiple logical pages. Cancellation keeps the old active image; unselected/cancelled successful scans remain retained. A partial/failed session's successful PNGs remain available for reconciliation and explicit selection.

Confirmation records a page revision and switches only the active image reference. The original image/hash/session/capture order do not change. Original and recorded replacement images are inspectable separately. Order/metadata changes do not invoke recognition. Changed effective images invalidate old results and use the existing queue; rework OCR is queued on resubmission. Successful unchanged identities are reused. The queue still processes one page at a time, using Tesseract or PaddleOCR under saved global defaults.

## Pass guards and revision lock

Pass requires a live independent claim, current document version, no capture/reconciliation/pending replacement, at least one included page, saved ordering/completeness/metadata checklists, no unresolved critical finding, no included page explicitly marked needs-correction, verified metadata and required policy values. It also checks that included original and active image files exist and match checksums.

Outstanding queued/running/paused OCR jobs must finish or be cancelled before pass. Failed/missing current OCR requires a saved, explicit QC exception; an exception cannot authorize an OCR job to continue changing text after pass. A decision snapshot records the document revision, metadata, logical page order/image identities and effective OCR/correction IDs. Ordinary page, metadata and OCR mutations are blocked afterward. There is no unlock/approval endpoint in this phase.

Page-by-page review tracking supports attention management; the pass completeness gate is the officer's explicit document-wide checklist, not a requirement to click every thumbnail. Findings retain their originating cycle and current resolution history through audit; decision snapshots also preserve findings and page-review statuses at that time.

## Recovery and limits

- Apply migrations before updated backend code. A healthy PostgreSQL server with an old schema can still produce the generic database-unavailable message; do not delete files or reset the database to fix it.
- Database/file errors roll back decisions. Reconciliation retains existing capture sources; retry after restoring PostgreSQL/storage. A stale version requires reload. An expired/lost claim requires reclaim, not a blind retry of an old mutation.
- Keep PostgreSQL, managed originals/revisions and recovery spools in the same backup/restore plan. Exclusion, cancellation and rework do not purge files. Preview derivatives are disposable.
- The workstation uses 40 thumbnails per window and internal scrolling. A synthetic 500-page/five-session check verifies practical navigation and viewport containment, not physical feeder throughput or OCR accuracy.
- Rule extraction is bounded to 200 current fields and exposes a warning if more suggestions exist. Existing fields are retained; a document needing more requires a deliberate schema/UI limit change. New suggestions for removed fields can reappear after later OCR refresh; deletion is not a permanent suppression rule.
- Supported desktop viewports: 1920×1080, 1366×768 and 1280×720. Full mobile, multiple documents per batch, approval decisions, publication, search, PDF generation and new OCR/AI infrastructure are out of scope.

## Authorized verification

Agent runs of any OCR-specific tests (including mocks), browser checks, benchmarks or physical scans require explicit approval under `AGENTS.md`. The Phase 4 approved run used isolated PostgreSQL schemas, generated simulator pages, mock OCR and cached Chromium only. It did not run installed-engine inference, physical scans or resume a benchmark.

After approval, the relevant commands are `pnpm test` (bounded test-file concurrency), `node test/qc-browser.check.mjs`, `node test/metadata-browser.check.mjs` and `node test/browser.mjs`. Static `pnpm lint`, `pnpm format:check` and `pnpm build` do not require OCR approval. See [ENGINEERING_REPORT.md](ENGINEERING_REPORT.md) for actual results and limitations.
