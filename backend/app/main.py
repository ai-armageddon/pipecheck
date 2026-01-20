from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from typing import List, Optional, Dict
import uuid
import pandas as pd
import io
import sys
import json
import hashlib
import logging
import os
from pathlib import Path
from datetime import datetime
import structlog
from contextlib import asynccontextmanager
from sqlalchemy import func
from .database import SessionLocal, engine, Base
from .models import IngestRun, DataRow, ErrorLog, RunStatus, ErrorCode
from .schemas import IngestRunResponse, RunDetail, ErrorDetail, StatsResponse, IngestRun as IngestRunSchema
from .pipeline import CSVProcessor, FileIntegrityError, ValidationError

logging.basicConfig(
    format="%(message)s",
    stream=sys.stdout,
    level=logging.INFO,
)

structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer()
    ],
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield

app = FastAPI(
    title="PipeCheck API",
    description="Ops-grade CSV ingestion pipeline with deduplication and idempotency",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

active_runs: Dict[str, Dict] = {}

@app.get("/")
async def root():
    return {"message": "PipeCheck API - CSV ingestion pipeline"}

@app.post("/upload", response_model=IngestRunResponse)
async def upload_csv(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...)
):
    if not (file.filename.endswith('.csv') or 
            file.filename.endswith(('.xlsx', '.xls', '.xlsm'))):
        raise HTTPException(status_code=400, detail="Only CSV and Excel files are allowed")
    
    run_id = str(uuid.uuid4())
    
    file_content = await file.read()
    file_hash = hashlib.sha256(file_content).hexdigest()
    
    db = next(get_db())
    
    existing_run = db.query(IngestRun).filter(
        IngestRun.file_hash == file_hash
    ).first()
    
    if existing_run:
        logger.info("Duplicate file detected", run_id=run_id, existing_run_id=existing_run.id)
        return JSONResponse(
            status_code=200,
            content={
                "run_id": existing_run.id,
                "status": "skipped",
                "message": "File already processed",
                "created_at": existing_run.created_at.isoformat(),
                "completed_at": existing_run.completed_at.isoformat() if existing_run.completed_at else None,
                "total_rows": existing_run.total_rows,
                "rows_inserted": existing_run.rows_inserted,
                "rows_updated": existing_run.rows_updated,
                "rows_skipped": existing_run.rows_skipped,
                "errors_count": existing_run.errors_count
            }
        )
    
    run = IngestRun(
        id=run_id,
        filename=file.filename,
        file_hash=file_hash,
        status=RunStatus.PENDING,
        created_at=datetime.utcnow()
    )
    
    db.add(run)
    db.commit()
    
    upload_dir = Path("uploads")
    upload_dir.mkdir(exist_ok=True)
    
    file_path = upload_dir / f"{run_id}_{file.filename}"
    with open(file_path, "wb") as f:
        f.write(file_content)
    
    active_runs[run_id] = {"status": "processing", "progress": 0}
    
    background_tasks.add_task(process_csv_file, run_id, str(file_path))
    
    return IngestRunResponse(
        run_id=run_id,
        status=RunStatus.PENDING,
        message="File uploaded successfully",
        created_at=run.created_at,
        total_rows=0,
        rows_inserted=0,
        rows_updated=0,
        rows_skipped=0,
        errors_count=0
    )

async def process_csv_file(run_id: str, file_path: str):
    db = next(get_db())
    processor = CSVProcessor(db)
    
    correlation_id = run_id
    logger = logger.bind(correlation_id=correlation_id, run_id=run_id)
    
    try:
        logger.info("Starting CSV processing", file_path=file_path)
        
        # Update status to processing
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        if run:
            run.status = RunStatus.PROCESSING
            db.commit()
        
        # Process the CSV with enhanced validation
        results = await processor.process_csv(file_path, run_id)
        
        logger.info("CSV processing completed", **results)
        
    except FileIntegrityError as e:
        logger.error("File integrity error", error=str(e))
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        if run:
            run.status = RunStatus.FAILED
            run.completed_at = datetime.utcnow()
            run.error_message = str(e)
            db.commit()
            
    except ValidationError as e:
        logger.error("Validation error", error=str(e))
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        if run:
            run.status = RunStatus.FAILED
            run.completed_at = datetime.utcnow()
            run.error_message = str(e)
            db.commit()
            
    except Exception as e:
        logger.error("Unexpected error during processing", error=str(e), exc_info=True)
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        if run:
            run.status = RunStatus.FAILED
            run.completed_at = datetime.utcnow()
            run.error_message = f"Internal error: {str(e)}"
            db.commit()
            
    finally:
        # Clean up uploaded file
        try:
            os.remove(file_path)
        except:
            pass
            
        # Remove from active runs
        if run_id in active_runs:
            del active_runs[run_id]
            
        db.close()

@app.get("/runs")
async def get_runs():
    db = next(get_db())
    runs = db.query(IngestRun).order_by(IngestRun.created_at.desc()).limit(50).all()
    
    return [
        {
            "run_id": run.id,
            "filename": run.filename,
            "status": run.status,
            "created_at": run.created_at.isoformat(),
            "completed_at": run.completed_at.isoformat() if run.completed_at else None,
            "total_rows": run.total_rows,
            "rows_inserted": run.rows_inserted,
            "rows_updated": run.rows_updated,
            "rows_skipped": run.rows_skipped,
            "errors_count": run.errors_count
        }
        for run in runs
    ]

