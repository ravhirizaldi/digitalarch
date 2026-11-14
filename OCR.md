# OCR processing and accuracy

For system-wide Mermaid diagrams, see [DND.md](DND.md), [DFD.md](DFD.md) and [ERD.md](ERD.md). OCR remains separate from capture/QC/approval state. The planned [approval and basic viewer](APPROVAL.md) should reuse saved QC/OCR identities, not start new recognition. Existing accuracy/test evidence below is historical; this documentation update ran no inference or benchmark.

## Architecture

Capture completion, the OCR job snapshot and page placeholders commit in the same PostgreSQL transaction. Capture remains `capture_completed` and read-only; `ocr_status` tracks the latest OCR run independently. Pre-feature completed batches have **Send to OCR** in their details. No scans are repeated.

The existing Node backend owns scheduling, authentication, paths, source validation, retries and persistence. Its worker claims a job with `FOR UPDATE SKIP LOCKED` and a UUID lease, commits, then processes one image outside a transaction. Every page result/progress update commits immediately. The .NET helper never connects to PostgreSQL.

The default Tesseract adapter uses the existing WSL → Windows PowerShell → .NET 8 path. An explicit alternative PaddleOCR adapter invokes a project-local Python CPU process from WSL; it does not change the Windows scanner helper. `server/ocr-engines.mjs` selects the adapter from each job's immutable processing configuration, not the current environment, so old jobs still retry with their original engine. Scanner/WIA acquisition and 300-DPI settings are unchanged. Neither engine introduces a queue service, additional database or Docker image.

## Alternative engine: PaddleOCR PP-OCRv6 Small

### Compatibility and installation evidence

Verified before installation on 2026-11-13 against the [official PP-OCRv6 documentation](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.md), [Python pipeline implementation](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_pipelines/ocr.py), [language groups](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_utils/langs.py), PyPI wheel metadata, and official model-archive HTTP headers. **Small is an actual detection/recognition pair**, not the default Medium model renamed. Both names and local directories are passed explicitly:

| Component       | Exact model          | Verified archive bytes | Approximate MiB |
| --------------- | -------------------- | ---------------------- | --------------- |
| Detector        | `PP-OCRv6_small_det` | 10,055,680             | 9.59            |
| Recognizer      | `PP-OCRv6_small_rec` | 21,442,560             | 20.45           |
| Combined models |                      | **31,498,240**         | **30.04**       |

