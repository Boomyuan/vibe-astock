import { useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarDays, Gavel, RefreshCw, RotateCcw, Zap } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageTabs, type PageTab } from "@/components/ui/PageTabs";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { cn } from "@/lib/utils";
import { LiveTab } from "@/shortline/LiveTab";
import { IntradayTab } from "@/shortline/IntradayTab";

type Tab = "live" | "intraday";
const TABS: PageTab<Tab>[] = [
  { key: "live", label: "实时动态", icon: Zap },
  { key: "intraday", label: "竞价与盘中路径", icon: Gavel },
];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 盯盘(Vibe AStock 短线,Simon 2026-10-10 定在首页和复盘之间):盘中看昨日涨停股怎么走、持仓自选有没有异动。
 * - 实时动态:页面开着就盯,自动刷新;切走页面就停。
 * - 竞价与盘中路径:后台按时点自动存快照;`?date=` 回看以前存的。
 */
export function Watch() {
  const { pathname } = useLocation();
  const tab: Tab = pathname.replace(/\/+$/, "") === "/watch/intraday" ? "intraday" : "live";
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const picked = params.get("date");
  const date = picked && ISO_DAY.test(picked) ? picked : null;
  const [refreshNonce, setRefreshNonce] = useState(0);
  /** 没指定 ?date= 时后端自己挑的那一天（非交易日 → 最近交易日），只用来回填日期框，不写进 URL */
  const [resolvedDate, setResolvedDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setDate = (d: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (d) next.set("date", d); else next.delete("date");
    return next;
  });
  const pickTab = (t: Tab) => navigate({ pathname: t === "live" ? "/watch" : `/watch/${t}`, search: t === "intraday" && params.toString() ? `?${params}` : "" });

  return (
    <div>
      <PageHeader
        title="盯盘"
        subtitle={tab === "live"
          ? "持仓与自选、昨日梯队、大票的当下读数和盘中异动 · 页面开着就自动刷新,实际时效以行情时间为准"
          : "昨日涨停股的竞价强弱、全天几个时点的情绪路径、昨晚验证条件的盘中读数"}
        actions={tab === "intraday" ? (
          <>
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              <span className="sr-only">看哪一天</span>
              <input type="date" aria-label="看哪一天" value={date ?? resolvedDate ?? ""} onChange={(ev) => setDate(ev.target.value || null)}
                className="bg-transparent text-foreground outline-none [color-scheme:dark]" />
            </label>
            {date && (
              <button type="button" onClick={() => setDate(null)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">
                <RotateCcw className="h-3.5 w-3.5" /> 回到今天
              </button>
            )}
            <button type="button" onClick={() => setRefreshNonce((n) => n + 1)} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
              <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} /> 刷新
            </button>
          </>
        ) : null}
      />
      <PageTabs label="盯盘的分页" value={tab} onChange={pickTab} options={TABS} />
      {tab === "live" ? <LiveTab /> : <IntradayTab key={date ?? "today"} date={date} refreshNonce={refreshNonce} onBusy={setBusy} onDate={setResolvedDate} />}
      <Disclaimer />
    </div>
  );
}
