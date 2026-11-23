# Agent Instructions for PipeCheck

## Environment

Python **3.11 or 3.12 only**. The pinned `pandas==2.1.3` and `pydantic==2.5.0` have
no wheels for 3.13+ and fail to compile from source (`pydantic-core` build error on
`ForwardRef._evaluate`). A bare `python3` on macOS/Homebrew may be 3.14 — check first.

```bash
# Backend
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt   # runtime deps + pytest

# Frontend
cd frontend && npm install
```

`backend/requirements.txt` is the single source of truth for runtime deps; the root
`requirements.txt` just includes it. Do not duplicate dependency lists — a stale copy
of that file is what previously broke the Docker build.

## Verification

Run all three before considering a change done:

```bash
cd backend && pytest
cd frontend && CI=true npx react-scripts test --watchAll=false
cd frontend && CI=false npx react-scripts build
cd frontend && npx react-scripts start        # port 3000, backend on 8001
```

The build compiles with no warnings. Any new warning is a regression.

## Ports

Backend **8001**, frontend **3000**. The frontend must never hardcode a URL — import
from `frontend/src/lib/api.js`, which reads `REACT_APP_API_URL`.

## Running under PM2

`ecosystem.config.js` defines `pipecheck-api` (uvicorn via `backend/.venv`) and
`pipecheck-web` (pm2's bundled static server on the production build).

```bash
pm2 start ecosystem.config.js
pm2 logs pipecheck-api --lines 50
```

`pipecheck-web` serves a **build artifact**, so frontend edits are not picked up until
you rebuild:

```bash
cd frontend && CI=false npx react-scripts build && pm2 restart pipecheck-web
```

Backend edits only need `pm2 restart pipecheck-api` (there is no `--reload` under PM2).
Both bind to 127.0.0.1 because the API is unauthenticated.

## Invariants worth protecting

These were all real bugs; the test suite covers each one.

- **Counters must reconcile.** `rows_inserted + rows_updated + rows_skipped +
  rows_rejected == total_rows`, and `errors_count` must equal the number of
  `error_logs` rows for the run. Every counter has to be written to the `IngestRun`
  record, not just returned from `process_csv`.
- **Never drop a row silently.** Records are split with the `csv` module, not
  pandas' python engine, which silently drops or column-shifts rows on unclosed
  quotes and early over-long rows. Over-long rows and a final record whose quote
  never closes are counted as rejected and logged as `MALFORMED_ROW` with their
  content.
- **Runs left mid-processing by a restart are failed at startup.** The 409 guards
  on delete/reprocess would otherwise block them forever.
- **The pipeline yields between batches.** It never awaits real I/O, so without
  `asyncio.sleep(0)` a large file freezes every other request until it ends.
- **Excel is converted, not parsed as text.** The first sheet is written to a
  temporary CSV; the upload itself is kept for reprocess.
- **`row_index` is the zero-based source position.** `iterrows()` yields the frame's
  absolute source-record label, including gaps left by malformed records. Use that
  label directly without adding `batch_start`.
- **`row_hash` is unique per `(run_id, row_hash)`.** A run owns its snapshot; a later
  overlapping upload must not move rows off an earlier run.
- **Intra-run dedup uses the in-memory `seen_hashes` set.** The session is
  `autoflush=False`, so a query cannot see pending inserts; relying on one made two
  identical rows crash the whole run.
- **Static routes go before parameterized siblings.** `/export/all` must be declared
  above `/export/{run_id}` or FastAPI parses `"all"` as a run id.
- **Uploads are retained** in `backend/uploads/` so reprocess works, and deleted when
  the run is deleted.
- **Invented values are flagged, not hidden.** Fixes that guess (inserting `@`,
  padding an area code, extracting a name from an email, anything from the LLM) set
  `_needs_review`, write a `NEEDS_REVIEW` error, and increment `rows_flagged`.
  Deterministic reformatting is not flagged. See `DataFix` in `pipeline.py`.
- **Unknown columns keep their casing.** The pipeline accepts any schema, so only
  known columns (`name`, `email`, `city`, `state`, `country`, ...) get normalized.

## Database

SQLite by default (`backend/pipecheck.db`, gitignored). There are no Alembic
migrations despite `alembic` being a dependency — schema changes require deleting the
dev database. `legacy_row_hash_index()` in `database.py` warns at startup when an old
database still has the globally-unique `row_hash` index.

## Style

Existing code mixes 4-space Python and 2-space JSX; match the file you are editing.
Do not add or remove unrelated comments.
