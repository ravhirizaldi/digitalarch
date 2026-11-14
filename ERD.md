# Entity relationship diagrams

**As-built baseline: 2026-11-14, migrations 001–011.** These diagrams describe the local source schema, not a fresh inspection of a running database. Selected columns are shown; the SQL migrations remain authoritative. Approval decisions and the final archive viewer do not exist yet; their proposed model is in [APPROVAL.md](APPROVAL.md).

## 1. Accounts, roles and sessions

```mermaid
erDiagram
    users ||--o{ user_roles : has
    roles ||--o{ user_roles : assigned_through
    roles ||--o{ role_permissions : grants
    permissions ||--o{ role_permissions : granted_through
    users ||--o{ auth_sessions : owns

    users {
        UUID id PK
        TEXT username UK
        TEXT display_name
        TEXT password_hash
        BOOLEAN is_active
        BOOLEAN must_change_password
        INTEGER version
    }
    roles {
        UUID id PK
        TEXT code UK
        TEXT display_name
    }
    permissions {
        UUID id PK
        TEXT code UK
    }
    user_roles {
        UUID user_id PK, FK
        UUID role_id PK, FK
    }
    role_permissions {
        UUID role_id PK, FK
        UUID permission_id PK, FK
    }
    auth_sessions {
        UUID id PK
        UUID user_id FK
        TEXT token_hash UK
        TEXT csrf_hash
        TIMESTAMPTZ expires_at
        TIMESTAMPTZ revoked_at
    }
    auth_login_attempts {
        TEXT username PK
        INTEGER attempts
        TIMESTAMPTZ window_started_at
    }
```

- Username uniqueness is on `lower(username)`, not a case-sensitive column constraint.
- `auth_login_attempts.username` is deliberately not a user FK: unknown usernames must also be throttled.
- Six roles are seeded, but L1/L2/Archive Viewer currently have permission scaffolding only. Role assignment prevents L1 + L2 and approval + Operator/QC combinations. Historical participation checks will still be needed for approval if an account changes roles later.
- Tokens and CSRF values are hashed in PostgreSQL. Raw session tokens are not stored in the frontend or these docs.

## 2. Capture, logical documents and image history

```mermaid
erDiagram
    users ||--o{ archive_batches : creates
    users o|--o{ archive_batches : assigned_operator
    archive_batches ||--o{ documents : contains
    archive_batches ||--o{ scan_sessions : groups
    documents ||--o{ scan_sessions : scopes
    scan_sessions ||--o{ pages : captures
    pages ||--o{ page_revisions : retains
    users ||--o{ page_revisions : records
    users o|--o{ audit_logs : acts
    archive_batches o|--o{ audit_logs : contextualizes
    pages o|--o{ scan_sessions : insertion_anchor
    pages o|--o{ scan_sessions : replacement_target

    archive_batches {
        UUID id PK
        TEXT batch_code UK
        UUID created_by FK
        UUID assigned_operator_id FK
        TEXT status
        TEXT ocr_status
        TEXT physical_location
        INTEGER version
        TIMESTAMPTZ deleted_at
        UUID deleted_by FK
    }
    documents {
        UUID id PK
        UUID batch_id FK
        INTEGER document_index
        TEXT title
        TEXT archive_number
        TEXT document_type
        TEXT workflow_status
        INTEGER version
        INTEGER revision
        INTEGER review_cycle
        INTEGER metadata_version
        TEXT metadata_status
        JSONB metadata_json
    }
    scan_sessions {
        UUID id PK
        UUID batch_id FK
        UUID document_id FK
        UUID created_by FK
        INTEGER session_number
        TEXT status
        TEXT scanner_mode
        JSONB settings_snapshot
        TEXT job_id UK
        INTEGER capture_order_base
        INTEGER display_order_base
        UUID insertion_anchor FK
        UUID replacement_target FK
        TEXT replacement_status
    }
    pages {
        UUID id PK
        UUID batch_id FK
        UUID document_id FK
        UUID scan_session_id FK
        INTEGER capture_order
        INTEGER display_order
        TEXT original_storage_key UK
        TEXT active_storage_key
        TEXT sha256
        TEXT active_image_sha256
        INTEGER image_revision
        INTEGER rotation_degrees
        BOOLEAN is_excluded
        BOOLEAN replacement_candidate
        UUID replaced_by_page_id FK
    }
    page_revisions {
        UUID id PK
        UUID page_id FK
        UUID created_by FK
        TEXT storage_key
        TEXT sha256
        INTEGER rotation_degrees
        JSONB metadata
    }
    audit_logs {
        UUID id PK
        UUID actor_id FK
        UUID batch_id FK
        TEXT action
        TEXT entity_type
        UUID entity_id
        JSONB metadata
        UUID correlation_id
    }
```

Important constraints not fully expressed by the drawing:

- The schema permits many documents per batch; the application currently creates and operates on **one logical document per batch**, across every feeder session.
- Composite FKs bind `scan_sessions(document_id,batch_id)` and `pages(scan_session_id,batch_id,document_id)` to the same document/batch. The columns are not independent cross-batch links.
- Unique pairs: `(batch_id,document_index)`, `(batch_id,session_number)` and `(batch_id,capture_order)`. A partial unique index permits only one running session per batch; the runtime also serializes the physical scanner globally.
- `pages.replaced_by_page_id` is a self-FK to the retained replacement candidate. Revision `metadata` records candidate/session provenance as JSON, not additional FK columns.
- `audit_logs.entity_id` is a polymorphic identifier, **not** a foreign key to every possible entity table. Actor and batch can be NULL for system/global events.
- Original provenance is protected by a trigger. Soft deletion excludes a batch from normal access without deleting children or files. `page_revisions` does not imply that every rotation is a new image file.

