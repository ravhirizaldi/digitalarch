# DigitalArch

A local document digitization app for Windows + WSL2. Capture paper documents, run Indonesian/English OCR, and review quality while preserving original images and history.

## Features

- Real scanner capture through NAPS2/WIA, plus a simulator.
- Multi-session batches with pause, resume and recovery.
- Operator-specific scanner selections, exclusive per-device reservations and FIFO waiting queues.
- Tesseract OCR and optional PaddleOCR.
- Metadata verification, QC findings and operator rework.
- Role-based access and an audit trail.

**Status:** capture, OCR, QC, configurable L1/L2 approval, staff Documents and the approved Viewer library are implemented in source. Viewer registration, list/grid tabs and audited image-only PDF downloads are documented in [VIEWER.md](VIEWER.md). The latest changes have static checks only.

## High-level workflow

1. **Scan:** the operator captures a document across one or more sessions, then selects **Complete Capture** to close scanning and start OCR.
2. **Prepare (optional):** after OCR finishes, edit metadata, page labels or other page details—or skip editing entirely. Completing capture and saving edits do **not** submit to QC.
3. **Send to QC:** explicitly send the document to the shared QC queue. It moves into operator tracking and becomes read-only for the operator.
4. **Claim and review:** an independent QC officer claims the document, fills missing metadata and corrects what is needed. On return, OP fixes metadata/Batch Info in preparation and **Resubmits to QC** without another OCR run when retained images are unchanged. Only new/changed scans need capture completion/OCR. QC can edit Batch Info while holding the review claim.
5. **Pass QC:** QC validates and locks the reviewed revision at **Awaiting Approval Level 1**, fixing this batch's approval policy.
6. **Confirm:** L1 explicitly publishes under an L1-only policy, or approves and selects the L2 authority who must confirm publication. Either level may return to QC or drop the whole batch with a reason.
7. **Documents:** working roles browse **published records only**, with advanced filters. Unpublished work stays in its workflow queues. Each L1/L2 confirmation has an authenticated QR receipt; OP is notified and can download/print it. Publication is not public access or export.

Operator/QC/L1/L2 have a **bell in the top navbar** with persistent read/unread/view notifications for handoffs, returns, approvals, takedowns and assignments. PostgreSQL transactions/indexes/LISTEN-NOTIFY provide updates without Redis. Apply migrations through **019** before the backend; see [NOTIFICATIONS.md](NOTIFICATIONS.md). Runtime/browser acceptance remains unverified.

## Getting started

Requires Node.js 22+, pnpm 10, Docker Desktop and Windows + WSL2. Real scanning also needs a WIA driver, NAPS2 and .NET 8.

Follow [SETUP.md](SETUP.md) to configure the database, create your administrator account and start the app at **http://localhost:3000**.

## Documentation

- [Architecture and development](DND.md)
- [Database diagrams](ERD.md) · [Data-flow diagrams](DFD.md)
- [OCR](OCR.md) · [QC workflow](QC.md)
- [Approval, Documents and QR receipts](APPROVAL.md)
- [Staff notification inbox](NOTIFICATIONS.md)
- [Database, backups and recovery](DATABASE.md)

Private scans, credentials and local OCR models are not included. This is a local-workstation application, not an internet-hardened deployment.
