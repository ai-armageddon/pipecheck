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

    def test_delete_all_runs(self, client):
        upload(client, "a,b\n1,x\n")

        client.delete("/runs")

        assert client.get("/runs").json() == []

    def test_health(self, client):
        assert client.get("/health").json()["status"] == "healthy"