## 3. OCR, metadata and QC

```mermaid
erDiagram
    archive_batches ||--o{ ocr_jobs : queues
    ocr_jobs ||--o{ page_ocr_results : snapshots
    pages ||--o{ page_ocr_results : recognized_as
    page_ocr_results o|--o{ page_ocr_results : exact_result_reuse
    ocr_jobs ||--o| document_metadata : historical_extraction
    users ||--o{ document_metadata : last_updates
    users o|--o{ ocr_defaults : configures
    documents ||--o{ document_metadata_revisions : retains
    users o|--o{ document_metadata_revisions : authors
    documents ||--o{ qc_reviews : review_cycles
    qc_reviews ||--o{ qc_page_reviews : tracks
    pages ||--o{ qc_page_reviews : reviewed_in
    documents ||--o{ qc_findings : has
    qc_reviews ||--o{ qc_findings : originates
    page_ocr_results ||--o{ ocr_text_corrections : corrected_separately
    users ||--o{ ocr_text_corrections : authors

    ocr_jobs {
        UUID id PK
        UUID batch_id FK
        TEXT status
        TEXT manifest_hash
        TEXT language
        TEXT request_key
        JSONB processing_config
        INTEGER total_pages
        INTEGER processed_pages
        INTEGER failed_pages
        UUID lease_token
        TIMESTAMPTZ lease_expires_at
        INTEGER version
    }
    page_ocr_results {
        UUID id PK
        UUID page_id FK
        UUID batch_id FK
        UUID ocr_job_id FK
        UUID reused_result_id FK
        TEXT image_sha256
        INTEGER image_revision
        TEXT config_hash
        TEXT status
        BOOLEAN is_stale
        TEXT extracted_text
        JSONB structured_result
    }
    ocr_defaults {
        BOOLEAN singleton PK
        TEXT language
        JSONB processing_config
        INTEGER version
        UUID updated_by FK
    }
    document_metadata {
        UUID ocr_job_id PK, FK
        INTEGER extractor_version
        JSONB fields
        JSONB warnings
        INTEGER version
        UUID updated_by FK
    }
    document_metadata_revisions {
        UUID id PK
        UUID document_id FK
        INTEGER version
        JSONB fields
        UUID actor_id FK
        TEXT action
    }
    qc_reviews {
        UUID id PK
        UUID document_id FK
        INTEGER cycle
        UUID claimed_by FK
        TIMESTAMPTZ claim_expires_at
        BOOLEAN ordering_reviewed
        BOOLEAN completeness_reviewed
        BOOLEAN metadata_reviewed
        TEXT ocr_exception
        TEXT outcome
        UUID decided_by FK
        INTEGER reviewed_revision
        JSONB snapshot
    }
    qc_page_reviews {
        UUID review_id PK, FK
        UUID page_id PK, FK
        INTEGER image_revision
        TEXT status
        UUID reviewed_by FK
    }
    qc_findings {
        UUID id PK
        UUID document_id FK
        UUID review_id FK
        UUID_ARRAY page_ids
        TEXT metadata_field_id
        TEXT category
        TEXT severity
        TEXT status
        UUID created_by FK
        UUID resolved_by FK
    }
    ocr_text_corrections {
        UUID id PK
        UUID result_id FK
        TEXT corrected_text
        UUID created_by FK
    }
```

- OCR job identity is unique on `(batch_id,manifest_hash,language,processing_config,request_key)`. Page results use composite job/batch and page/batch FKs, plus unique `(ocr_job_id,page_id)`.
- A successful source result has a partial uniqueness rule on page/checksum/config; reused results reference it. `image_revision` prevents stale generations being presented as current.
- `ocr_defaults` is one Boolean-keyed row, not a UUID entity. Job configuration is a saved snapshot; editing defaults does not alter existing runs.
- `documents.metadata_json.fields` is the authoritative current metadata. `document_metadata` is older per-run history. Neither field candidates nor source bounds are standalone SQL entities.
- Unique `(document_id,version)` protects metadata revisions; unique `(document_id,cycle)` protects review cycles. Metadata revisions and OCR corrections have append-only triggers.
- `UUID_ARRAY` above denotes PostgreSQL `UUID[]`. `qc_findings.page_ids` and `metadata_field_id` are application-validated references, not SQL FKs to pages or a nonexistent metadata-fields table.
- QC snapshots contain ordered public page identities/checksums/revisions, metadata, findings, page-review records and specific OCR result/correction IDs. References inside JSON are not SQL FKs. Future approval/viewer reads must resolve those saved identities rather than silently select the latest text/image.
- Reviewer/creator/resolver user FKs exist even where an extra user edge is omitted to keep the diagram readable.

## 4. Migration ledger and retention

`schema_migrations(name TEXT PRIMARY KEY, sha256 TEXT, applied_at TIMESTAMPTZ)` is maintained by `server/db.mjs`; it has no domain FK. Applied SQL files are checksummed and must never be edited in place.

Database rows describe files; images are not PostgreSQL blobs. Back up PostgreSQL, managed originals/replacements and recovery spools together. Thumbnail/preview derivatives are disposable. See [DATABASE.md](DATABASE.md) for operations and [DFD.md](DFD.md) for data movement.
