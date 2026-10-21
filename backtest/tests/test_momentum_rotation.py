"""动量轮动模板：截面排序选前 N、全不合格时空仓、调仓日之间不动仓、预热期不持有、
参数非法时拒绝、hold 口径会被拦下、能力清单与构造器默认值一一对应。"""
from __future__ import annotations

import inspect
import os
import sys

import numpy as np
import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from backtest.cli import _catalog  # noqa: E402
from backtest.gate import plan_backtest  # noqa: E402
from backtest.strategies import BUILTIN, MomentumRotation  # noqa: E402

import backtest.run as R  # noqa: E402
# ⚠️ 不从 backtest.run 直接 import 类：别的测试会 importlib.reload(backtest.run)，
#    重载后模块里的 BacktestNotValid / _Guarded 是新对象，导入时绑定的那个就再也对不上了
#    （单独跑能过、全量跑挂）。一律走 R.<名字> 在调用时取。


def _idx(n: int, start: str = "2020-01-01") -> pd.DatetimeIndex:
    return pd.date_range(start, periods=n, freq="B").astype("datetime64[ns]")


def _ohlc(values: np.ndarray, idx: pd.DatetimeIndex) -> pd.DataFrame:
    v = np.asarray(values, dtype=float)
    return pd.DataFrame({"open": v, "high": v, "low": v, "close": v, "volume": 1e6}, index=idx)


def _up(n: int) -> np.ndarray:
    return np.linspace(10, 20, n)


def _down(n: int) -> np.ndarray:
    return np.linspace(20, 10, n)


def _flat(n: int) -> np.ndarray:
    return np.full(n, 10.0)


def test_picks_the_strongest_and_ignores_the_rest():
    idx = _idx(120)
    r = MomentumRotation(lookback=20, top=1, ma_filter=20, rebalance=5)
    out = r.generate({"UP": _ohlc(_up(120), idx), "FLAT": _ohlc(_flat(120), idx), "DOWN": _ohlc(_down(120), idx)})
    assert out["UP"].iloc[-1] == pytest.approx(1.0)
    assert out["FLAT"].iloc[-1] == 0.0 and out["DOWN"].iloc[-1] == 0.0
    assert out["UP"].sum() > 0, "一直涨的标的应该被选中过"


def test_holds_cash_when_nothing_is_eligible():
    """趋势过滤下全都在均线下方 → 一只都不合格 → 空仓，而不是硬留一只。"""
    idx = _idx(120)
    r = MomentumRotation(lookback=20, top=1, ma_filter=20, rebalance=5)
    out = r.generate({"A": _ohlc(_down(120), idx), "B": _ohlc(_down(120) * 0.9, idx)})
    assert sum(float(s.sum()) for s in out.values()) == 0.0


def test_ma_filter_can_be_turned_off():
    """ma_filter=0 时不做趋势过滤：全在跌也会持有跌得最慢的那只。"""
    idx = _idx(120)
    r = MomentumRotation(lookback=20, top=1, ma_filter=0, rebalance=5)
    out = r.generate({"FAST": _ohlc(_down(120), idx), "SLOW": _ohlc(np.linspace(20, 15, 120), idx)})
    assert out["SLOW"].iloc[-1] == pytest.approx(1.0), "跌得慢（动量高）的那只应该被选中"
    assert out["FAST"].iloc[-1] == 0.0


def test_ties_go_to_the_first_code():
    """动量分打平时按 data_map 的顺序取前者 —— 确定，但依赖标的顺序（口径里写明了）。"""
    idx = _idx(120)
    r = MomentumRotation(lookback=20, top=1, ma_filter=0, rebalance=5)
    same = _down(120)  # 跌幅完全相同 ⇒ 打平
    out = r.generate({"AAA": _ohlc(same, idx), "BBB": _ohlc(same, idx)})
    assert out["AAA"].iloc[-1] == pytest.approx(1.0)
    assert out["BBB"].iloc[-1] == 0.0


def test_picks_are_equally_weighted():
    idx = _idx(120)
    r = MomentumRotation(lookback=20, top=2, ma_filter=20, rebalance=5)
    out = r.generate({
        "UP": _ohlc(_up(120), idx),
        "MID": _ohlc(np.linspace(10, 15, 120), idx),
        "DOWN": _ohlc(_down(120), idx),
    })
    assert out["UP"].iloc[-1] == pytest.approx(0.5)
    assert out["MID"].iloc[-1] == pytest.approx(0.5)
    assert out["DOWN"].iloc[-1] == 0.0


