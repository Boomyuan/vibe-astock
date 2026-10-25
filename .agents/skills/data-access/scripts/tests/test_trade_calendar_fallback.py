"""交易日历的降级链：baostock 挂了不能整页瘫痪，必须退到新浪。

现场（2026-10-25 实测）：baostock 夜间时段性登录失败 `10002007 网络接收错误`，
而复盘页整页依赖这份日历 —— 主源一挂就拒绝取数，这是健壮性缺陷而不是数据问题。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fetch_trade_calendar as C  # noqa: E402


def _run(monkeypatch, tmp_path, argv=("--symbol", "300308", "--days", "30")):
    """跑 main()，返回解析后的 JSON 结果。"""
    import io
    monkeypatch.setattr(sys, "argv", ["fetch_trade_calendar.py", *argv, "--out-dir", str(tmp_path)])
    buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buf)
    try:
        C.main()
    except SystemExit:      # finish() 按 status 设退出码，测试里只关心 JSON
        pass
    return json.loads(buf.getvalue())


def _fake_akshare(days):
    def fn(start, today, out_dir):
        return list(days), {"raw_ref": None, "window": [days[0], days[-1]], "rows": len(days), "provenance": {"akshare": "test"}}
    return fn


def test_falls_back_to_akshare_when_baostock_login_fails(monkeypatch, tmp_path):
    def boom(start, today, out_dir):
        raise RuntimeError("baostock 登录失败 10002007 网络接收错误。")
    monkeypatch.setattr(C, "_trading_days_baostock", boom)
    monkeypatch.setattr(C, "_trading_days_akshare", _fake_akshare(["2026-10-21", "2026-10-22", "2026-10-23"]))
    d = _run(monkeypatch, tmp_path)

    assert d["status"] == "ok", "主源挂了不能整份结果失败"
    assert d["primary_source"] == "akshare" and d["used_sources"] == ["akshare"]
    assert d["extra"]["degraded"] is True
    assert d["extra"]["last_trading_day"] == "2026-10-23"
    assert d["extra"]["previous_trading_day"] == "2026-10-22"
    assert {e["source"] for e in d["evidence"]} == {"akshare"}, "证据要如实写实际来源，不能还挂着 baostock"
    assert any("baostock" in e["source"] for e in d["errors"]), "降级原因要留在 errors 里，不能吞"


def test_baostock_success_is_not_marked_degraded(monkeypatch, tmp_path):
    def ok(start, today, out_dir):
        return ["2026-10-21", "2026-10-22", "2026-10-23"], {"raw_ref": "raw/x.json", "window": ["2026-10-21", "2026-10-23"], "rows": 30, "provenance": {"baostock": "test"}}
    monkeypatch.setattr(C, "_trading_days_baostock", ok)
    monkeypatch.setattr(C, "_trading_days_akshare", _fake_akshare(["1999-01-01"]))
    d = _run(monkeypatch, tmp_path)
    assert d["status"] == "ok" and d["primary_source"] == "baostock"
    assert d["extra"]["degraded"] is False
    assert d["errors"] == []


def test_both_sources_down_is_failed_not_silent(monkeypatch, tmp_path):
    def boom(*_a, **_k):
        raise RuntimeError("no network")
    monkeypatch.setattr(C, "_trading_days_baostock", boom)
    monkeypatch.setattr(C, "_trading_days_akshare", boom)
    d = _run(monkeypatch, tmp_path)
    assert d["status"] == "failed"
    assert len([e for e in d["errors"] if e["source"] in ("baostock", "akshare")]) == 2
    assert any(e["source"] == "calendar" for e in d["errors"]), "总失败也要有一条总结性的错误"


def test_insufficient_window_falls_through_to_next_source(monkeypatch, tmp_path):
    """主源只给到 1 个交易日（回看窗口太短 / 源不全）也算不可用，要换源。"""
    def one(start, today, out_dir):
        return ["2026-10-23"], {"raw_ref": None, "window": ["2026-10-23", "2026-10-23"], "rows": 1, "provenance": {}}
    monkeypatch.setattr(C, "_trading_days_baostock", one)
    monkeypatch.setattr(C, "_trading_days_akshare", _fake_akshare(["2026-10-22", "2026-10-23"]))
    d = _run(monkeypatch, tmp_path)
    assert d["status"] == "ok" and d["primary_source"] == "akshare"
    assert d["extra"]["previous_trading_day"] == "2026-10-22"


@pytest.mark.parametrize("phase_want", [
    # (当天是否交易日, 时刻, 期望 phase, 期望 reference_quote_day 取哪一天)
    (True, "08:00", "pre_open", "prev"),
    (True, "10:00", "trading", "last"),
    (True, "16:00", "post_close", "last"),
    (False, "10:00", "non_trading_day", "last"),
])
def test_session_phase_and_reference_day(monkeypatch, tmp_path, phase_want):
    trading_today, clock, want_phase, ref = phase_want
    import fetch_trade_calendar as mod

    days = ["2026-10-22", "2026-10-23"] if trading_today else ["2026-10-21", "2026-10-22"]

    class FakeDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            hh, mm = map(int, clock.split(":"))
            d = datetime(2026, 10, 23, hh, mm, tzinfo=tz)
            return d

    monkeypatch.setattr(mod, "datetime", FakeDateTime)
    monkeypatch.setattr(C, "_trading_days_baostock", lambda *a: (days, {"raw_ref": None, "window": days, "rows": 2, "provenance": {}}))
    monkeypatch.setattr(C, "_trading_days_akshare", _fake_akshare(days))
    d = _run(monkeypatch, tmp_path)
    assert d["extra"]["session_phase"] == want_phase
    assert d["extra"]["is_today_trading_day"] is trading_today
    assert d["extra"]["reference_quote_day"] == (days[-2] if ref == "prev" else days[-1])
