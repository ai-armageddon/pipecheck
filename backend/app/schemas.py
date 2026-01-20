from pydantic import BaseModel
from datetime import datetime
from typing import Optional
from .models import RunStatus, IngestRun

class IngestRunSchema(BaseModel):
    id: str
    filename: str
    status: RunStatus
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    total_rows: int = 0
    rows_inserted: int = 0
    rows_updated: int = 0
    rows_skipped: int = 0
    rows_rejected: int = 0
    errors_count: int = 0
    
    class Config:
        from_attributes = True

class IngestRunResponse(BaseModel):
    run_id: str
    status: RunStatus
    message: str
    created_at: datetime
    completed_at: Optional[datetime] = None
    total_rows: int = 0
    rows_inserted: int = 0
    rows_updated: int = 0
    rows_skipped: int = 0
    rows_rejected: int = 0
    errors_count: int = 0
    
    class Config:
        from_attributes = True

class RunDetail(BaseModel):
    run_id: str
    filename: str
    status: RunStatus
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    total_rows: int
    rows_inserted: int
    rows_updated: int
    rows_skipped: int
    errors_count: int
    
    class Config:
        from_attributes = True

class ErrorDetail(BaseModel):
    id: int
    row_index: int
    error_code: str
    error_message: str
    created_at: datetime
    
    class Config:
        from_attributes = True

class StatsResponse(BaseModel):
    total_runs: int
    completed_runs: int
    failed_runs: int
    success_rate: float
    total_rows_processed: int
    last_run: Optional[dict] = None
