/**
 * 盯盘 · 竞价与盘中路径:昨日涨停股 09:25 竞价强弱、全天 6 个时点的情绪路径、昨晚验证条件的盘中读数。
 * 移植自 Vibe AStock v2.0.0 的「竞价与分时」页。快照由后台在时点窗口里自动存(程序开着就行),
 * 过了时点补不回来;非交易时段不冒充当场快照。和 VA 的不同:路径柱按红涨绿跌上色(VA 那里写反了)。
 */
import { useEffect, useState } from "react";
import { Camera, ClipboardCheck, Gavel, Route } from "lucide-react";
import { backend } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useAiPage } from "../../../core/ai/pageContext";
import { cleanReason } from "./api";
import { Section } from "./FactsPanels";
import { finite, pctColor, rate, reading, safeArray, signed } from "./format";
import { GapsAndSource } from "./ViewBits";
import type { CaptureResult, CheckItem, IntradayResult, Slot, SlotRow, Snapshot } from "./watchTypes";

const STATE_TEXT: Record<SlotRow["state"], string> = { saved: "已存", failed: "没存成", skipped: "休市", missing: "没存到", upcoming: "待存" };
const STATE_STYLE: Record<SlotRow["state"], string> = {
  saved: "border-primary/40 bg-primary/10 text-primary",
  failed: "border-warning/50 bg-warning/10 text-warning",
  skipped: "border-border/60 text-muted-foreground",
  missing: "border-border/60 text-muted-foreground",
  upcoming: "border-dashed border-border/60 text-muted-foreground",
};
/** 09:25 那张是开盘价口径(高开率);盘中各时点是最新价口径(红盘率)。标错是概念错误 */
export const upLabel = (s: Slot) => (s === "09:25" ? "高开" : "红盘");

