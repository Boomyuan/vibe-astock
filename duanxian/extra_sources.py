"""盘外增强数据源：开盘啦(KPL) / 短线侠免费通道 / hhxg.top。

定位：**补充源**，不是替代 —— 主取数层（`fetchers.py`）失败或口径不足时，
给复盘与盯盘多一路参考读数。三家的性质各不相同，先说清楚再用：

  · 开盘啦 (apphq.longhuvip.com) —— App 抓包接口，实时情绪值 / 连板高度 /
    板块强度。情绪接口返回 `Day` 日期回显，**逐次核验**；回显对不上目标日
    就按取数失败处理。历史板块接口只传 Date 参数、响应无日期回显，
    按本项目"请求参数不是日期证据"的铁律，**只当实时读数用，不进历史复盘**。
  · 短线侠 (duanxianxia.cn) —— 免 token 的 `vendor/livedata/ztlive.json`
    涨停播报，带涨停原因（ztyy）。**仅当日实时**（条目只有 HH:MM 时点、
    无日期字段），免费通道限流 ≥10 秒/次，密集调用实测整站 403。
  · hhxg.top —— 静态 JSON（assistant/recent_theme_latest.json 题材热度榜），
    只有 `latest_date` 一个日期、无历史路径，**只对最新交易日可用**。

每个函数的共同约定：
  · 自包含，只依赖 requests；走 `fetchers._direct_get`（代理开关与主层一致）
  · 失败**抛异常**，由 `data.py` 的包装层统一降级 —— 这里不吞错、不返回假空
  · 能核验的日期回显必须核验；核不了的就明确标注"仅实时/仅最新"
"""

from __future__ import annotations

import time
import random

from . import fetchers as dr

# ---- 开盘啦 (KPL / 淘股吧世界) ----------------------------------------------
# App 抓包参数（DeviceID/Token/UserID 是公共演示值，来自抓包样例，非个人凭据）。
KPL_HOST_RT = "https://apphq.longhuvip.com"
KPL_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 14; V2178A Build/UP1A.231005.007)",
}


def kpl_mood(expected_ymd: str | None = None) -> dict:
    """开盘啦情绪指标（实时）：涨停家数 / 连板高度 / 情绪值 / 大幅回撤家数。

    expected_ymd: 期望交易日 'YYYYMMDD'。接口返回 `Day` 日期回显；
    给了期望值就对不上即抛异常 —— 复盘常态是回看上一场，
    把别的交易日的情绪当成被复盘那天的，比缺数据更糟。
    """
    url = f"{KPL_HOST_RT}/w1/api/index.php?a=ChangeStatistics&st=10&c=HomeDingPan"
    resp = dr._direct_get(url, headers=KPL_HEADERS, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    info = (data.get("info") or [{}])[0] if isinstance(data.get("info"), list) else {}
    day = str(info.get("Day") or "").strip()
    if not day:
        raise ValueError("KPL 情绪接口无日期回显，无法核对场次")
    day_ymd = day.replace("-", "")
    if expected_ymd and day_ymd != expected_ymd:
        raise ValueError(f"KPL 情绪是 {day} 的，不是目标日 {expected_ymd}")
    try:
        return {
            "date": day,
            "limit_up_count": int(info.get("ztjs") or 0),
            "drawdown_count": int(info.get("df_num") or 0),
            "sentiment": int(info.get("strong") or 0),
            "max_consec_boards": int(info.get("lbgd") or 0),
            "tip": str(data.get("tip") or ""),
        }
    except (TypeError, ValueError) as exc:
        raise ValueError(f"KPL 情绪字段无法解析: {exc}") from exc


# ---- 短线侠免费通道 ----------------------------------------------------------
DXZX_ZTLIVE = "https://duanxianxia.cn/vendor/livedata/ztlive.json"
# 免费通道限流：≥10 秒/次（实测密集调用整站 403）。进程内节流，跨函数共享。
_DXZX_MIN_INTERVAL = 10.0
_dxzx_last = [0.0]


def _dxzx_throttle():
    wait = _DXZX_MIN_INTERVAL - (time.time() - _dxzx_last[0])
    if wait > 0:
        time.sleep(wait + random.uniform(0.2, 0.8))
    _dxzx_last[0] = time.time()


def duanxianxia_ztlive() -> list[dict]:
    """短线侠涨停播报（免 token JSON，**仅当日实时**）。

    返回 [{code, name, reason, boards, time}]，reason 是源站编辑的涨停原因
    （ztyy，"+" 分隔题材串，与问财口径不同源）。条目只有 HH:MM 时点、
    无日期字段，因此**调用方必须只在目标日 == 当天时使用**，本函数没法替你核。
    """
    _dxzx_throttle()
    resp = dr._direct_get(DXZX_ZTLIVE, headers=dr.HEADERS, timeout=12)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict) or data.get("result") != "success":
        raise ValueError("短线侠涨停播报返回异常信封")
    rows = data.get("list")
    if not isinstance(rows, list):
        raise ValueError("短线侠涨停播报缺 list 字段")
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        code = str(r.get("code") or "").strip()
        if not code.isdigit() or len(code) != 6:
            continue  # 无效代码直接丢弃，不猜
        reason = str(r.get("zty") if r.get("zty") is not None else r.get("ztyy") or "").strip()
        out.append({
            "code": code,
            "name": str(r.get("name") or ""),
            "reason": dr._clean_reason(reason) if reason and reason.lower() != "nan" else "",
            "boards": str(r.get("zt") or "").strip(),
            "time": str(r.get("time") or "").strip(),
        })
    if not out:
        raise ValueError("短线侠涨停播报无有效条目")
    return out


# ---- hhxg.top ----------------------------------------------------------------
HHXG_BASE = "https://hhxg.top/static/data"
HHXG_HEADERS = {"User-Agent": "hhxg-skill/1.0", "X-Skill-Client": "clawhub"}


def hhxg_theme_heat(expected_date: str | None = None, top_n: int = 15) -> dict:
    """hhxg 题材热度榜（assistant/recent_theme_latest.json，**仅最新一期**）。

    expected_date: 'YYYY-MM-DD'。数据带 `latest_date` 字段，给了期望值就核对；
    不一致（多半是拿历史日期来问）抛异常 —— 这份数据没有历史路径，冒充不了。
    返回 {"date", "items": [{name, premium, limit_up, ratio}]}（yz=溢价，
    zt=涨停家数，ratio=占比；字段缺失填 None，不编数）。
    """
    resp = dr._direct_get(f"{HHXG_BASE}/assistant/recent_theme_latest.json",
                          headers=HHXG_HEADERS, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise ValueError("hhxg 题材热度返回非 JSON 对象")
    latest = str(data.get("latest_date") or "").strip()
    if not latest:
        raise ValueError("hhxg 题材热度无 latest_date，无法核对场次")
    if expected_date and latest != expected_date:
        raise ValueError(f"hhxg 题材热度是 {latest} 这一期，不是目标日 {expected_date}"
                         "（该源仅提供最新一期，无历史路径）")
    items = []
    for it in data.get("items") or []:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name") or "").strip()
        if not name:
            continue
        # 实测 schema v3 条目：{name, yz(溢价), zt(涨停家数), avg10, ratio(占比)}
        items.append({
            "name": name,
            "premium": it.get("yz"),
            "limit_up": it.get("zt"),
            "ratio": it.get("ratio"),
        })
        if len(items) >= top_n:
            break
    if not items:
        raise ValueError("hhxg 题材热度榜无有效条目")
    return {"date": latest, "items": items}
