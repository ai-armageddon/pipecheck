import pandas as pd
import hashlib
import json
import re
from datetime import datetime
from typing import Dict, List, Any, Tuple, Optional
import structlog
from sqlalchemy.orm import Session
from .models import DataRow, ErrorLog, IngestRun

logger = structlog.get_logger()

class ValidationError(Exception):
    pass

class CSVProcessor:
    def __init__(self, db: Session):
        self.db = db
        self.required_columns = ["email", "name"]
        self.optional_columns = ["phone", "address", "city", "state", "zip", "country"]
        
    async def process_csv(self, file_path: str, run_id: str) -> Dict[str, int]:
        try:
            df = pd.read_csv(file_path)
            logger.info("CSV loaded", rows=len(df), columns=list(df.columns))
            
            results = {
                "total_rows": len(df),
                "rows_inserted": 0,
                "rows_updated": 0,
                "rows_skipped": 0,
                "errors_count": 0
            }
            
            for index, row in df.iterrows():
                try:
                    result = await self.process_row(row, index, run_id)
                    if result == "inserted":
                        results["rows_inserted"] += 1
                    elif result == "updated":
                        results["rows_updated"] += 1
                    elif result == "skipped":
                        results["rows_skipped"] += 1
                        
                except Exception as e:
                    results["errors_count"] += 1
                    await self.log_error(run_id, index, "ROW_PROCESSING_ERROR", str(e), row.to_dict())
                    logger.warning("Row processing failed", run_id=run_id, row_index=index, error=str(e))
            
            return results
            
        except Exception as e:
            logger.error("CSV processing failed", run_id=run_id, error=str(e))
            raise
    
    async def process_row(self, row: pd.Series, row_index: int, run_id: str) -> str:
        validated_data = await self.validate_row(row, row_index)
        normalized_data = await self.normalize_data(validated_data)
        row_hash = self.generate_row_hash(normalized_data)
        
        existing_row = self.db.query(DataRow).filter(DataRow.row_hash == row_hash).first()
        
        if existing_row:
            if existing_row.run_id == run_id:
                return "skipped"
            else:
                existing_row.updated_at = datetime.utcnow()
                self.db.commit()
                return "updated"
        
        data_row = DataRow(
            row_hash=row_hash,
            run_id=run_id,
            row_index=row_index,
            normalized_data=json.dumps(normalized_data),
            raw_data=json.dumps(row.to_dict())
        )
        
        self.db.add(data_row)
        self.db.commit()
        
        return "inserted"
    
    async def validate_row(self, row: pd.Series, row_index: int) -> Dict[str, Any]:
        errors = []
        
        row_dict = row.to_dict()
        
        missing_required = []
        for col in self.required_columns:
            if col not in row_dict or pd.isna(row_dict[col]) or str(row_dict[col]).strip() == "":
                missing_required.append(col)
        
        if missing_required:
            raise ValidationError(f"Missing required columns: {', '.join(missing_required)}")
        
        if "email" in row_dict:
            email = str(row_dict["email"]).strip().lower()
            if not re.match(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$', email):
                errors.append("Invalid email format")
            row_dict["email"] = email
        
        if "phone" in row_dict and row_dict["phone"] and not pd.isna(row_dict["phone"]):
            phone = str(row_dict["phone"])
            digits = re.sub(r'[^\d]', '', phone)
            if len(digits) < 10:
                errors.append("Phone number must have at least 10 digits")
            row_dict["phone"] = digits
        
        if errors:
            raise ValidationError(f"Validation errors: {', '.join(errors)}")
        
        return row_dict
    
    async def normalize_data(self, data: Dict[str, Any]) -> Dict[str, Any]:
        normalized = {}
        
        for key, value in data.items():
            if pd.isna(value):
                normalized[key] = None
            elif isinstance(value, str):
                normalized[key] = value.strip().title() if key in ["name", "city"] else value.strip().lower()
            else:
                normalized[key] = value
        
        if "name" in normalized and normalized["name"]:
            name_parts = normalized["name"].split()
            normalized["first_name"] = name_parts[0] if name_parts else ""
            normalized["last_name"] = " ".join(name_parts[1:]) if len(name_parts) > 1 else ""
        
        if "address" in normalized and normalized["address"]:
            normalized["address"] = re.sub(r'\s+', ' ', normalized["address"]).strip()
        
        if "zip" in normalized and normalized["zip"]:
            zip_code = str(normalized["zip"]).split("-")[0]
            normalized["zip"] = zip_code.zfill(5) if zip_code.isdigit() else zip_code
        
        return normalized
    
    def generate_row_hash(self, data: Dict[str, Any]) -> str:
        hash_data = {
            "email": data.get("email", ""),
            "name": data.get("name", ""),
            "phone": data.get("phone", ""),
            "address": data.get("address", ""),
            "city": data.get("city", ""),
            "state": data.get("state", ""),
            "zip": data.get("zip", ""),
            "country": data.get("country", "")
        }
        
        hash_string = json.dumps(hash_data, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(hash_string.encode()).hexdigest()
    
    async def log_error(self, run_id: str, row_index: int, error_code: str, error_message: str, raw_data: Dict[str, Any]):
        error_log = ErrorLog(
            run_id=run_id,
            row_index=row_index,
            error_code=error_code,
            error_message=error_message,
            raw_data=json.dumps(raw_data)
        )
        
        self.db.add(error_log)
        self.db.commit()
