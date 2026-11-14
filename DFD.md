# Data flow diagrams

**As-built baseline: 2026-11-14.** These Mermaid diagrams describe implemented capture/OCR/QC flows. They are source-derived documentation, not evidence that a new scan or inference was run. [APPROVAL.md](APPROVAL.md) contains the separate planned extension.

## 1. System context

```mermaid
flowchart LR
    Operator["Operator"]
    QC["Independent QC Officer"]
    Admin["System Administrator"]
    App["DigitalArch local workstation"]
    Scanner["Windows WIA scanner and driver"]
    Recognition["Local Tesseract or PaddleOCR runtime"]
    Backup["Authorized backup operator"]

    Operator -->|capture commands and metadata corrections| App
    App -->|pages, session outcomes and rework findings| Operator
    QC -->|claims, verification, findings and decisions| App
    App -->|authorized pages, metadata and OCR history| QC
    Admin -->|accounts, assignments, settings and claim release| App
    App -->|audit and operational status| Admin
    App -->|explicit user-initiated capture| Scanner
    Scanner -->|PNG output and device outcomes| App
    App -->|saved image and OCR configuration| Recognition
    Recognition -->|text, bounds, errors and timing| App
    App -->|database, managed assets and recovery spools| Backup
```

Administrator is oversight, not inherited capture/QC/approval authority. Approval and Archive Viewer roles are not drawn as live flows because their screens/APIs are not implemented. Backups are an operational responsibility, not a built-in automated backup service.

## 2. Processes and stores

All database stores below are logical groups in the **same PostgreSQL database**, not separate services. Files remain local and authenticated access passes through Node.

```mermaid
flowchart TB
    Browser["Authenticated browser"]
    P1["1. Session and permission checks"]
    P2["2. Capture allocation and reconciliation"]
    P3["3. OCR queue and leased worker"]
    P4["4. Metadata extraction and verification"]
    P5["5. QC review and decision"]
    P6["6. Authorized preview and history reads"]
    Provider["Simulator or Windows capture provider"]
    Engine["Selected local OCR engine"]
    D1[("Accounts, roles and auth sessions")]
    D2[("Batches, documents, sessions and pages")]
    D3[("OCR defaults, jobs and page results")]
    D4[("Metadata revisions, QC reviews and corrections")]
    D5[("Append-only audit records")]
    F1[("Retained provider spool")]
    F2[("Managed originals and replacement images")]
    F3[("Disposable previews and thumbnails")]

    Browser -->|same-origin requests| P1
    P1 <--> D1
    P1 --> P2
    P1 --> P4
    P1 --> P5
    P1 --> P6
    P2 <--> D2
    P2 -->|persist session before feeding| Provider
    Provider --> F1
    F1 -->|complete PNGs| P2
    P2 -->|decode, fingerprint and finalize| F2
    P2 -->|atomic completion and enqueue| D3
    D3 <--> P3
    F2 -->|validated image or temporary derivative| P3
    P3 <--> Engine
    P3 -->|terminal result readiness| P4
    P4 <--> D2
    P4 <--> D4
    D3 -->|saved OCR and exact reuse references| P4
    D2 --> P5
    D3 --> P5
    P5 <--> D4
    P5 -->|workflow state and version| D2
    P5 -->|integrity validation| F2
    P2 --> D5
    P3 --> D5
    P4 --> D5
    P5 --> D5
    D2 --> P6
    D3 --> P6
    D4 --> P6
    F2 --> P6
    P6 <--> F3
    P6 -->|scoped JSON and image responses| Browser
```

### Data handling rules

- Persist batch/document/session identity before acquisition. Reconciliation registers valid PNGs idempotently; a failed transaction does not discard its spool or managed original.
- Original checksums and capture provenance are immutable. Replacements switch the active reference only after confirmation; old/candidate images remain retained.
- OCR reads the effective image snapshot, not an unversioned arbitrary upload. Temporary preparation never overwrites originals. Result commits are fenced by the job lease and retain engine/configuration identity.
- Extraction combines available current OCR/corrections into candidates. Human metadata remains authoritative; historical per-run metadata is read-only.
- QC reads and changes the same logical document. Return changes workflow/ownership of work, not file identity. Pass freezes a reviewed snapshot and rejects outstanding OCR.
- Audit events are intentionally bounded, but can contain user-entered reasons/notes and identifiers. Treat the audit store as private; do not export it publicly or use it to duplicate document text/secrets.
- Preview derivatives are caches, not source records or backups. The browser never receives raw filesystem paths or database credentials.

## 3. Capture to QC sequence

```mermaid
sequenceDiagram
    participant O as Operator browser
    participant A as Node API
    participant D as PostgreSQL
    participant C as Capture provider
    participant F as Local image storage
    participant W as OCR worker
    participant E as OCR engine
    participant Q as QC browser

    O->>A: Create batch and start feeder session
    A->>D: Validate owner and version and commit session identity
    A->>C: Start selected capture provider
    C->>F: Publish complete PNGs to retained spool
    A->>F: Validate PNG and finalize managed original
    A->>D: Register page and update session counters
    O->>A: Complete Capture with current version
    A->>D: Commit capture completion, review cycle and OCR enqueue
    W->>D: Claim queued work and commit lease
    W->>F: Read validated image snapshot
    W->>E: Recognize outside database transaction
    E-->>W: Text, geometry and processing outcome
    W->>D: Commit page result using live lease token
    A->>D: After terminal OCR, prepare metadata and QC readiness
    Q->>A: Claim document with current version
    A->>D: Check independence and commit exclusive QC claim
    Q->>A: Save review, metadata verification and corrections
    A->>D: Commit versioned data and audit
    Q->>A: Pass QC with current version
    A->>F: Validate included originals and active image hashes
    A->>D: Validate guards and save snapshot awaiting L1 approval
    A-->>Q: Locked reviewed revision
```

The sequence abbreviates multi-page commits, polling, retries and return/resubmission; it does not imply one transaction spans scanning or OCR. Original capture and replacement files remain available after review decisions.

## 4. Trust and privacy boundaries

| Boundary                         | Enforcement / limit                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Browser → API                    | Session cookie, same-origin checks, CSRF on mutations, body validation and server-side permission checks |
| Role → document                  | Assigned-operator checks or explicit QC/oversight permissions; no access inferred from a URL             |
| Capture spool → managed original | Decode, size/pixel limits, checksum, safe paths and exclusive finalization                               |
| Worker → database                | Persistent job lease/token, expiry, image/config identity and versioned results                          |
| QC → decision                    | Live independent claim, version checks, checklist/findings/metadata/OCR/file gates                       |
| Database → image read            | Scoped endpoints; private files are not a publicly served scan directory                                 |
| Workstation → backup             | Preserve database and managed/spool relationships together; no automated restore drill claimed           |

Queue search terms can be present in navigation URLs/history. Private document content, OCR excerpts, account credentials and raw evidence must not be copied into public docs, fixtures or issue logs. Local HTTP/loopback and privileged administrator tamper risks remain; this is not a hardened remote deployment.
