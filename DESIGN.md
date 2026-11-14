# DigitalArch document workstation

## Direction

An exact, restrained archive workstation. Preserve the dark navy header, compact Ant Design controls, clear source/status labels and large document inspection area. This is an operational interface, not a marketing dashboard. No decorative imagery, gradients, oversized metric cards or new component library.

## Tokens and components

Ant Design **6.7.0**, icons **6.3.4**, `src/theme.js`, one global compact ConfigProvider. Working type is **13px**, small type **12px**, controls **28px**, system UI/Segoe UI, tabular numerals. Semantic statuses always include text, not color alone. Decorative action icons are hidden from accessible names; icon-only actions have explicit labels.

| Role                  | Value                       |
| --------------------- | --------------------------- |
| Text                  | `#202c3b`                   |
| Secondary / muted     | `#566376` / `#667386`       |
| Header                | `#182d46` with light labels |
| Workspace / panels    | `#f3f5f8` / white           |
| Borders               | `#d8dee7`                   |
| Accent / selection    | `#2463a6` / `#edf3fa`       |
| Radius                | 4px                         |
| Gaps                  | 8px                         |
| Panel padding         | 8–12px                      |
| Header / nav / footer | 44px / 36px / 24px          |

## Shell and navigation

The shell is viewport-contained (`100dvh`, `min-height:0`, `min-width:0`). The browser document never scrolls at supported desktop sizes; tables, thumbnails, preview viewports, drawers and modal bodies own scrolling. The header shows scanner status where permitted, the current user, password change and sign-out. Mode appears only in the scanner mode selector, not as repeated source text on thumbnails, preview headings or a header badge. Provenance stays in PostgreSQL. Footer shows active batch or **No active batch** and WIB timezone. During document review it instead shows included/reviewed pages, unresolved findings, cycle and revision, removing the separate summary strip so the review area can grow. Storage implementation details stay in System/documentation.

Navigation derives from permissions. Operators open Capture Workspace, My Batches and Scanner. QC Officers open QC Queue; administrators have read-only QC oversight plus Users, Batch assignments, Audit Logs, Settings and System. Explicit combined roles expose their granted sets. Future-only users get a professional informational empty state, not dead navigation. Backend authorization is independent of the menu.

Document details keep **QC Queue** selected for accounts with QC access, or **My Batches** for operator-only accounts. Common page actions (previous/next, rotation/reset, order, fit, reload and back) use the shared Ant Design icon buttons, with action names in hover/focus tooltips and accessible labels. QC decisions and bulk-review actions retain visible text and their existing confirmations.

## Authentication and administration

Sign-in is a compact, centered form with visible labels and native autocomplete. A forced-password-change form blocks workspaces until successful. Errors remain actionable and do not expose account internals. User management uses internally scrolling tables and bounded create/edit/credential modals. Generated temporary passwords appear once and are cleared on dismissal. Destructive account actions require confirmation; current administrative access is protected. Audit detail uses a read-only table with paging.

## Operator home and batch lists

**Scan New Batch** is immediately visible beside the workspace heading. There is no pre-scan metadata form. Search accepts batch code or physical location. In Progress/Paused/Capture Completed tabs contain compact tables with pages, sessions, creation/activity (WIB), status, assignment and Resume/View details. Batch codes, not empty document titles, remain the primary identity, with the shared info/copy affordance. Recent activity is a compact, initially collapsed Event/Time table with readable event names and internal scrolling. Tabs, search, sorting, page size/pagination and activity expansion are URL-backed. Sorting applies to the full server-side result, not just the loaded page.

`src/WorklistTable.jsx` is the shared operational table surface, used by QC, operator Capture Workspace/My Batches and administrator batch assignments. It owns bounded table scrolling, compact rows, left-aligned filtered totals and far-right pagination. `ColumnHeading`, `BatchIdentity` and `BatchIdHeading` supply consistent icons/copy behavior without role logic; callers retain columns, filtering, permissions and actions. Reuse this surface for future role queues rather than cloning QC-specific layout or inventing new workflows. Shared styles use the `worklist-` prefix. Existing scanner/document panes keep their current common components.

The component/API and current URL-state contracts are documented in [DND.md](DND.md). [APPROVAL.md](APPROVAL.md) is a proposed handoff: future approval screens reuse this design as read-only inspection plus decisions, and the basic archive viewer exposes only permitted final-approved revisions. These screens and their authorization are not implemented by sharing the component.

