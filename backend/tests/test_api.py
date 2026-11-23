import io

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import IngestRun


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with TestClient(app) as test_client:
        yield test_client


def upload(client, content: str, name: str = "sample.csv", **params):
    return client.post(
        "/upload",
        files={"file": (name, io.BytesIO(content.encode()), "text/csv")},
        params=params,
    )


class TestUpload:
    def test_upload_processes_file_and_reports_status(self, client):
        run_id = upload(client, "a,b\n1,x\n2,y\n").json()["run_id"]

        run = client.get(f"/runs/{run_id}").json()
        assert run["status"] == "completed"
        assert run["total_rows"] == 2
        assert client.get(f"/runs/{run_id}/data").json()["total_rows"] == 2

    def test_duplicate_upload_is_skipped(self, client):
        upload(client, "a,b\n1,x\n")
        second = upload(client, "a,b\n1,x\n")

        assert second.json()["status"] == "skipped"

    def test_force_reuploads_duplicate(self, client):
        first = upload(client, "a,b\n1,x\n").json()["run_id"]
        second = upload(client, "a,b\n1,x\n", force=True).json()

        assert second["run_id"] != first
        assert second["status"] == "pending"

    def test_non_csv_upload_is_rejected(self, client):
        response = client.post(
            "/upload", files={"file": ("notes.txt", io.BytesIO(b"hello"), "text/plain")}
        )
        assert response.status_code == 400

    def test_extension_check_is_case_insensitive(self, client):
        response = upload(client, "a,b\n1,x\n", name="SAMPLE.CSV")

        assert response.status_code == 200
        assert client.get(f"/runs/{response.json()['run_id']}").json()["status"] == "completed"

    def test_empty_upload_is_rejected_without_leaking_a_file(self, client, tmp_path):
        response = upload(client, "", name="empty.csv")

        assert response.status_code == 400
        assert response.json()["detail"] == "Uploaded file is empty"
        assert not list((tmp_path / "uploads").glob("*"))

    def test_upload_size_limit_removes_partial_file(self, client, tmp_path, monkeypatch):
        import app.main as main

        monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 8)
        response = upload(client, "a,b\n123456789,x\n", name="large.csv")

        assert response.status_code == 413
        assert not list((tmp_path / "uploads").glob("*"))

    def test_uploaded_filename_is_sanitized(self, client):
        response = upload(client, "a,b\n1,x\n", name="../unsafe.csv")

        assert response.status_code == 200
        assert client.get("/runs").json()[0]["filename"] == "unsafe.csv"


class TestExcelUpload:
    @staticmethod
    def workbook(*sheets):
        import openpyxl

        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        for title, rows in sheets:
            ws = wb.create_sheet(title)
            for row in rows:
                ws.append(row)
        buffer = io.BytesIO()
        wb.save(buffer)
        return buffer.getvalue()

    def post(self, client, content: bytes, name: str = "people.xlsx"):
        return client.post("/upload", files={"file": (name, io.BytesIO(content), "application/octet-stream")})

    def test_xlsx_rows_are_imported_not_read_as_text(self, client):
        content = self.workbook(("People", [["name", "email"], ["Jane", "jane@example.com"], ["Sam", "sam@example.com"]]))
        run_id = self.post(client, content).json()["run_id"]

        run = client.get(f"/runs/{run_id}").json()
        assert run["status"] == "completed"
        assert run["total_rows"] == 2
        names = sorted(row["name"] for row in client.get(f"/runs/{run_id}/data").json()["data"])
        assert names == ["Jane", "Sam"]

    def test_only_the_first_sheet_is_imported(self, client):
        content = self.workbook(
            ("First", [["name"], ["Jane"]]),
            ("Second", [["name"], ["Ignored"], ["Also ignored"]]),
        )
        run_id = self.post(client, content).json()["run_id"]

        assert client.get(f"/runs/{run_id}").json()["total_rows"] == 1

    def test_corrupt_workbook_fails_with_a_clear_message(self, client):
        run_id = self.post(client, b"this is not a zip file").json()["run_id"]

        run = client.get(f"/runs/{run_id}").json()
        assert run["status"] == "failed"
        assert "Could not read Excel file" in run["error_message"]

    def test_excel_run_can_be_reprocessed(self, client):
        content = self.workbook(("People", [["name"], ["Jane"]]))
        run_id = self.post(client, content).json()["run_id"]

        assert client.post(f"/runs/{run_id}/reprocess").status_code == 200
        run = client.get(f"/runs/{run_id}").json()
        assert run["status"] == "completed"
        assert run["total_rows"] == 1


