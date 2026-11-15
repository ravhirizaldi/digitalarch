# Published document viewer

**Source implementation: 2026-11-15, migrations 017–018 applied locally. Static checks only. Registration, approval, page delivery, PDFs and transfers have not been exercised by the agent.**

## Accounts

- `/register` collects full name, username and matching 12–256-character passwords. Argon2id hashes are stored, never the passwords/confirmation. Registration grants only `archive_viewer`, with an inactive `pending` account and no session/document access. Usernames stay reserved after rejection/deletion.
- **Viewer registrations** is administrator-only (`viewers:approve`), with Pending/Approved/Rejected lists and explicit version-checked Approve/Reject confirmations. Existing account-edit routes cannot enable pending/rejected requests. Approved users can sign in; pending/rejected valid credentials return only their registration status, never a session.
- Administrator-created viewer role assignments are already administrator-authorized. Approved viewers appear in Users, where disabling/deletion and password resets retain identity/history and revoke sessions. Public registration has no role picker and no administrator grant.
- Registration is bounded to two concurrent password hashes and ten requests per 15-minute runtime window. Existing same-origin/CSRF/session/login throttling remains. This local-workstation application is not made internet/LAN reachable by registration.

## Library and tabs

`/library` has list/grid layouts, committed search, type filtering, sorting and paging. It exposes all and only **currently final-published** records under the existing L1-only/L1→L2 policy checks. Basic fields: title, number, type, document date, page count and publication date. Physical storage location, operator/QC/L1/L2 identities, findings, OCR text and workflow/audit history are excluded from viewer responses.

Document detail's **Metadata** button opens a 1200px, viewport-bounded modal: a compact basic-information summary and a scrollable **Field / Context / Value** table. Values come from the signed published metadata snapshot, without editor/reviewer identities, evidence/candidates or verification history. Physical location is excluded. The cramped side panel is removed so the page preview keeps its width. Document date falls back to the first normalized published date when no explicit date is stored.

Grid cards show only a low-resolution cover from the first published snapshot page, title and document date. Cover identifiers/rotation are returned by the list API; thumbnails reuse the bounded 320×420 derivative endpoint with publication and audit checks.

The Library tab cannot close. Document tabs can close; reopening an existing document focuses its tab. Closing an active tab selects its neighbour or Library. Open/active tabs and library filters are URL-backed; each mounted document retains its page/zoom while switching tabs. Inactive documents render no page images or thumbnails. Active previews have a 40-page thumbnail window and direct page-number navigation. Only published snapshot image identities are resolved and checksummed. No viewer text endpoint exists, and staff record/QC/OCR/capture APIs remain forbidden to viewer-only accounts.

Publication/access is checked on API requests, during each PDF page and before PDF delivery. Active document metadata is rechecked every 30 seconds. Content already received by a browser cannot be remotely erased. Hiding internal metadata does not redact names printed in a document image.

An independent L2 officer can take down publication with a reason, returning to QC for fresh inspection or L1 with the exact QC snapshot explicitly carried forward into a new cycle. Both routes clear publication and require fresh approvals under the fixed policy. New viewer image/PDF requests are denied while withdrawn; prepared PDFs are bound to the original publication cycle and cannot revive after republishing, even when the content revision is unchanged. Already authorized/in-flight responses and saved copies cannot be recalled. Original decisions, receipts and append-only takedown history remain.

## PDFs and real transfer progress

Download choices are **Current page**, **Selected pages** (`1, 3, 8–12`) and **All pages in the open document**, not the whole library. Selection is validated server-side against the requested published revision. PDFs contain image pages only, preserving logical order and rotation, with no OCR text layer or added workflow identities. Images are not resampled; 95-quality JPEG embedding bounds output size. PNG originals are untouched. PDFKit is the only new dependency.

PDF preparation is asynchronous and sequential (one generation per runtime), with page-count progress. At most four temporary outputs are retained. Output files are private, authenticated and owner-scoped; readiness polls do not carry public download credentials. Files expire after ten minutes without delivery, are removed on orderly shutdown, and cannot resume after restart. Restart appends an interruption event and removes the associated temporary PDF, never a managed original. Audit requests/manifests survive expiry/restart.

The flow is **Download PDF → choose pages → automatic preparation and transfer → save at 100%**. A floating bottom-right notification shows preparation separately from actual decoded bytes, percentage, average speed, elapsed time, estimated remaining time and Cancel. Dismissing only hides the notice, not the transfer; **Download progress** in the tab bar reopens it. Downloads belong to the library, so switching/closing document tabs does not cancel them. One transfer/save runs at a time; leaving the library or signing out aborts unfinished transfer.

