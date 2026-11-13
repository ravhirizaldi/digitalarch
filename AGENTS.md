# Verification boundaries

- Get the user's explicit approval before running any OCR-specific test, benchmark or verification inference, including mock-only OCR tests and recognition of saved/synthetic pages.
- Do not run `pnpm test` without that approval: the full suite includes OCR tests. Lint, formatting, builds and static inspection are allowed without running OCR.
- Never automatically resume a paused OCR benchmark. Ask before starting another run.
- Do not perform browser tests or physical scans without explicit approval.
- These restrictions govern agent verification, not the application's normal user-initiated capture/OCR workflow.
