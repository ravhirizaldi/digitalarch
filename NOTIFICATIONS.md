# Staff notifications

**2026-11-15: migration 019 applied locally. Source implementation; tests and browser acceptance remain unexecuted.**

## Inbox

Operator, QC, L1 and L2 have a **bell in the top navbar**, beside the account controls, with an unread badge. Its 600px viewport-bounded drawer has **Unread / All**, 25-item Newer/Older history, Refresh, Mark read/unread and Mark all read. Details show document title, batch code, actor, WIB timestamp, reason and first-view time. Opening details or a document/QR action marks that recipient's notification read and viewed; marking read alone does not record a view. Mark unread retains first-view time. Closing never changes read state. Read is not proof of task completion or full document inspection.

Publication opens the existing authenticated receipt, now offering **Download QR** (PNG) and **Print QR**. L1-only publication is final; intermediate L1 confirmation remains pending L2. Old receipts are labelled historical after withdrawal/new review cycles. Every destination rechecks existing permissions; notifications never authorize a claim or approval. Old assignees keep their event snapshot, but lose document actions if access has changed. Navigation respects active capture and unsaved-edit guards.

## Events

Recipients are snapshotted at event time: active staff only, excluding the actor and deduplicating users. Viewer and pure-administrator accounts do not get a staff inbox.

| Event                             | Recipients besides the actor                                    |
| --------------------------------- | --------------------------------------------------------------- |
| Send/resubmit to QC               | Eligible QC queue, or specifically assigned QC                  |
| QC starts/reclaims                | OP and previous claimant                                        |
| QC releases/admin reassigns       | OP, previous reviewer and eligible destination QC               |
| QC returns for correction         | OP                                                              |
| QC passes                         | OP and eligible L1; awaiting L1, not published                  |
| L1 approves to L2                 | OP and selected L2                                              |
| L1-only/L2 publication            | OP and involved QC/earlier confirming officers                  |
| Approval return, drop or takedown | OP, involved officers and applicable eligible QC/L1 destination |
| Operator/L2 reassignment          | Previous/new assignees and OP where applicable                  |

Queue eligibility mirrors historical capture/operator/QC/approval independence. Workflow APIs remain the final authority. Shared notices show the current stage or **Already claimed**, not an outdated Claim action. Other recipients are not automatically marked read when someone claims work. Newly assigned roles still discover existing work in their queue, even if they were not original recipients.

Current UI removes the old 15-second approval polling and recurring document-local workflow event popups. Local **Not sent to QC** guidance, validation errors, immediate action feedback and Viewer download progress stay separate. No startup toast stacks, email, sounds, browser push, reminders or Redis.

## PostgreSQL and lifecycle

- `staff_notification_events`: identity BIGINT, unique audit-event FK, frozen document/batch/actor labels, review cycle, reason and optional decision FK. Append-only trigger. A filtered `AFTER INSERT` audit trigger creates events inside the workflow transaction; a rollback leaves neither events nor recipients.
- `staff_notification_recipients`: `(user_id,event_id)` primary key, nullable `read_at` and first `viewed_at`. Primary-key backward scans support keyset paging; a partial unread index serves personal unread paging/counts and read-all. No OFFSET/deep paging, global unread scan or count cache. Idempotent individual state changes avoid unnecessary writes.
- Set-based recipient insertion deduplicates multi-role users. Supporting capture/QC/audit actor indexes bound independence lookups by batch/document. Only meaningful transitions create events—not page review, heartbeats, OCR progress or reads.
- Statement-level transition-table triggers `pg_notify` distinct recipient IDs only at commit. Payloads contain database/schema/user identity, never document content. Durable rows are authoritative; NOTIFY is a wake-up, not a broker/delivery guarantee.
- Node reuses its existing dedicated runtime-lock connection for LISTEN. Each browser SSE connection consumes **no dedicated database connection**. Coalesced wake-ups fetch an indexed summary when closed or one bounded inbox page when open. Reconnect/focus/manual refresh catch up; there is no recurring inbox poll.
- Same-origin/session-authenticated SSE is capped at eight streams per user/200 per runtime, closes slow/disconnected clients and revalidates session/permission every 30 seconds. Runtime disconnect/shutdown closes streams. Other tabs/devices receive read-state wake-ups.

Migration 019 retains all decisions, receipts and `approval_notification_reads`. It imports approved-confirmation notices and the latest outstanding task per batch from existing audit evidence; prior explicit approval dismissals become read. This is not reconstruction of every historical recipient/role assignment. Old notification endpoints remain compatibility-only; their dismiss action also marks the matching new recipient read.

Apply migrations through **019 before loading the backend**; restart/reload normally after deployment. The agent did not restart the application. No retention purge is added: history grows with transitions and recipient fan-out, not page count. Introduce an archival policy only when measured size justifies it. No throughput/latency claim is made without runtime acceptance.

## API and verification

- `GET /api/notifications/summary`: own unread count/latest ID.
- `GET /api/notifications?filter=all|unread&before=<id>`: own 25-item page/next cursor/summary, in a repeatable-read snapshot.
- `POST /api/notifications/:id` with `{action:"read"|"unread"|"view"}`: own state only.
- `POST /api/notifications` with `{action:"read-all",through:"<latest-id>"}`: own unread rows up to the displayed high-water ID; later IDs are excluded.
- `GET /api/notifications/stream`: authenticated SSE invalidation/keep-alive, not document content.

Mutations retain CSRF/same-origin checks. IDs are positive signed-BIGINT strings, avoiding JavaScript precision loss. Every read/write filters by recipient identity. Existing document scopes govern destinations; unavailable batches do not expose current state.

`test/notifications.test.mjs` has unexecuted recipient, read/view/unread, ownership, rollback/deduplication, immutable-event, keyset/read-all, historical QR and stream-cleanup regressions. It uses notification-only rows without pages or OCR fixtures. No tests, browser sessions, recognition, scans or workflow decisions were run. Schema migration is not end-to-end acceptance.
