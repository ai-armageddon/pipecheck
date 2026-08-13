from sqlalchemy import create_engine, inspect
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./pipecheck.db")

# Use StaticPool for SQLite to handle concurrent access better
if "sqlite" in DATABASE_URL:
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool
    )
else:
    engine = create_engine(DATABASE_URL, pool_size=20, max_overflow=30)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def legacy_row_hash_index() -> bool:
    """True if data_rows still carries the old globally-unique row_hash index.

    That index let a later upload steal rows from an earlier run. create_all()
    cannot rewrite an existing constraint, so databases created before the fix
    have to be recreated for it to take effect.
    """
    inspector = inspect(engine)
    if "data_rows" not in inspector.get_table_names():
        return False

    for index in inspector.get_indexes("data_rows"):
        if index.get("unique") and index.get("column_names") == ["row_hash"]:
            return True
    return False


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
