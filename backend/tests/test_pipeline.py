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

    @staticmethod
    def reconciles(results):
        return (
            results["rows_inserted"] + results["rows_updated"]
            + results["rows_skipped"] + results["rows_rejected"]
        ) == results["total_rows"]

    async def test_unterminated_quote_at_end_is_rejected_not_dropped(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        path = csv_file('name,email\nok,a@b.com\nbad,"x@y.com\n')

        results = await processor.process_csv(path, run_id)

        assert results["total_rows"] == 2
        assert results["rows_rejected"] == 1
        assert self.reconciles(results)
        malformed = db.query(ErrorLog).filter(ErrorLog.error_code == "MALFORMED_ROW").one()
        assert "Line 3" in malformed.error_message
        assert "never closed" in malformed.error_message
        assert "x@y.com" in malformed.raw_data

    async def test_unterminated_quote_mid_file_does_not_import_the_swallowed_lines(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        path = csv_file('name,email\nfirst,a@b.com\n"broken,x@y.com\nlater,c@d.com\n')

        results = await processor.process_csv(path, run_id)

        assert results["rows_inserted"] == 1
        assert results["rows_rejected"] == 1
        assert self.reconciles(results)
        assert "later,c@d.com" in db.query(ErrorLog).filter(
            ErrorLog.error_code == "MALFORMED_ROW"
        ).one().raw_data

    async def test_early_long_row_does_not_shift_columns(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        # pandas used to treat the first column as an index here and move
        # every value one column to the left.
        path = csv_file("id,label,extra\n1,short\n2,a,b,c,TOO_MANY\n3,c,d\n")

        results = await processor.process_csv(path, run_id)

        assert results["rows_rejected"] == 1
        assert self.reconciles(results)
        stored = sorted(
            (json.loads(r.normalized_data) for r in db.query(DataRow).filter(DataRow.run_id == run_id)),
            key=lambda row: row["id"],
        )
        assert [row["id"] for row in stored] == ["1", "3"]
        assert stored[1]["label"] == "c"

    async def test_text_after_closing_quote_keeps_the_row(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        path = csv_file('name,note\n"Jane" ,x\nSam,y\n')

        results = await processor.process_csv(path, run_id)

        assert results["total_rows"] == 2
        assert results["rows_inserted"] == 2

    async def test_quoted_field_larger_than_the_csv_default_limit(
        self, processor, db, csv_file, make_run
    ):
        run_id = make_run()
        path = csv_file('name,note\nJane,"' + "x" * 200_000 + '"\nSam,y\n')

        results = await processor.process_csv(path, run_id)

        assert results["total_rows"] == 2
        assert results["rows_inserted"] == 2

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


async def test_quoted_multiline_header_cannot_change_the_dialect(processor, csv_file, make_run, db):
    run_id = make_run()
    path = csv_file('id;"cost, units,\nEUR";sku\n1;2;KeepCase\n')
    await processor.process_csv(path, run_id)
    assert normalized(db, run_id) == [{"id": "1", "cost, units,\nEUR": "2", "sku": "KeepCase"}]


async def test_mixed_ascii_prefix_and_utf8_tail(processor, csv_file, make_run, db):
    run_id = make_run()
    path = csv_file("id,label\n" + "1,ASCII\n" * 1600 + "2,東京\n")
    await processor.process_csv(path, run_id)
    assert normalized(db, run_id)[-1]["label"] == "東京"


async def test_file_repair_keeps_original_bytes_and_flags_inferred_headers(processor, make_run, csv_file, db, monkeypatch):
    from app.ai_fixer import AIFixer
    from pathlib import Path
    fixer = AIFixer("claude")
    async def complete(prompt, system, max_tokens):
        return '{"delimiter": "~", "can_be_fixed": true, "has_headers": false, "suggested_headers": ["id","note"]}'
    monkeypatch.setattr(fixer, "complete", complete)
    processor.fixer = fixer
    run_id = make_run()
    content = '1~"literal~value"\n2~text\n'
    path = csv_file(content)
    result = await processor.process_csv(path, run_id)
    assert Path(path).read_text() == content
    assert result["rows_flagged"] == result["errors_count"] == 2
    assert normalized(db, run_id)[0]["note"] == "literal~value"


async def test_groq_transport_repairs_without_using_live_credentials(monkeypatch):
    import httpx
    from groq import AsyncGroq
    from app.ai_fixer import AIFixer
    fixer = AIFixer("off")
    fixer.provider = "groq"
    def respond(request):
        assert request.url.path.endswith("/chat/completions")
        return httpx.Response(200, json={"id": "demo", "created": 1, "object": "chat.completion",
            "model": "demo", "choices": [{"index": 0, "finish_reason": "stop",
            "message": {"role": "assistant", "content": '{"email":"demo@example.org"}'}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        fixer.client = AsyncGroq(api_key="synthetic", http_client=client)
        fixer.enabled = True
        values, fixes = await fixer.fix_row({"email": "demo at example dot org"}, "Invalid email", ["email"])
        assert values["email"] == "demo@example.org" and len(fixes) == 1


async def test_single_column_csv_and_json_paste_input(processor, db, make_run, csv_file):
    run_id = make_run()
    await processor.process_csv(csv_file('sku\n"A,B"\nX-42\n'), run_id)
    assert normalized(db, run_id) == [{"sku": "A,B"}, {"sku": "X-42"}]
