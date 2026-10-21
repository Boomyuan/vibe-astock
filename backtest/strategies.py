"""内置策略 —— 开箱能跑的几个，同时也是"策略长什么样"的模板。

策略只有一条契约::

    generate(data_map: {代码: OHLCV DataFrame}) -> {代码: pd.Series}

返回的 Series 是**目标仓位权重**，取值 -1 ~ 1（1 = 满仓做多，0 = 空仓，-1 = 满仓做空）。
引擎会自己做三件事，策略里**不要重复做**：

1. **整体后移一根** —— 今天收盘算出来的信号，明天开盘才成交。所以策略里可以放心用
   当天的 close，不会变成未来函数。
2. **归一化** —— 各票权重绝对值之和超过 1 时按比例缩回，不会超额加杠杆。
3. **市场规则** —— 涨跌停封死、T+1、整手、做空限制，由引擎按市场拒单。

🔴 策略里**不许出现"未来"的数据**：`shift(-1)`、`iloc[-1]` 当成每天都知道的常数、
   用整段序列算出来的分位数再回头用……这类写法回测会非常好看，实盘一分钱赚不到。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

import pandas as pd

if TYPE_CHECKING:  # 只给类型检查看：运行时不必为一个标注加载整套引擎
    from backtest.run import Strategy


class BuyAndHold:
    """一直满仓拿着 —— 任何策略的及格线：跑不赢它就没有意义。"""

    name = "买入持有"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n = len(data_map) or 1
        return {c: pd.Series(1.0 / n, index=df.index) for c, df in data_map.items()}


class MaCross:
    """均线交叉：快线在慢线上方满仓，下方空仓。"""

    def __init__(self, fast: int = 20, slow: int = 60) -> None:
        if not (isinstance(fast, int) and isinstance(slow, int)) or fast < 1 or slow < 1:
            raise ValueError(f"均线窗口要是正整数，收到 fast={fast!r} slow={slow!r}")
        if fast >= slow:
            raise ValueError(f"快线要短于慢线，收到 fast={fast} slow={slow}")
        self.fast, self.slow = fast, slow
        self.name = f"均线交叉 MA{fast}/MA{slow}"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n = len(data_map) or 1
        out = {}
        for code, df in data_map.items():
            c = df["close"]
            # min_periods 用满窗口：不足窗口时是 NaN，引擎会当 0（空仓）。
            # 若用 min_periods=1，头几天会拿 3 天均线冒充 60 天均线，
            # 那是**用一个不成立的指标开仓**，而回测里看不出来。
            fast = c.rolling(self.fast, min_periods=self.fast).mean()
            slow = c.rolling(self.slow, min_periods=self.slow).mean()
            out[code] = (fast > slow).astype(float) / n
        return out


class RsiReversion:
    """RSI 均值回归：超卖买入、超买清仓（短线口径的常见形态）。"""

    def __init__(self, window: int = 14, buy_below: float = 30.0, sell_above: float = 70.0) -> None:
        if not isinstance(window, int) or window < 2:
            raise ValueError(f"RSI 窗口要是 ≥2 的整数，收到 {window!r}")
        # 阈值反了 / 超界不会报错，只会静默生成一个「永不进场」或「永不退出」的策略 ——
        # 回测跑完给出零成交或全程满仓的结果，看不出是参数配错了
        if not (0 <= buy_below < sell_above <= 100):
            raise ValueError(
                f"RSI 阈值要满足 0 ≤ 买入线 < 卖出线 ≤ 100，收到 {buy_below!r} / {sell_above!r}"
            )
        self.window, self.buy_below, self.sell_above = window, float(buy_below), float(sell_above)
        self.name = f"RSI{window} 均值回归（<{buy_below:g} 买 / >{sell_above:g} 清）"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n = len(data_map) or 1
        out = {}
        for code, df in data_map.items():
            delta = df["close"].diff()
            gain = delta.clip(lower=0).rolling(self.window, min_periods=self.window).mean()
            loss = (-delta.clip(upper=0)).rolling(self.window, min_periods=self.window).mean()
            # 全是上涨时 loss=0 → rs 无穷 → rsi=100。直接相除会得到 inf/NaN，
            # 而 NaN 会被当成 0（空仓）—— 那等于"单边上涨时反而不持仓"，方向正好反了。
            rs = gain / loss.replace(0.0, pd.NA)
            rsi = 100 - 100 / (1 + rs)
            rsi = rsi.where(loss != 0, 100.0).where(gain.notna())
            pos = pd.Series(0.0, index=df.index)
            pos[rsi < self.buy_below] = 1.0 / n
            # 中间地带保持上一状态：不写的话每天都会在满仓与空仓之间跳，换手被费用吃光
            pos = pos.where((rsi < self.buy_below) | (rsi > self.sell_above)).ffill().fillna(0.0)
            out[code] = pos
        return out


def _day(ts: Any) -> str:
    return ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)[:10]


class Rsrs:
    """RSRS 择时（阻力支撑相对强度）：光大证券 2017 年公开研报的方法，按研报公式自己写，没有搬任何仓库的代码。

    每天用最近 n 天的最高价对最低价做最小二乘回归，斜率 β 大说明支撑比阻力强；再算 β 在最近 m 个读数里的
    标准分 z：z 高于阈值目标权重为 1，低于负阈值为 0，中间保留前值。只做了研报的基础标准分，
    R² 修正版和右偏版没有做。

    🔴 研报参数（18 / 600 / ±0.7）是在沪深300 指数 2005–2017 年上定的，个股和别的年份不一定成立。
    🔴 前 n+m-1 根只用来算指标、这段时间不持有 —— 区间要比别的策略长，运行期守卫按 ``warmup_bars`` 判样本够不够。
    🔴 只用于历史回测：这里不输出「今天」的读数。
    """

    #: 平仓记录少于这个数，报告里写明结论说明不了有效还是无效
    MIN_TRADES = 10
    warmup_remedy = "把标准化窗口 m 调短（研报用 600）"

    #: 阈值上限（参数稳健性网格也按它封顶）
    MAX_THRESHOLD = 3.0

    def __init__(self, n: int = 18, m: int = 600, threshold: float = 0.7) -> None:
        if not isinstance(n, int) or n < 3:
            raise ValueError(f"RSRS 回归天数 n 要是 ≥3 的整数，收到 {n!r}")
        if not isinstance(m, int) or m < 20:
            raise ValueError(f"RSRS 标准化窗口 m 要是 ≥20 的整数，收到 {m!r}")
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not (0 < threshold <= self.MAX_THRESHOLD):
            raise ValueError(f"RSRS 阈值要在 0 到 {self.MAX_THRESHOLD:g} 之间（不含 0），收到 {threshold!r}")
        self.n, self.m, self.threshold = n, m, float(threshold)
        self.name = f"RSRS 择时（回归 {n} 日 / 标准化 {m} 日 / 阈值 ±{threshold:g}）"
        #: 第一个读数出现在第 n+m-1 根收盘；引擎后移一根成交 ⇒ 前 n+m-1 根一定不持有
        self.warmup_bars = n + m - 1
        #: 每只标的第一个读数的日期（整段没有读数是 None）；结果说明要用
        self.first_reading: Dict[str, Optional[Any]] = {}

    def slope(self, high: pd.Series, low: pd.Series) -> pd.Series:
        """β = 最近 n 天最高价对最低价的最小二乘斜率 = cov(high, low) / var(low)。"""
        n = self.n
        cov = high.rolling(n, min_periods=n).cov(low)
        var = low.rolling(n, min_periods=n).var()
        # 最低价 n 天不变时斜率无定义，是 NaN，不当 0。
        # ⚠️ 不能用 var > 0 判：滚动方差有累积的浮点误差，常数序列算出来是 1e-15 这样的数，
        #    斜率会变成 ±4.8 这种假读数（测试里抓到过）⇒ 直接看这 n 天的最低价有没有变动
        roll = low.rolling(n, min_periods=n)
        moved = (roll.max() - roll.min()) > low.abs().rolling(n, min_periods=n).max() * 1e-9
        return cov / var.where(moved)

    def zscore(self, high: pd.Series, low: pd.Series) -> pd.Series:
        """β 在最近 m 个读数里的标准分（样本标准差）。"""
        m = self.m
        beta = self.slope(high, low)
        # 标准化只数**算得出的** β：中间有一段无定义时往前多取几天凑满 m 个，
        # 否则一个 NaN 会让之后整整 m 天都没有读数
        b = beta.dropna()
        roll = b.rolling(m, min_periods=m)
        mean, std = roll.mean(), roll.std()
        # 斜率 m 个读数完全不变时标准分无定义（同上，不能用 std > 0 判）
        moved = (roll.max() - roll.min()) > b.abs().rolling(m, min_periods=m).max() * 1e-9
        return ((b - mean) / std.where(moved)).reindex(beta.index)

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n_codes = len(data_map) or 1
        out = {}
        self.first_reading = {}
        for code, df in data_map.items():
            z = self.zscore(df["high"].astype(float), df["low"].astype(float))
            t = self.threshold
            pos = pd.Series(0.0, index=df.index)
            pos[z > t] = 1.0 / n_codes
            # 阈值之间保留前值；没有读数（预热期）是 NaN → 0
            pos = pos.where((z > t) | (z < -t)).ffill().fillna(0.0)
            out[code] = pos
            valid = z.dropna()
            self.first_reading[code] = valid.index[0] if len(valid) else None
        return out

    def result_notes(self, metrics: Dict[str, Any]) -> List[str]:
        """回测跑完后要写进口径的话：方法出处、预热期、第一个读数在哪天、平仓记录太少时结论不可靠。合成一条。"""
        t = f"{self.threshold:g}"
        text = (
            f"RSRS 择时按光大证券 2017 年公开研报的公式自写：每天用最近 {self.n} 天的最高价对最低价做回归取斜率，"
            f"再算这个斜率在最近 {self.m} 个读数里的标准分，高于 {t} 时目标权重为 1、低于 -{t} 时为 0、中间保留前值；"
            "只做了基础标准分，研报里的 R² 修正版和右偏版没有做。研报参数是在沪深300 指数 2005–2017 年上定的，"
            f"用在个股或别的年份不一定成立。前 {self.warmup_bars} 根日线只用来算指标、不持有，"
            "收益、年化、夏普按整个区间算，含这段不持有的时间，而对照基准这段时间是持有的。"
        )
        got = {c: d for c, d in self.first_reading.items() if d is not None}
        never = sorted(c for c, d in self.first_reading.items() if d is None)
        if got:
            days = sorted(_day(d) for d in got.values())
            text += f"第一个读数在 {days[0]}。" if days[0] == days[-1] else f"各标的第一个读数在 {days[0]} 到 {days[-1]} 之间。"
        if never:
            text += f"{'、'.join(never)} 整段没有读数，始终不持有。"
        tc = metrics.get("trade_count")
        if isinstance(tc, int) and not isinstance(tc, bool) and tc < self.MIN_TRADES:
            text += ("本次没有一条平仓记录，" if tc == 0 else f"本次只有 {tc} 条平仓记录，少于 {self.MIN_TRADES} 条，") + \
                "结果说明不了这个方法有效还是无效。"
        return [text]


class MomentumRotation:
    """动量轮动：在趋势向上的标的里挑动量最强的几只等权持有，按固定间隔调仓。

    和其他内置策略不同，这是**截面**策略 —— 要同时看所有标的才能排序：

    1. 动量分 = 最近 ``lookback`` 个交易日的涨幅（``close / close.shift(lookback) - 1``）
    2. ``ma_filter > 0`` 时做趋势过滤：只保留收盘价在自己 ``ma_filter`` 日均线上方的标的
    3. 每隔 ``rebalance`` 个交易日看一次：合格标的按动量分降序取前 ``top`` 只，等权；
       一只都不合格就**空仓**（这是它躲开熊市的方式，不是"随便留一只"）
    4. 两次调仓之间保持上一次的目标权重不动

    🔴 **必须用 rebalance 口径跑**（``style="swing"``）。``hold`` 口径只执行方向翻转和归零，
       同向调仓会被丢掉 —— 轮动就只剩第一笔建仓，而报告里的 rebalance 次数照旧，成交却对不上。
       这条由 ``_Guarded`` 在取数之前拦住（看 ``needs_rebalance``），不会静默跑出一份看着正常的报告。

    🔴 调仓日程是**从区间第一根起算的固定间隔**，不是"每 N 天恰好出现一次信号"：
       起点挪一天，调仓日整体跟着挪，结果会变。这是这类策略的固有性质，不是实现取巧。

    🔴 预热：前 ``max(lookback, ma_filter)`` 根算不出动量分 / 均线，这段时间不持有。
       收益、年化、夏普按整个区间算，含这段空仓的时间，而对照基准这段时间是持有的。

    🔴 动量分打平时按 ``data_map`` 里的标的顺序取前者：确定，但换一批标的顺序结果可能不同。
    """

    #: 调仓是它的全部收益来源，`hold` 口径会把调仓丢掉 —— 见类说明
    needs_rebalance = True
    #: 平仓记录少于这个数，报告里写明结论说明不了有效还是无效
    MIN_TRADES = 10
    warmup_remedy = "把均线过滤窗口调短，或把起点往前挪"

    def __init__(self, lookback: int = 20, top: int = 2, ma_filter: int = 60, rebalance: int = 5) -> None:
        if not isinstance(lookback, int) or isinstance(lookback, bool) or lookback < 1:
            raise ValueError(f"动量窗口要是 ≥1 的整数，收到 {lookback!r}")
        if not isinstance(top, int) or isinstance(top, bool) or top < 1:
            raise ValueError(f"持仓只数要是 ≥1 的整数，收到 {top!r}")
        if not isinstance(ma_filter, int) or isinstance(ma_filter, bool) or ma_filter < 0:
            raise ValueError(f"均线过滤窗口要是 ≥0 的整数（0 = 关掉过滤），收到 {ma_filter!r}")
        # 1 日均线就是收盘价本身，`close > ma` 永远不成立 ⇒ 全程空仓。
        # 这种参数不报错，只会安静地跑出一份零成交的报告。
        if ma_filter == 1:
            raise ValueError("均线过滤窗口不能是 1：1 日均线等于收盘价，过滤永远不成立，会一直空仓")
        if not isinstance(rebalance, int) or isinstance(rebalance, bool) or rebalance < 1:
            raise ValueError(f"调仓间隔要是 ≥1 的整数，收到 {rebalance!r}")
        self.lookback, self.top = lookback, top
        self.ma_filter, self.rebalance = ma_filter, rebalance
        self.name = (
            f"动量轮动（{lookback} 日动量 / 取前 {top}"
            + (f" / MA{ma_filter} 过滤" if ma_filter else " / 不过滤")
            + f" / 每 {rebalance} 日调仓）"
        )
        #: 第一个能出读数的位置：动量和均线谁先齐就用谁
        self.warmup_bars = max(lookback, ma_filter)

    def _pick(self, score_row: pd.Series, ok_row: pd.Series) -> List[str]:
        """当天该持哪几只。动量分缺失（预热期 / 停牌）或不合格的一律不选。"""
        s = score_row.dropna()
        if s.empty:
            return []
        ok = ok_row.reindex(s.index).fillna(False).astype(bool)
        s = s[ok]
        if s.empty:
            return []
        # nlargest 打平时保留先出现的那个 ⇒ 按 codes 顺序取前者，确定但依赖标的顺序
        return list(s.nlargest(self.top).index)

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        codes = list(data_map)
        if not codes:
            return {}
        # 每只票在自己的索引上算动量和均线，**再**对齐 —— 反过来先拼成矩阵再 shift，
        # 一只票停牌几天就会让别人少算几天（shift 数的是行，不是交易日）。
        close_by_code = {c: pd.to_numeric(data_map[c]["close"], errors="coerce").astype(float) for c in codes}
        score = pd.DataFrame({c: s / s.shift(self.lookback) - 1.0 for c, s in close_by_code.items()})
        if self.ma_filter:
            close = pd.DataFrame(close_by_code)
            ma = pd.DataFrame({
                c: s.rolling(self.ma_filter, min_periods=self.ma_filter).mean()
                for c, s in close_by_code.items()
            })
            eligible = (close > ma) & score.notna()
        else:
            eligible = score.notna()

        idx = score.index
        # 先铺满 NaN，再只写调仓日，最后 ffill —— 中间的日子要能"保持上一次"，写 0 就变成空仓了
        target = pd.DataFrame(index=idx, columns=codes, dtype=float)
        for t in idx[:: self.rebalance]:
            picked = self._pick(score.loc[t], eligible.loc[t])
            target.loc[t] = 0.0
            if picked:
                target.loc[t, picked] = 1.0 / len(picked)
        target = target.ffill().fillna(0.0)

        return {c: target[c].reindex(data_map[c].index).ffill().fillna(0.0) for c in codes}

    def result_notes(self, metrics: Dict[str, Any]) -> List[str]:
        """回测跑完后要写进口径的话：方法、调仓日程的性质、预热期、平仓记录太少时结论不可靠。合成一条。"""
        text = (
            f"动量轮动按截面做法：每天算每只标的最近 {self.lookback} 个交易日的涨幅，"
            + (f"只保留收盘价在自己 {self.ma_filter} 日均线上方的标的，" if self.ma_filter else "不做趋势过滤，")
            + f"每隔 {self.rebalance} 个交易日按涨幅降序取前 {self.top} 只等权持有，一只都不合格就空仓，"
            "两次调仓之间不动仓位。调仓日程从区间第一根起算，起点挪一天调仓日整体跟着挪，结果会变；"
            "动量分打平时按标的顺序取前者。"
            f"前 {self.warmup_bars} 根日线算不出指标、这段时间不持有，"
            "收益、年化、夏普按整个区间算，含这段空仓的时间，而对照基准这段时间是持有的。"
        )
        tc = metrics.get("trade_count")
        if isinstance(tc, int) and not isinstance(tc, bool) and tc < self.MIN_TRADES:
            text += ("本次没有一条平仓记录，" if tc == 0 else f"本次只有 {tc} 条平仓记录，少于 {self.MIN_TRADES} 条，") + \
                "结果说明不了这个方法有效还是无效。"
        return [text]


BUILTIN: Dict[str, Callable[..., Strategy]] = {
    "buy_and_hold": BuyAndHold,
    "ma_cross": MaCross,
    "rsi_reversion": RsiReversion,
    "rsrs": Rsrs,
    "momentum_rotation": MomentumRotation,
}
