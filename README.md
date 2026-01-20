# CSV-Magic (PipeCheck)

An **AI-powered CSV ingestion pipeline** with automatic data cleaning, error fixing, real-time monitoring, and a modern React dashboard.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.11+-green.svg)
![React](https://img.shields.io/badge/react-18+-blue.svg)

## ✨ Features

### Core Functionality
- **Schema-Flexible Processing**: Accepts any CSV structure - no predefined schema required
- **Large File Support**: Streaming uploads handle files 100MB+ without memory issues
- **Deduplication**: SHA-256 hashing prevents duplicate rows and files
- **Idempotent Uploads**: Re-uploading same file is safely skipped
- **Batch Processing**: Processes rows in batches of 1000 for efficiency

### AI-Powered Data Cleaning (Groq LLM)
- **Row-Level Fixes**: AI automatically fixes validation errors per row
- **File-Level Repairs**: Fixes delimiter issues and malformed headers
- **Smart Inference**: Generates missing data from context (e.g., email from name)
- **Fix Tracking**: All AI fixes are logged and displayed in the UI

### Modern Dashboard
- **Drag & Drop Upload**: Upload CSV/Excel files with drag-drop or click
- **Paste Support**: Paste CSV data directly or import from URL
- **Real-time Progress**: WebSocket-powered live processing updates
- **CSV Preview**: View original, processed, and error-highlighted data
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

## 🚀 Quick Start

### Prerequisites
- Python 3.11+
- Node.js 18+
- Groq API Key (optional, for AI features)

### Installation

```bash
# Clone repository
git clone https://github.com/ai-armageddon/pipecheck.git
cd CSV-Magic

# Backend setup
cd backend
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

## 📡 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/upload` | Upload CSV/Excel file |
| `POST` | `/upload?force=true` | Force upload (ignore duplicate) |
| `GET` | `/runs` | List all processing runs |
| `GET` | `/runs/{run_id}` | Get run details |
| `GET` | `/runs/{run_id}/errors` | Get errors for a run |
| `GET` | `/runs/{run_id}/data` | Get processed data (JSON) |
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

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   React App     │────▶│   FastAPI       │────▶│   SQLite/       │
│   (Port 3000)   │     │   (Port 8001)   │     │   PostgreSQL    │
│                 │◀────│                 │◀────│                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │
        │                       ▼
        │               ┌─────────────────┐
        │               │   Groq AI       │
        │               │   (LLM Fixer)   │
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

## 🗄️ Database Schema

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
| `rows_rejected` | Integer | Invalid rows rejected |
| `error_message` | Text | Error details or AI fixes applied |
| `created_at` | DateTime | Upload time |
| `completed_at` | DateTime | Processing end time |

### `data_rows`
| Column | Type | Description |
|--------|------|-------------|
| `id` | Integer | Primary key |
| `run_id` | UUID | Associated run |
| `row_index` | Integer | Original row number |
| `row_hash` | String | SHA-256 of normalized data |
| `normalized_data` | JSON | Cleaned/processed data |
| `raw_data` | JSON | Original row data |

### `error_logs`
| Column | Type | Description |
|--------|------|-------------|
| `id` | Integer | Primary key |
| `run_id` | UUID | Associated run |
| `row_index` | Integer | Row with error |
| `error_code` | String | Error category |
| `error_message` | String | Human-readable error |
| `raw_data` | JSON | Problematic row data |

## 🤖 AI Features (Groq Integration)

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

### Configuration
```bash
# .env file
GROQ_API_KEY=your_groq_api_key_here
```

The AI uses `llama-3.1-8b-instant` model with rate limiting (0.5s between calls).

## 📁 Project Structure

```
CSV-Magic/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI app, routes, WebSocket
│   │   ├── models.py        # SQLAlchemy models
│   │   ├── schemas.py       # Pydantic schemas
│   │   ├── pipeline.py      # CSV processing logic
│   │   ├── ai_fixer.py      # Groq AI integration
│   │   └── database.py      # Database config
│   ├── uploads/             # Temporary file storage
│   ├── requirements.txt
│   └── .env                 # API keys (not in git)
├── frontend/
│   ├── src/
│   │   ├── App.js           # Main React component
│   │   ├── Console.jsx      # Real-time log console
│   │   ├── components/
│   │   │   ├── CSVPreview.jsx    # Data preview with tabs
│   │   │   └── ui/               # shadcn/ui components
│   │   └── lib/
│   │       └── sounds.js    # Audio feedback
│   ├── package.json
│   └── tailwind.config.js
├── data/
│   └── bad.csv              # Test data with errors
├── docker-compose.yml
└── README.md
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GROQ_API_KEY` | Groq API key for AI features | None (AI disabled) |
| `DATABASE_URL` | Database connection string | `sqlite:///./pipecheck.db` |

### Large File Handling
- **Backend**: Streams uploads in 1MB chunks
- **Frontend**: Preview disabled for files >10MB
- **Processing**: Batches of 1000 rows

## 📊 Monitoring

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

## 🧪 Testing

```bash
# Test with sample bad data
curl -X POST "http://localhost:8001/upload" \
  -F "file=@data/bad.csv"

# Test with large file
curl -X POST "http://localhost:8001/upload" \
  -F "file=@/path/to/large.csv"

# Test reprocessing
curl -X POST "http://localhost:8001/runs/{run_id}/reprocess"
```

## 🚀 Production Deployment

### Recommendations
- **Database**: PostgreSQL for production
- **File Storage**: S3 for uploaded files
- **Queue**: Redis/Celery for async processing
- **Scaling**: Multiple uvicorn workers behind nginx
- **Monitoring**: Prometheus + Grafana

### Security Checklist
- [ ] Set secure `CORS_ORIGINS`
- [ ] Enable HTTPS
- [ ] Add rate limiting
- [ ] Implement authentication
- [ ] Sanitize all inputs
- [ ] Rotate API keys

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

## 🙏 Credits

- **FastAPI** - Modern Python web framework
- **React** - UI library
- **Tailwind CSS** - Styling
- **shadcn/ui** - UI components
- **Groq** - LLM API for AI features
- **Lucide** - Icons