@app.get("/runs/{run_id}")
async def get_run(run_id: str):
    db = next(get_db())
    run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
    
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    
    return {
        "run_id": run.id,
        "filename": run.filename,
        "status": run.status,
        "created_at": run.created_at.isoformat(),
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "total_rows": run.total_rows,
        "rows_inserted": run.rows_inserted,
        "rows_updated": run.rows_updated,
        "rows_skipped": run.rows_skipped,
        "errors_count": run.errors_count
    }

@app.get("/runs/{run_id}/errors")
async def get_run_errors(run_id: str):
    db = next(get_db())
    errors = db.query(ErrorLog).filter(ErrorLog.run_id == run_id).all()
    
    return [
        {
            "id": error.id,
            "row_index": error.row_index,
            "error_code": error.error_code,
            "error_message": error.error_message,
            "created_at": error.created_at.isoformat()
        }
        for error in errors
    ]

@app.get("/stats")
async def get_stats():
    db = next(get_db())
    
    total_runs = db.query(IngestRun).count()
    completed_runs = db.query(IngestRun).filter(IngestRun.status == RunStatus.COMPLETED).count()
    failed_runs = db.query(IngestRun).filter(IngestRun.status == RunStatus.FAILED).count()
    
    last_run = db.query(IngestRun).order_by(IngestRun.created_at.desc()).first()
    
    total_rows_processed = db.query(IngestRun).filter(IngestRun.status == RunStatus.COMPLETED).with_entities(
        func.sum(IngestRun.total_rows)
    ).scalar() or 0
    
    return {
        "total_runs": total_runs,
        "completed_runs": completed_runs,
        "failed_runs": failed_runs,
        "success_rate": (completed_runs / total_runs * 100) if total_runs > 0 else 0,
        "total_rows_processed": total_rows_processed,
        "last_run": {
            "run_id": last_run.id,
            "status": last_run.status,
            "created_at": last_run.created_at.isoformat() if last_run else None
        } if last_run else None
    }

@app.get("/health")
async def health_check():
    return {"status": "healthy", "active_runs": len(active_runs)}

@app.get("/export/{run_id}")
async def export_data(run_id: str, format: str = "csv"):
    db = next(get_db())
    
    # Get the run
    run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    
    # Get all data rows for this run
    data_rows = db.query(DataRow).filter(DataRow.run_id == run_id).all()
    
    if not data_rows:
        raise HTTPException(status_code=404, detail="No data found for this run")
    
    # Convert to DataFrame
    data = []
    for row in data_rows:
        normalized_data = json.loads(row.normalized_data)
        data.append(normalized_data)
    
    df = pd.DataFrame(data)
    
    # Create file in memory
    output = io.BytesIO()
    
    if format.lower() == "csv":
        df.to_csv(output, index=False)
        media_type = "text/csv"
        filename = f"pipecheck_export_{run_id}.csv"
    elif format.lower() == "excel":
        df.to_excel(output, index=False, engine='openpyxl')
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        filename = f"pipecheck_export_{run_id}.xlsx"
    else:
        raise HTTPException(status_code=400, detail="Unsupported format. Use 'csv' or 'excel'")
    
    output.seek(0)
    
    return StreamingResponse(
        io.BytesIO(output.read()),
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@app.get("/export/all")
async def export_all_data(format: str = "csv"):
    db = next(get_db())
    
    # Get all successful data rows
    data_rows = db.query(DataRow).all()
    
    if not data_rows:
        raise HTTPException(status_code=404, detail="No data found")
    
    # Convert to DataFrame
    data = []
    for row in data_rows:
        normalized_data = json.loads(row.normalized_data)
        normalized_data['run_id'] = row.run_id  # Add run_id for reference
        data.append(normalized_data)
    
    df = pd.DataFrame(data)
    
    # Create file in memory
    output = io.BytesIO()
    
    if format.lower() == "csv":
        df.to_csv(output, index=False)
        media_type = "text/csv"
        filename = f"pipecheck_all_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    elif format.lower() == "excel":
        df.to_excel(output, index=False, engine='openpyxl')
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        filename = f"pipecheck_all_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    else:
        raise HTTPException(status_code=400, detail="Unsupported format. Use 'csv' or 'excel'")
    
    output.seek(0)
    
    return StreamingResponse(
        io.BytesIO(output.read()),
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@app.get("/errors/{run_id}/export")
async def export_error_report(run_id: str, format: str = "csv"):
    """Export detailed error report for rejected rows"""
    db = next(get_db())
    processor = CSVProcessor(db)
    
    try:
        # Get error report
        error_report = await processor.export_error_report(run_id)
        
        if not error_report:
            raise HTTPException(status_code=404, detail="No errors found for this run")
        
        # Convert to DataFrame
        df = pd.DataFrame(error_report)
        
        # Flatten raw_data for better readability
        if 'raw_data' in df.columns:
            raw_data_df = pd.json_normalize(df['raw_data'])
            raw_data_df.columns = [f'raw_{col}' for col in raw_data_df.columns]
            df = pd.concat([df.drop('raw_data', axis=1), raw_data_df], axis=1)
        
        # Create file in memory
        output = io.BytesIO()
        
        if format.lower() == "csv":
            df.to_csv(output, index=False)
            media_type = "text/csv"
            filename = f"pipecheck_errors_{run_id[:8]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        elif format.lower() == "excel":
            df.to_excel(output, index=False, engine='openpyxl')
            media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            filename = f"pipecheck_errors_{run_id[:8]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        else:
            raise HTTPException(status_code=400, detail="Unsupported format. Use 'csv' or 'excel'")
        
        output.seek(0)
        
        logger.info("Error report exported", run_id=run_id, format=format, rows=len(error_report))
        
        return StreamingResponse(
            io.BytesIO(output.read()),
            media_type=media_type,
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
        
    finally:
        db.close()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
