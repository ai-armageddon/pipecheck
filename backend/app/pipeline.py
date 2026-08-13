import pandas as pd
import csv
import hashlib
import json
import re
import chardet
from datetime import datetime
from typing import Dict, List, Any, Tuple, Optional, NamedTuple
import structlog
from sqlalchemy.orm import Session
from .models import DataRow, ErrorLog, IngestRun
from .ai_fixer import ai_fixer

logger = structlog.get_logger()


class ValidationError(Exception):
    pass


class FileIntegrityError(Exception):
    pass


class DataFix(NamedTuple):
    """A repair applied to a row.

    ``fabricated`` marks fixes that invent information rather than reformat what
    was already there. Those rows stay in the output but are flagged for review
    so nobody mistakes a guess for source data.
    """

    description: str
    fabricated: bool


class CSVProcessor:
    def __init__(self, db: Session):
        self.db = db
        # No required columns by default - accept any schema
        self.required_columns = []
        # Known columns for special processing (email validation, phone formatting, etc.)
        self.known_columns = ["email", "name", "phone", "address", "city", "state", "zip", "country", "customer_id", "plan", "monthly_revenue", "signup_date", "is_active"]
        self.null_variants = ["", "NULL", "N/A", "n/a", "null", "-", "--", "none", "NONE", "nan", "NaN"]
        self.email_pattern = re.compile(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')

    async def process_csv(self, file_path: str, run_id: str) -> Dict[str, int]:
        try:
            # File integrity checks
            await self.validate_file_integrity(file_path)

            # Detect encoding and read file
            encoding = await self.detect_encoding(file_path)

            # Try to detect delimiter, use AI repair if it fails
            try:
                delimiter = await self.detect_delimiter(file_path, encoding)
            except FileIntegrityError as e:
                # Delimiter detection failed - try AI repair
                if ai_fixer.enabled:
                    logger.info("Attempting AI file repair", run_id=run_id, error=str(e))

                    # Read the raw file content
                    with open(file_path, 'r', encoding=encoding) as f:
                        file_content = f.read()

                    # Let AI analyze and repair the file
                    repaired_content, ai_fixes, delimiter = await ai_fixer.repair_file_content(file_content, str(e))

                    if ai_fixes:
                        logger.info("AI repaired file", run_id=run_id, fixes=ai_fixes)

                        # Write repaired content back to file
                        with open(file_path, 'w', encoding=encoding) as f:
                            f.write(repaired_content)

                        # Store AI fixes in run record
                        run = self.db.query(IngestRun).filter(IngestRun.id == run_id).first()
                        if run:
                            run.error_message = "AI Repairs: " + "; ".join(ai_fixes)
                            self.db.commit()
                    else:
                        # AI couldn't fix it either
                        raise e
                else:
                    raise e

            # Validate headers against the raw header line, before pandas renames
            # any duplicates (it silently turns a second "id" into "id.1").
            await self.validate_headers(file_path, encoding, delimiter)

            # Read with proper parameters
            df, bad_lines = await self.read_file_with_options(file_path, encoding, delimiter)

            logger.info("File loaded", run_id=run_id, rows=len(df), columns=list(df.columns))

            results = {
                # A line the parser could not use is still a row the operator
                # handed us, so it counts toward the total and toward rejections.
                "total_rows": len(df) + len(bad_lines),
                "rows_inserted": 0,
                "rows_updated": 0,
                "rows_skipped": 0,
                "rows_rejected": len(bad_lines),
                "rows_flagged": 0,
                "errors_count": len(bad_lines),
            }

            for bad_line in bad_lines:
                line_number = bad_line["line_number"]
                where = f"Line {line_number}" if line_number else "A line"
                await self.log_error(
                    run_id,
                    # row_index is the file line when known; -1 means unlocated.
                    line_number - 1 if line_number else -1,
                    "MALFORMED_ROW",
                    f"{where} has {len(bad_line['fields'])} fields, "
                    f"expected {len(df.columns)}. Row was not imported.",
                    {"raw_line": delimiter.join(bad_line["fields"])},
                )
                logger.warning(
                    "Malformed line rejected",
                    run_id=run_id,
                    line_number=line_number,
                    fields=len(bad_line["fields"]),
                )

            # Hashes already stored by this run, so duplicates inside a single
            # file are detected without relying on uncommitted session state.
            seen_hashes = set()

            # Process rows in batches for large files
            batch_size = 1000
            for batch_start in range(0, len(df), batch_size):
                batch_end = min(batch_start + batch_size, len(df))
                batch_df = df.iloc[batch_start:batch_end]

                batch_results = await self.process_batch(batch_df, batch_start, run_id, seen_hashes)

                for key in ["rows_inserted", "rows_updated", "rows_skipped", "rows_rejected", "rows_flagged", "errors_count"]:
                    results[key] += batch_results[key]

            self.db.commit()

            # Update run status
            run = self.db.query(IngestRun).filter(IngestRun.id == run_id).first()
            if run:
                clean = results["rows_rejected"] == 0 and results["rows_flagged"] == 0
                run.status = "completed" if clean else "partial_success"
                run.total_rows = results["total_rows"]
                run.rows_inserted = results["rows_inserted"]
                run.rows_updated = results["rows_updated"]
                run.rows_skipped = results["rows_skipped"]
                run.rows_rejected = results["rows_rejected"]
                run.rows_flagged = results["rows_flagged"]
                run.errors_count = results["errors_count"]
                run.completed_at = datetime.utcnow()
                self.db.commit()

            return results

        except Exception as e:
            logger.error("CSV processing failed", run_id=run_id, error=str(e), exc_info=True)

            # Update run status to failed
            self.db.rollback()
            run = self.db.query(IngestRun).filter(IngestRun.id == run_id).first()
            if run:
                run.status = "failed"
                run.completed_at = datetime.utcnow()
                self.db.commit()

            raise

    async def validate_file_integrity(self, file_path: str):
        """Check for empty files, header-only files, and file size"""
        with open(file_path, 'rb') as f:
            f.seek(0, 2)  # Seek to end
            file_size = f.tell()
            f.seek(0)  # Reset to beginning

            if file_size == 0:
                raise FileIntegrityError("File is completely empty")

            # Count non-empty lines, stopping as soon as we know there is data.
            # Streaming keeps this cheap and correct for very wide headers too.
            non_empty = 0
            for raw_line in f:
                if raw_line.strip():
                    non_empty += 1
                    if non_empty > 1:
                        break

        if non_empty == 0:
            raise FileIntegrityError("File is completely empty")
        if non_empty == 1:
            raise FileIntegrityError("File contains only headers, no data rows")

        logger.info("File integrity check passed", file_size=file_size)

    async def detect_encoding(self, file_path: str) -> str:
        """Detect file encoding with fallback options"""
        with open(file_path, 'rb') as f:
            raw_data = f.read(10000)  # Read first 10KB

        result = chardet.detect(raw_data)
        encoding = result.get('encoding') or 'utf-8'
        confidence = result.get('confidence') or 0

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

    async def read_file_with_options(
        self, file_path: str, encoding: str, delimiter: str
    ) -> Tuple[pd.DataFrame, List[Dict[str, Any]]]:
        """Read the file, returning the frame plus any lines the parser rejected.

        Bad lines are captured instead of discarded so a run can never report
        success while quietly losing rows.
        """
        bad_lines: List[Dict[str, Any]] = []

        def collect_bad_line(fields: List[str]):
            bad_lines.append({"line_number": None, "fields": fields})
            return None

        read_options = dict(
            encoding=encoding,
            delimiter=delimiter,
            dtype=str,
            keep_default_na=False,
            na_values=self.null_variants,
        )

        try:
            df = pd.read_csv(
                file_path,
                engine="python",
                on_bad_lines=collect_bad_line,
                **read_options,
            )
            if bad_lines:
                self.attach_line_numbers(bad_lines, file_path, encoding, delimiter, len(df.columns))
            return df, bad_lines

        except UnicodeDecodeError as e:
            raise FileIntegrityError(f"Encoding error: {str(e)}. Please check file encoding.")
        except pd.errors.EmptyDataError:
            raise FileIntegrityError("No data found in file")
        except pd.errors.ParserError as e:
            # Try again with more lenient parsing
            logger.warning("Initial parse failed, trying lenient mode", error=str(e))
            try:
                bad_lines.clear()
                df = pd.read_csv(file_path, engine="python", on_bad_lines="skip", **read_options)
                logger.warning("Lenient parsing succeeded, rows may have been skipped")
                return df, bad_lines
            except Exception:
                raise FileIntegrityError(f"Parse error: {str(e)}. File may be corrupted or have inconsistent formatting.")

    def attach_line_numbers(
        self,
        bad_lines: List[Dict[str, Any]],
        file_path: str,
        encoding: str,
        delimiter: str,
        expected_fields: int,
    ):
        """Fill in the real file line number for each rejected line.

        pandas reports the offending fields but not where they came from, and a
        row number an operator cannot look up is useless. csv.reader tracks
        line numbers and applies the same quoting rules, so a second cheap pass
        recovers them.
        """
        located = []
        try:
            with open(file_path, "r", encoding=encoding, newline="") as f:
                reader = csv.reader(f, delimiter=delimiter)
                for fields in reader:
                    if fields and len(fields) != expected_fields:
                        located.append(reader.line_num)
        except (OSError, csv.Error) as e:
            logger.warning("Could not resolve malformed line numbers", error=str(e))
            return

        # Only trust the mapping when both passes agree on how many lines were bad.
        if len(located) != len(bad_lines):
            logger.warning(
                "Malformed line count mismatch, reporting without line numbers",
                pandas_count=len(bad_lines),
                csv_count=len(located),
            )
            return

        for bad_line, line_number in zip(bad_lines, located):
            bad_line["line_number"] = line_number

    async def validate_headers(self, file_path: str, encoding: str, delimiter: str):
        """Check for duplicate headers, missing required headers"""
        with open(file_path, 'r', encoding=encoding) as f:
            header_line = f.readline()

        headers = [h.strip().strip('"') for h in header_line.rstrip('\r\n').split(delimiter)]

        # Check for duplicate headers
        duplicate_headers = {h for h in headers if headers.count(h) > 1}
        if duplicate_headers:
            raise FileIntegrityError(f"Duplicate headers found: {', '.join(sorted(duplicate_headers))}")

        # Check for missing required columns
        missing_required = [col for col in self.required_columns if col not in headers]
        if missing_required:
            raise FileIntegrityError(f"Missing required columns: {', '.join(missing_required)}")

        logger.info("Header validation passed", headers=headers)

    async def process_batch(
        self, batch_df: pd.DataFrame, batch_start: int, run_id: str, seen_hashes: set
    ) -> Dict[str, int]:
        """Process a batch of rows with transaction safety"""
        results = {
            "rows_inserted": 0,
            "rows_updated": 0,
            "rows_skipped": 0,
            "rows_rejected": 0,
            "rows_flagged": 0,
            "errors_count": 0
        }

        # Start transaction for batch
        try:
            # ``position`` is the offset within this batch; iterrows() yields the
            # frame's own absolute label, which must not be added to batch_start.
            for position, (_, row) in enumerate(batch_df.iterrows()):
                actual_index = batch_start + position

                try:
                    # Validate and process row
                    result, fabricated = await self.process_row(row, actual_index, run_id, seen_hashes)

                    if result == "inserted":
                        results["rows_inserted"] += 1
                    elif result == "updated":
                        results["rows_updated"] += 1
                    elif result == "skipped":
                        results["rows_skipped"] += 1

                    if fabricated:
                        results["rows_flagged"] += 1
                        results["errors_count"] += 1
                        await self.log_error(
                            run_id,
                            actual_index,
                            "NEEDS_REVIEW",
                            "Row was repaired with invented values: " + "; ".join(fabricated),
                            row.to_dict(),
                        )
                        logger.warning("Row flagged for review", run_id=run_id, row_index=actual_index, fixes=fabricated)

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

    async def process_row(
        self, row: pd.Series, row_index: int, run_id: str, seen_hashes: set
    ) -> Tuple[str, List[str]]:
        """Process individual row with auto-fix, AI-fix, and enhanced validation.

        Returns the outcome plus the descriptions of any invented values, so the
        caller can flag the row for review.
        """
        # First try to auto-fix the row
        fixed_data, fixes_applied = await self.auto_fix_row(row, row_index, run_id)

        # Try to validate - if it fails, attempt AI fix
        try:
            validated_data = await self.validate_row_lenient(fixed_data, row_index)
        except ValidationError as e:
            # Auto-fix failed, try AI fix
            logger.info("Validation failed, checking AI fixer", run_id=run_id, row_index=row_index, error=str(e), ai_enabled=ai_fixer.enabled)
            if ai_fixer.enabled:
                logger.info("Attempting AI fix", run_id=run_id, row_index=row_index, error=str(e))
                ai_fixed_data, ai_fixes = await ai_fixer.fix_row(
                    fixed_data,
                    str(e),
                    list(row.index)
                )
                logger.info("AI fix returned", run_id=run_id, row_index=row_index, fixes=ai_fixes)
                # Anything the model produced is inferred, never source data.
                fixes_applied.extend(DataFix(fix, fabricated=True) for fix in ai_fixes)

                # Try validation again with AI-fixed data
                try:
                    validated_data = await self.validate_row_lenient(ai_fixed_data, row_index)
                    fixed_data = ai_fixed_data
                    logger.info("AI fix successful", run_id=run_id, row_index=row_index, fixes=ai_fixes)
                except ValidationError as e2:
                    # AI fix also failed, re-raise original error
                    logger.warning("AI fix validation failed", run_id=run_id, row_index=row_index, error=str(e2))
                    raise e
            else:
                logger.warning("AI fixer not enabled", run_id=run_id, row_index=row_index)
                raise e

        normalized_data = await self.normalize_data(validated_data)
        row_hash = self.generate_row_hash(normalized_data)
        fabricated = [fix.description for fix in fixes_applied if fix.fabricated]

        # Store fixes applied for reporting
        if fixes_applied:
            normalized_data['_fixes_applied'] = [fix.description for fix in fixes_applied]
        if fabricated:
            normalized_data['_needs_review'] = True

        # Duplicate within this same run
        if row_hash in seen_hashes:
            return "skipped", fabricated

        existing_row = self.db.query(DataRow).filter(
            DataRow.run_id == run_id, DataRow.row_hash == row_hash
        ).first()
        if existing_row:
            return "skipped", fabricated

        # Rows identical to an earlier run are re-recorded against this run so
        # each run keeps a complete, independently exportable snapshot. The
        # earlier run keeps its own copy.
        seen_before = self.db.query(DataRow).filter(DataRow.row_hash == row_hash).first() is not None

        data_row = DataRow(
            row_hash=row_hash,
            run_id=run_id,
            row_index=row_index,
            normalized_data=json.dumps(normalized_data),
            raw_data=json.dumps(row.to_dict())
        )

        self.db.add(data_row)
        seen_hashes.add(row_hash)

        return ("updated" if seen_before else "inserted"), fabricated

    async def auto_fix_row(self, row: pd.Series, row_index: int, run_id: str) -> Tuple[Dict[str, Any], List[DataFix]]:
        """Attempt to auto-fix common data issues"""
        row_dict = row.to_dict()
        fixes_applied: List[DataFix] = []

        # Fix email issues
        if "email" in row_dict:
            email = str(row_dict.get("email", "")).strip()
            original_email = email

            # Fix missing @ symbol (e.g., "john.smith.example.com" -> try to fix)
            if email and "@" not in email:
                # Try to find common domain patterns
                domain_patterns = ['.com', '.io', '.co', '.net', '.org', '.biz']
                for pattern in domain_patterns:
                    if pattern in email:
                        idx = email.rfind(pattern)
                        # Find the last dot before the domain
                        prefix = email[:idx]
                        suffix = email[idx:]
                        # Find where the domain starts (last segment before .com etc)
                        parts = prefix.rsplit('.', 1)
                        if len(parts) == 2:
                            email = f"{parts[0]}@{parts[1]}{suffix}"
                            # Where the @ belongs is a guess: the address may
                            # resolve to a mailbox that is not the intended one.
                            fixes_applied.append(DataFix(
                                f"Fixed email: added @ symbol ({original_email} -> {email})",
                                fabricated=True,
                            ))
                            break

            # Fix emails starting with @
            if email.startswith("@"):
                email = ""  # Can't fix, will be caught by validation

            # Lowercase and trim
            if email:
                email = email.lower().strip()
                if email != original_email.lower().strip():
                    fixes_applied.append(DataFix("Normalized email to lowercase", fabricated=False))

            row_dict["email"] = email

        # Fix phone number issues
        if "phone" in row_dict:
            phone = str(row_dict.get("phone", "")).strip()
            original_phone = phone

            if phone and phone not in self.null_variants:
                # Remove all non-digit characters except +
                phone_clean = re.sub(r'[^\d+]', '', phone)

                # If phone is too short, try to pad with area code or mark as incomplete
                if len(phone_clean) < 10 and len(phone_clean) >= 7:
                    # Assume US number missing area code - add placeholder
                    phone_clean = "000" + phone_clean
                    fixes_applied.append(DataFix(
                        f"Phone number padded with placeholder area code ({original_phone} -> {phone_clean})",
                        fabricated=True,
                    ))
                elif len(phone_clean) < 7:
                    # Too short to fix, set to empty
                    phone_clean = ""
                    fixes_applied.append(DataFix(
                        f"Phone number too short, cleared ({original_phone})",
                        fabricated=True,
                    ))

                row_dict["phone"] = phone_clean

        # Fix name issues
        if "name" in row_dict:
            name = str(row_dict.get("name", "")).strip()

            # If name is empty but we have email, try to extract from email
            if (not name or name in self.null_variants) and "email" in row_dict:
                email = str(row_dict.get("email", ""))
                if "@" in email:
                    email_prefix = email.split("@")[0]
                    # Convert email prefix to name (john.doe -> John Doe)
                    name_parts = re.split(r'[._-]', email_prefix)
                    extracted_name = " ".join(part.capitalize() for part in name_parts if part)
                    if len(extracted_name) >= 2:
                        row_dict["name"] = extracted_name
                        fixes_applied.append(DataFix(
                            f"Extracted name from email: {extracted_name}",
                            fabricated=True,
                        ))

        # Fix missing email - check if there's an email-like value in other columns
        if "email" in row_dict and (not row_dict["email"] or row_dict["email"] in self.null_variants):
            for col, val in row_dict.items():
                if col != "email" and val and "@" in str(val):
                    potential_email = str(val).strip().lower()
                    if self.email_pattern.match(potential_email):
                        row_dict["email"] = potential_email
                        fixes_applied.append(DataFix(
                            f"Found email in '{col}' column: {potential_email}",
                            fabricated=True,
                        ))
                        break

        # Log fixes if any were applied
        if fixes_applied:
            logger.info(
                "Auto-fixes applied",
                run_id=run_id,
                row_index=row_index,
                fixes=[fix.description for fix in fixes_applied],
            )

        return row_dict, fixes_applied

    async def validate_row_lenient(self, row_dict: Dict[str, Any], row_index: int) -> Dict[str, Any]:
        """Lenient row validation - only reject truly unfixable issues"""
        # Check for completely empty rows
        if all(pd.isna(row_dict.get(col)) or str(row_dict.get(col, "")).strip() in self.null_variants for col in row_dict):
            raise ValidationError("Row is completely empty")

        # Only validate email if it exists in the schema
        if "email" in row_dict:
            email = str(row_dict.get("email", "")).strip()
            if email and email not in self.null_variants:
                # Validate email format only if present
                if not self.email_pattern.match(email):
                    # Don't reject, just log warning - AI may fix later
                    logger.warning("Invalid email format", email=email, row_index=row_index)
                else:
                    row_dict["email"] = email.lower()

        # Phone is optional but if present, just clean it (don't reject)
        if "phone" in row_dict and row_dict["phone"] and str(row_dict["phone"]).strip() not in self.null_variants:
            phone = str(row_dict["phone"]).strip()
            phone_clean = re.sub(r'[^\d+]', '', phone)
            row_dict["phone"] = phone_clean if phone_clean else None

        # Name is optional
        if "name" in row_dict:
            name = str(row_dict.get("name", "")).strip()
            row_dict["name"] = name if name and name not in self.null_variants else None

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
                    # Unknown columns keep their original casing: this pipeline
                    # accepts any schema and must not mangle values it cannot
                    # reason about (SKUs, plan tiers, external ids).
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
        """Generate consistent hash for deduplication - uses all columns"""
        # Use all non-internal columns for hash
        hash_data = {k: str(v) if v is not None else "" for k, v in data.items() if not k.startswith('_')}
        hash_string = json.dumps(hash_data, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(hash_string.encode()).hexdigest()

    async def log_error(self, run_id: str, row_index: int, error_code: str, error_message: str, raw_data: Dict[str, Any]):
        """Log detailed error information"""
        error_log = ErrorLog(
            run_id=run_id,
            row_index=row_index,
            error_code=error_code,
            error_message=error_message,
            raw_data=json.dumps(raw_data, default=str)
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
