# PipeCheck

An ops-grade CSV ingestion pipeline with deduplication, idempotency, and real-time monitoring dashboard.

**Visit us at [pipecheck.dev](https://pipecheck.dev)**

## Features

- **Robust CSV Processing**: Parse, validate, normalize, and store CSV data with comprehensive error handling
- **Deduplication**: Automatic detection of duplicate rows using SHA-256 hashing
- **Idempotency**: Re-uploading the same file won't create duplicate records
- **Real-time Dashboard**: Monitor processing status, view statistics, and track errors
- **Structured Logging**: JSON-formatted logs with run IDs for easy debugging
- **Error Tracking**: Detailed error logs with row indices and failure codes
- **SQLite/PostgreSQL Support**: Start with SQLite, easily migrate to Postgres

## Quickstart

### Prerequisites
- Python 3.11+
- Node.js 18+
- Docker (optional)

### Option 1: Local Development

```bash
# Clone and setup
git clone <repository-url>
cd CSV-Magic

# Backend setup
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt

# Start backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend setup (new terminal)
cd ../frontend
npm install
npm start

# Open http://localhost:3000
```

### Option 2: Docker Compose

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

### Option 3: Backend Only (FastAPI)

```bash
cd backend
uvicorn app.main:app --reload
# API docs at http://localhost:8000/docs
```

## Testing with Sample Data

Use the provided `data/bad.csv` file to test error handling:

```bash
# Upload via the dashboard or API
curl -X POST "http://localhost:8000/upload" \
  -H "accept: application/json" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@data/bad.csv"
```

## Design Decisions

### Architecture
- **FastAPI Backend**: Async Python web framework with automatic OpenAPI docs
- **React Frontend**: Modern UI with real-time updates and drag-drop upload
- **SQLAlchemy ORM**: Database-agnostic with migration support
- **Structured Logging**: JSON logs for production monitoring

### Data Processing Pipeline
1. **Upload**: File received with SHA-256 hash calculation
2. **Deduplication Check**: Skip if file hash exists
3. **Validation**: Required fields, email format, phone validation
4. **Normalization**: Case standardization, whitespace cleanup, field parsing
5. **Hash Generation**: Create row hash for deduplication
6. **Storage**: Insert/update/skip based on hash comparison

### Error Handling
- **Validation Errors**: Invalid emails, missing required fields
- **Processing Errors**: Malformed data, type mismatches
- **System Errors**: Database issues, file system errors
- **Transient Errors**: Retry logic for network timeouts (mocked)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/upload` | Upload and process CSV file |
| GET | `/runs` | List all ingest runs |
| GET | `/runs/{run_id}` | Get specific run details |
| GET | `/runs/{run_id}/errors` | Get errors for a run |
| GET | `/stats` | Get overall statistics |
| GET | `/health` | Health check endpoint |

## Database Schema

### ingest_runs
- `id`: UUID run identifier
- `filename`: Original filename
- `file_hash`: SHA-256 of file contents
- `status`: pending/processing/completed/failed/skipped
- `created_at`, `started_at`, `completed_at`: Timestamps
- Row counts: total/inserted/updated/skipped/errors

### data_rows
- `row_hash`: SHA-256 of normalized row data
- `run_id`: Associated run
- `row_index`: Original row number
- `normalized_data`: JSON of cleaned data
- `raw_data`: JSON of original data

### error_logs
- `run_id`: Associated run
- `row_index`: Error location
- `error_code`: Categorized error type
- `error_message`: Human-readable description
- `raw_data`: Problematic row data

## Failure Modes & Handling

### Input Validation
- **Non-CSV files**: Rejected with 400 error
- **Empty files**: Logged as validation error
- **Missing columns**: Detailed error per row
- **Invalid emails**: Row skipped with error code

### Processing Errors
- **Memory limits**: Chunked processing for large files
- **Database errors**: Transaction rollback with retry
- **File system errors**: Cleanup and error logging
- **Network timeouts**: Exponential backoff (mocked)

### Recovery Strategies
- **Partial failures**: Continue processing valid rows
- **Duplicate files**: Skip with informative message
- **Corrupted data**: Log error, continue with next row
- **System overload**: Queue requests, return 503

## Monitoring

### Metrics Tracked
- Total runs and success rate
- Rows processed per run
- Error types and frequencies
- Processing duration
- Active concurrent runs

### Log Format
```json
{
  "timestamp": "2024-01-16T10:00:00Z",
  "level": "info",
  "event": "CSV processing completed",
  "run_id": "123e4567-e89b-12d3-a456-426614174000",
  "total_rows": 1000,
  "rows_inserted": 950,
  "rows_updated": 30,
  "rows_skipped": 20,
  "errors_count": 0
}
```

## Production Considerations

### Scaling
- **Horizontal**: Multiple backend instances with shared database
- **Database**: Postgres for production, connection pooling
- **File Storage**: S3 or similar for large files
- **Queue**: Redis/RabbitMQ for async processing

### Security
- **Authentication**: JWT tokens (scaffolded)
- **Authorization**: Role-based access control
- **Input Sanitization**: Validate all user inputs
- **Rate Limiting**: Prevent abuse

### Performance
- **Batch Processing**: Process rows in batches
- **Indexing**: Optimize database queries
- **Caching**: Redis for frequent lookups
- **Async Processing**: Background task queue

## Development

### Running Tests
```bash
# Backend
cd backend
pytest

# Frontend
cd frontend
npm test
```

### Code Structure
```
CSV-Magic/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI application
│   │   ├── models.py        # Database models
│   │   ├── schemas.py       # Pydantic schemas
│   │   ├── pipeline.py      # CSV processing logic
│   │   └── database.py      # Database configuration
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.js          # Main React component
│   │   └── index.css       # Tailwind styles
│   ├── package.json
│   └── Dockerfile
├── data/
│   └── bad.csv             # Sample test data
├── docker-compose.yml
└── README.md
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

MIT License - see LICENSE file for details.
