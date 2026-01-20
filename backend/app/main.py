from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, WebSocket, WebSocketDisconnect, Query
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
import asyncio
from .database import SessionLocal, engine, Base
from .models import IngestRun, DataRow, ErrorLog, RunStatus, ErrorCode
from .schemas import IngestRunResponse, RunDetail, ErrorDetail, StatsResponse, IngestRun as IngestRunSchema
from .pipeline import CSVProcessor, FileIntegrityError, ValidationError

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.run_connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, run_id: str = None):
        await websocket.accept()
        self.active_connections.append(websocket)
        if run_id:
            if run_id not in self.run_connections:
                self.run_connections[run_id] = []
            self.run_connections[run_id].append(websocket)

    def disconnect(self, websocket: WebSocket, run_id: str = None):
        self.active_connections.remove(websocket)
        if run_id and run_id in self.run_connections:
            self.run_connections[run_id].remove(websocket)
            if not self.run_connections[run_id]:
                del self.run_connections[run_id]

    async def send_personal_message(self, message: str, websocket: WebSocket):
        await websocket.send_text(message)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except:
                # Connection closed, remove it
                self.active_connections.remove(connection)

    async def broadcast_to_run(self, message: str, run_id: str):
        if run_id in self.run_connections:
            disconnected = []
            for connection in self.run_connections[run_id]:
                try:
                    await connection.send_text(message)
                except:
                    disconnected.append(connection)
            
            # Clean up disconnected connections
            for conn in disconnected:
                self.run_connections[run_id].remove(conn)
                if conn in self.active_connections:
                    self.active_connections.remove(conn)

manager = ConnectionManager()

# Custom logger processor for WebSocket
def websocket_logger(logger, method_name: str, event_dict):
    """Send logs to WebSocket connections"""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            if "run_id" in event_dict:
                message = {
                    "type": "log",
                    "timestamp": datetime.utcnow().isoformat(),
                    "level": event_dict.get("level", "info"),
                    "message": event_dict.get("event", ""),
                    "run_id": event_dict.get("run_id"),
                    "data": event_dict
                }
                asyncio.create_task(manager.broadcast_to_run(json.dumps(message), event_dict["run_id"]))
            
            # Also broadcast to global console
            message = {
                "type": "log",
                "timestamp": datetime.utcnow().isoformat(),
                "level": event_dict.get("level", "info"),
                "message": event_dict.get("event", ""),
                "run_id": event_dict.get("run_id", "system"),
                "data": event_dict
            }
            asyncio.create_task(manager.broadcast(json.dumps(message)))
    except:
        # If no event loop or any other error, just skip WebSocket logging
        pass
    
    return event_dict

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
        structlog.processors.JSONRenderer(),
        websocket_logger,  # Custom processor for WebSocket
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
    expose_headers=["Content-Disposition"],
)

active_runs: Dict[str, Dict] = {}

@app.get("/")
async def root():
    return {"message": "PipeCheck API - CSV ingestion pipeline"}

@app.post("/upload", response_model=IngestRunResponse)
async def upload_csv(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    force: bool = Query(False, description="Force upload even if file hash exists")
):
    if not (file.filename.endswith('.csv') or 
            file.filename.endswith(('.xlsx', '.xls', '.xlsm'))):
        raise HTTPException(status_code=400, detail="Only CSV and Excel files are allowed")
    
    run_id = str(uuid.uuid4())
    
    # Stream file to disk and compute hash in chunks (handles large files)
    upload_dir = Path("uploads")
    upload_dir.mkdir(exist_ok=True)
    file_path = upload_dir / f"{run_id}_{file.filename}"
    
    file_hash = hashlib.sha256()
    file_size = 0
    chunk_size = 1024 * 1024  # 1MB chunks
    
    with open(file_path, "wb") as f:
        while True:
            chunk = await file.read(chunk_size)
            if not chunk:
                break
            f.write(chunk)
            file_hash.update(chunk)
            file_size += len(chunk)
    
    file_hash_hex = file_hash.hexdigest()
    logger.info("File uploaded", run_id=run_id, filename=file.filename, size_mb=round(file_size / 1024 / 1024, 2))
    
    db = next(get_db())
    
    existing_run = db.query(IngestRun).filter(
        IngestRun.file_hash == file_hash_hex
    ).first()
    
    if existing_run and not force:
        # Clean up the file we just saved
        try:
            os.remove(file_path)
        except:
            pass
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
        file_hash=file_hash_hex,
        status=RunStatus.PENDING,
        created_at=datetime.utcnow()
    )
    
    db.add(run)
    db.commit()
    
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
    run_logger = logger.bind(correlation_id=run_id, run_id=run_id)
    run_logger.info("Starting background processing task", file_path=file_path)
    
    db = SessionLocal()
    processor = CSVProcessor(db)
    
    try:
        run_logger.info("Starting CSV processing", file_path=file_path)
        
        # Update status to processing
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        if run:
            run.status = RunStatus.PROCESSING
            db.commit()
            run_logger.info("Updated run status to processing")
        
        # Process the CSV with enhanced validation
        results = await processor.process_csv(file_path, run_id)
        
        run_logger.info("CSV processing completed", **results)
        
    except FileIntegrityError as e:
        run_logger.error("File integrity error", error=str(e))
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        if run:
            run.status = RunStatus.FAILED
            run.completed_at = datetime.utcnow()
            run.error_message = str(e)
            db.commit()
            
    except ValidationError as e:
        run_logger.error("Validation error", error=str(e))
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        if run:
            run.status = RunStatus.FAILED
            run.completed_at = datetime.utcnow()
            run.error_message = str(e)
            db.commit()
            
    except Exception as e:
        run_logger.error("Unexpected error during processing", error=str(e), exc_info=True)
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
            run_logger.info("Cleaned up uploaded file", file_path=file_path)
        except:
            pass
            
        # Remove from active runs
        if run_id in active_runs:
            del active_runs[run_id]
            
        db.close()
        run_logger.info("Background processing task completed")

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
            "errors_count": run.errors_count,
            "error_message": run.error_message
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

