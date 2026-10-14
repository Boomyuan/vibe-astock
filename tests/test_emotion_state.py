"""情绪周期状态机（emotion_state）纯逻辑测试 —— 全程 monkeypatch，不出站。

重点测移植时最容易错的部分：
- 分位基线不足时只描述不判定（绝不拿几十天的样本装"历史规律"）
- S 合成的组内平均、组间加权与缺项重归一
- 候选态优先级与关键转移边（退潮→进攻需溢价为正、一致性夹紧）
- 非对称 T+1 确认（转防御立即生效、转进攻需连续一致）
"""

from __future__ import annotations

import pytest

from duanxian import emotion_state as es
from duanxian import stats_context as sc

DATE = "2026-10-13"


def _row(date: str, **kw) -> dict:
    base = {"limit_up": 50, "highest_board": 4, "broken_rate": 0.25,
            "money_effect": 1.0, "promotion_1to2": 0.3, "deep_loss": 5}
    base.update(kw)
    return {"date": date, **base}


def _install(monkeypatch, rows):
    monkeypatch.setattr(sc, "series", lambda days=90, end=None: rows)


def _dates(n: int) -> list[str]:
    # 连续日历日即可（状态机不校历，只要求唯一升序）
    import datetime as dt

    base = dt.date(2026, 7, 1)
    return [(base + dt.timedelta(days=i)).isoformat() for i in range(n)]


class TestBaseline:
    def test_insufficient_baseline_refuses_to_judge(self, monkeypatch):
        """<30 个交易日：只描述不判定 —— 这是移植时最要紧的坦白口径。"""
        rows = [_row(d) for d in _dates(10)]
        _install(monkeypatch, rows)
        out = es.build_state(rows[-1]["date"])
        assert out["available"] is False
        assert "基线不足" in out["reason"]
        assert out["sample_days"] == 10

    def test_missing_day_readings_reports_unavailable(self, monkeypatch):
        _install(monkeypatch, [])
        out = es.build_state(DATE)
        assert out["available"] is False
        assert "缓存" in out["reason"]

    def test_date_not_in_series(self, monkeypatch):
        rows = [_row(d) for d in _dates(35)[:-1]]
        _install(monkeypatch, rows)
        out = es.build_state(DATE)
        assert out["available"] is False


class TestClassify:
    """直接测单日分类纯函数 —— 转移边的边界在这里卡，不靠碰运气的序列。

    构造约定：其余读数全序列同值（扩张窗分位恒 100），**唯独 money_effect
    末日低于历史**（分位≈2.5%）—— 这样高潮三指标共振必差一条腿，
    才能测到它后面的启动/夹紧分支，不会被高潮截胡。
    """

    N = 40

    def _cols(self, prem_hist: list[float] | None = None,
              i_p12: float | None = 0.3, i_broken: float | None = 0.25,
              i_lu: float | None = 50, i_hb: float | None = 4,
              i_deep: float | None = 5) -> dict:
        n = self.N
        mk = lambda v: [v] * n  # noqa: E731
        me = prem_hist if prem_hist is not None else [2.0] * n
        return {"limit_up": mk(i_lu), "highest_board": mk(i_hb),
                "broken_rate": mk(i_broken), "money_effect": me,
                "promotion_1to2": mk(i_p12), "deep_loss": mk(i_deep)}

    def test_ebb_to_attack_requires_positive_premium(self):
        """前态退潮 + S 已到 60：溢价为负不许转进攻（防下跌中途转多）。"""
        cols = self._cols(prem_hist=[5.0] * (self.N - 1) + [-2.0])
        s = [60.0] * self.N
        got = es._classify(self.N - 1, cols, s, [100.0] * self.N,
                           [100.0] * self.N, "退潮")
        assert got == "退潮"

    def test_ebb_to_attack_with_positive_premium_starts(self):
        # 溢价为正但仍处低分位（历史更高）→ 高潮缺腿，落到启动分支
        cols = self._cols(prem_hist=[3.0] * (self.N - 1) + [1.0])
        s = [50.0] * self.N  # ≥40 未到 55 → 启动（≥55 会判发酵，另属正常）
        got = es._classify(self.N - 1, cols, s, [100.0] * self.N,
                           [100.0] * self.N, "退潮")
        assert got == "启动"

    def test_consistency_clamp_ice_high_score(self):
        """一致性夹紧：S 中位以上却挂冰点，且 p12 分位不够挡住启动分支
        → 溢价正→分歧，负→退潮。（当前溢价居低分位 → 高潮缺腿不截胡）"""
        s = [70.0] * self.N
        deep = [50.0] * self.N
        p12p = [30.0] * self.N  # < p12_start_pct(60) → 启动分支不过，落到夹紧
        cols_pos = self._cols(prem_hist=[2.0] * (self.N - 1) + [1.0])
        assert es._classify(self.N - 1, cols_pos, s, deep, p12p, "冰点") == "分歧"
        cols_neg = self._cols(prem_hist=[2.0] * (self.N - 1) + [-1.0])
        assert es._classify(self.N - 1, cols_neg, s, deep, p12p, "冰点") == "退潮"

    def test_two_day_weak_triggers_ebb_any_score(self):
        """盘面质量已破（晋级低/溢价深负/杀跌重）→ 任意 S 都先退潮。"""
        cols = self._cols(prem_hist=[-4.0] * self.N, i_p12=0.1)
        s = [80.0] * self.N
        got = es._classify(self.N - 1, cols, s, [90.0] * self.N,
                           [100.0] * self.N, "发酵")
        assert got == "退潮"

    def test_climax_needs_all_three_over_boom(self):
        """高潮共振：三指标分位都要 >85，缺一不可。"""
        cols = self._cols()  # 溢价全同值 → 分位 100，三条腿都过
        s = [90.0] * self.N
        got = es._classify(self.N - 1, cols, s, [10.0] * self.N,
                           [100.0] * self.N, "发酵")
        assert got == "高潮"

    def test_missing_money_effect_never_boom(self):
        cols = self._cols(prem_hist=[None] * self.N)
        s = [90.0] * self.N
        got = es._classify(self.N - 1, cols, s, [10.0] * self.N,
                           [100.0] * self.N, "发酵")
        assert got != "高潮"

    def test_ebb_band_is_pure_interval_capture(self):
        """退潮带 [15,40) 区间捕获不看前态 —— 冰点从此有出边。"""
        cols = self._cols(prem_hist=[-1.0] * self.N)
        s = [30.0] * self.N
        assert es._classify(self.N - 1, cols, s, [50.0] * self.N,
                            [100.0] * self.N, "冰点") == "退潮"
        assert es._classify(self.N - 1, cols, s, [50.0] * self.N,
                            [100.0] * self.N, "高潮") == "退潮"



