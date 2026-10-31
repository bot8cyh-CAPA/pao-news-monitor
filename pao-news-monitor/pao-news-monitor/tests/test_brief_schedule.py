"""Days-per-brief schedule: a brief is written only when enough days have passed (offline)."""
from datetime import datetime, timedelta, timezone

from collector import brief
from collector.store import JsonStore

NOW = datetime(2026, 11, 7, 15, 47, tzinfo=timezone.utc)


def _ago(days):
    return (NOW - timedelta(days=days)).isoformat()


def test_no_previous_brief_is_always_due():
    assert brief.brief_due(None, 7, now=NOW)


def test_due_exactly_after_the_interval():
    assert brief.brief_due(_ago(7), 7, now=NOW)


def test_not_due_before_the_interval():
    assert not brief.brief_due(_ago(3), 7, now=NOW)


def test_grace_covers_a_slightly_late_scheduled_run():
    # 6.6 days is within the 12-hour grace of a 7-day interval, so the run still goes ahead
    assert brief.brief_due(_ago(6.6), 7, now=NOW)


def test_zero_means_always_write():
    assert brief.brief_due(_ago(0.01), 0, now=NOW)


def test_accepts_z_suffix_timestamps():
    assert brief.brief_due(_ago(8).replace("+00:00", "Z"), 7, now=NOW)


def test_local_store_reports_latest_brief_end(tmp_path):
    s = JsonStore(tmp_path / "local.json")
    assert s.latest_brief_end() is None
    s.data["briefs"] = [{"period_end": _ago(10)}, {"period_end": _ago(2)}, {"period_end": _ago(5)}]
    assert s.latest_brief_end() == _ago(2)
