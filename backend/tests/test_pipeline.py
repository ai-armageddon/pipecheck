import json

import pytest

from app.models import DataRow, ErrorLog, IngestRun


def rows_for(db, run_id):
    return db.query(DataRow).filter(DataRow.run_id == run_id).order_by(DataRow.id).all()


def normalized(db, run_id):
    return [json.loads(r.normalized_data) for r in rows_for(db, run_id)]


class TestReportedCounters:
    async def test_errors_count_is_persisted_on_the_run(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file("a,b,c\n1,2,3\n,,\nNULL,N/A,-\n4,5,6\n")

        results = await processor.process_csv(path, run_id)

        logged = db.query(ErrorLog).filter(ErrorLog.run_id == run_id).count()
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        assert logged == 2
        assert results["errors_count"] == logged
        assert run.errors_count == logged, "errors_count must reach the run record the UI reads"

    async def test_counters_account_for_every_data_row(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file("a,b\n1,x\n2,y\n3,z\n")

        results = await processor.process_csv(path, run_id)

        accounted = (
            results["rows_inserted"]
            + results["rows_updated"]
            + results["rows_skipped"]
            + results["rows_rejected"]
        )
        assert results["total_rows"] == 3
        assert accounted == results["total_rows"]


class TestRowIndex:
    async def test_row_index_matches_file_position_across_batches(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        body = "\n".join(f"{i},Item_{i}" for i in range(2500))
        path = csv_file(f"id,label\n{body}\n")

        await processor.process_csv(path, run_id)

        stored = rows_for(db, run_id)
        assert len(stored) == 2500
        for row in stored:
            data = json.loads(row.normalized_data)
            assert row.row_index == int(data["id"]), (
                f"row_index {row.row_index} should match source row {data['id']}"
            )

    async def test_row_index_is_zero_based_and_contiguous(self, processor, db, csv_file, make_run):
        run_id = make_run()
        body = "\n".join(f"{i},v{i}" for i in range(1200))
        path = csv_file(f"id,label\n{body}\n")

        await processor.process_csv(path, run_id)

        indices = sorted(r.row_index for r in rows_for(db, run_id))
        assert indices == list(range(1200))


class TestMalformedLines:
    async def test_extra_column_row_is_reported_not_silently_dropped(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        path = csv_file("a,b\n1,x\n2,y,SURPRISE\n3,z\n")

        results = await processor.process_csv(path, run_id)
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()

        assert results["total_rows"] == 3, "the malformed line is still a data row"
        assert results["rows_rejected"] == 1
        assert run.status == "partial_success", "dropping a row is not a clean success"

        errors = db.query(ErrorLog).filter(ErrorLog.run_id == run_id).all()
        codes = {e.error_code for e in errors}
        assert "MALFORMED_ROW" in codes
        malformed = next(e for e in errors if e.error_code == "MALFORMED_ROW")
        assert "SURPRISE" in malformed.raw_data, "operator needs the offending content"
        assert "Line 3" in malformed.error_message, "must point at the real file line"

    async def test_malformed_line_numbers_are_the_real_file_lines(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        # Header on line 1; the malformed lines are 4 and 7.
        path = csv_file(
            "a,b\n"
            "1,x\n"
            "2,y\n"
            "3,z,BAD\n"
            "4,w\n"
            "5,v\n"
            "6,u,ALSO_BAD\n"
        )

        results = await processor.process_csv(path, run_id)

        assert results["rows_rejected"] == 2
        reported = sorted(
            e.error_message
            for e in db.query(ErrorLog).filter(ErrorLog.error_code == "MALFORMED_ROW").all()
        )
        assert "Line 4" in reported[0]
        assert "Line 7" in reported[1]

    async def test_quoted_delimiters_are_not_treated_as_malformed(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        path = csv_file('a,b\n1,"Smith, John"\n2,plain\n')

        results = await processor.process_csv(path, run_id)

        assert results["rows_rejected"] == 0
        assert normalized(db, run_id)[0]["b"] == "Smith, John"

    async def test_clean_file_reports_no_malformed_rows(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file("a,b\n1,x\n2,y\n")

        results = await processor.process_csv(path, run_id)

        assert results["rows_rejected"] == 0
        assert db.query(ErrorLog).filter(ErrorLog.run_id == run_id).count() == 0


class TestNormalization:
    async def test_case_is_preserved_for_unknown_columns(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file("customer_id,plan,sku\nCUST-1001,Professional,AB-99-Xy\n")

        await processor.process_csv(path, run_id)

        row = normalized(db, run_id)[0]
        assert row["plan"] == "Professional", "arbitrary column values must not be lowercased"
        assert row["sku"] == "AB-99-Xy"
        assert row["customer_id"] == "CUST-1001"

    async def test_known_columns_are_normalized(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file(
            "name,email,city,state,country\n"
            "  jane DOE ,Jane.Doe@Example.COM,new york,ny,usa\n"
        )

        await processor.process_csv(path, run_id)

        row = normalized(db, run_id)[0]
        assert row["name"] == "Jane Doe"
        assert row["email"] == "jane.doe@example.com"
        assert row["city"] == "New York"
        assert row["state"] == "NY"
        assert row["country"] == "USA"

    async def test_null_variants_become_none(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file("a,b,c,d\nkeep,N/A,none,--\n")

        await processor.process_csv(path, run_id)

        row = normalized(db, run_id)[0]
        assert row["a"] == "keep"
        assert row["b"] is None and row["c"] is None and row["d"] is None


class TestDeduplication:
    async def test_overlapping_upload_leaves_earlier_run_intact(
        self, processor, db, csv_file, make_run
    ):
        first = make_run("f1.csv", file_hash="hash-1")
        second = make_run("f2.csv", file_hash="hash-2")

        await processor.process_csv(csv_file("a,b\n1,x\n2,y\n3,z\n"), first)
        await processor.process_csv(csv_file("a,b\n1,x\n2,y\n3,z\n4,w\n"), second)

        assert len(rows_for(db, first)) == 3, "earlier run must keep its own rows"
        assert len(rows_for(db, second)) == 4
        first_run = db.query(IngestRun).filter(IngestRun.id == first).first()
        assert first_run.rows_inserted == len(rows_for(db, first))

    async def test_cross_run_overlap_is_counted_as_updated(
        self, processor, db, csv_file, make_run
    ):
        first = make_run("f1.csv", file_hash="hash-1")
        second = make_run("f2.csv", file_hash="hash-2")

        await processor.process_csv(csv_file("a,b\n1,x\n2,y\n"), first)
        results = await processor.process_csv(csv_file("a,b\n1,x\n2,y\n9,new\n"), second)

        assert results["rows_updated"] == 2
        assert results["rows_inserted"] == 1

    async def test_duplicate_rows_inside_one_run_are_skipped(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        path = csv_file("a,b\n1,x\n1,x\n2,y\n")

        results = await processor.process_csv(path, run_id)

        assert results["rows_inserted"] == 2
        assert results["rows_skipped"] == 1
        assert len(rows_for(db, run_id)) == 2


class TestFabricatedFixes:
    async def test_invented_email_is_flagged_for_review(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file("name,email\nMike Johnson,invalid.email.com\n")

        results = await processor.process_csv(path, run_id)

        row = normalized(db, run_id)[0]
        assert row["email"] == "invalid@email.com", "the fix is still applied"
        assert row["_needs_review"] is True, "invented data must be flagged"
        assert any("@" in f for f in row["_fixes_applied"])
        assert results["rows_flagged"] == 1

        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        assert run.rows_flagged == 1
        assert run.status == "partial_success", "a run containing invented data is not clean"

        flagged = db.query(ErrorLog).filter(ErrorLog.error_code == "NEEDS_REVIEW").all()
        assert len(flagged) == 1
        assert flagged[0].row_index == 0

    async def test_padded_phone_is_flagged_for_review(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file("name,phone\nAmy Smith,555-3333\n")

        await processor.process_csv(path, run_id)

        row = normalized(db, run_id)[0]
        assert row["phone"] == "0005553333", "placeholder area code is invented"
        assert row["_needs_review"] is True

    async def test_discarded_phone_is_flagged_for_review(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file("name,phone\nAmy Smith,555-333\n")

        await processor.process_csv(path, run_id)

        row = normalized(db, run_id)[0]
        assert row["phone"] is None, "unusable phone is dropped"
        assert row["_needs_review"] is True, "losing a value is also worth review"

    async def test_deterministic_cleanup_is_not_flagged(self, processor, db, csv_file, make_run):
        run_id = make_run()
        path = csv_file("name,email,phone\nJane Doe,Jane.Doe@Example.com,(555) 987-6543\n")

        results = await processor.process_csv(path, run_id)

        row = normalized(db, run_id)[0]
        assert row.get("_needs_review") is not True, "trim/case/format fixes invent nothing"
        assert results["rows_flagged"] == 0
        run = db.query(IngestRun).filter(IngestRun.id == run_id).first()
        assert run.status == "completed"


class TestFileIntegrity:
    async def test_empty_file_fails_clearly(self, processor, csv_file, make_run):
        from app.pipeline import FileIntegrityError

        with pytest.raises(FileIntegrityError, match="empty"):
            await processor.process_csv(csv_file(""), make_run())

    async def test_header_only_file_fails_clearly(self, processor, csv_file, make_run):
        from app.pipeline import FileIntegrityError

        with pytest.raises(FileIntegrityError, match="only headers"):
            await processor.process_csv(csv_file("a,b,c\n"), make_run())

    async def test_large_header_only_file_is_still_caught(self, processor, csv_file, make_run):
        from app.pipeline import FileIntegrityError

        wide_header = ",".join(f"column_{i}" for i in range(400))
        with pytest.raises(FileIntegrityError, match="only headers"):
            await processor.process_csv(csv_file(wide_header + "\n"), make_run())

    async def test_semicolon_delimiter_is_detected(self, processor, db, csv_file, make_run):
        run_id = make_run()

        results = await processor.process_csv(csv_file("a;b;c\n1;2;3\n4;5;6\n"), run_id)

        assert results["total_rows"] == 2
        assert normalized(db, run_id)[0] == {"a": "1", "b": "2", "c": "3"}

    async def test_duplicate_headers_are_rejected(self, processor, csv_file, make_run):
        from app.pipeline import FileIntegrityError

        with pytest.raises(FileIntegrityError, match="Duplicate headers"):
            await processor.process_csv(csv_file("a,b,a\n1,2,3\n"), make_run())