An assigned operator sees **Delete** only on In Progress/Paused rows. Capture Completed batches cannot be deleted, including through the API. Confirmation names the batch and states that originals/audit history are retained. Successful soft deletion removes the row without a second scanner action or extra workspace; active scans block deletion. Administrator-only accounts do not gain deletion authority. The table body fills its available panel height so horizontal scrolling stays below the body rather than immediately below a short list of rows.

## Active capture

The batch context bar stays above scanner controls: **Active batch · B-… (Session 3)** and optional location, with Batch Info, Save & Exit and Complete Capture. Batch Info is optional. Empty-batch cancellation is explicit and soft. The retained page count appears only in the **Captured pages** heading. There is no success/result strip or repeated session/count label; errors and hardware checks still surface when actionable. Session filtering never changes the batch total. Per-session counts/outcomes remain in the session selector. Scan feeder is the only acquisition action; each click adds a session to the current batch.

The existing Simulator/Real Hardware segmented control, scenario or device/profile selectors, Refresh, settings and Scan feeder remain. Requested mode highlights while backend inspection runs. Device and Profile labels remain distinct; unsupported native profiles remain visible but disabled. Detection never claims loaded paper. Settings live in a compact drawer.

The resizable split retains a page rail and the large PageViewer. The rail contains only active-batch pages, 50 thumbnails per window, with session filtering and global feeder order. Thumbnail WebP derivatives are bounded to 320×420; medium previews to 1400×1800. Actual-size/download explicitly use the original PNG. Zoom/fit/pan/fullscreen remain; the original is never rewritten.

The selected page heading contains Rotate left/right and Remove controls; no separate correction toolbar. Rotation updates the preview, fullscreen and thumbnail without rewriting the original. Removed pages are hidden by default, with immediate Undo removal and a Show removed option for later restoration. Kept-page counts decrease/increase on removal/restore. All edits are disabled while scanning, and completed batches expose no correction controls.

Session outcomes distinguish **completed**, **partial**, **failed** and **interrupted** in the session selector, and errors appear without duplicating Scan feeder. Save & Exit pauses and clears context. Complete Capture confirms total pages/sessions and explicitly acknowledges partial/interrupted sessions before locking. It is not QC/approval. Completed batches are read-only. Navigation away from an active batch also pauses before clearing. No active batch means no thumbnails or stale preview.

Completed batch details omit the entire acquisition toolbar (mode, scenario/device/profile, scanner refresh/settings and Scan feeder), along with unrelated scanner-readiness feedback. Page inspection remains. A pre-OCR completed batch offers **Send to OCR**; an existing job offers **Open OCR**. Narrow-screen page navigation remains available in the preview heading.

## OCR Processing

Reuse the same compact workstation palette, Ant Design tables, descriptions and bounded panels. `/ocr` shows five inline overview counts (not metric cards), a status filter and paginated jobs. `/ocr/jobs/<UUID>` restores a job detail after refresh and Back/Forward. Detail uses a narrow page/status rail beside resizable source-preview and recognized-text panes. The radio column has an empty visual heading and explicitly labelled controls, never a wrapping “Inspect” header. A slim progress strip replaces the oversized summary card; full details are collapsed by default. Profile/PSM selection and confirmed Reprocess preserve old runs. Polling is independent of scanner UI state. Private scans are inspected only when the user explicitly requests a comparison, never used as browser screenshot fixtures.

Pause/resume/retry controls follow persisted job state and permissions. Queued cancellation requires confirmation and explicitly retains existing text. Historical image results are labelled stale, never presented as current. Engine/version, language, timestamps and per-page processing time remain available in detail rather than repeated in every list row. Desktop 1366×768 is the target; browser-level scrolling remains disabled by the shell. Phase 4 browser checks use generated pages and mock OCR only, not private scans or installed recognition engines.

Global OCR defaults now live in the administrator **Settings** menu at `/settings`, using the same compact Ant Design form/palette. Engine, languages, profile, explicit preprocessing flags, Tesseract PSM/layout and PaddleOCR 1/2/4-thread controls are grouped in one bounded scrolling form. Model/version, available logical CPUs, RAM and fixed worker/scanner limits are read-only details below the form. Unavailable models and unsupported controls are disabled with explanations; stale saves require a reload. Saving does not launch OCR or modify old job snapshots.

