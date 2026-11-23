# CSV-Magic (PipeCheck)

An **AI-powered CSV ingestion pipeline** with automatic data cleaning, error fixing, real-time monitoring, and a modern React dashboard.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.11+-green.svg)
![React](https://img.shields.io/badge/react-18+-blue.svg)

## Features

### Core Functionality
- **Schema-Flexible Processing**: Accepts any CSV structure - no predefined schema required
- **Large File Support**: Streaming uploads handle files up to the configurable 100MB limit without loading them into memory
- **Deduplication**: SHA-256 hashing prevents duplicate rows and files
- **Idempotent Uploads**: Re-uploading same file is safely skipped
- **Batch Processing**: Processes rows in batches of 1000 for efficiency
- **No Silent Loss**: Lines the parser cannot use are rejected and reported, never dropped quietly

### AI-assisted data cleaning
- **Row-Level Fixes**: AI automatically fixes validation errors per row
- **File-Level Repairs**: Fixes delimiter issues and malformed headers
- **Smart Inference**: Generates missing data from context (e.g., email from name)
- **Fix Tracking**: All AI fixes are logged and displayed in the UI
- **Review Flags**: Fixes that invent a value mark the row `needs_review` instead of
  passing it off as source data (see [Invented values](#invented-values))

### Modern Dashboard
- **Drag & Drop Upload**: Upload CSV/Excel files with drag-drop or click (Excel imports the first worksheet)
- **Paste Support**: Paste CSV or a JSON array of objects; JSON is converted to CSV locally before ingest
- **Guided Demo**: Run or edit bundled CSV/JSON samples to learn the pipeline without preparing a file
- **Real-time Progress**: WebSocket-powered live processing updates
- **Run review**: Page through CSV and Excel results, compare source and cleaned values, filter issues, and download the original upload
- **Pagination**: Navigate large datasets with shadcn/ui pagination
- **Run Management**: View, reprocess, or delete previous runs
- **Export Options**: Download processed data or error reports (CSV/Excel)
- **Sound Effects**: Optional audio feedback for upload events
- **Responsive Design**: Works on desktop and mobile

### Data Processing
- **Auto-Encoding Detection**: Handles UTF-8, Latin-1, CP1252, etc.
- **Delimiter Detection**: Auto-detects comma, tab, semicolon, pipe
- **Null Handling**: Normalizes NULL, N/A, none, nan, empty strings
- **Field Validation**: Email format, phone normalization, date parsing
- **Data Normalization**: Case standardization, whitespace cleanup

### Monitoring & Logging
- **Real-time Console**: Live structured logs with color-coded levels
- **Persistent Logs**: Console logs saved to localStorage
- **WebSocket Updates**: Real-time status and progress
- **Error Tracking**: Detailed error logs with row indices

## Quick Start

### Prerequisites
- Python 3.11 or 3.12 (the pinned `pandas`/`pydantic` builds have no wheels for 3.13+)
- Node.js 18+
- Optional AI repair through a Groq API key or a signed-in local Claude Code or Codex CLI

### Installation

```bash
# Clone repository
git clone https://github.com/ai-armageddon/pipecheck.git
cd pipecheck

# Backend setup
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Create .env file for AI features (optional)
echo "GROQ_API_KEY=your_key_here" > .env

# Start backend (port 8001)
uvicorn app.main:app --reload --port 8001

# Frontend setup (new terminal)
cd ../frontend
npm install
npm start

# Open http://localhost:3000
```

### Docker (Alternative)

```bash
docker-compose up -d
# Open http://localhost:3000
```

### PM2 (Alternative)

Runs the API under uvicorn and serves the production frontend build:

```bash
cd frontend && npm install && CI=false npx react-scripts build && cd ..
pm2 start ecosystem.config.js
# Open http://localhost:3000
```

| Command | Purpose |
|---------|---------|
| `pm2 logs pipecheck-api` | Tail backend logs |
| `pm2 restart pipecheck-api` | Apply backend changes |
| `pm2 restart pipecheck-web` | Apply a **rebuilt** frontend |
| `pm2 stop pipecheck-api pipecheck-web` | Stop both |
| `pm2 save` | Persist across reboots (with `pm2 startup`) |

`pipecheck-web` serves a static build, so rebuild before restarting it after frontend
changes. Both processes bind to `127.0.0.1`; see the security note below before
exposing them.

### Running the tests

```bash
cd backend
pip install -r requirements-dev.txt
pytest
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/upload` | Upload CSV/Excel file |
| `POST` | `/upload?force=true` | Force upload (ignore duplicate) |
| `GET` | `/runs` | List all processing runs |
| `GET` | `/runs/{run_id}` | Get run details |
| `GET` | `/runs/{run_id}/errors` | Get errors for a run |
| `GET` | `/runs/{run_id}/data` | Get processed data (JSON) |
| `GET` | `/runs/{run_id}/review` | Page through processed rows or issues with `view`, `offset`, and `limit` (1–100) |
| `GET` | `/runs/{run_id}/source` | Download the retained original CSV or workbook |
| `GET` | `/providers` | Check CLI sign-in, pending connections, and Groq configuration |
| `POST` | `/providers/{provider}/connect` | Start native subscription sign-in for Claude Code or Codex on the backend machine. Supply the matching `X-PipeCheck-Provider` header. |
| `POST` | `/runs/{run_id}/reprocess` | Reprocess existing file |
| `DELETE` | `/runs/{run_id}` | Delete a run |
| `DELETE` | `/runs` | Delete all runs |
| `GET` | `/export/{run_id}` | Export processed data (CSV/Excel) |
| `GET` | `/errors/{run_id}/export` | Export error report |
| `GET` | `/stats` | Get overall statistics |
| `GET` | `/logs/recent` | Get recent log entries |
| `GET` | `/health` | Health check |
| `WS` | `/ws` | Global WebSocket for logs |
| `WS` | `/ws/{run_id}` | Run-specific WebSocket |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   React App     │────▶│   FastAPI       │────▶│   SQLite/       │
│   (Port 3000)   │     │   (Port 8001)   │     │   PostgreSQL    │
│                 │◀────│                 │◀────│                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │
        │                       ▼
        │               ┌─────────────────┐
        │               │ Repair provider │
        │               │ Claude/Codex/   │
        │               └─────────────────┘
        │
        ▼
┌─────────────────┐
│   WebSocket     │
│   (Real-time)   │
└─────────────────┘
```

### Data Flow

1. **Upload**: File streamed to disk in 1MB chunks
2. **Hash Check**: SHA-256 prevents duplicate file processing
3. **Encoding Detection**: chardet identifies file encoding
4. **Delimiter Detection**: Auto-detect or AI-repair if needed
5. **Validation**: Per-row validation with AI fix attempts
6. **Normalization**: Standardize case, format, whitespace
7. **Deduplication**: Row-level hash prevents duplicate data
8. **Storage**: Insert/update based on hash comparison
9. **Reporting**: Real-time progress via WebSocket

## Database Schema

### `ingest_runs`
| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Run identifier |
| `filename` | String | Original filename |
| `file_hash` | String | SHA-256 of file |
| `status` | Enum | pending/processing/completed/failed/partial_success |
| `total_rows` | Integer | Total rows in file |
| `rows_inserted` | Integer | New rows added |
| `rows_updated` | Integer | Existing rows updated |
| `rows_skipped` | Integer | Duplicate rows skipped |
| `rows_rejected` | Integer | Invalid or unparseable rows rejected |
| `rows_flagged` | Integer | Rows kept but repaired with invented values |
| `errors_count` | Integer | Entries written to `error_logs` for this run |
| `error_message` | Text | Error details or AI fixes applied |
| `created_at` | DateTime | Upload time |
| `started_at` | DateTime | Processing start time |
| `completed_at` | DateTime | Processing end time |

A run is `completed` only when nothing was rejected and nothing was flagged.
Otherwise it is `partial_success`, which still contains data and is exportable.

### `data_rows`
| Column | Type | Description |
|--------|------|-------------|
| `id` | Integer | Primary key |
| `run_id` | UUID | Associated run |
| `row_index` | Integer | Zero-based row number within the source file |
| `row_hash` | String | SHA-256 of normalized data, unique **per run** |
| `normalized_data` | JSON | Cleaned/processed data |
| `raw_data` | JSON | Original row data |

`row_hash` is unique per `(run_id, row_hash)`, so every run keeps a complete,
independently exportable snapshot. Rows already seen in an earlier run are
counted as `rows_updated` without being taken away from that run.

> **Upgrading an existing database:** versions before this change made `row_hash`
> globally unique, which let a later upload move rows off an older run.
> `create_all()` cannot rewrite that constraint, so the server logs a warning at
> startup if it is still present. Delete the SQLite file to recreate the schema.

### `error_logs`
| Column | Type | Description |
|--------|------|-------------|
| `id` | Integer | Primary key |
| `run_id` | UUID | Associated run |
| `row_index` | Integer | Row with error |
| `error_code` | String | Error category |
| `error_message` | String | Human-readable error |
| `raw_data` | JSON | Problematic row data |

| Error code | Meaning |
|------------|---------|
| `MALFORMED_ROW` | Line could not be parsed (e.g. extra fields) and was not imported |
| `VALIDATION_ERROR` | Row was parsed but rejected, e.g. completely empty |
| `NEEDS_REVIEW` | Row was imported after a fix that invented a value |
| `PROCESSING_ERROR` | Unexpected failure while handling the row |

## AI repair providers

Open **AI provider** in the dashboard header. The selected provider applies to uploads and reprocessing from this browser. **Run Details** records the choice for each new or reprocessed run. Deterministic cleanup runs first. When AI repair is needed, the selected provider receives the affected row or a sample of the file. Model-generated values appear in the review queue.

| Provider | Setup on the machine running the backend |
| --- | --- |
| Local cleanup only | Select this to process data entirely on the machine. |
| Groq | Set `GROQ_API_KEY` in `backend/.env`, restart the API, then select Groq. |
| Claude Code | Install the official `claude` CLI. Click **Connect Claude subscription** and sign in to your Claude account in the browser it opens. |
| Codex | Install the official `codex` CLI. Click **Connect ChatGPT subscription** and finish ChatGPT sign-in in the browser it opens. |

The panel updates automatically after sign-in. Select the connected provider to use it for new uploads and reprocessing. If the backend has no desktop browser, run `claude auth login` or `codex login` in its terminal and use **Refresh connections**. PipeCheck invokes the installed CLI in a temporary directory for each repair. The CLI manages its own credentials. Subscription access is for the local owner's loopback dashboard. A container has its own executable path and login environment. The stock Docker image supports Groq and local cleanup.

API callers can set the `X-PipeCheck-Provider` request header on `POST /upload` and `POST /runs/{id}/reprocess` to `off`, `groq`, `claude`, or `codex`. Omitting it uses Groq when configured, otherwise local cleanup. Duplicate uploads return the original run. Reprocess to apply another provider.

### Reviewing a run

**Processed** displays stored output in source-record order. Select a row number to compare fields side by side and read its repair history. **Issues** can show all entries, flagged records, or rejections. **Original file** downloads the retained bytes, including duplicate and rejected records. The **Original** tab also previews recently uploaded small CSVs.

Displayed row numbers start at 1 after the header. A quoted multiline record occupies one row. Physical line numbers in parse errors identify the location in the file. Runs processed by older versions keep their stored indices until reprocessed.


### Row-Level Fixing
When validation fails, the AI attempts to fix:
- **Missing emails**: Generates from name or context
- **Invalid formats**: Corrects email/phone formatting
- **Missing names**: Extracts from email prefix
- **Data inference**: Uses context to fill gaps

### File-Level Repair
For file structure issues:
- **Delimiter conversion**: Fixes incorrect delimiters
- **Header generation**: Creates missing headers
- **Format repair**: Fixes malformed CSV structure

### Invented values

Some repairs cannot be derived from the file — they are guesses. Inserting an `@`
into `invalid.email.com` produces `invalid@email.com`, which may be a real mailbox
belonging to someone else; a phone number missing an area code gets a placeholder
`000`. These rows are still imported, but they are marked so a guess is never
mistaken for source data:

- `normalized_data._needs_review` is set to `true`
- a `NEEDS_REVIEW` entry is written to `error_logs` listing what was invented
- the run reports `rows_flagged` and its status becomes `partial_success`
- exports gain `needs_review` and `fixes_applied` columns
- the dashboard shows an amber flag on the run, the row, and the preview

Deterministic cleanup — trimming whitespace, lowercasing an email, stripping
punctuation from a phone number — is not flagged, because nothing is invented.

### Configuration
```bash
# .env file
GROQ_API_KEY=your_groq_api_key_here
```

Groq defaults to `llama-3.1-8b-instant`. Set `GROQ_MODEL` to override it. Local CLIs use their default model.

## Project Structure

```
pipecheck/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI app, routes, WebSocket
│   │   ├── models.py        # SQLAlchemy models
│   │   ├── schemas.py       # Pydantic schemas
│   │   ├── pipeline.py      # CSV processing logic
│   │   ├── ai_fixer.py      # Provider-independent repair logic
│   │   └── database.py      # Database config
│   ├── tests/               # pytest suite
│   ├── uploads/             # Retained source files (for reprocess)
│   ├── requirements.txt     # Runtime deps (single source of truth)
│   ├── requirements-dev.txt # Runtime deps + test tooling
│   └── .env                 # API keys (not in git)
├── frontend/
│   ├── src/
│   │   ├── App.js           # Main React component
│   │   ├── Console.js       # Real-time log console
│   │   ├── components/
│   │   │   ├── CSVPreview.jsx    # Data preview with tabs
│   │   │   └── ui/               # shadcn/ui components
│   │   └── lib/
│   │       ├── api.js       # API base URL (REACT_APP_API_URL)
│   │       └── sounds.js    # Audio feedback
│   ├── package.json
│   └── tailwind.config.js
├── data/
│   └── bad.csv              # Test data with errors
├── docker-compose.yml
├── LICENSE
└── README.md
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GROQ_API_KEY` | Groq API key | None |
| `MAX_UPLOAD_BYTES` | Maximum size of a retained upload | 104857600 |
| `DATABASE_URL` | Database connection string | `sqlite:///./pipecheck.db` |
| `CORS_ORIGINS` | Comma-separated allowed browser origins | `http://localhost:3000,http://127.0.0.1:3000` |
| `REACT_APP_API_URL` | Backend URL the frontend calls (build-time) | `http://localhost:8001` |

### Large File Handling
- **Backend**: Streams uploads in 1MB chunks
- **Frontend**: Processed rows and issues load one page at a time. Local source-text previews are limited to CSV files up to 2 MiB.
- **Processing**: Batches of 1000 rows

### Disk Usage
Uploaded files are kept in `backend/uploads/` so a run can be reprocessed. They
are deleted when the run is deleted (`DELETE /runs/{id}` or `DELETE /runs`).

## Monitoring

### Backend Logs
```bash
# Watch uvicorn output for structured JSON logs
uvicorn app.main:app --reload --port 8001
```

### Frontend Console
The dashboard includes a real-time console showing:
- Upload progress
- Processing status
- Errors and warnings
- AI fix notifications

Logs persist in localStorage across page refreshes.

## Testing

```bash
# Automated suite (pipeline + API)
cd backend && pytest

# Test with sample bad data
curl -X POST "http://localhost:8001/upload" \
  -F "file=@data/bad.csv"

# Test with large file
curl -X POST "http://localhost:8001/upload" \
  -F "file=@/path/to/large.csv"

# Test reprocessing
curl -X POST "http://localhost:8001/runs/{run_id}/reprocess"
```

## Production Deployment

### Recommendations
- **Database**: PostgreSQL for production
- **File Storage**: S3 for uploaded files
- **Queue**: Redis/Celery for async processing
- **Scaling**: Single worker for in-process run tracking and WebSockets
- **Monitoring**: Prometheus + Grafana

### Security Checklist
- [x] `CORS_ORIGINS` is configurable (defaults to `http://localhost:3000`)
- [x] Uploaded filenames are reduced to their base name before touching disk
- [ ] Enable HTTPS
- [ ] Add rate limiting
- [ ] Implement authentication
- [x] Enforce the configured upload size limit
- [ ] Rotate API keys

> The API is unauthenticated: anyone who can reach it can upload files and delete
> every run. Do not expose it beyond localhost without putting auth in front.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Credits

- **FastAPI** - Modern Python web framework
- **React** - UI library
- **Tailwind CSS** - Styling
- **shadcn/ui** - UI components
- **Groq** - LLM API for AI features
- **Lucide** - Icons