The recognizer supports Indonesian (`id` in Paddle's Latin language group) and English in one multilingual model; DigitalArch retains its existing `ind`, `eng`, `ind+eng` and `eng+ind` API values. Unlike Tesseract, these values do not restrict the multilingual recognizer's output alphabet. The installed-engine check recognizes Indonesian and English literal sentences under `ind`, `eng` and `ind+eng` without translating or repairing them.

Installed runtime: **PaddleOCR 3.7.0, PaddlePaddle 3.3.1 CPU, PaddleX 3.7.2**, Python **3.12.3**, Linux x86-64 under the existing WSL environment. No CUDA package or GPU is used. The CPU Python-3.12 wheel alone is approximately **185.8 MiB**; the complete isolated environment occupies approximately **1.4 GiB on disk**, separate from the 31-MiB extracted models. Model size is not runtime RAM or total installation size. Paddle's base OCR package necessarily brings its upstream dependencies; no `[all]`, document-parser, extra OCR engine or service extras were installed. The complete resolved versions are retained privately in `.local/paddleocr/installed-requirements.txt` and recorded in job metadata.

PaddleOCR [source license](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE) and the official [Small detector](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det) / [Small recognizer](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec) model cards declare **Apache-2.0**, permitting commercial use subject to its terms, notices and disclaimer. This verifies the published code/model license, not the provenance of the upstream training corpus or a legal audit of every transitive wheel. Retain upstream license/NOTICE files with redistributed artifacts.

Explicit setup (not run during job processing):

```sh
pnpm ocr:paddle:setup
pnpm db:migrate
pnpm test:paddle-runtime
```

`scripts/paddle/setup.py` creates `.local/paddleocr/venv`, installs the pinned three runtime packages and downloads only the official Small pair. Archive byte sizes and SHA-256 values are checked before safe extraction. The pinned hashes were measured from these official HTTPS downloads:

- Detection: `bfb7c1e59f0faa6b540ebdca93aea3f4b1f2477805b389fbee117820d68fe9f5`.
- Recognition: `da460f968ce9f88325ac3a34fa302077d6e9b0dcefb16ba3137cd7796f879d06`.

The runner supplies explicit existing model directories and disables model-source discovery. Missing resources fail with a setup instruction; there is no model download or silent Tesseract fallback in the worker. The setup/runner currently target this Linux/WSL workstation, not a second Windows-native Python installation.

### Configuration, result schema and resource limits

**The initial default remains Tesseract.** Engine, languages, profile, PSM, layout and preprocessing defaults now live in PostgreSQL and are edited through the administrator **Settings** menu at `/settings`. Environment values (`OCR_ENGINE`, `OCR_LANGUAGE`, `OCR_PROFILE`, `OCR_PSM` and optional `OCR_PADDLE_CPU_THREADS`) seed the singleton row on its first initialization only; they do not overwrite saved global defaults on restart. Optional trusted deployment paths remain `OCR_PADDLE_PYTHON` and `OCR_PADDLE_MODELS`; requests cannot supply filesystem paths, executable names or arbitrary model URLs. Each job retains its own immutable configuration regardless of subsequent global changes.

In **Settings → OCR defaults**, choose the engine, languages, profile, supported preprocessing steps, Tesseract PSM/layout or PaddleOCR thread budget, then **Save global defaults**. New capture-completion jobs, **Send to OCR** and ordinary **Reprocess** use this saved configuration for every operator. Existing queued/running/paused/completed jobs are not edited, restarted or reprocessed by saving settings. The OCR result view no longer has per-run engine/profile selectors or a “Next run / CPU segmentation” strip. Model and workstation details live in Settings; actual saved engine/model/thread information lives in collapsed Job details. An administrator can open Settings from the main menu or the OCR settings button. Ordinary operators can use the defaults but cannot change them.

`GET/PATCH /api/settings/ocr` require `settings:read` / `settings:manage` respectively; these permissions are granted to System Administrator only. PATCH validates supported settings and the selected runtime/resources before committing, requires the current settings version, and writes `ocr.settings_updated` to the audit log. A stale concurrent save returns 409 instead of overwriting another administrator's changes. `GET /api/ocr/defaults` and `GET /api/ocr/engines` require OCR-read permission; engine availability reads package/model metadata without recognizing a page. Saving a setting does not run an OCR test.

The enqueue/reprocess APIs retain explicit overrides for existing integrations and benchmarks: `engine: "paddleocr"`, optional `model: "PP-OCRv6 Small"`, `cpuThreads: 1|2|4` and existing profile/preprocessing fields. Empty enqueue and `{ "version": <job-version> }` reprocess requests snapshot global defaults, including global languages. Explicit legacy reprocess overrides keep the source job's language. Paddle processing-version-3 jobs retain an implicit one-thread budget; new explicitly budgeted jobs use version 4, including an explicit one-thread choice. Their retained `psm: 3` field is schema compatibility only, **not a Paddle inference setting**; other PSMs and `layout: "regions"` are rejected. Tesseract configurations still do not claim a configurable thread setting. Migrations 007/008 retain old jobs/results and extend only new-job configuration validation/default resolution.

The unified adapter keeps `info(language, signal, config)` and `process(buffer, page, language, signal, config)`. PaddleOCR returns the same extracted text, page bounds, line bounds and timing structure used by Tesseract, plus original quadrilateral polygons and actual recognition confidence. Axis-aligned bounds are derived from each polygon in the full preprocessed image coordinate system, with the existing rotation/deskew transform recorded. This initial integration provides **line boxes**, not guessed word positions: `words: []` and `wordBoundsAvailable: false` explicitly express that limit. It never corrects document numbers, dates, identity numbers or spelling.

One page is passed to one short-lived, low-priority Python process. The initial PaddleOCR CPU budget remains **1 thread**; Settings supports **1, 2 or 4** up to the workstation's available logical CPUs. Paddle inference, BLAS/OpenMP and OpenCV receive the same recorded budget. This is a thread budget, not physical-core pinning or a CPU reservation. **Recognition batch size and page concurrency remain 1**. This workstation reports an Intel i7-8665U, four physical cores/eight logical CPUs, all eight available to WSL without a CPU quota. The Settings page reports live logical CPU availability, model information and system RAM. Higher thread counts have not been promoted as a faster default.

Detector maximum side remains 1,280 pixels internally; originals retain their 300 DPI and dimensions. Optional document orientation, unwarping and line-orientation models remain disabled. Saved rotation and temporary preprocessing still apply. **oneDNN stays disabled** because the previous Paddle 3.3.1 executor failed on this workstation; the thread change does not silently re-enable it or choose a different model.

### Verification approval policy

**Do not run OCR tests, benchmarks or verification inference without explicit user approval for that run.** This includes saved/synthetic pages, mock-only OCR tests and the full `pnpm test` suite. Do not automatically resume a paused benchmark. Lint, formatting, builds and static inspection may proceed without invoking OCR. The thread-comparison CLI supports `--mode=threads` with explicit 1/2/4-thread Enhanced Small variants, but its run was stopped when the user clarified this restriction; incomplete results are not a validated speed comparison. The one-thread initial default remains unchanged. The same policy is recorded in `AGENTS.md`.

Each process is killed on cancellation/page deadline and also has its own Linux alarm if Node exits unexpectedly. Its isolated temporary PNG/result directory is removed after success, failure or timeout. Forced machine/process termination may leave a private `page-*` directory; these are derived inputs, not originals. There is no persistent Paddle service, Redis, Docker image or second queue. Cold imports/model load are included in processing time; peak engine RAM is Linux `ru_maxrss` including imports and model loading, not a claim about total application/process-tree RAM. A small model still requires hundreds of MiB of runtime RAM.

Job identity fingerprints all installed Python distribution versions, the two local models' inference files, the runner/Node preprocessing source and runtime options. Changed versions/weights cannot reuse the old engine identity; historical results remain readable. The existing UUID lease, fencing, bounded retries, pause/resume, short transactions, per-page commits, source checksum revalidation and exact-success cache remain in force. Engine mismatches fail before recognition rather than persisting mislabeled text.

### Reproducible engine comparison

```sh
pnpm ocr:benchmark --mode=engines --job=<retained-job-UUID> \
  --full-references=.local/ocr-benchmarks/engine-full-references.json \
  --field-references=.local/ocr-benchmarks/engine-field-references.json \
  --output=.local/ocr-benchmarks/paddle-tesseract-comparison.json
```

This queues Tesseract Best/standard/PSM-3, the earlier adaptive-region Tesseract candidate, and Small with standard/enhanced/adaptive profiles through the same PostgreSQL worker, concurrency 1. `--variant=<listed-name>` selects one candidate. References remain private, ignored and mode 0600. Global CER and whitespace-token WER count insertions/deletions and preserve case/punctuation except dotted leaders; extra logo noise counts as errors. Private field references map page UUIDs to `{ "documentNumbers": ["literal printed number"], "dates": ["literal printed date"] }`. Field accuracy requires exact, token-bounded matches after whitespace normalization only; substring digits inside a different value do not count. These reference values are measurement inputs only, never application extraction rules or OCR corrections.

The comparison covers all three saved contract PNGs with manually visually checked non-logo printed text, two complete document-number instances and three date instances. Two pages are closely related versions of the same agreement; page 3 has a two-column signing area. CER/WER depend on the reference reading order there. This is a small, single-document-family benchmark with one visual transcription, not a representative Indonesian-document accuracy estimate or independently reviewed legal ground truth. No real scan or browser test is part of this experiment.

#### Measured engine results

The three references total **2,655 normalized characters and 414 whitespace-delimited words**. All five ordinary jobs completed, using identical saved page snapshots:

| Candidate                                | CER                   | WER        | Exact document numbers | Exact dates | Three-page processing | Peak engine RAM |
| ---------------------------------------- | --------------------- | ---------- | ---------------------- | ----------- | --------------------- | --------------- |
| Tesseract Best, standard / PSM 3         | 12.54% (333 errors)   | 22.71%     | 0/2                    | 3/3         | 9.97 s*               | 159.5 MiB*      |
| Tesseract Best, adaptive regions / PSM 6 | 7.46% (198 errors)    | 20.29%     | 1/2                    | 3/3         | 67.92 s               | 152.8 MiB       |
| PaddleOCR Small, standard                | 3.73% (99 errors)     | 23.91%     | 2/2                    | 3/3         | 37.38 s               | 952.4 MiB       |
| PaddleOCR Small, enhanced                | **2.90% (77 errors)** | 17.63%     | 2/2                    | 3/3         | 38.47 s               | 952.3 MiB       |
| PaddleOCR Small, adaptive                | 4.82% (128 errors)    | **12.80%** | 2/2                    | 3/3         | 40.07 s               | 952.1 MiB       |

\* Standard Tesseract reused three exact successful results: its retained processing/RAM measurements are historical, **not fresh timings from this matrix**. The other twelve pages were freshly recognized. Native memory is Windows peak working set for Tesseract versus Linux child `ru_maxrss` for Paddle; neither includes the whole application, and they are not OS-equivalent measurements. Paddle times include a new Python import/model load per page. No total-tree RAM or controlled cross-OS throughput claim is made.

Enhanced Small has the lowest character error rate; adaptive Small has the lowest whitespace-token word error rate. These rankings differ because punctuation/space segmentation and reading order can change multiple word edits without many character edits. Standard Small's WER is actually worse than standard Tesseract despite its lower CER. Preset names do not guarantee that every quality measure improves.

After adding before/after resource fingerprint verification, Python-version metadata and an explicit one-thread OpenCV limit, the selected Enhanced candidate was freshly rerun through the queue. It reproduced **77/2,655 character errors (2.90%)**, **73/414 word errors (17.63%)**, **2/2 document numbers**, **3/3 dates**, and **12/12 exact checked numeric tokens**. Final three-page time was **39.25 s** and native peak RAM **956.9 MiB**. Retained result: `/ocr/jobs/8b125805-e5e2-4f18-bcad-2cf14125b021`. Evidence: `.local/ocr-benchmarks/paddle-tesseract-comparison.json` and `.local/ocr-benchmarks/paddle-final-verification.json` (both mode 0600). All three original PNG checksums, source-job text and the retained legacy Fast job were verified unchanged.

**Decision: keep Tesseract as the production default.** Small demonstrates a real character/document-number improvement on this sample, but still has errors, has materially higher RAM use (approximately 0.94 GiB native peak), and lacks validation on unrelated layouts/documents. It is available for explicit operator comparisons, not silently substituted or automatically promoted.

#### Alternative-engine verification

- `pnpm test`: **67 passed, 0 failed**, including engine-specific snapshots/labels, switching back to exact cached Tesseract history, ownership, engine-catalog permissions, missing-resource failures, geometry/schema checks, CER/WER/field scoring and the existing queue/recovery/scanner tests.
- `pnpm test:paddle-runtime`: **1 passed**, with actual Small CPU recognition under Indonesian/English/bilingual job languages, exact synthetic text, model/configuration identity, corrected rotation, original-buffer integrity, bounded boxes and cancellation.
- `pnpm test:ocr-runtime`: **1 passed** using the unchanged installed NAPS2/Tesseract engine and Simulator-to-PostgreSQL persistence.
- An installed-engine timeout self-check deliberately used a one-second page deadline, asserted rejection, waited for child termination, and verified removal of the temporary page directory.
- `pnpm test:profiles`: **26 assertions passed**, without WIA/hardware operations. `pnpm lint`, `pnpm format:check`, `pnpm build` passed; build retains existing third-party warnings. Static UI detector reported no findings.
- Migration 007 was applied without resetting accounts, batches, files or PostgreSQL storage. The live adapter catalog reports `defaultEngine: "tesseract"` and the installed Small alternative available. Source/checksum/history and private-file-mode checks passed.
- Browser/layout execution, new physical scans and unrelated-document accuracy validation were intentionally not performed. The existing .NET helper source was not changed or replaced.

## Exact SDK and executable integration

The installed package is **NAPS2.Sdk 1.6.0**, with assembly identity `NAPS2.Sdk, Version=8.6.0.0`. APIs were inspected from the installed assembly and compiled/executed, not guessed:

```csharp
TesseractOcrEngine.Custom(string executable, string languageDataPath)
Task<OcrResult?> ProcessImage(ScanningContext context, string imagePath,
    OcrParams parameters, CancellationToken cancellationToken)
new OcrParams(string languageCode, OcrMode mode, double timeoutInSeconds)
```

`OcrResult.PageBounds`, `.Lines`, `.Words` and `OcrResultElement.Text`, `.Bounds`, `.Children`, `.LanguageCode`, `.RightToLeft`, `.Baseline`, `.FontSize` provide text and structured bounds. Plain text joins recognized lines. No confidence score is exposed by this result API, so none is invented.

**PSM is not an `OcrParams` property.** `DigitalArch.Ocr/` is a small framework-dependent Windows .NET 8 executable used through the SDK's supported custom-executable hook. It forwards the SDK's hOCR invocation to the same installed Tesseract with its verified `--psm 3|4|6` and `--dpi 300` CLI options. NAPS2 still parses hOCR into its normal OCR result. The adapter does not recognize text itself, parse documents, access the database or invoke the scanner. Its apphost uses the normal .NET Windows target pack, not another OCR framework. No new NuGet application dependency was added.

The Windows wrapper enforces the timeout and kills the entire helper → adapter → Tesseract tree. SDK-local timeout/cancellation is disabled for adapter invocations because terminating only the adapter could orphan its native child. Node graceful shutdown signals the wrapper through a private cancellation marker; forced crashes leave the wrapper's independent timeout in place. Legacy direct invocations retain the SDK timeout behavior.

Tesseract/native OCR and the helper run at **BelowNormal** priority. `OCR_PRIORITY` accepts `low` only. No unsupported thread/priority SDK setting or invented environment variable is passed to Tesseract.

## Resources and language verification

The installed engine is **Tesseract 5.5.1**, at:

```text
C:\Program Files\NAPS2\lib\_win64\tesseract.exe
%APPDATA%\NAPS2\components\tesseract4\best\ind.traineddata
%APPDATA%\NAPS2\components\tesseract4\best\eng.traineddata
```

Both Best resources already existed and were exercised through NAPS2. New profiles use **tessdata_best**, never silently substituting Fast or English-only data. `OCR_TESSDATA_PATH`, when set, names the **parent directory containing `best/` and `fast/`**, not the old `fast` directory itself. `OCR_TESSERACT_PATH` is a trusted Windows executable path. Browser requests cannot supply either.

Verified Best SHA-256 values:

| Language | SHA-256                                                            |
| -------- | ------------------------------------------------------------------ |
| `ind`    | `45adaade8715f553c108334f603f24e4bc902fc6763892b5a9245afe230c82b4` |
| `eng`    | `daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047` |

Legacy Fast results remain stored and explicitly identified as legacy. Missing/empty required language data produces a job-level failure with the missing language named; no English fallback occurs. New workstations must install the matching resources through NAPS2. No OCR models or Docker images were downloaded for this implementation.

## Profiles and preprocessing

| Profile         | Language data             | Temporary-image processing                                                              |
| --------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `standard`      | Best Indonesian + English | Retain source pixels; apply only persisted quarter-turn rotation and 300-DPI metadata   |
| `enhanced`      | Best Indonesian + English | Grayscale, percentile contrast normalization, bounded deskew and light median denoising |
| `high-accuracy` | Best Indonesian + English | Enhanced processing plus optional adaptive thresholding                                 |

The profile name is a processing preset, **not a guarantee of higher recognition accuracy**. Adaptive thresholding can damage faint strokes/logos; the benchmark determines whether it helps a particular scan. Individual preprocessing flags can be disabled/enabled when queueing/reprocessing.

Implementation details, recorded under pipeline version 1:

- Existing Sharp/libvips performs grayscale, 1st–99th percentile contrast normalization and a light 3×3 median filter.
- Deskew estimates a correction from a reduced grayscale analysis image using horizontal projection variance. It searches only ±3°, applies a correction only above a 5% score gain and a 0.15° minimum, and rotates a full-size temporary image against white. It does not resample the original to a higher DPI or attempt 90° orientation detection.
- Adaptive thresholding uses a 31×31 local-mean window with a 0.88 factor. A sliding-column algorithm avoids a full-image integral table.
- Pixel analysis/thresholding runs in Node worker threads, not on the HTTP event loop. Only the current image is loaded; there is no batch image preload.
- Full-resolution PNGs are kept at their existing pixel resolution. 300 DPI remains the default metadata/recognition setting; scanner resolution is unchanged.

Input PNGs are read through managed storage, checked for readability, nonzero/bounded size, PNG decoding and exact SHA-256. The original is copied into a unique Windows staging directory and never overwritten. All derived images/hOCR/metrics are private temporary files removed in `finally`. Abandoned staging directories older than one hour are removed only within the helper's dedicated `ocr-temp/page-*` namespace; originals/spools are not cleanup targets.

Bounds are in **OCR-input image pixels**, not automatically source pixels after deskew/rotation. The recorded transform explains the coordinate space; highlighting/mapping back to original coordinates is not implemented.

## Persistent identity, history and recovery

Migrations:

- `004_ocr_processing.sql`: OCR jobs/results, permissions, leases, source identity, stale-result handling and queue function.
- `005_ocr_revision_generation.sql`: monotonic page-image generation and one-processing-page-per-job constraint.
- `006_ocr_profiles.sql`: per-job profile/PSM/preprocessing snapshots and idempotent reprocessing request identity. Existing results become explicit legacy configurations, without rewriting their text.
- `007_ocr_engines.sql`: explicit Small configuration validation and insert-only engine labels; historical Tesseract rows/hashes are retained.

`ocr_jobs` links to the existing batch. `page_ocr_results` has composite page/job/batch foreign keys, source checksum/revision, engine/version/configuration identity, text, JSON line/word bounds, timing, attempts and errors. Successful raw result identities have a partial unique index. An exact source/configuration reuse references the existing successful result instead of duplicating extracted text.

Identity covers source SHA-256, language codes/file hashes, Tesseract version and binary hash, adapter binary hash, SDK, profile/PSM, preprocessing/version, Sharp/libvips versions and persisted rotation. A mid-job engine/resource change fails visibly instead of mixing configurations. Explicit **Reprocess** creates a new run; old results and PNGs remain. Repeated requests for the same source job/configuration are idempotent. Reprocessing an unchanged successful identity can reuse its exact stored result.

Replacing a page through the existing recorded-revision schema marks old results stale, increments the page image generation and queues the current revision. Returning to identical old bytes still creates a current snapshot; exact recognition can be reused safely. There is no page replacement/QC interface in this phase. Current-text and historical-source APIs do not substitute a newer image for an older run.

Job states:

| State                   | Meaning                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `queued`                | Pending work, eligible when retry delay expires                 |
| `running`               | One claimed page/initialization step                            |
| `paused`                | Explicit pause; any already-started page may finish and persist |
| `completed`             | Every page reached successful terminal state                    |
| `completed_with_errors` | All pages terminal, at least one permanently failed             |
| `failed`                | Job-level initialization/persistence/configuration failure      |
| `cancelled`             | Explicitly cancelled while queued; existing text retained       |

Default concurrency remains **1**. A separate lease/UUID fences every result commit. Heartbeats renew live claims, and the lease is longer than the bounded Windows helper lifetime. Interrupted claims recover after expiry; old tokens cannot overwrite a newer claim. Graceful shutdown aborts the helper tree and returns the interrupted page to the queue without charging a failed OCR attempt. Default transient retry budget is three attempts with bounded exponential delay; permanent missing/corrupt/checksum errors fail immediately. One failed page never stops other pages.

Pause/resume and retry controls keep their original behavior. Explicit retry resets failed page budgets only; successful text is retained. Queued cancellation requires confirmation and never deletes extracted text or files. The single existing runtime/advisory lock still protects the scanner/application.

## Configuration and APIs

```text
OCR_WORKER_CONCURRENCY=1
OCR_LANGUAGE=ind+eng
OCR_PRIORITY=low
OCR_PROFILE=standard
OCR_PSM=3
OCR_TIMEOUT_SECONDS=120
OCR_MAX_ATTEMPTS=3
```

Higher concurrency is rejected in this accuracy-focused phase. PSM accepts only 3, 4, 6; language accepts `ind`, `eng`, `ind+eng`, `eng+ind`, with `ind+eng` the production default. The single-language values allow independent recognition checks.

- `GET /api/ocr/jobs` — paginated owned jobs, optional status filter and overview counts.
- `GET /api/ocr/jobs/:id` — job identity, counters, configuration, engine, timestamps and current page.
- `GET /api/ocr/jobs/:id/pages` — paginated page text/status/error/structured results.
- `GET /api/ocr/jobs/:id/pages/:pageId/image|preview` — authenticated historical source corresponding to that run.
- `GET /api/pages/:id/ocr` — current, non-stale result; validates managed source checksum.
- `POST /api/batches/:id/ocr` — queue a completed capture, including pre-feature captures. Optional `profile`, numeric `psm`, `preprocessing` flags.
- `POST /api/ocr/jobs/:id/pause|resume|cancel|retry-failed` — `{version}`.
- `POST /api/ocr/jobs/:id/reprocess` — `{version, profile, psm, preprocessing?}`; new history-preserving run.

Preprocessing accepts boolean `grayscale`, `contrast`, `deskew`, `denoise`, `adaptiveThreshold` only. Executables, paths, arbitrary command arguments and arbitrary preprocessing code are never accepted from the browser. All endpoints require authentication and OCR permissions; assigned operators are ownership-bound, and administrator read/manage-all is explicitly granted. Mutations require existing same-origin/CSRF protection. Audit/logs never contain document text or credentials.

## Benchmark mode

With the normal backend running:

```sh
pnpm ocr:benchmark --job=<existing-job-UUID> --output=.local/ocr-benchmarks/comparison.json
```

The CLI enqueues nine persistent runs: three profiles × PSM 3/4/6, all using the same current batch image snapshots. The **existing worker** processes them sequentially at concurrency 1; the CLI does not launch a competing OCR process. Results remain available in OCR Processing. The local JSON report is created exclusively with mode 0600 and contains private extracted text; stdout prints only numeric/status summaries. Do not publish it.

Optional `--references=<private-JSON-path>` maps page UUIDs to manually transcribed excerpts. The report measures normalized excerpt character errors using semi-global edit distance. It is **not whole-page CER**. Without references it reports text differences/timing/memory, not an invented accuracy score. Reused exact results are labelled and retain their original processing measurements rather than pretending to be fresh speed tests.

Time is measured per-page Node pipeline wall time, with preprocessing and engine durations separately recorded. Memory is Windows Tesseract peak working set sampled every 25 ms plus Node RSS before/after. These are **not total process-tree peak memory**. Queue wait time is not OCR processing time. A cancelled/paused benchmark job remains an ordinary persisted job; stopping the CLI does not silently cancel background work.

## Verification and limits

### Opt-in region-based processing

`POST /api/ocr/jobs/:id/reprocess` and `POST /api/batches/:id/ocr` now accept `layout: "regions"`. The three existing profiles remain available; no document template, company name, field value, fixed crop coordinates or corrected identity number is built into recognition. Ordinary jobs keep their existing whole-page default and identity. Region/line-cleanup requests snapshot processing version 2 using the existing JSONB job configuration; no database-architecture change or new migration is needed.

Region detection analyzes grayscale image geometry at a bounded preview size: text-row bands, whitespace, a possible letterhead separator and large header graphics. Header text is processed separately from body paragraphs; detected header graphics are masked only on disposable OCR input. Recognition uses the same verified NAPS2/Tesseract calls and selected PSM, sequentially, with white padding around each crop. Line/word bounds are translated back into the full OCR-input coordinate system. Region bounds, ignored-graphic bounds and fallback state/reason are recorded with each result. No extracted words/numbers are post-corrected from a dictionary or supplied reference transcript.

Conservative guards fall back to the entire page for detected multiple columns, strongly ruled layouts, landscape pages, significant edge content, absent text bands or more than 24 regions. Fallback preserves the chosen PSM; it does not claim to understand every table. These are heuristics, not universal document understanding. Tests cover an unrelated letterhead, body/footer text, two-column pages, ruled forms, landscape and edge content. Only the user's supplied document has real-scan accuracy evidence. Processing-version-2 results also fingerprint the Node preprocessing/layout source files, so an implementation change cannot silently reuse an old experimental recognition identity.

`preprocessing.lineRemoval: true` is an **experimental, opt-in** test of thin diagonal-pen removal. A bounded Hough-style search requires long geometric support, excludes near-vertical strokes and retains thick intersections. Only a derived grayscale image is changed, and removed-pixel counts/line geometry are recorded. It cannot restore characters hidden by ink and can still remove real thin strokes. It is never enabled globally just because it helps one sample.

Example explicit reprocessing payload:

```json
{
  "version": 12,
  "profile": "standard",
  "psm": 6,
  "layout": "regions"
}
```

Use the job's actual version rather than copying the example value. Existing UI profile controls still queue normal whole-page runs; region/line-removal settings are currently exposed through these API fields and benchmark CLI, not a separate layout editor.

Full-page evaluation:

```sh
pnpm ocr:benchmark --mode=layout --job=<existing-job-UUID> \
  --full-references=.local/ocr-benchmarks/private-reference.json \
  --output=.local/ocr-benchmarks/layout-comparison.json
```

This compares region PSM 3/6, processing without median denoising, adaptive thresholding and optional line removal through ordinary jobs at concurrency 1. The private reference file maps page UUIDs to `{ "text": "manually transcribed page", "exactValues": ["literal digit token"] }`. Full-page CER uses **global** edit distance, so omitted text and extra header/footer noise count as errors. Only whitespace and visually ambiguous dotted leaders are normalized. Exact numeric-token matches are counted separately; values are never fed into the OCR engine or used to repair its output. Unreferenced pages have no claimed accuracy score. This supplements, rather than rebrands, the earlier limited-excerpt benchmark.

Use `--variant=regions-adaptive-6` (or another listed variant name) to verify one candidate rather than enqueueing the entire matrix. Every run still uses ordinary persisted jobs and the same single worker. Region processing is bounded by the page timeout; a region failure rejects the partial page rather than persisting a mixture of successful and missing crops.

The user's current three-page sample and a manually transcribed page-1 reference are evaluation data only. They remain in ignored, mode-0600 local files; neither the reference text nor document-specific geometry is an application rule. No corpus-wide claim or default switch is justified from this one document.

#### Full-page sample results

The current source job is `3fa23264-fb6c-4f56-b50f-378eccf00a30`. The manually transcribed reference covers **1,064 normalized characters of page-1 non-logo printed text**, including header labels, title, all body paragraphs/details and footer. Decorative logo monograms/pen strokes are not reference text; spurious OCR from them still counts as insertion errors. Identity-number strings are transcribed exactly as visibly printed—even when their length looks unusual—never padded or repaired to fit an expected format. This is one visual transcription, not an independently double-reviewed legal transcript.

| Candidate                                  | Page-1 character errors | Full-page CER | Exact numeric tokens / 6 | Three-page processing time              |
| ------------------------------------------ | ----------------------- | ------------- | ------------------------ | --------------------------------------- |
| Preserved whole-page high-accuracy / PSM 6 | 84                      | 7.89%         | 3                        | Historical timing not directly compared |
| Regions, standard / PSM 3                  | 41                      | 3.85%         | 4                        | 49.76 s                                 |
| Regions, standard / PSM 6                  | 46                      | 4.32%         | 4                        | 55.84 s                                 |
| Regions, enhanced without median / PSM 6   | 49                      | 4.61%         | 4                        | 62.63 s                                 |
| Regions, adaptive / PSM 6                  | **39**                  | **3.67%**     | **4**                    | 91.46 s                                 |
| Regions, enhanced + line removal / PSM 6   | 91                      | 8.55%         | 3                        | 60.06 s                                 |
| Regions, adaptive + line removal / PSM 6   | 77                      | 7.24%         | 3                        | 70.80 s                                 |

All six candidates completed on the three retained PNGs; only page 1 is accuracy-scored. Native peak working set was 95.6–95.7 MiB, not total application peak memory. Initial comparison evidence is `.local/ocr-benchmarks/layout-page1-comparison.json`; the private full reference is `.local/ocr-benchmarks/page1-full-reference.json`. Line cleanup damaged recognition relative to the uncleaned region candidates, so it remains experimental and disabled. Region recognition cut this sample's errors, but **two checked numeric tokens remain incorrect**. None of the sample-specific results changes global defaults or establishes accuracy on other document types.

Final verification with the conservative guards and recorded pipeline fingerprint reproduced **39/1,064 errors (3.67%) and 4/6 exact numeric tokens**. It completed all three pages in **72.01 s**, with **152.8 MiB** native peak working set; page 3 selected the full-page `ruled-layout` fallback, rather than forcing the page-1 segmentation. Those timing/memory values therefore supersede the preliminary matrix for the final guarded candidate, not its unchanged page-1 CER. The preserved final result is `/ocr/jobs/8203d077-8e7e-456f-a911-4a8ed43daf00`; local evidence is `.local/ocr-benchmarks/layout-final-verification.json`. All three original PNG checksums and the source job were verified unchanged.

Actual installed-engine checks recognized all three known lines independently for English and Indonesian, then persisted both pages through Simulator → capture completion → bilingual OCR. For example:

```text
The original document remains unchanged.
Surat keterangan penerimaan dokumen.
```

Tests assert expected text, line/word bounds, unchanged source hashes, explicit missing-Indonesian errors and persisted bilingual results. These clean synthetic sheets establish integration, **not production-document accuracy**.

### Actual real-scan comparison (2026-11-13)

Source job `66503df9-3502-4bac-8453-d9f392ddf84f` retained its original Fast result. All nine candidate runs completed on the same three retained scanned PNGs. The reference set contains **205 manually transcribed characters in seven page-1 excerpts** (title, document number, short labels, a sentence and footer), not full-page transcripts. No page-2/page-3 accuracy is claimed. Whitespace is normalized; edit distance permits matching an excerpt within the longer OCR output, so surrounding layout noise is deliberately not penalized.

| Best profile  | PSM | Excerpt errors / 205 | Excerpt CER | Three-page processing time | Peak Tesseract working set |
| ------------- | --- | -------------------- | ----------- | -------------------------- | -------------------------- |
| standard      | 3   | 7                    | 3.41%       | 10.01 s                    | 161.1 MiB                  |
| standard      | 4   | 7                    | 3.41%       | 11.35 s                    | 160.3 MiB                  |
| standard      | 6   | 9                    | 4.39%       | 13.96 s                    | 160.3 MiB                  |
| enhanced      | 3   | 11                   | 5.37%       | 15.64 s                    | 159.1 MiB                  |
| enhanced      | 4   | 11                   | 5.37%       | 16.19 s                    | 159.3 MiB                  |
| enhanced      | 6   | 9                    | 4.39%       | 17.13 s                    | 158.9 MiB                  |
| high-accuracy | 3   | 10                   | 4.88%       | 18.01 s                    | 159.3 MiB                  |
| high-accuracy | 4   | 10                   | 4.88%       | 17.66 s                    | 160.5 MiB                  |
| high-accuracy | 6   | 5                    | 2.44%       | 18.39 s                    | 159.7 MiB                  |

The preserved Fast baseline had **9/205 errors (4.39%)** on those same excerpts. Standard/PSM 3 reduced that to 7; high-accuracy/PSM 6 reduced it to 5 (44% fewer excerpt character errors), but this is **not a 44% whole-document accuracy gain**. The old baseline stores engine-only durations, so its total 4.79 s cannot be compared directly to the new full-pipeline durations. Each candidate's memory number is the largest measured native working set across its three pages, not aggregate application memory.

Keep **Best/standard/PSM 3** as the general default: switching to Best helped the reviewed excerpts without imposing destructive thresholding on every document. Enhanced preprocessing worsened this reference set. High-accuracy/PSM 6 is an optional candidate worth inspecting for this agreement, not a universally superior setting. All detected deskew corrections on these scans were 0°; deskew correctness is covered by a synthetic slanted-line test, but no real-sample deskew improvement is claimed.

Inspect the preserved candidate runs:

- Standard/PSM 3: `/ocr/jobs/86420a71-63f3-422f-8f8b-077fad25f7b4`.
- High-accuracy/PSM 6: `/ocr/jobs/df57c50f-2778-48d6-a18e-7cb783a0a036`.

The private report and references are ignored local files at `.local/ocr-benchmarks/phase3a-accuracy-comparison.json` and `.local/ocr-benchmarks/reviewed-excerpts.json`, with mode 0600. The report contains private extracted text; this document intentionally contains only non-content metrics. Pen strokes, mixed-column/logo headers, document-number ambiguity and short-line detection remain imperfect.

Browser tests and physical scans are not run in this phase, per the user's instruction. The existing OCR UI has been compacted and source/text comparison added, but rendered acceptance at 1366×768 is not asserted without a browser check. There is no QC workflow, AI extraction/classification, approval, archive search, embeddings or PDF output.

Earlier Phase 3A non-browser verification (the layout-update checks follow below):

- `pnpm test`: **57 passed, 0 failed**. Includes queue races/fencing, retries, pause/resume/cancel, shutdown/recovery, source integrity, authorization/CSRF, profile snapshots, reprocessing idempotency, benchmark snapshots/report permissions, thresholding, transparent PNGs and synthetic deskew.
- `pnpm test:ocr-runtime`: **1 installed-engine integration test passed**, covering independent Best English/Indonesian recognition, missing-language rejection and bilingual Simulator-to-PostgreSQL persistence.
- `pnpm test:profiles`: **26 assertions passed**, without WIA or hardware access.
- `pnpm lint`, `pnpm format:check`, `pnpm build`: passed. Vite still emits third-party Ant Design `use client` warnings and a large-main-chunk warning; bundle optimization was not part of this task.
- Both .NET projects compiled in Release; explicit build checks reported zero warnings/errors. Legacy Fast preflight reproduced the preserved job's configuration hash exactly.
- Direct managed-storage reads verified all three real original PNG checksums, and all nine candidates used the same source checksums. Ten jobs including the original remain completed, with 30 completed page-result records retained.
- Direct HTTP loads of the old and candidate detail routes returned 200; unauthenticated OCR API access returned 401. This is an HTTP availability/security check, not a browser/layout test.

Local check logs are under `/tmp/opencode/digitalarch-final-tests.log`, `digitalarch-final-ocr-runtime.log`, `digitalarch-final-profile-checks.log`, `digitalarch-final-build.log` and `digitalarch-real-ocr-benchmark.log`. The private text-bearing benchmark report stays under ignored `.local/`, not in those numeric/status logs. A batch-detail read now uses one read-only repeatable-read transaction so its version and session/page state cannot come from different reconciliation snapshots; this fixes the completion-version race exposed by the queue tests without weakening version checks.

Troubleshooting:

1. Missing `ind.traineddata`/`eng.traineddata`: install **both Best models**, verify the configured parent directory, then retry failed initialization or reprocess. Never rename Fast data to Best.
2. Changed configuration: preserve the prior result and use Reprocess for a new snapshot rather than editing successful rows.
3. Missing/corrupt PNG or checksum mismatch: restore the exact managed image from backup; OCR will not trust substituted bytes.
4. Interrupted worker: restart the backend, wait for the expired lease, inspect recovery state and resume if explicitly paused.
5. Poor recognition: inspect the source at actual size, compare profiles/PSMs, and remember that pen strokes, faint logos, physical streaks and page layout can still defeat Tesseract. A heavier preset is not automatically better.
