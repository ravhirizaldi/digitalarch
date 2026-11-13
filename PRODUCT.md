# DigitalArch

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React 19, Ant Design 6 compact, one Node.js ES-module backend, pnpm, PostgreSQL 16 + pgvector, local PNG filesystem storage. The existing Windows .NET 8 console helper uses NAPS2 SDK 1.6.0 and WIA through the WSL2 Windows bridge.

## Product Purpose

Digitize physical document bundles without mandatory metadata entry. An operator creates a batch, captures multiple feeder sessions, pauses/switches/resumes work across days, and explicitly completes capture. The system preserves identity, ownership, sequence, source provenance, originals and an audit trail.

## Operating Context

Desktop archive workstation, WSL2 backend and Windows browser/scanner driver. One backend/scanner installation with multiple authenticated accounts, not a distributed deployment. The tested Brother ADS-2400N default is simplex feeder, Letter, 300 dpi, color and right alignment. Device detection is evidence, not a physical readiness claim.

## Capabilities and Constraints

PostgreSQL is authoritative for users, sessions, permissions and new capture workflow. Each batch represents one physical bundle and starts with one placeholder logical document; the schema permits future multiple documents. Physical location is optional and nonunique. Batch IDs are generated from Jakarta time plus a random suffix; actual identity is UUID. Display time is Asia/Jakarta; storage timestamps are UTC.

The active scanner contains exactly one batch or an explicit empty state. Scanning creates a sequential session, never another batch. Successfully registered pages from partial failures remain visible. Capture-completed batches are locked to ordinary operators. Required batch versions, database transactions/row locks and a one-running-session constraint prevent overwrites. Originals and feeder capture order are immutable. The provider spool is retained for idempotent recovery after registration/database failure.

The role-aware shell includes Operator Capture Workspace/My Batches/Scanner, OCR Processing, and Administration Users/Batch assignments/Audit Logs/System. System Administrator has no inherited capture privileges; OCR read/manage-all oversight is explicitly granted. Temporary-password onboarding, account disabling, role assignment, session revocation and permission enforcement are implemented. Capture/QC and approval roles, and the two approval levels, must remain separate.

The user's later instruction removed all legacy code/workflows: no global history, JSON QC registry/manifests or compatibility/import routes remain. Historical scan/QC stores were inspected and empty. QC Officer, approver and Archive Viewer accounts can authenticate but see an informational future-workspace state. There are no fake QC/approval/search actions.

Simulator is the startup capture default and its capture provider never touches Windows or hardware. Real scanning preserves profile discovery, capability evidence and the .NET helper; native profiles are read-only and unsupported processing options are not silently applied. There is no simulator fallback for hardware failure. Completed captures atomically queue PostgreSQL-backed OCR through the same Windows/.NET 8 helper and NAPS2.Sdk 1.6.0 Tesseract API. Best Indonesian and English resources are required by default. OCR is separate from capture state, runs at concurrency 1, persists text and bounds immediately, and supports pause/resume, bounded retries and lease-based recovery. Standard/enhanced/high-accuracy profiles, PSM 3/4/6 and sequential benchmark mode compare configurable preprocessing on temporary images, never the retained originals. Reprocess preserves prior results. Scanner resolution remains 300 DPI; higher accuracy is measured rather than guaranteed by preset names. Pre-feature completed captures have an explicit Send to OCR action; completed details hide acquisition controls. No AI extraction/classification, PDF, QC workflow, approval, publication, search, embeddings, cloud storage or distributed queue infrastructure is implemented. pgvector is enabled without an arbitrary vector dimension.

## Evidence on Hand

An explicit alternative OCR engine is available through the same OCR job/reprocessing workflow: PaddleOCR 3.7.0 with the verified PP-OCRv6 Small detector/recognizer, running on a project-local Linux/WSL Python CPU runtime. It supports Indonesian and English and preserves original PNGs and Tesseract history. The administrator Settings menu stores global OCR defaults in PostgreSQL, including supported 1/2/4-thread Paddle budgets (initially 1), languages, profile and preprocessing. New capture/enqueue/reprocess jobs snapshot defaults; existing jobs never inherit later setting changes. Page concurrency remains 1 and Tesseract remains the initial production default. Model/hardware details are in Settings and saved Job details; the redundant next-run strip is removed. Paddle adds no Docker image, Redis or separate service. Higher-thread speed claims require an explicitly approved benchmark; OCR verification must never be run without user approval. Existing benchmark evidence and resource limitations are in OCR.md.

The existing local `pgvector/pgvector:pg16-bookworm` image was inspected and reused, with no image download. PostgreSQL 16.15/vector 0.8.7 connectivity was verified through WSL Node.js. Automated checks exercise authentication, all six roles, administration, ownership, batch lifecycle, concurrency, simulation, files/checksums, recovery, strict CSP and three desktop viewport sizes.

On 2026-11-13 the user loaded paper and authorized a physical operation. The unchanged Windows bridge/.NET/NAPS2/WIA path captured three 2550×3300, 300-dpi color Letter PNGs. The database-backed session completed, originals passed decoding/SHA-256 verification, and batch `B-20261113-115334-FB68BC7B` was paused. The verification operator was disabled; an administrator can reassign the retained batch. Private physical documents are not visual-test fixtures. Duplex, physical jam/disconnect handling and mechanical readiness after a shutdown remain office checks.
