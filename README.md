# DigitalArch

Document capture and background OCR for Windows workstations, with a React interface, Node.js backend and PostgreSQL. Supports WIA scanners through NAPS2, a scanner simulator, Indonesian/English Tesseract OCR and optional PaddleOCR. Original PNGs and OCR history are preserved.

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

More details: [database and recovery](DATABASE.md) · [OCR](OCR.md) · [product scope](PRODUCT.md).