class TestExportRoutes:
    def test_export_all_is_not_shadowed_by_run_id_route(self, client):
        upload(client, "a,b\n1,x\n2,y\n")

        response = client.get("/export/all", params={"format": "csv"})

        assert response.status_code == 200, "/export/all must not be parsed as a run_id"
        assert "run_id" in response.text
        assert "1,x" in response.text.replace("\r", "")

    def test_export_all_reports_empty_state_distinctly(self, client):
        response = client.get("/export/all")
        assert response.status_code == 404
        assert response.json()["detail"] != "Run not found"

    def test_export_single_run(self, client):
        run_id = upload(client, "a,b\n1,x\n").json()["run_id"]

        response = client.get(f"/export/{run_id}")

        assert response.status_code == 200
        assert "attachment" in response.headers["content-disposition"]

    def test_export_unknown_run_is_404(self, client):
        assert client.get("/export/does-not-exist").status_code == 404

    def test_error_report_export(self, client):
        run_id = upload(client, "a,b\n1,x\n2,y,EXTRA\n").json()["run_id"]

        response = client.get(f"/errors/{run_id}/export")

        assert response.status_code == 200
        assert "MALFORMED_ROW" in response.text


class TestReprocess:
    def test_reprocess_works_after_initial_processing(self, client):
        run_id = upload(client, "a,b\n1,x\n2,y\n").json()["run_id"]
        assert client.get(f"/runs/{run_id}").json()["status"] == "completed"

        response = client.post(f"/runs/{run_id}/reprocess")

        assert response.status_code == 200, "the source file must survive processing"
        run = client.get(f"/runs/{run_id}").json()
        assert run["status"] == "completed"
        assert run["total_rows"] == 2
        assert client.get(f"/runs/{run_id}/data").json()["total_rows"] == 2

    def test_reprocess_unknown_run_is_404(self, client):
        assert client.post("/runs/nope/reprocess").status_code == 404

    def test_deleting_a_run_removes_its_stored_file(self, client, tmp_path):
        run_id = upload(client, "a,b\n1,x\n").json()["run_id"]
        uploads = tmp_path / "uploads"
        assert list(uploads.glob(f"{run_id}_*")), "file retained for reprocess"

        client.delete(f"/runs/{run_id}")

        assert not list(uploads.glob(f"{run_id}_*")), "deleting a run must not leak files"


class TestRunRecovery:
    def test_runs_interrupted_by_a_restart_are_failed_at_startup(self, tmp_path, monkeypatch, db):
        from datetime import datetime
        from app.models import RunStatus

        db.add(IngestRun(
            id="orphan", filename="orphan.csv", file_hash="orphan",
            status=RunStatus.PROCESSING, created_at=datetime.utcnow(),
        ))
        db.commit()
        monkeypatch.chdir(tmp_path)

        with TestClient(app) as client:
            run = client.get("/runs/orphan").json()
            assert run["status"] == "failed"
            assert "server restart" in run["error_message"]
            assert client.delete("/runs/orphan").status_code == 200

    @pytest.mark.filterwarnings("ignore::sqlalchemy.exc.SAWarning")
    def test_failure_is_recorded_when_the_session_needs_a_rollback(self, client, monkeypatch):
        from datetime import datetime
        from app.pipeline import CSVProcessor

        async def broken_process_csv(self, file_path, run_id):
            # A duplicate primary key leaves the session in a failed state.
            self.db.add(IngestRun(id=run_id, filename="x", file_hash="x", created_at=datetime.utcnow()))
            self.db.flush()

        monkeypatch.setattr(CSVProcessor, "process_csv", broken_process_csv)
        run_id = upload(client, "a,b\n1,x\n").json()["run_id"]

        run = client.get(f"/runs/{run_id}").json()
        assert run["status"] == "failed"
        assert run["error_message"].startswith("Internal error")


class TestLegacySchemaDetection:
    def test_current_schema_is_not_reported_as_legacy(self):
        from app.database import legacy_row_hash_index

        assert legacy_row_hash_index() is False

    def test_globally_unique_row_hash_is_reported_as_legacy(self):
        from sqlalchemy import text

        from app.database import engine, legacy_row_hash_index

        with engine.begin() as conn:
            conn.execute(text("CREATE UNIQUE INDEX legacy_ix ON data_rows (row_hash)"))
        try:
            assert legacy_row_hash_index() is True
        finally:
            with engine.begin() as conn:
                conn.execute(text("DROP INDEX legacy_ix"))


