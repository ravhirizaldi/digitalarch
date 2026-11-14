# DigitalArch

A local document digitization app for Windows + WSL2. Capture paper documents, run Indonesian/English OCR, and review quality while preserving original images and history.

## Features

- Real scanner capture through NAPS2/WIA, plus a simulator.
- Multi-session batches with pause, resume and recovery.
- Tesseract OCR and optional PaddleOCR.
- Metadata verification, QC findings and operator rework.
- Role-based access and an audit trail.

**Status:** capture, OCR and QC are implemented. Approval Levels 1/2 and a basic archive viewer are planned.

## High-level workflow

1. **Scan:** the operator captures a document across one or more sessions, then selects **Complete Capture** to close scanning and start OCR.
2. **Prepare (optional):** after OCR finishes, edit metadata, page labels or other page details—or skip editing entirely. Completing capture and saving edits do **not** submit to QC.
3. **Send to QC:** explicitly send the document to the shared QC queue. It moves into operator tracking and becomes read-only for the operator.
4. **Claim and review:** an independent QC officer claims the document, fills missing metadata and corrects what is needed. QC can return it for operator rework; the operator fixes the same batch, finishes capture/OCR and explicitly **Resubmits to QC**.
5. **Pass QC:** QC validates and locks the reviewed revision at **Awaiting Approval Level 1**. L1/L2 decisions and final archive viewing are not implemented yet.

## Getting started

Requires Node.js 22+, pnpm 10, Docker Desktop and Windows + WSL2. Real scanning also needs a WIA driver, NAPS2 and .NET 8.

Follow [SETUP.md](SETUP.md) to configure the database, create your administrator account and start the app at **http://localhost:3000**.

## Documentation

- [Architecture and development](DND.md)
- [Database diagrams](ERD.md) · [Data-flow diagrams](DFD.md)
- [OCR](OCR.md) · [QC workflow](QC.md)
- [Approval and viewer plan](APPROVAL.md)
- [Database, backups and recovery](DATABASE.md)

Private scans, credentials and local OCR models are not included. This is a local-workstation application, not an internet-hardened deployment.
