"""模拟盘：配置校验、成交流水还原账户、目标 vs 持仓生成下单清单、
期末不平仓（模拟盘与回测的唯一差别）、以及还原净值与引擎净值必须对得上。"""
from __future__ import annotations

import json
import os
import sys

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
import backtest.paper as P  # noqa: E402
from backtest.gate import plan_backtest  # noqa: E402
from backtest.run import make_engine  # noqa: E402
from backtest.strategies import BUILTIN  # noqa: E402

SPEC = {"codes": ["600519.SH", "000651.SZ"], "strategy": "buy_and_hold",
        "style": "swing", "initial_cash": 30000.0, "start": "2021-01-04", "name": "t"}


def _frames(n: int, codes=("600519.SH", "000651.SZ"), price: float = 10.0):
    idx = pd.date_range("2021-01-04", periods=n, freq="B").astype("datetime64[ns]")
    return {c: pd.DataFrame({"open": price, "high": price, "low": price, "close": price, "volume": 1e6},
                            index=idx) for c in codes}


class _FakeLoader:
    """离线替身：``run()`` 只调 ``fetch``，再读 failures / provenance 两张表。

    ⚠️ 必须**按区间切片**（真实 loader 就会切）—— 不切的话引擎跑的是整段数据，
    最后一根不是请求的那天，测「跑到今天」这件事就测了个寂寞。
    """

    def __init__(self, frames):
        self.frames = frames
        self.failures, self.provenance = {}, {}
        self.benchmark_failures, self.benchmark_provenance = {}, {}
        self.notes: list = []

    def fetch(self, codes, start_date, end_date, **kwargs):
        want = set(codes)
        return {c: f.loc[str(start_date):str(end_date)]
                for c, f in self.frames.items() if c in want}


# ── 配置校验 ──────────────────────────────────────────────────────────────

def test_spec_accepts_a_minimal_valid_config():
    spec = P.make_spec(SPEC)
    assert spec.codes == ("600519.SH", "000651.SZ") and spec.initial_cash == 30000.0
    assert spec.name == "t" and spec.to_json()["start"] == "2021-01-04"


@pytest.mark.parametrize("bad, why", [
    ({"codes": []}, "空标的"),
    ({"codes": "600519.SH"}, "codes 写成字符串"),
    ({"strategy": "no_such"}, "不存在的策略"),
    ({"initial_cash": 0}, "本金 0"),
    ({"initial_cash": -100}, "负本金"),
    ({"initial_cash": "30000"}, "本金写成字符串"),
    ({"start": ""}, "没写起点"),
    ({"params": [1, 2]}, "params 不是对象"),
    ({"strategy": "ma_cross", "params": {"fast": 60, "slow": 20}}, "策略参数非法（快线≥慢线）"),
])
def test_spec_rejects_illegal_config(bad, why):
    """参数写错会安静地跑出**另一个策略**，所以一律在建账户时就挡住。"""
    with pytest.raises(ValueError):
        P.make_spec({**SPEC, **bad})


def test_spec_rejects_non_object():
    with pytest.raises(ValueError, match="JSON 对象"):
        P.make_spec(["600519.SH"])


# ── 成交流水还原账户 ──────────────────────────────────────────────────────

def _write_fills(tmp_path, rows):
    p = tmp_path / "fills.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    return p


def test_ledger_is_empty_for_a_missing_file(tmp_path):
    led = P._ledger_from_fills(tmp_path / "nope.jsonl", 30000.0)
    assert led["cash"] == 30000.0 and led["shares"] == {} and led["fills"] == 0


def test_ledger_uses_signed_quantity_not_the_absolute_notional(tmp_path):
    """``notional`` 是**绝对值**，方向只在 ``signed_quantity`` 上 —— 拿 notional 加减会把卖出算成买入。"""
    p = _write_fills(tmp_path, [
        {"symbol": "600519.SH", "signed_quantity": 100, "execution_price": 10.0, "notional": 1000.0, "fee": 5.0},
        {"symbol": "600519.SH", "signed_quantity": -100, "execution_price": 12.0, "notional": 1200.0, "fee": 6.0},
    ])
    led = P._ledger_from_fills(p, 30000.0)
    assert led["shares"]["600519.SH"] == 0
    assert led["cash"] == pytest.approx(30000.0 - 1000.0 - 5.0 + 1200.0 - 6.0)
    assert led["fees"] == pytest.approx(11.0)


def test_ledger_reduces_cost_proportionally_on_partial_sell(tmp_path):
    """部分卖出按**当时的每股成本**冲减，不是按当前价 —— 否则已实现的部分会被再算一次。"""
    p = _write_fills(tmp_path, [
        {"symbol": "600519.SH", "signed_quantity": 200, "execution_price": 10.0, "notional": 2000.0, "fee": 0.0},
        {"symbol": "600519.SH", "signed_quantity": -100, "execution_price": 50.0, "notional": 5000.0, "fee": 0.0},
    ])
    led = P._ledger_from_fills(p, 30000.0)
    assert led["shares"]["600519.SH"] == 100
    assert led["cost"]["600519.SH"] == pytest.approx(1000.0), "成本按比例减半，不随卖出价变化"


def test_ledger_zeroes_cost_when_fully_closed(tmp_path):
    p = _write_fills(tmp_path, [
        {"symbol": "600519.SH", "signed_quantity": 100, "execution_price": 10.0, "notional": 1000.0, "fee": 0.0},
        {"symbol": "600519.SH", "signed_quantity": -100, "execution_price": 9.0, "notional": 900.0, "fee": 0.0},
    ])
    led = P._ledger_from_fills(p, 30000.0)
    assert led["shares"]["600519.SH"] == 0.0 and led["cost"]["600519.SH"] == 0.0


