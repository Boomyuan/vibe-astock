"""国内源必须直连：启动器清了环境变量代理，挡不住 Windows 注册表里的系统代理。

现场（2026-10）：用户开着 Clash，启动器把 HTTP_PROXY 清成空，但 requests 的 trust_env=True
在 Windows 上照样读注册表代理 → 国内数据源被代理弄断，而且代理回一段 HTML 错误页时
**不抛 ProxyError**，被当成取到了数据往下走，比报错更难查。
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sources import _http  # noqa: E402
import common  # noqa: E402


@pytest.mark.parametrize("url, want", [
    ("https://searchapi.eastmoney.com/api/suggest/get", True),
    ("https://push2.eastmoney.com/api/qt/stock/get", True),
    ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get", True),
    ("https://hq.sinajs.cn/list=sh600519", True),
    ("https://www.szse.cn/api/report/ShowReport", True),
    ("https://www.cninfo.com.cn/new/hisAnnouncement/query", True),
    ("https://query2.finance.yahoo.com/v8/finance/chart/AAPL", False),
    ("https://data.sec.gov/api/xbrl/companyconcept", False),
    ("https://api.exa.ai/search", False),
    ("https://gamma-api.polymarket.com/events", False),
])
def test_is_domestic(url, want):
    assert _http.is_domestic(url) is want


class _Resp:
    def __init__(self):
        self.content = b"{}"
        self.headers = {"Content-Type": "application/json"}
        self.url = "https://x/"
        self.encoding = None
        self.status_code = 200

    def json(self):
        return {}


def _recording_sessions(monkeypatch):
    seen = []

    class S:
        def __init__(self, trust):
            self.trust = trust

        def get(self, url, **kw):
            seen.append(("GET", self.trust, url))
            return _Resp()

        def post(self, url, **kw):
            seen.append(("POST", self.trust, url))
            return _Resp()

    monkeypatch.setattr(_http, "_session", lambda trust_env=True: S(trust_env))
    return seen


def test_http_get_routes_domestic_direct_and_foreign_through_proxy(monkeypatch):
    seen = _recording_sessions(monkeypatch)
    _http.http_get("https://push2.eastmoney.com/api/qt/stock/get")
    _http.http_get("https://query2.finance.yahoo.com/v8/finance/chart/AAPL")
    _http.http_post("https://www.cninfo.com.cn/new/hisAnnouncement/query")
    assert seen == [
        ("GET", False, "https://push2.eastmoney.com/api/qt/stock/get"),      # 国内：不信任代理
        ("GET", True, "https://query2.finance.yahoo.com/v8/finance/chart/AAPL"),  # 境外：沿用系统代理
        ("POST", False, "https://www.cninfo.com.cn/new/hisAnnouncement/query"),
    ]


def test_em_get_tries_direct_first(monkeypatch):
    """东财直连优先：只在直连失败时才退到代理（纯代理才能上网的环境）。"""
    order = []

    class S:
        def __init__(self, trust):
            self.trust = trust

        def get(self, url, **kw):
            order.append(self.trust)
            if not self.trust and "fail-direct" in url:
                import requests
                raise requests.exceptions.ConnectionError("direct blocked")
            return _Resp()

    monkeypatch.setattr(common, "_em_serial", lambda fn: fn())
    monkeypatch.setattr(common, "_em_session", lambda trust_env: S(trust_env))

    common.em_get("https://push2.eastmoney.com/api/qt/stock/get")
    assert order == [False], "直连成功就不该再碰代理"

    order.clear()
    common.em_get("https://push2.eastmoney.com/api/qt/fail-direct")
    assert order == [False, True], "直连不通才退到代理"


def test_urlopen_bytes_bypasses_proxy_for_domestic(monkeypatch):
    """标准库 urlopen 也会读系统代理，国内源同样要绕开。"""
    used = []

    class FakeOpener:
        def open(self, req, timeout=None):
            used.append(("opener", req.full_url))
            import io
            return io.BytesIO(b"ok")

    class Ctx:
        def __enter__(self):
            import io
            return io.BytesIO(b"ok")

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(_http.urllib.request, "build_opener", lambda *a, **k: FakeOpener())
    monkeypatch.setattr(_http.urllib.request, "urlopen", lambda req, timeout=None: used.append(("urlopen", req.full_url)) or Ctx())

    _http.urlopen_bytes("https://www.szse.cn/api/report")
    _http.urlopen_bytes("https://www.sec.gov/Archives/edgar")
    assert used == [("opener", "https://www.szse.cn/api/report"), ("urlopen", "https://www.sec.gov/Archives/edgar")]