Chunks stream into origin-private browser file storage where available, then the app requests saving only after the full byte count is validated and the temporary writable closes. Unsupported/private-storage-restricted browsers use a bounded 256 MB Blob fallback; larger outputs require supported browser file storage. At 100%, the app attempts the native picker; browsers commonly require a fresh user gesture, so it falls back to the browser's blob save and exposes **Save PDF** for an explicit picker retry. A native Save As prompt cannot be forced when browser settings disable it. No completion outcome claims a user-selected file was saved unless its writable actually closes.

The last completed local download is retained for ten minutes for save/retry and is cleared when replaced or leaving the library. Incomplete browser staging is discarded on failure/cancellation. Files abandoned by a browser crash are pruned from the app's private staging folder on a later download after 24 hours, avoiding interference with other tabs' long-running transfers. No managed original is touched.

Transfer is an authenticated, same-origin, CSRF-protected **POST** with an empty JSON body. The response uses `application/vnd.digitalarch.transfer`, no attachment header and no PDF signature: bounded base64 JSON-line packets reconstruct the PDF inside DigitalArch. `X-Document-Bytes` declares the decoded length; progress/speed count actual decoded bytes, not preparation or encoded network bytes. Base64 adds roughly 33% wire overhead. There is no direct GET file endpoint. This reduces ordinary IDM/PDF interception, not a guarantee against browser extensions; disabling IDM integration for the local application may still be necessary. The fallback browser save is also outside app control.

The server records delivery start/outcome, bytes read from the file stream and server duration. The client reports received/saved/cancelled/failed, byte count, duration and save mode, explicitly labelled `clientReported`. Server delivery is not proof of disk persistence; fallback browser receipt is not proof the Save dialog completed. Client reports are observational, not a security/accounting authority. If an outcome audit temporarily fails, runtime retries pending server outcomes; a restart can establish interruption but cannot reconstruct unreported client actions.

## Four separate append-only audit tables

| Table                       | Coverage                                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewer_registration_audit` | Submitted, approved/rejected, administrator-created viewer accounts, account updates/disabling/deletion                                                                                                         |
| `viewer_access_audit`       | Viewer sign-in/out, known-account failed sign-ins, pending/rejected status checks, revoked/expired session attempts, denied routes, password changes/resets                                                     |
| `viewer_activity_audit`     | Library queries/search/filter/sort/page, list/grid choice, tab open/select/close, document open/recheck, thumbnail/page-image requests, page selection, zoom/fit/fullscreen and download selection/cancellation |
| `viewer_download_audit`     | Request manifest with revision/page identities/checksums/rotation, preparation checksum/size, server delivery start/outcome/duration, client transfer reports, expiry/interruption/failure                      |

Each table has its own monotonically increasing sequence, event UUID, actor/subject/resource references, timestamp, correlation ID and bounded event metadata; download lifecycle rows share a `download_id`. Update/delete triggers prohibit rewriting events. `all_audit_logs` is a union view, not another copy: the existing administrator Audit Logs screen exposes all four categories alongside operational history. Viewers cannot read it.

Audit persistence must succeed before library content/page access or PDF preparation/delivery is authorized. Mouse movement, scroll position and every typed character are deliberately not logged. Search values do enter the activity audit and browser history. Client-reported UI actions do not prove that somebody read the page. Browser Save Image, screenshots and activity after disconnect cannot be reliably observed; page-image requests themselves are recorded.

## API map

- `POST /api/auth/register`; existing login returns pending/rejected status without a session.
- `GET /api/admin/viewer-registrations?status=pending|approved|rejected`
- `POST /api/admin/viewer-registrations/:userId` with `version, action=approve|reject`
- `GET /api/viewer/documents?search=&type=&sort=published_at|title|document_date&direction=asc|desc&limit=&offset=`
- `GET /api/viewer/documents/:batchId`
- `GET /api/viewer/documents/:batchId/pages/:pageId/image|preview|thumbnail`
- `POST /api/viewer/activity` (allowlisted client events)
- `POST /api/viewer/documents/:batchId/downloads` with `revision, selection` and selected `range` or `currentPage`
- `GET /api/viewer/downloads/:id` (status only)
- `POST /api/viewer/downloads/:id/transfer` with `{}` (encoded app-managed transfer)
- `POST /api/viewer/downloads/:id/report` (bounded owner-scoped observational report)

Viewer tab containment targets Ant Design 6's actual `body-holder`/`body` wrappers and active tab panels, with bounded internal preview scrolling. Zoom applies immediately; a short debounce audits the final zoom/fit/fullscreen state without gating the interaction on a network request. Drag/scroll remain in the shared PageViewer, not a duplicate viewer.

Regression sources are in `test/viewer.test.mjs`, `test/download.test.mjs` and `test/routes.test.mjs`; they are intentionally unexecuted. Private browser staging tests use mock storage, not a browser. No browser, PDF rendering, OCR recognition, physical scanning or large-document timing claim is made.
