import pandas as pd
import hashlib
import json
import re
import chardet
from datetime import datetime
from typing import Dict, List, Any, Tuple, Optional, Union
import structlog
from sqlalchemy.orm import Session
from .models import DataRow, ErrorLog, IngestRun

logger = structlog.get_logger()

class ValidationError(Exception):
    pass

class FileIntegrityError(Exception):
    pass

class CSVProcessor:
    def __init__(self, db: Session):
        self.db = db
        self.required_columns = ["email"]  # Only email is truly required
        self.optional_columns = ["name", "phone", "address", "city", "state", "zip", "country", "customer_id", "plan", "monthly_revenue", "signup_date", "is_active"]
        self.null_variants = ["", "NULL", "N/A", "n/a", "null", "-", "--", "none", "NONE"]
        
    async def process_csv(self, file_path: str, run_id: str) -> Dict[str, int]:
        try:
            # File integrity checks
            await self.validate_file_integrity(file_path)
            
            # Detect encoding and read file
            encoding = await self.detect_encoding(file_path)
            delimiter = await self.detect_delimiter(file_path, encoding)
            
            # Read with proper parameters
            df = await self.read_file_with_options(file_path, encoding, delimiter)
            
            logger.info("File loaded", run_id=run_id, rows=len(df), columns=list(df.columns))
            
            # Validate headers
            await self.validate_headers(df)
            
            results = {
                "total_rows": len(df),
                "rows_inserted": 0,
                "rows_updated": 0,
                "rows_skipped": 0,
                "rows_rejected": 0,
                "errors_count": 0
            }
            
            # Process rows in batches for large files
            batch_size = 1000
            for batch_start in range(0, len(df), batch_size):
                batch_end = min(batch_start + batch_size, len(df))
                batch_df = df.iloc[batch_start:batch_end]
                
                batch_results = await self.process_batch(batch_df, batch_start, run_id)
                
                for key in ["rows_inserted", "rows_updated", "rows_skipped", "rows_rejected", "errors_count"]:
                    results[key] += batch_results[key]
            
            # Update run status
            run = self.db.query(IngestRun).filter(IngestRun.id == run_id).first()
            if run:
                run.status = "completed" if results["rows_rejected"] == 0 else "partial_success"
                run.total_rows = results["total_rows"]
                run.rows_inserted = results["rows_inserted"]
                run.rows_updated = results["rows_updated"]
                run.rows_skipped = results["rows_skipped"]
                run.rows_rejected = results["rows_rejected"]
                run.completed_at = datetime.utcnow()
                self.db.commit()
            
            return results
            
        except Exception as e:
            logger.error("CSV processing failed", run_id=run_id, error=str(e), exc_info=True)
            
            # Update run status to failed
            run = self.db.query(IngestRun).filter(IngestRun.id == run_id).first()
            if run:
                run.status = "failed"
                run.completed_at = datetime.utcnow()
                self.db.commit()
            
            raise
    
    async def validate_file_integrity(self, file_path: str):
        """Check for empty files, header-only files, and file size"""
        file_size = 0
        
        with open(file_path, 'rb') as f:
            # Check file size
            f.seek(0, 2)  # Seek to end
            file_size = f.tell()
            f.seek(0)  # Reset to beginning
            
            # Read first few bytes to check if file is empty
            first_bytes = f.read(1024)
            if not first_bytes:
                raise FileIntegrityError("File is completely empty")
            
            # Check for header-only file
            if file_size < 1024:  # Small file, likely header-only
                content = first_bytes.decode('utf-8', errors='ignore')
                lines = content.strip().split('\n')
                if len(lines) <= 1:
                    raise FileIntegrityError("File contains only headers, no data rows")
        
        logger.info("File integrity check passed", file_size=file_size)
    
    async def detect_encoding(self, file_path: str) -> str:
        """Detect file encoding with fallback options"""
        with open(file_path, 'rb') as f:
            raw_data = f.read(10000)  # Read first 10KB
        
        result = chardet.detect(raw_data)
        encoding = result.get('encoding', 'utf-8')
        confidence = result.get('confidence', 0)
        
        # Fallback to common encodings if confidence is low
        if confidence < 0.7:
            encodings_to_try = ['utf-8', 'latin-1', 'cp1252', 'iso-8859-1']
            for enc in encodings_to_try:
                try:
                    with open(file_path, 'r', encoding=enc) as f:
                        f.read()
                    encoding = enc
                    break
                except UnicodeDecodeError:
                    continue
        
        logger.info("Detected encoding", encoding=encoding, confidence=confidence)
        return encoding
    
    async def detect_delimiter(self, file_path: str, encoding: str) -> str:
        """Detect CSV delimiter (comma, tab, semicolon, pipe)"""
        with open(file_path, 'r', encoding=encoding) as f:
            first_line = f.readline()
            
        delimiters = [',', '\t', ';', '|']
        delimiter_counts = {}
        
        for delim in delimiters:
            delimiter_counts[delim] = first_line.count(delim)
        
        # Choose delimiter with most occurrences
        best_delimiter = max(delimiter_counts, key=delimiter_counts.get)
        
        # If comma is not found but others are, it's likely wrong delimiter
        if delimiter_counts[best_delimiter] == 0:
            raise FileIntegrityError("Could not detect valid delimiter. File may not be properly formatted.")
        
        logger.info("Detected delimiter", delimiter=best_delimiter if best_delimiter != '\t' else 'TAB')
        return best_delimiter
    
    async def read_file_with_options(self, file_path: str, encoding: str, delimiter: str) -> pd.DataFrame:
        """Read file with proper error handling for large files"""
        try:
            # For large files, use chunking
            file_size = 0
            with open(file_path, 'rb') as f:
                f.seek(0, 2)
                file_size = f.tell()
            
            # Use on_bad_lines='warn' to handle rows with extra/missing columns
            if file_size > 50 * 1024 * 1024:  # 50MB threshold
                logger.warning("Large file detected, using streaming", file_size_mb=file_size / (1024*1024))
                df = pd.read_csv(file_path, encoding=encoding, delimiter=delimiter, 
                                dtype=str, keep_default_na=False, na_values=self.null_variants,
                                on_bad_lines='warn')
            else:
                df = pd.read_csv(file_path, encoding=encoding, delimiter=delimiter,
                                dtype=str, keep_default_na=False, na_values=self.null_variants,
                                on_bad_lines='warn')
            
            return df
            
        except UnicodeDecodeError as e:
            raise FileIntegrityError(f"Encoding error: {str(e)}. Please check file encoding.")
        except pd.errors.EmptyDataError:
            raise FileIntegrityError("No data found in file")
        except pd.errors.ParserError as e:
            # Try again with more lenient parsing
            logger.warning("Initial parse failed, trying lenient mode", error=str(e))
            try:
                df = pd.read_csv(file_path, encoding=encoding, delimiter=delimiter,
                                dtype=str, keep_default_na=False, na_values=self.null_variants,
                                on_bad_lines='skip')
                logger.info("Lenient parsing succeeded, some rows may have been skipped")
                return df
            except Exception as e2:
                raise FileIntegrityError(f"Parse error: {str(e)}. File may be corrupted or have inconsistent formatting.")
    
    async def validate_headers(self, df: pd.DataFrame):
        """Check for duplicate headers, missing required headers"""
        headers = list(df.columns)
        
        # Check for duplicate headers
        duplicate_headers = [h for h in headers if headers.count(h) > 1]
        if duplicate_headers:
            raise FileIntegrityError(f"Duplicate headers found: {', '.join(set(duplicate_headers))}")
        
        # Check for missing required columns
        missing_required = [col for col in self.required_columns if col not in headers]
        if missing_required:
            raise FileIntegrityError(f"Missing required columns: {', '.join(missing_required)}")
        
        logger.info("Header validation passed", headers=headers)
    
    async def process_batch(self, batch_df: pd.DataFrame, batch_start: int, run_id: str) -> Dict[str, int]:
        """Process a batch of rows with transaction safety"""
        results = {
            "rows_inserted": 0,
            "rows_updated": 0,
            "rows_skipped": 0,
            "rows_rejected": 0,
            "errors_count": 0
        }
        
        # Start transaction for batch
        try:
            for index, row in batch_df.iterrows():
                actual_index = batch_start + index
                
                try:
                    # Validate and process row
                    result = await self.process_row(row, actual_index, run_id)
                    
                    if result == "inserted":
                        results["rows_inserted"] += 1
                    elif result == "updated":
                        results["rows_updated"] += 1
                    elif result == "skipped":
                        results["rows_skipped"] += 1
                    
                except ValidationError as e:
                    # Row validation failed - reject with specific reason
                    results["rows_rejected"] += 1
                    results["errors_count"] += 1
                    await self.log_error(run_id, actual_index, "VALIDATION_ERROR", str(e), row.to_dict())
                    logger.warning("Row validation failed", run_id=run_id, row_index=actual_index, error=str(e))
                    
                except Exception as e:
                    # Unexpected error - reject row
                    results["rows_rejected"] += 1
                    results["errors_count"] += 1
                    await self.log_error(run_id, actual_index, "PROCESSING_ERROR", str(e), row.to_dict())
                    logger.error("Row processing error", run_id=run_id, row_index=actual_index, error=str(e))
            
            # Commit batch transaction
            self.db.commit()
            
        except Exception as e:
            # Rollback on batch failure
            self.db.rollback()
            logger.error("Batch processing failed", batch_start=batch_start, error=str(e))
            raise
        
        return results
    
    async def process_row(self, row: pd.Series, row_index: int, run_id: str) -> str:
        """Process individual row with enhanced validation"""
        validated_data = await self.validate_row(row, row_index)
        normalized_data = await self.normalize_data(validated_data)
        row_hash = self.generate_row_hash(normalized_data)
        
        # Check for existing row (idempotency)
        existing_row = self.db.query(DataRow).filter(DataRow.row_hash == row_hash).first()
        
        if existing_row:
            if existing_row.run_id == run_id:
                return "skipped"  # Duplicate in same run
            else:
                # Update existing record with upsert conflict resolution
                existing_row.updated_at = datetime.utcnow()
                existing_row.run_id = run_id  # Latest run wins
                existing_row.normalized_data = json.dumps(normalized_data)
                self.db.commit()
                return "updated"
        
        # Insert new row
        data_row = DataRow(
            row_hash=row_hash,
            run_id=run_id,
            row_index=row_index,
            normalized_data=json.dumps(normalized_data),
            raw_data=json.dumps(row.to_dict())
        )
        
        self.db.add(data_row)
        
        return "inserted"
    
    async def validate_row(self, row: pd.Series, row_index: int) -> Dict[str, Any]:
        """Enhanced row validation with detailed error messages"""
        errors = []
        row_dict = row.to_dict()
        
        # Check for completely empty rows
        if all(pd.isna(row_dict[col]) or str(row_dict[col]).strip() in self.null_variants for col in row_dict):
            raise ValidationError("Row is completely empty")
        
        # Validate required fields
        missing_required = []
        for col in self.required_columns:
            if col not in row_dict:
                missing_required.append(f"'{col}' column missing")
            elif pd.isna(row_dict[col]) or str(row_dict[col]).strip() in self.null_variants:
                missing_required.append(f"'{col}' is empty or null")
        
        if missing_required:
            raise ValidationError(f"Missing required fields: {', '.join(missing_required)}")
        
        # Email validation with detailed error
        if "email" in row_dict:
            email = str(row_dict["email"]).strip()
            if not email:
                raise ValidationError("Email cannot be empty")
            
            email = email.lower()
            if not re.match(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$', email):
                raise ValidationError(f"Invalid email format: '{email}'. Expected format: user@domain.com")
            row_dict["email"] = email
        
        # Phone validation with locale support
        if "phone" in row_dict and row_dict["phone"] and str(row_dict["phone"]).strip() not in self.null_variants:
            phone = str(row_dict["phone"]).strip()
            
            # Remove common formatting
            phone_clean = re.sub(r'[^\d+]', '', phone)
            
            if len(phone_clean) < 10:
                raise ValidationError(f"Phone number must have at least 10 digits: '{phone}'")
            
            # Store cleaned phone
            row_dict["phone"] = phone_clean
        
        # Name validation
        if "name" in row_dict:
            name = str(row_dict["name"]).strip()
            if len(name) < 2:
                raise ValidationError("Name must be at least 2 characters long")
            row_dict["name"] = name
        
        # Date validation for any date columns
        date_columns = ['date', 'created_at', 'updated_at', 'birth_date']
        for col in date_columns:
            if col in row_dict and row_dict[col] and str(row_dict[col]).strip() not in self.null_variants:
                date_str = str(row_dict[col]).strip()
                parsed_date = await self.parse_date(date_str)
                if parsed_date:
                    row_dict[col] = parsed_date
                else:
                    raise ValidationError(f"Invalid date format in '{col}': '{date_str}'")
        
        # Numeric validation
        numeric_columns = ['age', 'score', 'amount', 'price']
        for col in numeric_columns:
            if col in row_dict and row_dict[col] and str(row_dict[col]).strip() not in self.null_variants:
                num_str = str(row_dict[col]).strip()
                # Handle locale formats (1,000 vs 1.000)
                num_clean = num_str.replace(',', '')
                try:
                    row_dict[col] = float(num_clean)
                except ValueError:
                    raise ValidationError(f"Invalid number format in '{col}': '{num_str}'")
        
        return row_dict
    
    async def parse_date(self, date_str: str) -> Optional[str]:
        """Parse various date formats with locale support"""
        date_formats = [
            '%Y-%m-%d',    # 2026-01-16
            '%m/%d/%Y',    # 01/16/26
            '%m/%d/%y',    # 01/16/2026
            '%d/%m/%Y',    # 16/01/2026 (European)
            '%d-%m-%Y',    # 16-01-2026
            '%Y/%m/%d',    # 2026/01/16
            '%b %d, %Y',   # Jan 16, 2026
            '%B %d, %Y',   # January 16, 2026
        ]
        
        for fmt in date_formats:
            try:
                parsed = datetime.strptime(date_str, fmt)
                return parsed.isoformat()
            except ValueError:
                continue
        
        return None
    
    async def normalize_data(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Enhanced data normalization with locale handling"""
        normalized = {}
        
        for key, value in data.items():
            # Handle null variants
            if pd.isna(value) or (isinstance(value, str) and value.strip() in self.null_variants):
                normalized[key] = None
            elif isinstance(value, str):
                # Trim whitespace
                value = value.strip()
                
                # Title case for names, cities
                if key in ["name", "city", "first_name", "last_name"]:
                    normalized[key] = value.title()
                # Lowercase for emails
                elif key == "email":
                    normalized[key] = value.lower()
                # Uppercase for state codes, country codes
                elif key in ["state", "country"]:
                    normalized[key] = value.upper()
                else:
                    normalized[key] = value
            else:
                normalized[key] = value
        
        # Split name into first and last
        if "name" in normalized and normalized["name"]:
            name_parts = normalized["name"].split()
            normalized["first_name"] = name_parts[0] if name_parts else ""
            normalized["last_name"] = " ".join(name_parts[1:]) if len(name_parts) > 1 else ""
        
        # Normalize address
        if "address" in normalized and normalized["address"]:
            normalized["address"] = re.sub(r'\s+', ' ', normalized["address"]).strip()
        
        # Normalize ZIP/postal codes
        if "zip" in normalized and normalized["zip"]:
            zip_code = str(normalized["zip"]).split("-")[0]
            if zip_code.isdigit() and len(zip_code) <= 5:
                normalized["zip"] = zip_code.zfill(5)
            else:
                normalized["zip"] = zip_code
        
        return normalized
    
    def generate_row_hash(self, data: Dict[str, Any]) -> str:
        """Generate consistent hash for deduplication"""
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
        """Log detailed error information"""
        error_log = ErrorLog(
            run_id=run_id,
            row_index=row_index,
            error_code=error_code,
            error_message=error_message,
            raw_data=json.dumps(raw_data)
        )
        
        self.db.add(error_log)
    
    async def export_error_report(self, run_id: str) -> List[Dict[str, Any]]:
        """Export detailed error report for rejected rows"""
        errors = self.db.query(ErrorLog).filter(ErrorLog.run_id == run_id).all()
        
        report = []
        for error in errors:
            report.append({
                "row_index": error.row_index,
                "error_code": error.error_code,
                "error_message": error.error_message,
                "raw_data": json.loads(error.raw_data) if error.raw_data else {}
            })
        
        return report
    
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