The OCR job view removes per-run selectors and the redundant “Next run / CPU segmentation” label strip entirely. **Reprocess** confirms use of current global defaults; an administrator can open **OCR settings**, while ordinary operators cannot edit workstation-wide defaults. Collapsed Job details show the actual saved model/engine/thread budget rather than current settings. Run metadata is read-only history, with a direct link to current document metadata/QC.

History API routes preserve the active batch across browser refreshes; reloading restores authentication, pages, rotations/exclusions, current session and live polling without restarting capture. Back/Forward obeys the same workflow boundaries as the navigation menu. No localStorage session token or router dependency is added.

The legacy global history and JSON QC UI were removed by explicit user instruction; no old registry, import or QC action remains.

## Document metadata and QC workstation

`/qc` separates **Shared QC queue** (waiting, in-review, returned, passed/history and OCR-incomplete filters) from **Claimed documents** (the signed-in officer's claims and saved drafts). `/documents/<batch UUID>` is the shared operator/QC workstation. A left thumbnail rail shows logical order across sessions, current OCR/review state and 40 pages per window. The center reuses PageViewer, with fit-width/fit-page, zoom, fullscreen and current/original/history inspection. The right inspector contains Metadata, OCR Text, Page Properties, Issues and History; inactive tab panes are actually hidden, not merely moved below the active content.

Both queue tabs share compact icon-bearing headings, a copyable **(i)** batch identity, linked document titles, semantic text status tags, combined search/metadata/OCR filters and allowlisted server-side sorting, including Created and Activity dates. Filter labels wrap rather than truncate. **Search** has a search icon; clearing filters is a labelled icon action. Filtered document/page/session counters sit on the left of the table footer, with page navigation and page size anchored right. Queue-wide counts remain separate from filtered totals. The table fills its available height and owns scrolling.

QC view state is URL-backed: queue tab/search/filters/sort/paging and document tab/page/session/window, excluded/original/revision selection, preview zoom/fit/fullscreen and expanded processing/source details survive reload. Back/Forward restores state through the existing route guard; opening and returning from a document preserves the queue view. Search typing and transient preview changes replace the current history entry; explicit navigation pushes an entry. No draft form values or document/OCR text enter the URL. These queue/URL refinements remain untested at the user's request.

Inspector tabs use consistent section headings, 12–16px spacing, restrained status tags, visible form labels and compact history/revision rows. The document-title banner above the workstation is omitted; the title remains in metadata and queue search. OCR text leads its tab, with saved processing settings presented as readable rows inside **Processing details**, never raw JSON. These follow-up UI refinements were intentionally not test- or browser-verified at the user's request.

The workstation owns its internal scrolling at 1920×1080, 1366×768 and 1280×720. The 500-page check exercises five sessions and bounded thumbnails rather than rendering all images at once. Metadata source links navigate to the current logical page; an overlay appears only where the engine returned real bounds and page dimensions. No invented boxes or confidence scores.

Claim/release, draft save, return and pass are explicit actions; return/pass use bounded confirmation dialogs. Dirty metadata, text or checklist drafts warn before navigation. A stale version or lost claim produces a reload/reclaim error rather than silently overwriting another officer. Page changes clear checklists. Scanner rework selects insertion anchors or a replacement target; replacement candidates are previewed and explicitly confirmed, never silently applied to the selected page. Original/capture identities remain visible in Page Properties and History.

The narrow copy cleanup follows unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0: preserve the existing workstation layout/palette, remove repeated retention and implementation copy, and let the document preview and accurate counts lead. No generated imagery or decorative motion was added.

## Security and verification

Production HTML receives a per-response CSP style nonce. ConfigProvider forwards it to Ant Design. The existing pinned `@rc-component/util` patch also forwards it to scrollbar-measurement styles; no unsafe-inline/script relaxation. Sessions use HttpOnly cookies and in-memory CSRF tokens, never localStorage.

`test/browser.mjs` drives real database-backed authentication/administration and simulator capture at **1920×1080, 1366×768 and 1280×720**, checks no browser scrolling, active-batch isolation, session results, completion locks, empty scanner, failure feedback and CSP/browser errors. Synthetic screenshots live in `.impeccable/review`; private hardware pages are not captured there. Desktop is the acceptance target; below 960px the existing page-rail drawer remains, but a complete mobile workflow is not claimed.

The hardware architecture is unchanged. A user-authorized physical test captured three pages and verified persisted PNG integrity; this does not establish duplex or mechanical failure recovery.
