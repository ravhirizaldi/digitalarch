# DigitalArch setup and operations

Detailed installation and operating instructions for Windows + WSL2. For a short project overview, see [README.md](README.md).

**Current source workflow:** capture → OCR/metadata → independent QC → L1 → selected L2, or explicit L1-only publication under the batch's fixed policy. Working roles use one **Documents** menu showing published records only. Viewers register at `/register`, wait for administrator approval and use `/library` with image-only PDF downloads and separate audits. Apply migrations through **017** before loading the updated backend (017 is applied locally). See [APPROVAL.md](APPROVAL.md) and [VIEWER.md](VIEWER.md); these changes remain runtime-unverified. Reload/sign in again to refresh administrator navigation permissions. Registration is viewport-contained with a compact two-column form, not a scrolling document.

## Documentation map

| Document                                       | Purpose                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [DND.md](DND.md)                               | As-built design/development handoff, architecture, lifecycle, module/API map and reusable UI contracts  |
| [ERD.md](ERD.md)                               | Mermaid entity relationships for security, capture, OCR, metadata and QC; actual versus JSON references |
| [DFD.md](DFD.md)                               | Mermaid data flows, trust boundaries and capture-to-QC sequence                                         |
| [APPROVAL.md](APPROVAL.md)                     | Approval policy, decisions, Documents access and printable QR confirmations                             |
| [VIEWER.md](VIEWER.md)                         | Viewer registration/approval, list/grid tabs, image-only PDFs, transfer progress and four audit tables  |
| [PRODUCT.md](PRODUCT.md)                       | Product scope, operational constraints and remaining work                                               |
| [DESIGN.md](DESIGN.md)                         | Compact workstation visual rules, shared components and navigation behavior                             |
| [DATABASE.md](DATABASE.md)                     | Schema inventory, migrations, permissions, storage, backups and recovery                                |
| [OCR.md](OCR.md)                               | OCR engines/settings, queue/result identity and historical accuracy evidence                            |
| [QC.md](QC.md)                                 | Operator/QC workflow, metadata verification, rework and pass guards                                     |
| [ENGINEERING_REPORT.md](ENGINEERING_REPORT.md) | Delivery history and verification evidence, with checkpoint limitations                                 |
| [AGENTS.md](AGENTS.md)                         | Agent verification approval boundaries                                                                  |

Diagrams use fenced `mermaid` blocks with standard ER, flowchart, sequence and state syntax, suitable for Mermaid-capable Markdown such as GitHub. No diagram service, plugin or generated image is required. Source/schema descriptions are distinguished from proposed features and from earlier runtime verification.

## Run on Windows + WSL2

### 1. Install prerequisites

On **Windows**:

- Install WSL2 with Ubuntu (`wsl --install` from an administrator PowerShell), then restart if prompted.
- Install Docker Desktop and enable **Settings → Resources → WSL Integration** for Ubuntu.
- For real scanning and Tesseract OCR, install the **.NET 8 Desktop Runtime (x64)** and **NAPS2**. Install your scanner's Windows **WIA driver** for real scanning.
- In NAPS2, install the **Best Indonesian and English Tesseract language data**. The default paths are shown in `.env.example`; override them if your installation differs.

Inside **Ubuntu/WSL2**:

- Install Git, **Node.js 22+**, **pnpm 10**, and the **.NET 8 SDK** (needed to build the Windows helpers).
- Keep Windows interoperability enabled: the backend calls Windows PowerShell from WSL2.
- Ensure a compatible PostgreSQL 16 + pgvector image is available locally. Compose deliberately never pulls images; on a new workstation, provision an image yourself, for example `docker pull pgvector/pgvector:pg16-bookworm`.

The application runs in WSL2; Windows runs the scanner/Tesseract helpers. Simulator capture does not need Windows drivers or .NET, but completing a simulated batch still queues OCR.

### 2. Configure and start

Run these commands in **Ubuntu/WSL2**, preferably in its Linux filesystem rather than `/mnt/c`:

