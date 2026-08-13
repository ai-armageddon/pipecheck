import os
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

# Point the app at a throwaway database before app.database is imported.
os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.pop("GROQ_API_KEY", None)

from app.database import Base, engine, SessionLocal  # noqa: E402
from app.pipeline import CSVProcessor  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_schema():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def processor(db):
    return CSVProcessor(db)


@pytest.fixture
def csv_file(tmp_path):
    """Write CSV text to a temp file and return its path."""

    counter = {"n": 0}

    def _write(content: str, name: str = None) -> str:
        counter["n"] += 1
        target = tmp_path / (name or f"sample_{counter['n']}.csv")
        target.write_text(content)
        return str(target)

    return _write


@pytest.fixture
def make_run(db):
    """Create an IngestRun row and return its id."""
    from app.models import IngestRun, RunStatus
    import uuid
    from datetime import datetime

    def _make(filename: str = "sample.csv", file_hash: str = None) -> str:
        run_id = str(uuid.uuid4())
        db.add(
            IngestRun(
                id=run_id,
                filename=filename,
                file_hash=file_hash or run_id,
                status=RunStatus.PENDING,
                created_at=datetime.utcnow(),
            )
        )
        db.commit()
        return run_id

    return _make
