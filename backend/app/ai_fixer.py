import os
import json
import time
from typing import Dict, Any, Optional, List, Tuple
from groq import Groq
from dotenv import load_dotenv
import structlog

load_dotenv()

logger = structlog.get_logger()

class AIFixer:
    """AI-powered data fixer using Groq API"""
    
    def __init__(self):
        self.api_key = os.getenv("GROQ_API_KEY")
        self.client = None
        self.enabled = False
        self.model = "llama-3.1-8b-instant"  # Fast, free tier friendly
        
        # Rate limiting for free tier (30 req/min, 6000 tokens/min)
        self.requests_per_minute = 25  # Stay under limit
        self.last_request_time = 0
        self.request_count = 0
        self.minute_start = time.time()
        
        if self.api_key:
            try:
                self.client = Groq(api_key=self.api_key)
                self.enabled = True
                logger.info("Groq AI Fixer initialized", model=self.model)
            except Exception as e:
                logger.warning("Failed to initialize Groq client", error=str(e))
        else:
            logger.info("Groq API key not found, AI fixing disabled")
    
    def _rate_limit(self):
        """Enforce rate limiting for free tier"""
        current_time = time.time()
        
        # Reset counter every minute
        if current_time - self.minute_start >= 60:
            self.request_count = 0
            self.minute_start = current_time
        
        # Check if we're at the limit
        if self.request_count >= self.requests_per_minute:
            sleep_time = 60 - (current_time - self.minute_start)
            if sleep_time > 0:
                logger.info("Rate limit reached, waiting", sleep_seconds=sleep_time)
                time.sleep(sleep_time)
                self.request_count = 0
                self.minute_start = time.time()
        
        self.request_count += 1
    
    async def fix_row(self, row_data: Dict[str, Any], error_message: str, all_columns: List[str]) -> Tuple[Dict[str, Any], List[str]]:
        """
        Use AI to fix a problematic row.
        Returns (fixed_data, fixes_applied)
        """
        if not self.enabled:
            return row_data, []
        
        self._rate_limit()
        
        fixes_applied = []
        
        try:
            # Build context about the row
            prompt = f"""You are a data cleaning assistant. Fix the following CSV row data that has validation errors.

Row data (JSON):
{json.dumps(row_data, indent=2)}

Error: {error_message}

Available columns: {', '.join(all_columns)}

Rules:
1. If email is missing or invalid (like 'nan', empty, or malformed), try to generate a plausible email from the name or other data
2. If name is missing, try to extract it from email or generate from context
3. Keep all other fields unchanged
4. Return ONLY valid JSON with the fixed data, no explanation

Example: If name is "John Smith" and email is missing, generate "john.smith@example.com"

Return the fixed row as JSON:"""

            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "You are a data cleaning assistant. Return only valid JSON, no markdown or explanation."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.1,
                max_tokens=500
            )
            
            result_text = response.choices[0].message.content.strip()
            
            # Clean up the response (remove markdown code blocks if present)
            if result_text.startswith("```"):
                result_text = result_text.split("```")[1]
                if result_text.startswith("json"):
                    result_text = result_text[4:]
                result_text = result_text.strip()
            
            # Parse the JSON response
            fixed_data = json.loads(result_text)
            
            # Track what was fixed
            for key, value in fixed_data.items():
                if key in row_data:
                    old_value = str(row_data.get(key, ""))
                    new_value = str(value)
                    if old_value != new_value and new_value:
                        fixes_applied.append(f"AI fixed {key}: '{old_value}' -> '{new_value}'")
                        row_data[key] = value
            
            if fixes_applied:
                logger.info("AI fixes applied", fixes=fixes_applied)
            
            return row_data, fixes_applied
            
        except json.JSONDecodeError as e:
            logger.warning("AI returned invalid JSON", error=str(e), response=result_text[:200] if 'result_text' in locals() else "N/A")
            return row_data, []
        except Exception as e:
            logger.warning("AI fix failed", error=str(e))
            return row_data, []
    
    async def generate_email_from_name(self, name: str) -> Optional[str]:
        """Generate a plausible email from a name"""
        if not self.enabled or not name:
            return None
        
        self._rate_limit()
        
        try:
            prompt = f"""Generate a professional email address for someone named "{name}".
Use the format: firstname.lastname@example.com
Return ONLY the email address, nothing else."""

            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "user", "content": prompt}
                ],
                temperature=0.1,
                max_tokens=50
            )
            
            email = response.choices[0].message.content.strip().lower()
            
            # Validate it looks like an email
            if "@" in email and "." in email:
                logger.info("AI generated email", name=name, email=email)
                return email
            
            return None
            
        except Exception as e:
            logger.warning("AI email generation failed", error=str(e))
            return None
    
    async def infer_missing_data(self, row_data: Dict[str, Any], missing_field: str) -> Optional[str]:
        """Infer a missing field value from other data in the row"""
        if not self.enabled:
            return None
        
        self._rate_limit()
        
        try:
            prompt = f"""Given this row data:
{json.dumps(row_data, indent=2)}

What would be a reasonable value for the missing field "{missing_field}"?
Return ONLY the value, nothing else. If you cannot determine a reasonable value, return "UNKNOWN"."""

            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "user", "content": prompt}
                ],
                temperature=0.1,
                max_tokens=100
            )
            
            value = response.choices[0].message.content.strip()
            
            if value and value != "UNKNOWN":
                logger.info("AI inferred value", field=missing_field, value=value)
                return value
            
            return None
            
        except Exception as e:
            logger.warning("AI inference failed", error=str(e))
            return None


# Singleton instance
ai_fixer = AIFixer()