# ── 下单清单 ──────────────────────────────────────────────────────────────

def _engine():
    plan = plan_backtest(["600519.SH", "000651.SZ"], "2021-01-01", "2025-12-31", style="swing",
                         initial_cash=30000.0)
    return plan, make_engine(plan, plan.to_config())


def test_no_order_when_holding_matches_the_target():
    plan, eng = _engine()
    orders = P._orders(plan, eng, ["600519.SH"], {"600519.SH": 0.5},
                       {"600519.SH": 1500.0}, {"600519.SH": 10.0}, 30000.0)
    assert orders == []


def test_target_zero_liquidates_the_position():
    plan, eng = _engine()
    orders = P._orders(plan, eng, ["600519.SH"], {"600519.SH": 0.0},
                       {"600519.SH": 1500.0}, {"600519.SH": 10.0}, 30000.0)
    assert len(orders) == 1 and orders[0]["side"] == "sell" and orders[0]["shares"] == 1500


def test_order_shares_are_floored_to_lots():
    """0.5 × 30000 / 33 = 454.5 股 → 400 股（整手向下取整），不是 455。"""
    plan, eng = _engine()
    orders = P._orders(plan, eng, ["600519.SH"], {"600519.SH": 0.5},
                       {"600519.SH": 0.0}, {"600519.SH": 33.0}, 30000.0)
    assert orders[0]["shares"] == 400 and orders[0]["target_shares"] == 400


def test_sub_lot_difference_produces_no_order():
    """差额不足一手：下不出去，报出来只会让清单变长。"""
    plan, eng = _engine()
    assert P._orders(plan, eng, ["600519.SH"], {"600519.SH": 0.5002},
                     {"600519.SH": 1500.0}, {"600519.SH": 10.0}, 30000.0) == []


def test_order_is_skipped_without_a_price():
    plan, eng = _engine()
    assert P._orders(plan, eng, ["600519.SH"], {"600519.SH": 0.5}, {}, {}, 30000.0) == []


# ── 期末不平仓：模拟盘与回测的唯一差别 ────────────────────────────────────

def test_engine_rejects_a_non_boolean_close_positions_at_end():
    """写错成字符串会被当 True，静默走回「期末平仓」—— 而那是另一份结果。"""
    plan = plan_backtest(["600519.SH"], "2021-01-01", "2025-12-31", style="swing")
    with pytest.raises(ValueError, match="close_positions_at_end"):
        make_engine(plan, {**plan.to_config(), "close_positions_at_end": "no"})


def test_backtest_still_liquidates_by_default():
    """默认必须保持原行为 —— 改默认值会把所有历史回测的结果换掉。"""
    plan = plan_backtest(["600519.SH"], "2021-01-01", "2025-12-31", style="swing")
    eng = make_engine(plan, plan.to_config())
    assert eng.close_positions_at_end is True


# ── 端到端（离线） ────────────────────────────────────────────────────────

def test_run_paper_keeps_positions_and_balances(tmp_path, monkeypatch):
    frames = _frames(600)
    monkeypatch.setattr(P, "VibeLoader", lambda **kw: _FakeLoader(frames))

    view = P.run_paper(P.make_spec(SPEC), tmp_path, as_of="2023-01-31")
    assert view["ok"] is True
    a = view["account"]
    assert a["as_of"] == "2023-01-31", "跑到的最后一根应当是请求的日期"
    assert a["positions"], "模拟盘期末必须留着仓位 —— 平掉就什么也看不到了"
    assert a["fill_count"] > 0

    mv = sum(p["market_value"] for p in a["positions"])
    assert mv == pytest.approx(a["market_value"])
    assert a["net_value"] == pytest.approx(a["cash"] + a["market_value"], abs=0.02)
    assert a["total_return"] == pytest.approx(a["net_value"] / 30000.0 - 1.0, abs=1e-6)
    # 还原的净值和引擎算的期末净值对得上 ⇒ 成交流水没读漏（对不上会进 notes 告警）
    assert not any("还原的净值" in n for n in view["notes"]), view["notes"]


def test_run_paper_reports_the_pending_target_for_every_code(tmp_path, monkeypatch):
    frames = _frames(600)
    monkeypatch.setattr(P, "VibeLoader", lambda **kw: _FakeLoader(frames))
    a = P.run_paper(P.make_spec(SPEC), tmp_path, as_of="2023-05-31")["account"]
    assert set(a["pending_target"]) == {"600519.SH", "000651.SZ"}
    # 买入持有两只等权 ⇒ 明天目标各 0.5
    assert a["pending_target"]["600519.SH"] == pytest.approx(0.5)


def test_run_paper_hands_the_gate_refusal_through(tmp_path, monkeypatch):
    """闸口拦住不是错误：原样把 reason / remedy 交出去，和 backtest.cli 同一个契约。"""
    monkeypatch.setattr(P, "VibeLoader", lambda **kw: _FakeLoader({}))
    spec = P.make_spec({**SPEC, "initial_cash": 50.0})   # 买不起一手
    view = P.run_paper(spec, tmp_path, as_of="2023-05-31")
    assert view["ok"] is False and "reason" in view["refused"]


def test_every_builtin_strategy_can_back_a_paper_account():
    """能力清单里的策略都能建账户 —— 少一个就是界面上选得到、跑不起来。"""
    for key in BUILTIN:
        spec = P.make_spec({**SPEC, "strategy": key})
        assert spec.strategy == key
