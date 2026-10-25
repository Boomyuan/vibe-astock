#!/usr/bin/env python3
"""A 股交易日历(全市场维度):最近一个交易日、今天是否交易日、近 N 天日历。

源(按顺序降级,任一可用即可):
  1. baostock `query_trade_dates`(零鉴权 TCP)—— 权威口径,日常首选
  2. akshare `tool_trade_date_hist_sina`(新浪交易日历,含已公布的未来交易日)——
     baostock 夜间时段性登录失败时兜底。**复盘页整页依赖这份日历,不能只有一个源。**

用途:判定 fetch_quote 的报价日期差异是"全市场休市 / 盘前"还是"个股停牌 / 陈旧"(company-research §2 依赖矩阵)。
输出(均为 evidence,symbol=MARKET,market=CN):
  last_trading_day       最近一个交易日(≤ 今天)
  previous_trading_day   上一个交易日(< last_trading_day)
  is_today_trading_day   今天是否交易日
  session_phase          pre_open(交易日 09:30 前)/ trading(09:30–15:00)/ post_close(15:00 后)/ non_trading_day
  reference_quote_day    此刻一条"新鲜"报价应携带的日期:pre_open → previous_trading_day;其余 → last_trading_day
判定规则(SOP 引用):quote_date == reference_quote_day → 正常;quote_date < reference_quote_day → 该股停牌或数据陈旧 → stale;
  pre_open 时 fetch_quote 的 is_stale=true(成交额 0 且现价 == 昨收)是盘前正常现象,不算僵尸。
与个股无关,--symbol 仅用于落盘归档(仍校验格式)。
用法:python fetch_trade_calendar.py --symbol 300308 --days 30 [--out-dir ...]
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta
from datetime import time as dtime
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (TZ_SH, base_parser, bs_paging_error, evidence, finish, lib_versions, now_iso, parse_symbol_or_exit, quiet_stdout,
                    record_error, result_skeleton, save_raw, today_str)

SCRIPT = "fetch_trade_calendar"
EP_BAOSTOCK = "query_trade_dates"
EP_AKSHARE = "tool_trade_date_hist_sina"


def _trading_days_baostock(start, today, out_dir: Optional[str]) -> tuple[list[str], dict]:
    """baostock 的交易日列表(升序 ISO 日期) + 元信息(raw_ref / 窗口)。"""
    import baostock as bs
    with quiet_stdout():
        lg = bs.login()
        if lg.error_code != "0":
            raise RuntimeError(f"baostock 登录失败 {lg.error_code} {lg.error_msg}")
        try:
            rs = bs.query_trade_dates(start_date=start.isoformat(), end_date=today.isoformat())
            if rs.error_code != "0":
                raise RuntimeError(f"baostock 查询失败 {rs.error_code} {rs.error_msg}")
            rows = []
            while rs.next():
                rows.append(dict(zip(rs.fields, rs.get_row_data())))
            why = bs_paging_error(rs)
            if why:   # 翻页失败不抛异常（见 common.bs_paging_error），不查就拿着前 2000 行当完整日历
                raise RuntimeError(f"baostock 翻页失败 {why}（只取到 {len(rows)} 行）")
        finally:
            bs.logout()
    if not rows:
        raise ValueError("交易日历为空")
    raw = save_raw(out_dir, "baostock", EP_BAOSTOCK, json.dumps(rows, ensure_ascii=False).encode("utf-8"), "json",
                   kind="extracted")
    trading = [r["calendar_date"] for r in rows if r.get("is_trading_day") == "1"]
    return trading, {"raw_ref": raw["raw_ref"], "window": [rows[0]["calendar_date"], rows[-1]["calendar_date"]],
                     "rows": len(rows), "provenance": lib_versions("baostock")}


def _trading_days_akshare(start, today, out_dir: Optional[str]) -> tuple[list[str], dict]:
    """新浪交易日历(akshare)。返回窗口内的交易日,升序。

    🔴 这个源给的是**全量**日历(1990 到当年年末,含已公布的未来交易日),自己按窗口切。
       日期对象可能是 datetime.date 也可能是 Timestamp,统一按 ISO 字符串比较,不做类型假设。
    """
    import akshare as ak
    df = ak.tool_trade_date_hist_sina()
    if df is None or "trade_date" not in getattr(df, "columns", []):
        raise ValueError("新浪交易日历返回的结构不认识(没有 trade_date 列)")
    lo, hi = start.isoformat(), today.isoformat()
    trading = sorted(s for s in (str(v)[:10] for v in df["trade_date"]) if lo <= s <= hi)
    if not trading:
        raise ValueError("新浪交易日历在该窗口内没有交易日")
    return trading, {"raw_ref": None, "window": [trading[0], trading[-1]], "rows": len(df),
                     "provenance": lib_versions("akshare")}


def main() -> None:
    p = base_parser("A 股交易日历(baostock → 新浪降级,全市场)")
    p.add_argument("--days", type=int, default=30, help="回看天数(默认 30)")
    args = p.parse_args()
    parse_symbol_or_exit(args.symbol, SCRIPT, args.out_dir)  # 只校验格式
    res = result_skeleton(SCRIPT, "MARKET", "CN")
    try:
        today = datetime.now(TZ_SH).date()
        start = today - timedelta(days=args.days)
        trading: list[str] = []
        meta: dict = {}
        used_source = used_endpoint = ""
        # 按顺序试,第一个能给出 ≥2 个交易日的源胜出;失败原因全部记进 errors,不吞
        for name, ep, fn in (("baostock", EP_BAOSTOCK, _trading_days_baostock),
                             ("akshare", EP_AKSHARE, _trading_days_akshare)):
            try:
                got, got_meta = fn(start, today, args.out_dir)
            except Exception as e:  # noqa: BLE001 — 换下一个源
                record_error(res, name, ep, e)
                continue
            if len(got) < 2:
                record_error(res, name, ep, ValueError(f"回看窗口内交易日不足 2 个({len(got)}),无法给出上一交易日"))
                continue
            trading, meta, used_source, used_endpoint = got, got_meta, name, ep
            break
        if not trading:
            raise ValueError("交易日历没有可用源:baostock 与 akshare 都没取到(详见 errors)")

        last_td, prev_td = trading[-1], trading[-2]
        is_today_td = last_td == today.isoformat()
        now = datetime.now(TZ_SH).time()
        if not is_today_td:
            phase = "non_trading_day"
        elif now < dtime(9, 30):
            phase = "pre_open"
        elif now < dtime(15, 0):
            phase = "trading"
        else:
            phase = "post_close"
        ref_day = prev_td if phase == "pre_open" else last_td
        degraded = used_source != "baostock"
        note = "extracted:SDK 行数据拼装;全市场日历,非个股;session_phase 按 Asia/Shanghai 当前时刻推算"
        if degraded:
            note += f";主源 baostock 本次不可用,已降级到 {used_source}(同为交易所交易日口径,来源不同)"
        for f, v, u in (("last_trading_day", last_td, "date"), ("previous_trading_day", prev_td, "date"),
                        ("is_today_trading_day", is_today_td, "bool"), ("session_phase", phase, "text"),
                        ("reference_quote_day", ref_day, "date")):
            res["evidence"].append(evidence(script=SCRIPT, symbol="MARKET", market="CN", field=f, value=v, unit=u,
                                            period=today_str(), source=used_source, endpoint=used_endpoint,
                                            raw_ref=meta.get("raw_ref"), currency="n/a", note=note))
        res["extra"] = {"window": meta.get("window"), "trading_days": len(trading),
                        "last_trading_day": last_td, "previous_trading_day": prev_td, "is_today_trading_day": is_today_td,
                        "session_phase": phase, "reference_quote_day": ref_day, "checked_at": now_iso(),
                        "source_used": used_source, "degraded": degraded,
                        "provenance": meta.get("provenance")}
        res["primary_source"] = used_source
        res["status"] = "ok"
        res["used_sources"].append(used_source)
    except Exception as e:  # noqa: BLE001
        record_error(res, "calendar", "all_sources", e)
        res["status"] = "failed"
    finish(res, args.out_dir)


if __name__ == "__main__":
    main()