function SlotStrip({ slots }: { slots: SlotRow[] }) {
  return (
    <ol aria-label="今天各时点的快照" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {slots.map((s) => (
        <li key={s.slot} className={cn("rounded-lg border px-2.5 py-1.5 text-[12px]", STATE_STYLE[s.state])} title={s.reason ?? undefined}>
          <div className="flex items-center justify-between gap-1">
            <b className="font-mono">{s.slot}</b>
            <span>{STATE_TEXT[s.state]}</span>
          </div>
          <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            {s.state === "saved" && s.snapshot ? `${s.snapshot.clock} 存 · ${s.snapshot.cohort.sample}/${s.snapshot.cohort.expected} 只`
              : s.state === "upcoming" ? `${s.slot}–${s.window_end} 自动存`
              : s.reason ?? ""}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Big({ value, label, className }: { value: string; label: string; className?: string }) {
  return <div><div className={cn("font-mono text-2xl font-bold tabular-nums", className)}>{value}</div><div className="text-[11px] text-muted-foreground">{label}</div></div>;
}

function Auction({ snap, reason, basisLabel }: { snap: Snapshot | null; reason: string | null; basisLabel: string }) {
  if (!snap) {
    return (
      <Section icon={Gavel} title="昨日涨停股 · 今日竞价强弱">
        <p role="status" className="text-[13px] text-muted-foreground">{reason ?? "09:25 竞价快照没有"}</p>
      </Section>
    );
  }
  const c = snap.cohort;
  const tiers = Object.entries(c.by_tier ?? {});
  return (
    <Section icon={Gavel} title={`昨日涨停股 · 今日竞价强弱(${snap.clock} 存)`}
      hint={`样本是 ${snap.prev_date} 收盘封住的 ${c.expected} 只,取到竞价行情 ${c.sample} 只。口径:${basisLabel}。`}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Big value={signed(c.median)} label="中位数(多数人的体感)" className={pctColor(c.median)} />
        <Big value={signed(c.avg)} label="均值" className={pctColor(c.avg)} />
        <Big value={rate(c.up_rate)} label={`高开占比(${c.up_count}/${c.sample})`} />
        <Big value={`${c.deep_loss_5}`} label="低开超 5%" className="text-success" />
      </div>
      {c.coverage_rate < 0.8 && <p className="mt-2 text-[11px] text-warning">当时只取到 {rate(c.coverage_rate)} 的样本,读数不代表全体。</p>}
      {tiers.length > 0 && (
        <div className="mt-4 border-t border-dashed border-border pt-3">
          <div className="mb-2 text-[11px] font-semibold text-muted-foreground">分昨日板位 —— 首板和高位板的竞价含义完全不同</div>
          <div className="flex flex-wrap gap-3">
            {tiers.map(([k, t]) => (
              <div key={k} className="min-w-[8.5rem] flex-1 rounded-lg border border-border px-3 py-2">
                <div className="text-[12px] font-bold">{k} <span className="font-normal text-muted-foreground">({t.sample} 只)</span></div>
                <div className={cn("font-mono text-lg font-bold tabular-nums", pctColor(t.median))}>{signed(t.median)}</div>
                <div className="text-[11px] text-muted-foreground">高开 {rate(t.up_rate)} · 均 {signed(t.avg)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {safeArray(c.top_boards).length > 0 && (
        <div className="mt-4 border-t border-dashed border-border pt-3">
          <div className="mb-2 text-[11px] font-semibold text-muted-foreground">最高标({c.top_board_level} 板)· 客观读数</div>
          <div className="flex flex-wrap gap-2">
            {c.top_boards.map((t) => (
              <span key={t.code} className="rounded-lg border border-border px-2.5 py-1 text-[12px]">
                <b>{t.name}</b> <span className="text-muted-foreground">{t.code}{t.sector ? ` · ${t.sector}` : ""}</span>
                <b className={cn("ml-1.5 tabular-nums", pctColor(t.pct))}>{signed(t.pct)}</b>
              </span>
            ))}
          </div>
        </div>
      )}
      {snap.live_reason && <p className="mt-3 text-[11px] text-muted-foreground">全市场涨停 / 炸板家数:{snap.live_reason}。</p>}
    </Section>
  );
}

const n = (v: number | null | undefined, unit = "") => (finite(v) === null ? "—" : `${v}${unit}`);

function PathTable({ slots, closed, today }: { slots: SlotRow[]; closed: boolean; today: boolean }) {
  const saved = slots.filter((s) => s.snapshot);
  const maxAbs = Math.max(1, ...saved.map((s) => Math.abs(s.snapshot!.cohort.median)));
  return (
    <Section icon={Route} title="今日情绪路径"
      hint="同样是收盘 -2%,「早上 +3% 一路杀下来」和「早上 -5% 修复上来」是完全不同的两天,只看收盘值读不出这个差别。上排是昨日涨停股的中位涨幅(承接强弱),下面是当时全市场的涨停 / 炸板家数(扩散或退潮)。">
      {saved.length === 0 ? <p role="status" className="text-[13px] text-muted-foreground">{closed ? "这一天休市,没有盘中路径。" : today ? "这一天还没有存到时点快照。后台在 09:25 / 09:35 / 10:00 / 11:30 / 14:00 / 15:00 自动存,程序开着就行。" : "这一天没存到时点快照(当时程序没开着,或取数失败)。"}</p> : (
        <>
          <div className="flex items-end gap-3" aria-hidden>
            {slots.map((s) => {
              const m = s.snapshot?.cohort.median;
              return (
                <div key={s.slot} className="flex-1 text-center">
                  <div className={cn("text-[12px] font-bold tabular-nums", m == null ? "text-muted-foreground" : pctColor(m))}>{m == null ? "—" : signed(m)}</div>
                  <div className={cn("mx-auto mt-1 w-full rounded", m == null ? "bg-muted/40" : m > 0 ? "bg-danger/60" : m < 0 ? "bg-success/60" : "bg-muted")}
                    style={{ height: `${m == null ? 4 : Math.max(4, (Math.abs(m) / maxAbs) * 56)}px` }} />
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{s.slot}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 overflow-x-auto">
            <table aria-label="各时点读数" className="w-full text-left text-[12px] tabular-nums">
              <thead className="text-[11px] text-muted-foreground">
                <tr>{["时点", "存的时间", "中位", "均值", "红盘 / 高开", "跌超 5%", "样本", "涨停", "炸板", "跌停", "最高板", "封板率", "1进2"].map((h) => <th key={h} className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {saved.map((s) => {
                  const p = s.snapshot!, c = p.cohort, l = p.live;
                  return (
                    <tr key={s.slot} className="border-t border-border/40">
                      <td className="px-2 py-1 font-mono font-semibold">{s.slot}</td>
                      <td className="px-2 py-1 font-mono text-muted-foreground">{p.clock}</td>
                      <td className={cn("px-2 py-1 font-mono font-semibold", pctColor(c.median))}>{signed(c.median)}</td>
                      <td className={cn("px-2 py-1 font-mono", pctColor(c.avg))}>{signed(c.avg)}</td>
                      <td className="px-2 py-1">{upLabel(s.slot)} {rate(c.up_rate)}</td>
                      <td className="px-2 py-1 text-success">{c.deep_loss_5}</td>
                      <td className={cn("px-2 py-1", c.coverage_rate < 0.8 && "text-warning")}>{c.sample}/{c.expected}</td>
                      <td className="px-2 py-1 text-danger">{l ? n(l.limit_up) : "—"}</td>
                      <td className="px-2 py-1">{l ? n(l.broken) : "—"}</td>
                      <td className="px-2 py-1 text-success">{l ? n(l.limit_down) : "—"}</td>
                      <td className="px-2 py-1">{l ? n(l.highest_board, "板") : "—"}</td>
                      <td className="px-2 py-1">{l ? rate(l.seal_rate) : "—"}</td>
                      <td className="px-2 py-1">{l ? rate(l.promotion_1to2) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            「红盘 / 高开」:09:25 那张按开盘价算是高开占比,之后各时点按当时最新价算是红盘占比。样本标黄 = 当时行情只回来不到八成,那个点不代表全体。
            09:25 是集合竞价,还没有当天的涨停 / 炸板池,所以那一行全市场家数是「—」。
          </p>
        </>
      )}
    </Section>
  );
}

/** 和「明日验证」同一套写法和颜色(成立 / 不成立不是涨跌,不用红绿);盘中只是临时对照,前面加「暂」 */
const VERDICT: Record<string, { text: string; cls: string }> = {
  yes: { text: "暂成立", cls: "bg-primary/15 text-primary" },
  no: { text: "暂不成立", cls: "bg-muted text-foreground/70" },
  none: { text: "判不了", cls: "bg-muted text-muted-foreground" },
};
const verdictOf = (v: boolean | null) => VERDICT[v === true ? "yes" : v === false ? "no" : "none"]!;

function Checks({ checks, date, closed, today }: { checks: IntradayResult["checks"]; date: string; closed: boolean; today: boolean }) {
  const items = safeArray<CheckItem>(checks.items);
  const empty = closed ? `${date} 休市,没有盘中读数。`
    : checks.set_date ? `${checks.set_date} 晚上没写验证条件。在情绪复盘的「明日验证」里写。`
    : today ? "还没存到时点快照,存下第一张后才有读数可对。条件在情绪复盘的「明日验证」里写。"
    : "这一天没存到时点快照,没有盘中读数可对。";
  return (
    <Section icon={ClipboardCheck} title="昨晚的验证条件 · 盘中读数"
      hint={`${checks.set_date ?? "上一个交易日"} 晚上在「明日验证」里写的条件,拿 ${date} 各时点的读数先对一对。盘中读数只是临时对照,成不成立以收盘为准;只在收盘后才有的读数如实标出来,不硬凑。`}>
      {items.length === 0 ? <p className="text-[13px] text-muted-foreground">{empty}</p> : (
        <div className="space-y-3">
          {items.map((it) => (
            <div key={it.id} className="rounded-lg border border-border/60 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <b>{it.label}</b>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">预期{it.direction_label}</span>
                <span className="text-muted-foreground">昨天 {reading(it.base_value, it.kind, it.unit)}</span>
                {it.reason && <span className="text-[11px] text-muted-foreground/80">· {it.reason}</span>}
              </div>
              {it.close_only ? <p className="mt-1 text-[11px] text-muted-foreground">这项只在收盘后才有读数,盘中不判断。</p> : (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {it.points.map((p) => {
                    const v = verdictOf(p.verified);
                    return (
                      <span key={p.slot} className="inline-flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[11px] tabular-nums">
                        <span className="font-mono text-muted-foreground">{p.slot}</span>
                        <span>{reading(p.value, it.kind, it.unit)}</span>
                        {p.actual_label && <span className="text-muted-foreground">{p.actual_label}</span>}
                        <span className={cn("rounded px-1 text-[10px] font-bold", v.cls)}>{v.text}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

export function IntradayView({ r, onCapture, capturing, captureMsg }: { r: IntradayResult; onCapture: (() => void) | null; capturing: boolean; captureMsg: string | null }) {
  const closed = r.trading_day === false;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          {r.date}{r.today ? "(今天)" : ""} · {closed ? "休市,不存快照" : r.today ? "后台在每个时点的窗口里自动存一张(程序开着就行),过了时点补不回来" : "当天存下的时点快照,没存的补不回来"}
        </p>
        {onCapture && !closed && (
          <button type="button" onClick={onCapture} disabled={capturing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="在时点窗口里立刻存一张(窗口外会告诉你哪几个时间能存)">
            <Camera className={cn("h-3.5 w-3.5", capturing && "animate-pulse")} /> 现在存一张
          </button>
        )}
      </div>
      {captureMsg && <p role="status" className="text-[12px] text-muted-foreground">{captureMsg}</p>}
      <SlotStrip slots={r.slots} />
      <Auction snap={r.auction} reason={r.auction_reason} basisLabel={r.basis_labels.open} />
      <PathTable slots={r.slots} closed={closed} today={r.today} />
      <Checks checks={r.checks} date={r.date} closed={closed} today={r.today} />
      {safeArray<string>(r.warnings).map((w) => <p key={w} role="status" className="text-[11px] text-warning">⚠️ {w}</p>)}
      <GapsAndSource gaps={safeArray<string>(r.gaps)} source={r.source} />
    </div>
  );
}

export function intradaySummary(r: IntradayResult): string {
  const out = [`盯盘 · 竞价与盘中路径,${r.date}${r.today ? "(今天)" : ""}${r.trading_day === false ? ",休市" : ""}。`];
  out.push(`时点快照:${r.slots.map((s) => `${s.slot} ${STATE_TEXT[s.state]}${s.reason && s.state !== "saved" ? `(${s.reason})` : ""}`).join(";")}`);
  const a = r.auction;
  if (a) {
    const c = a.cohort;
    out.push(`09:25 竞价(${a.prev_date} 涨停 ${c.expected} 只,取到 ${c.sample} 只,${r.basis_labels.open}):中位 ${signed(c.median)},均 ${signed(c.avg)},高开占比 ${rate(c.up_rate)},低开超 5% ${c.deep_loss_5} 只;分板位 ${Object.entries(c.by_tier).map(([k, t]) => `${k} 中位 ${signed(t.median)}(${t.sample})`).join(",")};最高标 ${c.top_board_level} 板 ${c.top_boards.map((t) => `${t.name} ${signed(t.pct)}`).join("、")}`);
  } else out.push(`09:25 竞价:${r.auction_reason ?? "没有"}`);
  const saved = r.slots.filter((s) => s.snapshot && s.slot !== "09:25");
  if (saved.length) out.push(`盘中路径:${saved.map((s) => { const p = s.snapshot!; const l = p.live; return `${s.slot} 昨日涨停股中位 ${signed(p.cohort.median)},红盘 ${rate(p.cohort.up_rate)}${l ? `,全市场涨停 ${n(l.limit_up)} 炸板 ${n(l.broken)} 跌停 ${n(l.limit_down)} 最高 ${n(l.highest_board, "板")}` : ""}`; }).join(";")}`);
  const items = safeArray<CheckItem>(r.checks.items);
  if (items.length) out.push(`昨晚(${r.checks.set_date})的验证条件盘中读数(临时,以收盘为准):${items.map((it) => `${it.label} 预期${it.direction_label}(昨 ${reading(it.base_value, it.kind, it.unit)}):${it.close_only ? "只在收盘后判断" : it.points.map((p) => `${p.slot} ${reading(p.value, it.kind, it.unit)} ${verdictOf(p.verified).text}`).join(",") || "还没有读数"}`).join(";")}`);
  if (r.warnings.length) out.push(`提醒:${r.warnings.join(";")}`);
  if (r.gaps.length) out.push(`缺口:${r.gaps.join(";")}`);
  return out.join("\n");
}

export function IntradayTab({ date, refreshNonce, onBusy, onDate }:
  { date: string | null; refreshNonce: number; onBusy?: (b: boolean) => void; onDate?: (d: string) => void }) {
  const [st, setSt] = useState<{ state: "loading" } | { state: "done"; r: IntradayResult } | { state: "failed"; why: string }>({ state: "loading" });
  const [reloads, setReloads] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    onBusy?.(true);
    backend.shortlineIntraday<IntradayResult>(date, ctl.signal)
      // 把后端解析出的「实际看的是哪一天」回报给父组件：不指定日期时后端会自己选
      // （非交易日 → 最近交易日），页面上的日期框要跟着显示，不能空着让人以为没选。
      .then((r) => { if (!ctl.signal.aborted) { setSt({ state: "done", r }); onDate?.(r.date); } })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setSt({ state: "failed", why: cleanReason(e instanceof Error ? e.message : String(e)) }); })
      .finally(() => { if (!ctl.signal.aborted) onBusy?.(false); });
    return () => { ctl.abort(); onBusy?.(false); };
    // onBusy 是父组件的 setState,不会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, refreshNonce, reloads]);
  // 今天的页面开着时,每分钟重读一次:时点到了后台自动存,不用手动刷新
  const today = st.state === "done" && st.r.today;
  useEffect(() => {
    if (!today) return;
    const t = window.setInterval(() => { if (!document.hidden) setReloads((x) => x + 1); }, 60_000);
    return () => window.clearInterval(t);
  }, [today]);
  const r = st.state === "done" ? st.r : null;
  useAiPage(r ? { key: `watch:intraday:${r.date}`, title: `竞价与盘中路径 ${r.date}`, context: intradaySummary(r),
    suggestions: ["今天竞价承接和昨天收盘比是强是弱", "盘中路径是一路走强还是冲高回落", "昨晚的验证条件现在看哪些在兑现"] } : null);
  const capture = async () => {
    setCapturing(true);
    setCaptureMsg(null);
    try {
      const c = await backend.shortlineIntradayCapture<CaptureResult>();
      setCaptureMsg(c.already ? `${c.slot} 这张已经存过了。` : c.ok ? `${c.slot} 存好了。` : `${c.slot} 没存成:${c.reason ?? "原因不明"}`);
      setReloads((x) => x + 1);
    } catch (e) {
      setCaptureMsg(cleanReason(e instanceof Error ? e.message : String(e)));
    } finally {
      setCapturing(false);
    }
  };
  if (st.state === "loading") return <div className="glass flex min-h-[10rem] items-center justify-center p-6"><p role="status" className="text-sm text-muted-foreground">竞价与盘中路径加载中…</p></div>;
  if (st.state === "failed") return <div className="glass p-6"><p role="status" className="text-sm text-muted-foreground">竞价与盘中路径这次没取到:{st.why || "原因不明"}。不代表没有,可点右上角刷新重试。</p></div>;
  return <IntradayView r={st.r} onCapture={st.r.today ? () => void capture() : null} capturing={capturing} captureMsg={captureMsg} />;
}