class TestRunsAndStats:
    def test_stats_reflect_completed_runs(self, client):
        upload(client, "a,b\n1,x\n")

        stats = client.get("/stats").json()

        assert stats["total_runs"] == 1
        assert stats["completed_runs"] == 1
        assert stats["total_rows_processed"] == 1

    def test_stats_count_partial_success_as_processed(self, client):
        upload(client, "a,b\n1,x\n2,y,EXTRA\n")

        stats = client.get("/stats").json()

        assert stats["partial_runs"] == 1
        assert stats["total_rows_processed"] == 2
        assert stats["success_rate"] == 100

    def test_delete_all_refuses_while_a_run_is_active(self, client):
        from app.main import active_runs

        active_runs["busy"] = {"status": "processing", "progress": 10}
        try:
            response = client.delete("/runs")
            assert response.status_code == 409
        finally:
            active_runs.pop("busy", None)

    def test_delete_all_runs(self, client):
        upload(client, "a,b\n1,x\n")

        client.delete("/runs")

        assert client.get("/runs").json() == []

    def test_health(self, client):
        assert client.get("/health").json()["status"] == "healthy"


class TestReview:
    def test_source_order_and_pages_survive_rejections_and_multiline_values(self, client):
        content = 'name,email\n"Jo\nLee",jo@example.org\nbad,row,extra\nSam,sam.example.org\n,\n'
        run_id = upload(client, content).json()["run_id"]
        url = f"/runs/{run_id}/review"
        page = client.get(url, params={"offset": 1, "limit": 1}).json()
        assert page["total"] == 2
        assert len(page["rows"]) == 1
        row = page["rows"][0]
        assert row["row_index"] == 2
        assert row["original"]["email"] == "sam.example.org"
        assert row["values"]["email"] == "sam@example.org"
        assert row["needs_review"] and row["fixes"]
        flagged = client.get(url, params={"view": "flagged"}).json()
        assert [r["row_index"] for r in flagged["rows"]] == [2]
        rejected = client.get(url, params={"view": "rejected"}).json()
        assert [r["row_index"] for r in rejected["rows"]] == [1, 3]
        assert client.get(url, params={"offset": 10}).json() == {"total": 2, "rows": []}
        assert client.get(f"/runs/{run_id}/source").content == content.encode()

    def test_legacy_nan_is_readable_and_limits_are_checked(self, client, db):
        from app.models import DataRow
        run_id = upload(client, "a,b\nold,\n").json()["run_id"]
        db.query(DataRow).filter_by(run_id=run_id).update({"raw_data": '{"a":"old","b":NaN}'})
        db.commit()
        url = f"/runs/{run_id}/review"
        assert client.get(url).json()["rows"][0]["original"]["b"] is None
        assert client.get(url, params={"limit": 101}).status_code == 422
        assert client.get(url, params={"offset": -1}).status_code == 422
        assert client.get("/runs/missing/review").status_code == 404

    def test_workbook_review_and_original_download(self, client):
        workbook = TestExcelUpload.workbook(("Sheet 1", [["sku", "priority"], ["A1", 0]]))
        run_id = TestExcelUpload().post(client, workbook).json()["run_id"]
        assert client.get(f"/runs/{run_id}/review").json()["rows"][0]["values"]["priority"] == "0"
        assert client.get(f"/runs/{run_id}/source").content == workbook