@app.get("/runs/{run_id}/data")
async def get_run_data(run_id: str):
    """Get processed data for a run as JSON (for preview)"""
    db = next(get_db())
    
    run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    
    data_rows = db.query(DataRow).filter(DataRow.run_id == run_id).all()
    
    # Convert to list of dicts
    data = []
    for row in data_rows:
        normalized_data = json.loads(row.normalized_data)
        data.append(normalized_data)
    
    return {
        "run_id": run_id,
        "filename": run.filename,
        "total_rows": len(data),
        "data": data
    }

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

@app.websocket("/ws/{run_id}")
async def websocket_endpoint(websocket: WebSocket, run_id: str):
    await manager.connect(websocket, run_id)
    try:
        while True:
            # Keep connection alive
            await asyncio.sleep(10)
            await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        manager.disconnect(websocket, run_id)

@app.websocket("/ws")
async def websocket_global(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep connection alive
            await asyncio.sleep(10)
            await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.get("/logs/recent")
async def get_recent_logs(limit: int = 100):
    """Get recent logs from the database"""
    db = next(get_db())
    
    try:
        # Get recent error logs (you could also implement a full logging table)
        recent_errors = db.query(ErrorLog).order_by(ErrorLog.created_at.desc()).limit(limit).all()
        
        logs = []
        for error in recent_errors:
            logs.append({
                "timestamp": error.created_at.isoformat(),
                "level": "error",
                "message": f"Row {error.row_index}: {error.error_message}",
                "run_id": error.run_id
            })
        
        # Also get recent runs with their status
        recent_runs = db.query(IngestRun).order_by(IngestRun.created_at.desc()).limit(10).all()
        for run in recent_runs:
            logs.append({
                "timestamp": run.created_at.isoformat(),
                "level": "info",
                "message": f"File '{run.filename}' uploaded with status '{run.status}'",
                "run_id": run.id
            })
            
            if run.completed_at:
                logs.append({
                    "timestamp": run.completed_at.isoformat(),
                    "level": "info",
                    "message": f"Processing completed. Inserted: {run.rows_inserted}, Updated: {run.rows_updated}, Errors: {run.errors_count}",
                    "run_id": run.id
                })
        
        # Sort by timestamp
        logs.sort(key=lambda x: x["timestamp"], reverse=True)
        
        return logs[:limit]
        
    finally:
        db.close()

@app.delete("/runs/{run_id}")
async def delete_run(run_id: str):
    """Delete a specific run and all its associated data"""
    db = next(get_db())
    
    try:
        # Check if run exists
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        
        # Delete associated data rows
        db.query(DataRow).filter(DataRow.run_id == run_id).delete()
        
        # Delete associated error logs
        db.query(ErrorLog).filter(ErrorLog.run_id == run_id).delete()
        
        # Delete the run itself
        db.delete(run)
        db.commit()
        
        logger.info("Run deleted successfully", run_id=run_id)
        
        return {"message": "Run deleted successfully"}
        
    except Exception as e:
        db.rollback()
        logger.error("Failed to delete run", run_id=run_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to delete run")
        
    finally:
        db.close()

@app.delete("/runs")
async def delete_all_runs():
    """Delete all runs and associated data"""
    db = next(get_db())
    
    try:
        # Delete all data rows
        db.query(DataRow).delete()
        
        # Delete all error logs
        db.query(ErrorLog).delete()
        
        # Delete all runs
        db.query(IngestRun).delete()
        
        db.commit()
        
        logger.info("All runs deleted successfully")
        
        return {"message": "All runs deleted successfully"}
        
    except Exception as e:
        db.rollback()
        logger.error("Failed to delete all runs", error=str(e))
        raise HTTPException(status_code=500, detail="Failed to delete all runs")
        
    finally:
        db.close()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
