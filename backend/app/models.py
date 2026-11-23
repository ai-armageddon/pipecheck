from sqlalchemy import Column, String, Integer, DateTime, Text, Boolean, BigInteger, UniqueConstraint, ForeignKey
from sqlalchemy.orm import relationship
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
    MALFORMED_ROW = "MALFORMED_ROW"
    NEEDS_REVIEW = "NEEDS_REVIEW"

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
    rows_flagged = Column(Integer, default=0)
    errors_count = Column(Integer, default=0)
    error_message = Column(Text, nullable=True)

    repair_settings = relationship("RunRepairSettings", uselist=False, cascade="all, delete-orphan")


class RunRepairSettings(Base):
    __tablename__ = "run_repair_settings"

    run_id = Column(String, ForeignKey("ingest_runs.id"), primary_key=True)
    provider = Column(String, nullable=False)


class DataRow(Base):
    __tablename__ = "data_rows"

    # Uniqueness is per run, not global: a run owns its own snapshot of the file
    # so a later overlapping upload cannot take rows away from an earlier run.
    __table_args__ = (
        UniqueConstraint("run_id", "row_hash", name="uq_data_rows_run_id_row_hash"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    row_hash = Column(String, nullable=False, index=True)
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