class TestProviders:
    def test_cli_cannot_be_used_from_nonlocal_client(self, client):
        response = client.post("/upload", headers={"X-PipeCheck-Provider": "codex"},
                               files={"file": ("a.csv", b"a,b\n1,2\n")})
        assert response.status_code == 403
        assert client.get("/runs").json() == []

    @pytest.mark.parametrize("provider", ["claude", "codex"])
    def test_selected_provider_used_for_upload_and_reprocess(self, client, monkeypatch, provider):
        import app.main as main
        from app.ai_fixer import AIFixer
        seen = []
        async def status(name):
            return "subscription"
        async def complete(self, prompt, system, max_tokens):
            seen.append(self.provider)
            return '{"email":"demo@example.org","name":"Unexpected edit"}'
        monkeypatch.setattr(main, "local_cli_access", lambda request: True)
        monkeypatch.setattr(main, "cli_status", status)
        monkeypatch.setattr(AIFixer, "complete", complete)
        headers = {"X-PipeCheck-Provider": provider}
        run_id = client.post("/upload", headers=headers, files={
            "file": ("demo.csv", b"name,email\nDemo,demo at example dot org\n")
        }).json()["run_id"]
        row = client.get(f"/runs/{run_id}/review").json()["rows"][0]
        assert row["values"]["name"] == "Demo"
        assert row["needs_review"] and row["values"]["email"] == "demo@example.org"
        assert client.post(f"/runs/{run_id}/reprocess", headers=headers).status_code == 200
        assert client.get(f"/runs/{run_id}").json()["repair_provider"] == provider
        assert seen == [provider, provider]
        assert client.post(f"/runs/{run_id}/reprocess", headers={"X-PipeCheck-Provider": "off"}).status_code == 200
        assert client.get("/runs").json()[0]["repair_provider"] == "off"
        assert len(seen) == 2
        assert client.get(f"/runs/{run_id}/review").json()["rows"][0]["values"]["email"] == "demo at example dot org"

    def test_missing_sign_in_preserves_existing_run(self, client, monkeypatch):
        import app.main as main
        async def signed_out(name):
            return "signed_out"
        monkeypatch.setattr(main, "local_cli_access", lambda request: True)
        monkeypatch.setattr(main, "cli_status", signed_out)
        run_id = upload(client, "a,b\na,b\n").json()["run_id"]
        assert client.post(f"/runs/{run_id}/reprocess", headers={"X-PipeCheck-Provider": "claude"}).status_code == 409
        assert client.get(f"/runs/{run_id}/review").json()["total"] == 1


@pytest.mark.parametrize("provider", ["claude", "codex"])
def test_native_subscription_connect_is_idempotent(client, monkeypatch, tmp_path, provider):
    import os
    import time
    import app.main as main
    monkeypatch.setattr(main, "local_cli_access", lambda request: True)
    commands = {
        "claude": ("auth status --json", "auth login --claudeai"),
        "codex": ("login status", "login"),
    }
    status_args, login_args = commands[provider]
    executable = tmp_path / provider
    executable.write_text(f'''#!/bin/sh
case "$*" in
    "{status_args}")
        if [ -f "{tmp_path}/signed-in" ]; then
            echo '{"Logged in using ChatGPT" if provider == "codex" else '{"loggedIn":true,"authMethod":"claude.ai"}'}'
            exit 0
        fi
        echo '{"Not logged in" if provider == "codex" else '{"loggedIn":false}'}'
        exit 1 ;;
    "{login_args}")
        echo login >> "{tmp_path}/launches"
        while [ ! -f "{tmp_path}/consent" ]; do sleep 0.05; done
        touch "{tmp_path}/signed-in" ;;
    *) exit 2 ;;
esac
''')
    executable.chmod(0o755)
    # Both probes must only use test binaries.
    (tmp_path / ("codex" if provider == "claude" else "claude")).symlink_to(executable)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    endpoint = f"/providers/{provider}/connect"
    headers = {"X-PipeCheck-Provider": provider}
    assert client.get("/providers").json()["states"][provider] == "signed_out"
    assert client.post(endpoint, headers=headers).status_code == 202
    assert client.post(endpoint, headers=headers).json() == {"connection": "pending"}
    assert client.get("/providers").json()["connections"][provider] == "pending"
    (tmp_path / "consent").touch()
    for _ in range(80):
        result = client.get("/providers").json()
        if result["connections"][provider] == "finished":
            break
        time.sleep(0.025)
    assert result["states"][provider] == "subscription"
    assert client.post(endpoint, headers=headers).json() == {"connection": "connected"}
    assert (tmp_path / "launches").read_text() == "login\n"


def test_provider_login_requires_local_access_and_matching_header(client, monkeypatch):
    import app.main as main
    assert client.post("/providers/codex/connect", headers={"X-PipeCheck-Provider": "codex"}).status_code == 403
    monkeypatch.setattr(main, "local_cli_access", lambda request: True)
    assert client.post("/providers/claude/connect").status_code == 422
    assert client.post("/providers/claude/connect", headers={"X-PipeCheck-Provider": "codex"}).status_code == 403
    assert client.post("/providers/groq/connect", headers={"X-PipeCheck-Provider": "groq"}).status_code == 422
