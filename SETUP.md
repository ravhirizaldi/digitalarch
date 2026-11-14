# DigitalArch setup and operations

Detailed installation and operating instructions for Windows + WSL2. For a short project overview, see [README.md](README.md).

**Current boundary:** capture → OCR/metadata → independent QC → locked **Awaiting Approval Level 1**. Approval Levels 1/2 and the basic authenticated archive viewer are the remaining planned workflow, not implemented features. Their proposed scope and decisions to confirm are in [APPROVAL.md](APPROVAL.md).

## Documentation map

| Document                                       | Purpose                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [DND.md](DND.md)                               | As-built design/development handoff, architecture, lifecycle, module/API map and reusable UI contracts  |
| [ERD.md](ERD.md)                               | Mermaid entity relationships for security, capture, OCR, metadata and QC; actual versus JSON references |
| [DFD.md](DFD.md)                               | Mermaid data flows, trust boundaries and capture-to-QC sequence                                         |
| [APPROVAL.md](APPROVAL.md)                     | Proposed minimal L1/L2 approval and read-only viewer plan; not implemented                              |
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

Open **http://localhost:3000** in your Windows browser. Bootstrap prints a temporary administrator password once; sign in and change it. Create an **Operator** account in Users, or explicitly add the Operator role to your administrator account, to capture documents.

Use **Capture Workspace → Scan New Batch**, choose Simulator or Real Hardware, capture pages, then **Complete Capture** to queue OCR. The Windows helpers build/install automatically on first use:

- **DigitalArch Service** (`DigitalArch.Service/`): scanner and NAPS2 integration; a console helper, not a registered Windows service.
- **DigitalArch OCR** (`DigitalArch.Ocr/`): Tesseract command adapter.

Helper installation lives under `%LOCALAPPDATA%\DigitalArch\DigitalArch.Service`; existing scan spools remain under `%LOCALAPPDATA%\DigitalArch\scans`.

### 3. OCR settings

Administrators can change global engine, languages, preprocessing, Tesseract layout/PSM and PaddleOCR CPU-thread settings in **Settings**. Changes affect future runs only; originals and earlier results stay intact. Tesseract is the initial default and page concurrency remains 1.

Optional PaddleOCR setup requires Python 3.12 with venv support in WSL2:

```sh
pnpm ocr:paddle:setup
```

This downloads a project-local CPU runtime and PP-OCRv6 Small models (roughly 1.4 GiB installed). Select PaddleOCR in Settings after setup. See [OCR.md](OCR.md) for resource requirements and engine details.

## Document metadata and QC

One batch is one logical document, even across multiple feeder sessions. Open **Document / Metadata / QC** from capture to enter optional metadata before OCR. **Complete Capture** queues the existing OCR worker and prepares a QC review; metadata extraction adds rule-based suggestions without overwriting human values.

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