class TestStates:
    def test_steady_rise_reaches_climax(self, monkeypatch):
        """一路走强：S 与各分位持续抬升，末日三指标分位均 >85 → 高潮。"""
        rows = []
        for i, d in enumerate(_dates(40)):
            rows.append(_row(d, limit_up=30 + i, highest_board=2 + i // 10,
                             money_effect=0.5 + i * 0.1,
                             promotion_1to2=0.2 + i * 0.005,
                             broken_rate=0.3 - i * 0.003, deep_loss=8 - i // 5))
        _install(monkeypatch, rows)
        out = es.build_state(rows[-1]["date"])
        assert out["available"] is True
        assert out["candidate"] == "高潮"
        assert out["confirmed"] == "高潮"

    def test_defensive_confirms_immediately(self, monkeypatch):
        """强势段后突然大面：two_day_weak 触发退潮，防御态 T+1 当日即确认。"""
        rows = []
        for i, d in enumerate(_dates(40)):
            rows.append(_row(d, limit_up=30 + i, highest_board=2 + i // 10,
                             money_effect=0.5 + i * 0.1,
                             promotion_1to2=0.2 + i * 0.005,
                             broken_rate=0.3 - i * 0.003, deep_loss=8 - i // 5))
        # 末日：晋级率崩、溢价转深负、杀跌分位拉满 —— 满足 two_day_weak
        rows[-1] = _row(rows[-1]["date"], limit_up=18, highest_board=3,
                        money_effect=-4.5, promotion_1to2=0.1,
                        broken_rate=0.55, deep_loss=30)
        _install(monkeypatch, rows)
        out = es.build_state(rows[-1]["date"])
        assert out["candidate"] == "退潮"
        assert out["confirmed"] == "退潮"  # 转防御不等 T+1

    def test_history_window_carried(self, monkeypatch):
        rows = [_row(d, limit_up=40 + i) for d, i in
                zip(_dates(35), range(35))]
        _install(monkeypatch, rows)
        out = es.build_state(rows[-1]["date"])
        assert out["available"] is True
        assert len(out["history"]) <= 20
        assert out["history"][-1]["date"] == rows[-1]["date"]
        assert out["history"][-1]["state"] == out["confirmed"]


class TestRender:
    def test_render_unavailable_states_reason(self, monkeypatch):
        _install(monkeypatch, [])
        text = es.render(es.build_state(DATE))
        assert "不可用" in text
        assert "不影响其他情绪读数" in text

    def test_render_discloses_framework(self, monkeypatch):
        rows = [_row(d) for d in _dates(40)]
        _install(monkeypatch, rows)
        text = es.render(es.build_state(rows[-1]["date"]))
        assert "分析框架" in text
        # 读数要格式化成中文；移植口径说明（含 limit_up 等键名映射）是刻意保留的
        assert "· 当日读数" in text
        assert "'limit_up'" not in text   # 不能漏 dict repr
        assert "readings" not in text


class TestDataWiring:
    def test_get_emotion_state_data_returns_tuple(self, monkeypatch):
        from duanxian import data

        rows = [_row(d) for d in _dates(40)]
        _install(monkeypatch, rows)
        text, struct = data.get_emotion_state_data(rows[-1]["date"])
        assert "情绪周期状态机" in text
        assert struct["available"] is True

    def test_get_emotion_state_data_degrades_on_error(self, monkeypatch):
        from duanxian import data

        def boom(*a, **kw):
            raise RuntimeError("网络炸了")

        monkeypatch.setattr(sc, "series", boom)
        text, struct = data.get_emotion_state_data(DATE)
        assert text.startswith("[⚠️ 情绪状态机")
        assert struct == {}
