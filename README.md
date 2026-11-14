# DigitalArch

A local document digitization app for Windows + WSL2. Capture paper documents, run Indonesian/English OCR, and review quality while preserving original images and history.

## Features

- Real scanner capture through NAPS2/WIA, plus a simulator.
- Multi-session batches with pause, resume and recovery.
- Tesseract OCR and optional PaddleOCR.
- Metadata verification, QC findings and operator rework.
- Role-based access and an audit trail.

**Status:** capture, OCR and QC are implemented. Approval Levels 1/2 and a basic archive viewer are planned.

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
