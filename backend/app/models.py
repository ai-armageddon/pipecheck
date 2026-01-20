from sqlalchemy import Column, String, Integer, DateTime, Text, Boolean, BigInteger
from sqlalchemy.sql import func
from .database import Base
from datetime import datetime
import enum

class RunStatus(str, enum.Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    PARTIAL_SUCCESS = "partial_success"

class ErrorCode(str, enum.Enum):
    VALIDATION_ERROR = "VALIDATION_ERROR"
    PROCESSING_ERROR = "PROCESSING_ERROR"
    DUPLICATE_FILE = "DUPLICATE_FILE"
    INVALID_FORMAT = "INVALID_FORMAT"
    MISSING_REQUIRED = "MISSING_REQUIRED"
    INVALID_EMAIL = "INVALID_EMAIL"
    INVALID_PHONE = "INVALID_PHONE"
    ROW_PROCESSING_ERROR = "ROW_PROCESSING_ERROR"

class IngestRun(Base):
    __tablename__ = "ingest_runs"
    
    id = Column(String, primary_key=True, index=True)
    filename = Column(String, nullable=False)
    file_hash = Column(String, nullable=False, index=True)
    status = Column(String, default=RunStatus.PENDING, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    total_rows = Column(Integer, default=0)
    rows_inserted = Column(Integer, default=0)
    rows_updated = Column(Integer, default=0)
    rows_skipped = Column(Integer, default=0)
    rows_rejected = Column(Integer, default=0)
    errors_count = Column(Integer, default=0)
    error_message = Column(Text, nullable=True)

class DataRow(Base):
    __tablename__ = "data_rows"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    row_hash = Column(String, nullable=False, index=True, unique=True)
    run_id = Column(String, nullable=False, index=True)
    row_index = Column(Integer, nullable=False)
    normalized_data = Column(Text, nullable=False)
    raw_data = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

class ErrorLog(Base):
    __tablename__ = "error_logs"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String, nullable=False, index=True)
    row_index = Column(Integer, nullable=False)
    error_code = Column(String, nullable=False, index=True)
    error_message = Column(Text, nullable=False)
    raw_data = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