```sh
git clone https://github.com/ravhirizaldi/digitalarch.git
cd digitalarch
pnpm install --frozen-lockfile
cp .env.example .env  # New installations only; never overwrite an existing .env.
```

Edit `.env`: replace `POSTGRES_PASSWORD` with a strong random secret, confirm `PGVECTOR_IMAGE` matches your local image, and choose an unused `POSTGRES_HOST_PORT`. Generate a password with `openssl rand -hex 32` if needed. Do not commit `.env`.

```sh
pnpm db:up
pnpm db:status
pnpm db:migrate
pnpm admin:bootstrap
pnpm dev
```

Open **http://localhost:3000** in your Windows browser. Bootstrap prints a temporary administrator password once; sign in and change it. Create an **Operator** account in Users, or explicitly add the Operator role to your administrator account, to capture documents. User creation/reset offers a generated or manually set temporary password; both require a first-sign-in change. Select users for bulk reset (one shared manual password or separate generated passwords) or confirmed deletion. Deletion revokes access and hides accounts, but retains ownership/history and reserves their usernames; reassign their unfinished work if needed.

Use **Capture Workspace → Scan New Batch**, choose Simulator or Real Hardware, capture pages, then **Complete Capture** to queue OCR. The Windows helpers build/install automatically on first use:

- **DigitalArch Service** (`DigitalArch.Service/`): scanner and NAPS2 integration; a console helper, not a registered Windows service.
- **DigitalArch OCR** (`DigitalArch.Ocr/`): Tesseract command adapter.

Helper installation lives under `%LOCALAPPDATA%\DigitalArch\DigitalArch.Service`; existing scan spools remain under `%LOCALAPPDATA%\DigitalArch\scans`.

While acquisition runs, the operator sees a blocking progress dialog with the saved-page count and **Cancel scan** as its only action. No guessed `1/N` or percentage is shown for an unknown feeder total. Cancellation retains finished pages, waits for the helper to settle and registers its output before unlocking the workspace. A cancellation during preparation is queued until the session can be safely identified, or prevents starting capture if the request has not been sent. Reload/other tabs recover the operator-scoped lock through scanner status; backend mutation guards also prevent bypasses. Browser/OS closing cannot be prohibited, so a before-unload warning is used. A real scanner may still need manual feeder/jam attention after helper cancellation; check it and Refresh before another session. The cancelled session is **interrupted**, not a cancelled/deleted batch, and needs the usual acknowledgement before Complete Capture.

An unconfirmed Windows process stop keeps capture locked and file registration active, with a recovery error shown in the dialog. An administrator must verify the helper/device is no longer acquiring before restarting the backend; do not treat a Cancel click or backend restart as proof that the physical scanner stopped.

#### Scanner/profile discovery

No scanner brand, model or device ID is built into selection. Real Hardware discovers WIA devices and reads profiles from both `%APPDATA%\NAPS2\profiles.xml` and `%PROGRAMDATA%\NAPS2\profiles.xml` for the Windows identity running the helper. For portable/custom NAPS2 installations, set `DIGITALARCH_NAPS2_PROFILES` to the full **Windows** path of the desired `profiles.xml`; that explicit file replaces the standard discovery locations. Other Windows accounts' private profiles are not enumerated.

Initial selection prefers a single native default, otherwise a single compatible matching profile. Multiple defaults/profiles/devices require explicit selection; an unrelated first scanner is never selected. Without native profiles, the device-neutral **WIA feeder (application defaults)** profile uses Letter/300 dpi/color/right alignment. These are application settings, not detected device settings; no brand-specific driver fallback exists. Existing native profiles are read-only. All parsed profiles remain visible, but TWAIN, unsupported schema/processing/source/size options and duplicate profile names are marked unsupported rather than silently approximated.

While Real Hardware status is being viewed, discovery refreshes automatically about every 30 seconds, without scanning. **Scanner settings → Last detected changes** shows additions/removals and changed profile settings; profile notes show source files, native defaults and unsupported reasons. The selected profile remains pinned even if NAPS2's default changes. Removed/renamed profiles require reselection. Stable profile IDs survive list reordering and settings edits; revisions detect edits. Capture checks selection again before creating a session and pins the revision/device through the Windows scan call, refusing intervening changes instead of silently capturing with new settings. Automatic refresh never runs during acquisition and never clears a scan-failure latch; explicitly Refresh after clearing a jam. Detection is not proof of paper availability or physical readiness.

