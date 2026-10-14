"""盘外增强源（extra_sources）纯逻辑测试 —— 全程 monkeypatch，不出站。

重点测那些**错了也看不出来**的地方：
- KPL 日期回显核对：回显对不上目标日必须拒绝（复盘回看上一场是常态，
  把别的交易日的情绪当成被复盘那天的，比缺数据更糟）
- 短线侠播报：异常信封不解析、无效代码丢弃、限流节流存在
- hhxg 题材热度：latest_date 核对，历史日期冒充不了最新一期
"""

from __future__ import annotations

import pytest

from duanxian import extra_sources as es


class _Resp:
    """最小 requests 响应替身。"""

    def __init__(self, payload, ok=True):
        self._payload = payload
        self._ok = ok

    def raise_for_status(self):
        if not self._ok:
            raise RuntimeError("HTTP 500")
        return None

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


# ── KPL 情绪 ──────────────────────────────────────────────────────────────
class TestKplMood:
    def test_parses_fields_and_echoes_date(self, monkeypatch):
        payload = {"info": [{"Day": "2026-10-13", "ztjs": "82", "df_num": "7",
                             "strong": "1234", "lbgd": "6"}], "tip": "情绪偏热"}
        monkeypatch.setattr(es.dr, "_direct_get",
                            lambda *a, **kw: _Resp(payload))
        out = es.kpl_mood(expected_ymd="20261013")
        assert out["date"] == "2026-10-13"
        assert out["limit_up_count"] == 82
        assert out["max_consec_boards"] == 6
        assert out["tip"] == "情绪偏热"

    def test_rejects_session_mismatch(self, monkeypatch):
        """复盘 10-09，接口回的是 10-13 —— 必须当场拒绝。"""
        payload = {"info": [{"Day": "2026-10-13", "ztjs": 82}]}
        monkeypatch.setattr(es.dr, "_direct_get",
                            lambda *a, **kw: _Resp(payload))
        with pytest.raises(ValueError, match="不是目标日"):
            es.kpl_mood(expected_ymd="20261009")

    def test_rejects_missing_date_echo(self, monkeypatch):
        payload = {"info": [{"ztjs": 82}]}  # 无 Day
        monkeypatch.setattr(es.dr, "_direct_get",
                            lambda *a, **kw: _Resp(payload))
        with pytest.raises(ValueError, match="无日期回显"):
            es.kpl_mood()


# ── 短线侠涨停播报 ────────────────────────────────────────────────────────
class TestDuanxianxiaZtlive:
    def test_parses_rows_and_cleans_reason(self, monkeypatch):
        payload = {"result": "success", "list": [
            {"code": "002491", "name": "通鼎互联", "ztyy": "光纤光缆+数据中心+算力",
             "zt": "3", "time": "09:41"},
            {"code": "bad", "name": "无效", "ztyy": "x"},      # 代码无效 → 丢弃
            {"code": "600584", "name": "长电科技", "ztyy": "", "zt": "1"},
        ]}
        monkeypatch.setattr(es.dr, "_direct_get",
                            lambda *a, **kw: _Resp(payload))
        rows = es.duanxianxia_ztlive()
        assert [r["code"] for r in rows] == ["002491", "600584"]
        assert rows[0]["reason"] == "光纤光缆+数据中心+算力"
        assert rows[1]["reason"] == ""

    def test_rejects_bad_envelope(self, monkeypatch):
        monkeypatch.setattr(es.dr, "_direct_get",
                            lambda *a, **kw: _Resp({"result": "fail"}))
        with pytest.raises(ValueError, match="信封"):
            es.duanxianxia_ztlive()

    def test_rejects_empty_valid_rows(self, monkeypatch):
        monkeypatch.setattr(es.dr, "_direct_get",
                            lambda *a, **kw: _Resp({"result": "success", "list": []}))
        with pytest.raises(ValueError, match="无有效条目"):
            es.duanxianxia_ztlive()

    def test_throttle_exists(self):
        """免费通道限流 ≥10 秒 —— 没有它密集调用会整站 403。"""
        assert es._DXZX_MIN_INTERVAL >= 10.0


# ── hhxg 题材热度 ─────────────────────────────────────────────────────────
class TestHhxgThemeHeat:
    def test_parses_items(self, monkeypatch):
        payload = {"latest_date": "2026-10-13", "items": [
            {"name": "算力", "heat": 98.2, "limit_up": 12},
            {"name": "机器人", "heat": 87.1},
            {"noname": True},   # 缺名字 → 跳过
        ]}
        monkeypatch.setattr(es.dr, "_direct_get",
                            lambda *a, **kw: _Resp(payload))
        out = es.hhxg_theme_heat(expected_date="2026-10-13", top_n=2)
        assert out["date"] == "2026-10-13"
        assert [it["name"] for it in out["items"]] == ["算力", "机器人"]

    def test_rejects_stale_issue(self, monkeypatch):
        """只有 latest 一期：拿历史日期来问必须拒绝，不能拿今天的冒充。"""
        payload = {"latest_date": "2026-10-13", "items": [{"name": "算力"}]}
        monkeypatch.setattr(es.dr, "_direct_get",
                            lambda *a, **kw: _Resp(payload))
        with pytest.raises(ValueError, match="仅提供最新一期"):
            es.hhxg_theme_heat(expected_date="2026-10-09")


# ── data.py 接线 ──────────────────────────────────────────────────────────
class TestDataWiring:
    def test_extra_sources_block_lists_all_lines(self, monkeypatch):
        """块内三路各自独立缺席；整块永不返回空（体检查空即降级）。"""
        from duanxian import data

        def mood_ok(expected_ymd=None):
            return {"date": "2026-10-13", "sentiment": 1234,
                    "limit_up_count": 82, "max_consec_boards": 6,
                    "drawdown_count": 7, "tip": ""}

        def ztlive_fail():
            raise RuntimeError("网络不可用")

        def heat_fail(expected_date=None, top_n=15):
            raise ValueError("hhxg 题材热度是 2026-10-13 这一期，不是目标日 2026-10-09"
                             "（该源仅提供最新一期，无历史路径）")

        monkeypatch.setattr(es, "kpl_mood", mood_ok)
        monkeypatch.setattr(es, "duanxianxia_ztlive", ztlive_fail)
        monkeypatch.setattr(es, "hhxg_theme_heat", heat_fail)
        text = data.get_extra_sources_data("2026-10-09")
        assert text.strip()
        assert "开盘啦情绪" in text
        assert "短线侠涨停播报" in text
        assert "hhxg 题材热度榜" in text
        assert "不可用" in text  # 失败的两路要如实说