def test_nothing_is_held_during_warmup():
    """前 warmup_bars 根算不出指标，必须不持有 —— 否则等于用不成立的指标开仓。"""
    idx = _idx(120)
    r = MomentumRotation(lookback=20, top=1, ma_filter=60, rebalance=5)
    assert r.warmup_bars == 60
    out = r.generate({"UP": _ohlc(_up(120), idx)})
    assert (out["UP"].iloc[: r.warmup_bars] == 0.0).all()
    assert out["UP"].iloc[r.warmup_bars] > 0.0, "预热一结束就该有仓位"


def test_weights_only_change_on_rebalance_dates():
    """调仓日之间保持上一次的目标权重 —— 天天重排会把换手和费用打上天。"""
    idx = _idx(80)
    n = 80
    a = np.concatenate([_up(n // 2), _down(n - n // 2)])       # 先涨后跌
    b = np.concatenate([_down(n // 2), _up(n - n // 2)])       # 先跌后涨 ⇒ 中途排序翻转
    r = MomentumRotation(lookback=10, top=1, ma_filter=0, rebalance=7)
    out = r.generate({"A": _ohlc(a, idx), "B": _ohlc(b, idx)})
    encoded = out["A"] + 2 * out["B"]                          # 0=空仓 / 1=持 A / 2=持 B
    changed = list(encoded[encoded.diff().fillna(0.0) != 0.0].index)
    assert changed, "中途应该发生过换标的"
    assert all(idx.get_loc(t) % 7 == 0 for t in changed), [idx.get_loc(t) for t in changed]


def test_never_emits_short_or_leveraged_weights():
    """A 股不能做空：权重必须落在 [0, 1] 且合计不超过 1，否则会被引擎静默拒单。"""
    idx = _idx(120)
    rng = np.random.default_rng(7)
    data = {f"S{i}": _ohlc(20 * np.cumprod(1 + rng.normal(0, 0.02, 120)), idx) for i in range(4)}
    r = MomentumRotation(lookback=20, top=2, ma_filter=20, rebalance=5)
    out = r.generate(data)
    total = sum(out.values())
    assert (total >= -1e-12).all() and (total <= 1 + 1e-12).all(), "合计权重越界"
    for s in out.values():
        assert (s >= 0).all()


@pytest.mark.parametrize("kwargs", [
    {"lookback": 0}, {"lookback": 1.5}, {"top": 0}, {"rebalance": 0},
    {"ma_filter": -1}, {"ma_filter": 1},
])
def test_rejects_illegal_params(kwargs):
    """非法参数不报错的话，会安静地跑出一份零成交或全程满仓的报告。"""
    with pytest.raises(ValueError):
        MomentumRotation(**kwargs)


def test_ma_filter_one_is_rejected_with_the_reason():
    """1 日均线等于收盘价，`close > ma` 永远不成立 ⇒ 全程空仓。这条最容易看走眼。"""
    with pytest.raises(ValueError, match="一直空仓"):
        MomentumRotation(ma_filter=1)


def test_hold_style_is_refused_before_any_data_is_fetched():
    """轮动靠调仓赚钱，hold 口径只执行方向翻转和归零 —— 必须拦下，不能照跑。"""
    plan = plan_backtest(["600519.SH"], "2015-01-01", "2025-12-31", style="long")
    with pytest.raises(R.BacktestNotValid, match="position_adjustment"):
        R._Guarded(MomentumRotation(), plan)


def test_rebalance_style_passes_the_guard():
    plan = plan_backtest(["600519.SH"], "2015-01-01", "2025-12-31", style="swing")
    guarded = R._Guarded(MomentumRotation(), plan)   # 不抛即可
    assert guarded.name.startswith("动量轮动")


def test_catalog_matches_constructor_defaults():
    entry = next(s for s in _catalog()["strategies"] if s["key"] == "momentum_rotation")
    sig = inspect.signature(MomentumRotation.__init__).parameters
    assert {k: v["default"] for k, v in entry["params"].items()} == {
        k: sig[k].default for k in ("lookback", "top", "ma_filter", "rebalance")
    }
    assert "rebalance" in entry["note"], "必须写明要配 rebalance 口径"
    assert {s["key"] for s in _catalog()["strategies"]} == set(BUILTIN), "选项表与实际策略一一对应"


def test_result_notes_warn_when_there_are_too_few_trades():
    r = MomentumRotation()
    few = r.result_notes({"trade_count": 3})[0]
    assert "3 条平仓记录" in few and "说明不了" in few
    zero = r.result_notes({"trade_count": 0})[0]
    assert "没有一条平仓记录" in zero
    many = r.result_notes({"trade_count": 50})[0]
    assert "说明不了" not in many
    assert "前 60 根" in many, "预热期要写进口径"
