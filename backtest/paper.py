"""模拟盘：把回测引擎向前跑到今天，输出「现在持有什么、值多少钱、明天开盘该动什么」。

🔴 **不另写一套撮合。** 账户状态全部来自一次 ``close_positions_at_end=False`` 的回测：
   市场规则（T+1 / 整手 / 费用 / 涨跌停）与回测共用同一份实现，不会两处漂移 ——
   模拟盘和回测的差别只有一条，回测跑完把仓位按最后一天收盘价平掉（净值落回现金），
   模拟盘把仓位留着，于是它的期末状态就是账户的现状。

🔴 **「明天要执行的目标」取的是最后一根 bar 上的信号。** 引擎的规则是「今天收盘算出来的信号，
   明天开盘才成交」（见 ``engines/base.py::_align`` 里对信号做的后移一根），所以最后一根上的
   信号是**还没执行**的那一个 —— 它正是明天开盘要执行的目标。
   ``target_positions.csv`` 里没有它：那是**已经生效**的目标（= 前一根的信号）。

🔴 账户状态从 ``fills.jsonl``（引擎逐笔成交的原始记录）还原，不从权重反推 ——
   权重会因整手取整和现金不足与真实持仓对不上，而流水是引擎自己记的账。

🔴 这是**记账**，不是撮合：它不接券商、不下单。输出的是「明天该买/卖多少股」的清单，
   由你自己在券商 App 里执行。真接自动交易要先过合规那关（程序化交易报备）。
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from backtest.gate import Plan, plan_backtest
from backtest.loader import VibeLoader
from backtest.run import BacktestNotValid, _Guarded, make_engine, run
from backtest.strategies import BUILTIN


@dataclass(frozen=True)
class PaperSpec:
    """一个模拟盘账户的配置。**持久化的是它，不是状态** —— 状态每次由回测重算，不会漂。"""

    codes: Tuple[str, ...]
    strategy: str
    params: Dict[str, Any] = field(default_factory=dict)
    style: str = "swing"
    initial_cash: float = 30000.0
    start: str = ""
    name: str = "default"

    def to_json(self) -> Dict[str, Any]:
        return {
            "name": self.name, "codes": list(self.codes), "strategy": self.strategy,
            "params": dict(self.params), "style": self.style,
            "initial_cash": self.initial_cash, "start": self.start,
        }


def make_spec(raw: Dict[str, Any]) -> PaperSpec:
    """从 JSON 对象建账户配置。逐项校验 —— 一个参数写错的账户会安静地跑出别的策略。"""
    if not isinstance(raw, dict):
        raise ValueError(f"账户配置要是 JSON 对象，收到 {type(raw).__name__}")
    codes = raw.get("codes")
    if not isinstance(codes, (list, tuple)) or not codes or not all(isinstance(c, str) and c.strip() for c in codes):
        raise ValueError("codes 要是至少一个非空代码的数组，如 [\"600036.SH\"]")
    key = raw.get("strategy")
    if key not in BUILTIN:
        raise ValueError(f"认不出策略 {key!r}（可用：{', '.join(sorted(BUILTIN))}）")
    style = str(raw.get("style", "swing"))
    cash = raw.get("initial_cash", 30000.0)
    if isinstance(cash, bool) or not isinstance(cash, (int, float)) or not cash > 0:
        raise ValueError(f"initial_cash 要是正数，收到 {cash!r}")
    start = str(raw.get("start", "") or "")
    if not start:
        raise ValueError("start 要写明，如 \"2024-01-02\" —— 账户从哪天开始算")
    params = raw.get("params") or {}
    if not isinstance(params, dict):
        raise ValueError(f"params 要是 JSON 对象，收到 {type(params).__name__}")
    # 构造一次把非法参数挡在这里，而不是等取完数才在策略里炸
    BUILTIN[key](**params)
    return PaperSpec(
        codes=tuple(str(c) for c in codes), strategy=str(key), params=dict(params),
        style=style, initial_cash=float(cash), start=start,
        name=str(raw.get("name") or "default"),
    )


def _ledger_from_fills(path: Path, initial_cash: float) -> Dict[str, Any]:
    """从成交流水还原账户：每只票的股数 / 成本、现金、累计费用。

    ``fills.jsonl`` 每行是一次成交：``signed_quantity`` 带方向（买正卖负），
    ``notional`` 是**绝对值**，所以现金要用 ``signed_quantity * execution_price`` 推。
    """
    shares: Dict[str, float] = {}
    cost: Dict[str, float] = {}
    cash = float(initial_cash)
    fees = 0.0
    fills = 0
    if not path.exists():
        return {"shares": shares, "cost": cost, "cash": cash, "fees": fees, "fills": fills}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        c = str(r.get("symbol") or "")
        q = float(r.get("signed_quantity") or 0.0)
        px = float(r.get("execution_price") or 0.0)
        fee = float(r.get("fee") or 0.0)
        if not c or q == 0:
            continue
        fills += 1
        cash -= q * px + fee
        fees += fee
        prev = shares.get(c, 0.0)
        if q > 0:
            shares[c] = prev + q
            cost[c] = cost.get(c, 0.0) + q * px + fee
        else:
            # 卖出按**当时**的每股成本冲减，不是按当前价 —— 否则浮动盈亏会把已实现的部分再算一遍
            if prev > 1e-9:
                avg = cost.get(c, 0.0) / prev
                cost[c] = max(0.0, cost.get(c, 0.0) - avg * min(-q, prev))
            shares[c] = prev + q
            if shares[c] <= 1e-9:
                shares[c], cost[c] = 0.0, 0.0
    return {"shares": shares, "cost": cost, "cash": cash, "fees": fees, "fills": fills}


def _pending_signal(strategy: Any, plan: Any, data_map: Dict[str, pd.DataFrame]) -> Tuple[Dict[str, float], str]:
    """最后一根 bar 上的目标权重 —— 引擎会把它留到下一个交易日开盘才成交。

    走 ``_Guarded`` 是为了和引擎算出来的信号**完全一致**：它自己那套样本检查、
    做空信号检查都在里面，绕过去就等于用另一个函数的结果当信号。
    """
    if not data_map:
        return {}, "一只标的的数据都没取到，算不出明天要执行的目标"
    try:
        sig = _Guarded(strategy, plan).generate(data_map)
    except BacktestNotValid as exc:
        return {}, f"算明天目标时被守卫拦下：{exc}"
    out: Dict[str, float] = {}
    for c, ser in (sig or {}).items():
        if ser is None or len(ser) == 0:
            continue
        out[str(c)] = float(pd.to_numeric(ser, errors="coerce").fillna(0.0).iloc[-1])
    return out, ""


def _orders(plan: Any, engine: Any, codes: List[str], pending: Dict[str, float],
            shares: Dict[str, float], ref_price: Dict[str, float], net_value: float) -> List[Dict[str, Any]]:
    """目标权重 vs 当前股数 → 明天开盘要下的单。

    ⚠️ ``plan.market.lot`` 是给人看的**披露文字**（"100 股整手（不足一手只能卖不能买）"），
       不是数值 —— 解析它会直接崩。整手规则一律走引擎自己的 ``round_size``，
       不在这里另写一份，也就不会和撮合用的那份漂移。
    """
    rows: List[Dict[str, Any]] = []
    for c in codes:
        px = ref_price.get(c)
        if px is None or not px > 0:
            continue
        want = float(engine.round_size(float(pending.get(c, 0.0)) * net_value / px, px))
        have = float(shares.get(c, 0.0))
        delta = want - have
        if abs(delta) < 1e-9:
            continue
        # 差额自己也要下得出去：不足一手的调整报出来只会让清单变长
        if float(engine.round_size(abs(delta), px)) <= 0:
            continue
        rows.append({
            "code": c,
            "side": "buy" if delta > 0 else "sell",
            "shares": abs(delta),
            "ref_price": round(px, 4),
            "est_amount": round(abs(delta) * px, 2),
            "current_shares": have,
            "target_shares": want,
            "target_weight": round(float(pending.get(c, 0.0)), 6),
        })
    return rows


def run_paper(spec: PaperSpec, out_dir: Path, python: Optional[str] = None,
              as_of: Optional[str] = None) -> Dict[str, Any]:
    """把账户跑到 ``as_of``（默认今天），返回账户现状与明天的下单清单。"""
    out_dir = Path(out_dir)
    end = as_of or date.today().isoformat()
    codes = list(spec.codes)

    plan = plan_backtest(codes, spec.start, end, style=spec.style, initial_cash=spec.initial_cash)
    # ⚠️ 用 isinstance 而不是 `if not plan`：Refusal 的 __bool__ 是 False，但类型检查器
    #    看不懂真值收窄，`Plan | Refusal` 会在下面每一处报 union-attr（cli.py 也是这么写的）。
    if not isinstance(plan, Plan):
        # 闸口的结论不是错误，原样交给调用方（与 backtest.cli 同一个契约）
        return {"ok": False, "refused": {"reason": plan.reason, "remedy": plan.remedy}}

    strategy = BUILTIN[spec.strategy](**spec.params)
    loader = VibeLoader(out_dir=out_dir / "data", python=python)
    # 先把数据取进来：算「明天目标」和引擎跑回测必须是**同一份**数据，
    # 否则两次取数之间上游更新了，报出来的持仓和信号对不上（loader 按 (代码,起,止) 缓存，不会重取）。
    data_map = loader.fetch(codes, spec.start, end)
    pending, pending_why = _pending_signal(strategy, plan, data_map)

    res = run(plan, strategy, run_dir=out_dir / "run", python=python, loader=loader,
              config_overrides={"close_positions_at_end": False})

    art = res.run_dir / "artifacts"
    equity = pd.read_csv(art / "equity.csv", parse_dates=["timestamp"]).set_index("timestamp")
    equity = equity[equity["equity"].notna()]
    if equity.empty:
        return {"ok": False, "error": "净值序列是空的，账户算不出来"}
    as_of_bar = equity.index[-1]
    net_value = float(equity["equity"].iloc[-1])

    led = _ledger_from_fills(art / "fills.jsonl", spec.initial_cash)

    # 最新收盘价取引擎自己写下的那根 bar，不另外取一次数。
    # ⚠️ 用 index_col=0 而不是 parse_dates=["date"]：引擎是 df.to_csv() 直接落盘的，
    #    索引列叫什么取决于 data_map 里那根索引有没有名字 —— 写死列名会在没名字时崩。
    ref_price: Dict[str, float] = {}
    for c in codes:
        f = art / f"ohlcv_{c}.csv"
        if not f.exists():
            continue
        d = pd.read_csv(f, index_col=0, parse_dates=True)
        if not isinstance(d.index, pd.DatetimeIndex):
            raise ValueError(f"{f.name} 的索引不是日期，读不出最新收盘价")
        if as_of_bar in d.index:
            ref_price[c] = float(d.loc[as_of_bar, "close"])

    positions: List[Dict[str, Any]] = []
    market_value = 0.0
    for c in codes:
        q = float(led["shares"].get(c, 0.0))
        px = ref_price.get(c)
        if q <= 1e-9 or px is None:
            continue
        mv = q * px
        market_value += mv
        cost = float(led["cost"].get(c, 0.0))
        positions.append({
            "code": c,
            "shares": q,
            "last_price": round(px, 4),
            "market_value": round(mv, 2),
            "cost": round(cost, 2),
            "unrealized_pnl": round(mv - cost, 2),
            "unrealized_pct": round(mv / cost - 1.0, 6) if cost > 1e-9 else None,
            "weight": round(mv / net_value, 6) if net_value > 1e-9 else None,
        })
    positions.sort(key=lambda r: -r["market_value"])

    engine = make_engine(plan, {**plan.to_config(), "close_positions_at_end": False})
    orders = _orders(plan, engine, codes, pending, led["shares"], ref_price, net_value)

    notes: List[str] = list(res.notes)
    if pending_why:
        notes.append(f"明天要执行的目标算不出来：{pending_why}")
    # 对账：还原出来的净值应当和引擎自己算的期末净值一致。对不上说明流水读漏了，
    # 而那种情况下「明天买多少」是拿一个错的净值算出来的 —— 必须说出来，不能照报。
    rebuilt = float(led["cash"]) + market_value
    drift = abs(rebuilt - net_value)
    if net_value > 1e-9 and drift / net_value > 0.005:
        notes.append(
            f"⚠️ 按成交流水还原的净值 {rebuilt:.2f} 与引擎算出的期末净值 {net_value:.2f} 差 "
            f"{drift:.2f}（{drift / net_value * 100:.2f}%），下单清单是按前者算的，先核对再照做"
        )
    buys = sum(o["est_amount"] for o in orders if o["side"] == "buy")
    if buys > float(led["cash"]) + 1e-6:
        notes.append(
            f"⚠️ 明天要买入 {buys:.2f}，账上现金只有 {led['cash']:.2f} —— "
            "引擎在真实撮合里会按现金缩量或拒单，这份清单需要你自己按可用资金取舍"
        )

    return {
        "ok": True,
        "account": {
            "name": spec.name,
            "codes": codes,
            "strategy": res.strategy,
            "strategy_key": spec.strategy,
            "style": plan.style.label,
            "initial_cash": spec.initial_cash,
            "start": plan.start,
            "as_of": str(as_of_bar.date()),
            "cash": round(float(led["cash"]), 2),
            "market_value": round(market_value, 2),
            "net_value": round(net_value, 2),
            "total_return": round(net_value / spec.initial_cash - 1.0, 6),
            "max_drawdown": res.metrics.get("max_drawdown"),
            "cumulative_fees": round(float(led["fees"]), 2),
            "fill_count": led["fills"],
            "positions": positions,
            "pending_target": {c: round(v, 6) for c, v in pending.items()},
            "orders": orders,
        },
        "limits": list(plan.limits),
        "notes": notes,
        "provenance": [
            {"code": p.code, "endpoint": p.endpoint, "rows": p.rows,
             "first_bar": p.first_bar, "last_bar": p.last_bar, "note": p.note}
            for p in res.provenance.values()
        ],
        "run_dir": str(res.run_dir),
    }


def _catalog() -> dict:
    """界面与 Agent 读的能力说明。

    🔴 措辞受产品红线约束（``orchestrator/test/tool_catalog_gate.test.ts`` 会把每个工具的说明
       过一遍 ``complianceGate``，命中就拦）。红线不只是"建议买入"这种搭配 ——
       子串表里有 **建仓 / 加仓 / 减仓 / 清仓 / 满仓 / 空仓 / 止损 / 止盈 / 目标价** 这些裸词，
       所以说明里连这些词都不能出现，哪怕是在说"不做这件事"。
    """
    return {
        "title": "模拟盘",
        "summary": "把回测引擎向前跑到指定日期、期末保留持仓不平掉，于是它的期末状态就是账户现状："
                   "最后一天的持仓、成本、市值、净值与累计收益，以及策略在最后一根 bar 上算出的目标权重。"
                   "只读公开行情，不接券商、不落任何委托；账户状态由引擎的成交流水还原，"
                   "与回测共用同一套市场规则（T+1、整手、费用、涨跌停）。",
        "input": {
            "type": "object",
            "required": ["codes", "strategy", "start"],
            "properties": {
                "name": {"type": "string", "description": "账户名，决定产物目录；默认 default"},
                "codes": {"type": "array", "minItems": 1, "items": {"type": "string"},
                          "description": "标的代码数组，例如 600519.SH / AAPL / 00700.HK。字段必须叫 codes。"},
                "strategy": {"type": "string", "description": "策略键，与回测工具同一张表"},
                "params": {"type": "object", "description": "所选策略的参数，无参数用 {}"},
                "style": {"type": "string", "description": "口径：长线 long / 短线 swing；默认 swing"},
                "initial_cash": {"type": "number", "description": "模拟本金；默认 30000"},
                "start": {"type": "string", "description": "账户从哪天开始算，YYYY-MM-DD"},
            },
        },
        "outputs": {
            "account": "现金、市值、净值、累计收益、最大回撤、累计费用、每只标的的持仓与浮动盈亏",
            "pending_target": "策略在最后一根 bar 上算出的目标权重（引擎的规则是这根收盘的信号下一根开盘才成交，"
                              "所以它对应的是最后一个交易日之后那根 bar 上的目标）",
            "orders": "目标权重与当前持仓的差额换算成股数，按引擎自己的整手规则取整；只描述差额，不构成任何动作建议",
            "notes": "运行期说明：口径、预热期、以及按流水还原的净值与引擎净值对不上时的告警",
        },
        "notes": [
            "跑到哪一天由 as_of 决定（默认今天）；区间起点由 start 决定，账户从那天开始算。",
            "口径决定引擎是否执行目标权重的变化：长线口径只执行方向翻转和归零，所以轮动类策略要用短线口径。",
            "预热期只用来算指标、这段时间不持有，收益与回撤按整个区间算，含这段不持有的时间。",
            "结果是历史模拟，不是对未来的判断；账户状态只在本机、不进 AI。",
        ],
    }


def main() -> None:
    """stdin 进一份账户配置，stdout 出一份账户现状。用法见 backtest/paper/README 或 --help。"""
    import argparse
    import contextlib
    import io

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from backtest.stdio_utf8 import force_utf8_stdio

    force_utf8_stdio()
    p = argparse.ArgumentParser(description="模拟盘：把回测向前跑到今天，给出持仓与明天的下单清单")
    p.add_argument("--out-dir", default=None, help="产物目录；默认 .local/paper/<账户名>")
    p.add_argument("--spec", default=None, help="账户配置 JSON 文件；不给则从 stdin 读")
    p.add_argument("--as-of", default=None, help="跑到哪一天（YYYY-MM-DD），默认今天；用于复现")
    a = p.parse_args()

    raw = json.loads(Path(a.spec).read_text(encoding="utf-8")) if a.spec else json.load(sys.stdin)
    # 能力说明：界面与 Agent 先问一次有哪些参数可填，不填就调等于让它猜
    if isinstance(raw, dict) and raw.get("action") == "catalog":
        print(json.dumps({"ok": True, "catalog": _catalog()}, ensure_ascii=False))
        return

    spec = make_spec(raw)
    repo = Path(__file__).resolve().parent.parent
    out_dir = Path(a.out_dir) if a.out_dir else repo / ".local" / "paper" / spec.name
    # 🔴 引擎会往 stdout 打整份 metrics JSON —— 不接住的话我们这份 JSON 前面会多出一坨，
    #    调用方 parse 直接失败（与 backtest/cli.py 同一个坑）。
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        view = run_paper(spec, out_dir, as_of=a.as_of)
    print(json.dumps(view, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