The existing source fingerprint rebuilds/copies helper changes on its next preparation after a backend restart; profile XML changes need no rebuild/restart. No Windows service registration, schema migration or extra process is introduced. Discovery and physical behavior for this update remain unverified; tests were added/updated but not run.

Create separate QC, L1 and L2 accounts for approval work. **Settings → Approval policy** controls whether future first QC passes require L2 and edits the two role display names. Each batch keeps its first-pass policy through rework. L1 selects L2; the selected officer must sign in and confirm. Operators receive confirmation notices with **View / print QR**; receipts remain in document history after dismissal. QR links use the local application origin: a phone scanning a localhost URL cannot verify against this workstation. No remote/public endpoint is added.

### 3. OCR settings

Administrators can change global engine, languages, preprocessing, Tesseract layout/PSM and PaddleOCR CPU-thread settings in **Settings**. Changes affect future runs only; originals and earlier results stay intact. Tesseract is the initial default and page concurrency remains 1.

Optional PaddleOCR setup requires Python 3.12 with venv support in WSL2:

```sh
pnpm ocr:paddle:setup
```

This downloads a project-local CPU runtime and PP-OCRv6 Small models (roughly 1.4 GiB installed). Select PaddleOCR in Settings after setup. See [OCR.md](OCR.md) for resource requirements and engine details.

## Document metadata and QC

One batch is one logical document, even across multiple feeder sessions. Open **Prepare document** to enter optional metadata. **Complete Capture** queues OCR and opens preparation; it does not submit to QC. After OCR finishes, optionally edit metadata/pages or skip editing, then explicitly **Send to QC**. QC must claim before corrections. Returned work requires capture completion/OCR and a separate **Resubmit to QC**. Suggestions never overwrite human values. Apply all migrations through 016 before starting the updated backend; subsequent L1/L2 decisions and Documents are described in [APPROVAL.md](APPROVAL.md).

An independent QC Officer opens **QC Queue**, claims a document, checks pages/order/completeness, verifies metadata and saves findings. Claims expire after 30 minutes without renewal. **Return to Operator** reopens the same batch for corrections, insertion or confirmed page replacement; **Resubmit to QC** creates a new review cycle. **Pass QC** locks the reviewed revision at **Awaiting Approval Level 1**, not final approval or publication. OCR-run metadata is read-only history; current values belong to the document.

Run `pnpm db:migrate` **before** running updated backend code. Migration 010 adds QC; 011 adopts the latest saved run metadata while retaining historical rows and newer document edits. Back up PostgreSQL and managed files together before upgrading. See [QC workflow and recovery](QC.md).

## Useful commands

| Command                           | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| `pnpm dev`                        | Development server with automatic reload |
| `pnpm build` then `pnpm start`    | Production build and local server        |
| `pnpm db:migrate`                 | Apply database migrations                |
| `pnpm db:down`                    | Stop the database; retain its volume     |
| `pnpm lint` / `pnpm format:check` | Static checks                            |

Run only one backend per database/scanner; do not run dev and production together. OCR tests/benchmarks (including `pnpm test`), browser tests and physical scans require explicit user approval before an agent runs them.

## Storage and deployment

- PostgreSQL stores accounts, batches, queue state and audit history. `.local/managed` stores original images; `.local` and `.env` are excluded from Git.
- Back up the database volume, managed originals and recovery spools together. `pnpm db:down` does not delete the database volume.
- The app and database bind to loopback. This is a local-workstation application, **not a hardened internet-facing deployment**.
- NAPS2, Tesseract and PaddleOCR are separate third-party components with their own licenses; local runtimes/models and private scans are not bundled in this repository.

More details: [database and recovery](DATABASE.md) · [OCR](OCR.md) · [QC](QC.md) · [product scope](PRODUCT.md) · [engineering report](ENGINEERING_REPORT.md).
