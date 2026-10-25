import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import {
  MAX_TRIES, captureSnapshot, cohortStats, dayDir, intradayBeat, loadDay, quotesOf, readStatus, resetIntradayCalendar, shortlineIntraday, shortlineIntradayAct,
  slotDue, timingProblem, validWindow, windowEnd, type LadderStock, type Snapshot,
} from "../src/finance/shortline/intraday.ts";
import { shortlineCloseFetch } from "../src/finance/shortline/close_fetch.ts";
import type { GateResult, JobContext } from "../src/notify.ts";
import { ServiceError, ledgerInsertMany, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";

const DAY = "2026-10-12";             // 周一
const PREV = "2026-10-09";
const sh = (hms: string, day = DAY) => new Date(`${day}T${hms.length === 5 ? `${hms}:00` : hms}+08:00`);
const signal = new AbortController().signal;

function tmpCtx(): ServiceContext {
  return { repoRoot: process.cwd(), dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-intraday-")), python: "python3", node: process.execPath };
}
const clean = (ctx: ServiceContext) => fs.rmSync(ctx.dataRoot, { recursive: true, force: true });

const LADDER: LadderStock[] = [
  { code: "600825", name: "新华传媒", boards: 4, sector: "出版" },
  { code: "000001", name: "甲", boards: 2, sector: "银行" },
  { code: "300001", name: "乙", boards: 1, sector: "软件" },
  { code: "688001", name: "丙", boards: 1, sector: "芯片" },
];
const key = (c: string) => `${/^6/.test(c) ? "sh" : "sz"}${c}`;
type Q = { price?: number; change_pct?: number; open?: number; last_close?: number; limit_up_price?: number; quote_time?: string; security_name?: string };
const quoteEnv = (rows: Record<string, Q>) => ({
  status: "ok",
  evidence: Object.entries(rows).flatMap(([c, f]) => Object.entries(f).map(([field, value]) => ({ record_key: key(c), field, value, period: DAY }))),
});
const ladderEnv = (quote_date = DAY) => ({ status: "ok", evidence: [], extra: { result: { quote_date, sample_date: PREV, stocks: LADDER } } });
const calEnv = (isToday = true, period = DAY) => ({
  status: "ok",
  evidence: Object.entries({ last_trading_day: isToday ? period : PREV, previous_trading_day: PREV, is_today_trading_day: isToday, session_phase: "continuous" })
    .map(([field, value]) => ({ field, value, period })),
});
const liveEnv = (date = DAY) => ({ status: "ok", evidence: [], extra: { result: { date, live: { limit_up: 52, broken: 13, limit_down: 4, highest_board: 5, consec_count: 9, seal_rate: 0.8, broken_rate: 0.2, promotion_1to2: 0.25, promotion_all: 0.3 } } } });

/** 假取数:按端点回;记下调用 */
function fakeFetch(over: Partial<Record<string, unknown>> = {}) {
  const calls: { endpoint: string; args?: Record<string, unknown>; consistency?: unknown }[] = [];
  const auction: Record<string, Q> = {
    "600825": { open: 11, last_close: 10, price: 11, change_pct: 10, limit_up_price: 11, quote_time: "20261012092503" },
    "000001": { open: 9.5, last_close: 10, price: 9.5, change_pct: -5, quote_time: "20261012092503" },
    "300001": { open: 10.2, last_close: 10, price: 10.2, change_pct: 2, quote_time: "20261012092503" },
    "688001": { open: 0, last_close: 10, price: 10, change_pct: 0, quote_time: "20261012092503" },   // 竞价没成交:开盘价 0 不算
  };
  const fetch = async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown>; consistency?: unknown }) => {
    calls.push({ endpoint: req.endpoint, args: req.args, consistency: req.consistency });
    if (req.endpoint in over) {
      const v = over[req.endpoint];
      if (v instanceof Error) throw v;
      return { envelope: (typeof v === "function" ? (v as () => unknown)() : v) as Record<string, unknown> };
    }
    if (req.endpoint === "cn_shortline_ladder") return { envelope: ladderEnv() };
    if (req.endpoint === "tx_quotes_batch") return { envelope: quoteEnv(auction) };
    if (req.endpoint === "cn_shortline_live") return { envelope: liveEnv() };
    if (req.endpoint === "fetch_trade_calendar") return { envelope: calEnv() };
    throw new Error(`没料到的端点 ${req.endpoint}`);
  };
  return { fetch, calls };
}
/** 依次给出的时刻;用完停在最后一个 */
const clockSeq = (...ts: string[]) => { let i = 0; return () => sh(ts[Math.min(i++, ts.length - 1)]!); };

test("时点窗口与 VA 一致:09:25 只到 09:29,其余 8 分钟;午休不收;窗口外的时刻不对应任何时点", () => {
  assert.equal(validWindow("09:25", "09:24"), false);
  assert.equal(validWindow("09:25", "09:25"), true);
  assert.equal(validWindow("09:25", "09:29"), true);
  assert.equal(validWindow("09:25", "09:30"), false);
  assert.equal(validWindow("09:35", "09:43"), true);
  assert.equal(validWindow("09:35", "09:44"), false);
  assert.equal(validWindow("11:30", "11:38"), true, "午收允许晚 8 分钟");
  assert.equal(validWindow("14:00", "14:08"), true);
  assert.equal(validWindow("15:00", "15:08"), true);
  assert.equal(validWindow("15:00", "15:09"), false);
  assert.equal(validWindow("10:00", "9:59"), false, "格式坏了不收");
  assert.deepEqual(["09:24", "09:25", "09:29", "09:30", "09:36", "10:08", "10:09", "11:31", "12:00", "13:05", "14:03", "15:08", "15:09"].map(slotDue),
    [null, "09:25", "09:25", null, "09:35", "10:00", null, "11:30", null, null, "14:00", "15:00", null]);
  assert.equal(windowEnd("09:25"), "09:29");
  assert.equal(windowEnd("11:30"), "11:38");
  assert.match(timingProblem("09:25", "09:31")!, /补不回来/);
  assert.match(timingProblem("10:00", "10:30")!, /超过 8 分钟/);
  assert.match(timingProblem("14:00", "13:59")!, /还没到/);
  assert.equal(timingProblem("15:00", "15:05"), null);
});

test("强弱统计:09:25 用开盘价且行情时间要过 09:25;盘中用最新涨跌;行情时间不是今天的不算;分板位;最高标", () => {
  const q = quotesOf([quoteEnv({
    "600825": { open: 11, last_close: 10, price: 11, change_pct: 10, limit_up_price: 11, quote_time: "20261012100203" },
    "000001": { open: 9.5, last_close: 10, price: 9.4, change_pct: -6, quote_time: "20261012100203" },
    "300001": { open: 10.2, last_close: 10, price: 10.3, change_pct: 3, quote_time: "20261009150003" },   // 节前的报价
    "688001": { open: 10, last_close: 10, price: 10.1, change_pct: 1, quote_time: "20261012092000" },     // 试撮合时段
  })]);
  const open = cohortStats(LADDER, q, "open", DAY)!;
  assert.equal(open.sample, 2, "节前报价、09:25 以前的报价都不算开盘价");
  assert.deepEqual([open.avg, open.median, open.up_count, open.down_count, open.up_rate, open.deep_loss_5], [2.5, 2.5, 1, 1, 0.5, 1]);
  assert.equal(open.coverage_rate, 0.5);
  assert.equal(open.top_boards[0]!.at_limit, null, "竞价价位碰到涨停价不等于封住");
  const latest = cohortStats(LADDER, q, "latest", DAY)!;
  assert.equal(latest.sample, 3);
  assert.deepEqual(Object.keys(latest.by_tier), ["首板", "2板", "3板及以上"]);
  assert.deepEqual(latest.by_tier["首板"], { sample: 1, avg: 1, median: 1, up_rate: 1 });
  assert.equal(latest.deep_loss_5, 1);
  assert.deepEqual(latest.top_boards, [{ code: "600825", name: "新华传媒", boards: 4, sector: "出版", pct: 10, at_limit: true }]);
  assert.equal(cohortStats(LADDER, quotesOf([quoteEnv({ "600825": { change_pct: 1, quote_time: "20261009150003" } })]), "latest", DAY), null, "一只都不是今天的 = 不出统计");
});

test("09:25 当场存一张:开盘价口径,没有盘中情绪并说明原因;存在当天目录里", async () => {
  const ctx = tmpCtx();
  try {
    const { fetch, calls } = fakeFetch();
    const r = await captureSnapshot(ctx, "09:25", signal, { fetch, clock: clockSeq("09:25:20") });
    assert.equal(r.ok, true);
    const s = (r as { snapshot: Snapshot }).snapshot;
    assert.equal(s.basis, "open");
    assert.equal(s.prev_date, PREV);
    assert.deepEqual([s.cohort.expected, s.cohort.sample, s.cohort.median], [4, 3, 2]);
    assert.equal(s.live, null);
    assert.match(s.live_reason!, /集合竞价/);
    assert.match(s.gaps.join(), /取到今天行情的 3 只/);
    assert.equal(s.clock, "09:25:20");
    assert.ok(!calls.some((c) => c.endpoint === "cn_shortline_live"), "竞价时不去取盘中情绪");
    assert.deepEqual(calls.find((c) => c.endpoint === "tx_quotes_batch")!.consistency, { mode: "fresh" }, "行情一定现取");
    assert.deepEqual(loadDay(ctx.dataRoot, DAY).snapshots.map((x) => x.slot), ["09:25"]);
  } finally { clean(ctx); }
});

test("存不了的情形一律不写文件:过了窗口 / 今天没开市 / 行情不是今天的 / 取数跨进连续竞价", async () => {
  const ctx = tmpCtx();
  try {
    let f = fakeFetch();
    let r = await captureSnapshot(ctx, "09:25", signal, { fetch: f.fetch, clock: clockSeq("10:30") });
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /补不回来/);
    assert.equal(f.calls.length, 0, "时刻不对,一次都不取");

    f = fakeFetch({ cn_shortline_ladder: ladderEnv("2026-10-09") });
    r = await captureSnapshot(ctx, "10:00", signal, { fetch: f.fetch, clock: clockSeq("10:01") });
    assert.match((r as { reason: string }).reason, /不是今天.*可能今天没开市/);

    f = fakeFetch({ tx_quotes_batch: quoteEnv({ "600825": { change_pct: 3, quote_time: "20261009150003" } }) });
    r = await captureSnapshot(ctx, "10:00", signal, { fetch: f.fetch, clock: clockSeq("10:01") });
    assert.match((r as { reason: string }).reason, /行情时间都不是今天/);

    f = fakeFetch();
    r = await captureSnapshot(ctx, "09:25", signal, { fetch: f.fetch, clock: clockSeq("09:29:50", "09:30:02") });
    assert.match((r as { reason: string }).reason, /取数用了太久/);

    f = fakeFetch({ cn_shortline_ladder: new Error("连不上") });
    r = await captureSnapshot(ctx, "14:00", signal, { fetch: f.fetch, clock: clockSeq("14:00") });
    assert.match((r as { reason: string }).reason, /昨日梯队没取到\(连不上\)/);

    assert.equal(fs.existsSync(dayDir(ctx.dataRoot, DAY)), false);
  } finally { clean(ctx); }
});

test("盘中时点:最新价口径 + 盘中情绪;盘中情绪没取到照样存行情部分并说明", async () => {
  const ctx = tmpCtx();
  try {
    const intraday = quoteEnv({ "600825": { price: 11, change_pct: 10, limit_up_price: 11, quote_time: "20261012100103" }, "000001": { price: 9, change_pct: -10, quote_time: "20261012100103" } });
    let f = fakeFetch({ tx_quotes_batch: intraday });
    let r = await captureSnapshot(ctx, "10:00", signal, { fetch: f.fetch, clock: clockSeq("10:01") });
    let s = (r as { snapshot: Snapshot }).snapshot;
    assert.equal(s.basis, "latest");
    assert.equal(s.live!.limit_up, 52);
    assert.equal(s.cohort.top_boards[0]!.at_limit, true);

    f = fakeFetch({ tx_quotes_batch: intraday, cn_shortline_live: { status: "failed", errors: [{ source: "eastmoney", error: "timed out" }] } });
    r = await captureSnapshot(ctx, "14:00", signal, { fetch: f.fetch, clock: clockSeq("14:02") });
    s = (r as { snapshot: Snapshot }).snapshot;
    assert.equal(s.live, null);
    assert.match(s.live_reason!, /盘中情绪没取到\(eastmoney 超时\)/);

    f = fakeFetch({ tx_quotes_batch: intraday, cn_shortline_live: liveEnv("2026-10-09") });
    r = await captureSnapshot(ctx, "15:00", signal, { fetch: f.fetch, clock: clockSeq("15:03") });
    assert.match((r as { snapshot: Snapshot }).snapshot.live_reason!, /日期\(2026-10-09\)不是 2026-10-12/, "隔天的盘中情绪不当今天的用");
  } finally { clean(ctx); }
});

test("每拍钩子:不在窗口不动;休市只记一次不再试;失败按分钟重试到上限;存了就不再取", async () => {
  const ctx = tmpCtx();
  try {
    let gates = 0;
    const gate = (g: GateResult) => async () => { gates++; return g; };
    const f = fakeFetch();
    assert.equal(await intradayBeat({ ctx, signal, gate: gate({ status: "open" }) }, { fetch: f.fetch, clock: clockSeq("12:00") }), undefined);
    assert.equal(gates, 0, "不在窗口里不查门、不取数");

    await intradayBeat({ ctx, signal, gate: gate({ status: "closed", reason: "今天 A 股休市" }) }, { fetch: f.fetch, clock: clockSeq("09:25") });
    assert.deepEqual(readStatus(ctx.dataRoot, DAY)["09:25"], { state: "skipped", reason: "今天 A 股休市", at: sh("09:25").toISOString(), tries: 1 });
    await intradayBeat({ ctx, signal, gate: gate({ status: "closed", reason: "今天 A 股休市" }) }, { fetch: f.fetch, clock: clockSeq("09:26") });
    assert.equal(gates, 1, "休市记过一次,同一时点不再查");
    assert.equal(f.calls.length, 0);

    const bad = fakeFetch({ cn_shortline_ladder: new Error("连不上") });
    for (let i = 0; i < MAX_TRIES + 2; i++) {
      await intradayBeat({ ctx, signal, gate: gate({ status: "unavailable", reason: "日历没取到" }) }, { fetch: bad.fetch, clock: clockSeq(`10:0${i}`) });
    }
    assert.equal(bad.calls.length, MAX_TRIES, "日历取不到照样试(靠行情时间把关),试满就停");
    assert.equal(readStatus(ctx.dataRoot, DAY)["10:00"]!.state, "failed");

    const good = fakeFetch({ tx_quotes_batch: quoteEnv({ "600825": { change_pct: 2, quote_time: "20261012140003" } }) });
    const note = await intradayBeat({ ctx, signal, gate: gate({ status: "open" }) }, { fetch: good.fetch, clock: clockSeq("14:00") });
    assert.match(String(note), /盘中快照 14:00:已存\(昨日涨停 1\/4 只\)/);
    const n = good.calls.length;
    await intradayBeat({ ctx, signal, gate: gate({ status: "open" }) }, { fetch: good.fetch, clock: clockSeq("14:01") });
    assert.equal(good.calls.length, n, "存过就不再取");
  } finally { clean(ctx); }
});

test("读回时不认不是当场存的快照:原件保留、写进提示", async () => {
  const ctx = tmpCtx();
  try {
    const f = fakeFetch({ tx_quotes_batch: quoteEnv({ "600825": { change_pct: 2, quote_time: "20261012100003" } }) });
    await captureSnapshot(ctx, "10:00", signal, { fetch: f.fetch, clock: clockSeq("10:00") });
    const file = path.join(dayDir(ctx.dataRoot, DAY), "1000.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...s, clock: "10:30:00" }));
    const day = loadDay(ctx.dataRoot, DAY);
    assert.equal(day.snapshots.length, 0);
    assert.match(day.warnings[0]!, /10:00 的快照不是这个时点当场存的/);
    assert.ok(fs.existsSync(file), "原件不删");
    fs.writeFileSync(path.join(dayDir(ctx.dataRoot, DAY), "0925.json"), "{坏");
    assert.match(loadDay(ctx.dataRoot, DAY).warnings.join(), /09:25 的快照读不出来/);
  } finally { clean(ctx); }
});

test("视图:周末 / 节假日各时点标「休市」,竞价说没有;日历没取到就照常说「没存到」,不猜", async () => {
  const ctx = tmpCtx();
  try {
    // 周六:日历的 period 对不上（取不到今天的事实）→ 不猜，仍按今天，各时点标休市
    const sat = fakeFetch();
    const w = await shortlineIntraday(ctx, {}, signal, sh("19:50", "2026-10-10"), sat.fetch);
    assert.equal(w.date, "2026-10-10", "拿不到今天的日历就按今天，不瞎跳到别的日子");
    assert.equal(w.trading_day, false);
    assert.deepEqual(w.slots.map((s) => [s.state, s.reason]), Array(6).fill(["skipped", "周末休市"]));
    assert.equal(w.auction_reason, "周末休市,没有竞价");
    assert.equal(sat.calls.filter((c) => c.endpoint !== "fetch_trade_calendar").length, 0, "休市不取行情数");
    // 周六但日历说清了（今天不开市、最近交易日是周五）→ **默认看周五**，不是看今天
    resetIntradayCalendar();   // 上一步把「按今天」缓存住了，换个日历要清掉
    const sat2 = fakeFetch({ fetch_trade_calendar: {
      status: "ok",
      evidence: Object.entries({ last_trading_day: PREV, previous_trading_day: "2026-10-08", is_today_trading_day: false, session_phase: "non_trading_day" })
        .map(([field, value]) => ({ field, value, period: "2026-10-10" })),
    } });
    const w2 = await shortlineIntraday(ctx, {}, signal, sh("19:50", "2026-10-10"), sat2.fetch);
    assert.equal(w2.date, PREV, "非交易日默认看最近一个交易日 —— 看今天只会是一页空白");
    assert.equal(w2.today, false);
    assert.equal(w2.trading_day, null, "过去的工作日不另查开不开市");
    // 工作日的节假日:日历说今天不开市
    const hol = fakeFetch({ fetch_trade_calendar: calEnv(false, "2026-10-01") });
    const h = await shortlineIntraday(ctx, {}, signal, sh("09:00", "2026-10-01"), hol.fetch);
    assert.equal(h.trading_day, false);
    assert.ok(h.slots.every((s) => s.state === "skipped" && s.reason === "休市"));
    // 先存下的状态(定时任务的门判断写的)照原样显示
    const ctx2 = tmpCtx();
    try {
      await intradayBeat({ ctx: ctx2, signal, gate: async () => ({ status: "closed", reason: "今天不是交易日" }) }, { fetch: fakeFetch().fetch, clock: clockSeq("09:26") });
      await intradayBeat({ ctx: ctx2, signal, gate: async () => ({ status: "open" }) }, { fetch: fakeFetch({ cn_shortline_ladder: new Error("连不上") }).fetch, clock: clockSeq("09:36") });
      // 显式指定看哪一天：这一段验的是「当天存下的状态照原样显示」，
      // 不指定日期时非交易日会默认跳到最近交易日（见下面那条断言），就不是这一天了。
      const g = await shortlineIntraday(ctx2, { date: DAY }, signal, sh("09:40"), fakeFetch({ fetch_trade_calendar: calEnv(false) }).fetch);
      assert.deepEqual(g.slots.slice(0, 3).map((x) => x.state), ["skipped", "failed", "skipped"], "当时真试过、没存成的照实说");
      assert.equal(g.slots[0]!.reason, "今天不是交易日");
      assert.match(g.slots[1]!.reason!, /昨日梯队没取到/);
      assert.equal(g.slots[2]!.reason, "休市");
    } finally { clean(ctx2); }
    // 日历没取到(断网 / 日期对不上):不猜,照常「没存到 / 待存」;一分钟内不重复查
    const ctx3 = tmpCtx();
    try {
      const bad = fakeFetch({ fetch_trade_calendar: calEnv(true, PREV) });
      const u = await shortlineIntraday(ctx3, {}, signal, sh("09:40"), bad.fetch);
      assert.equal(u.trading_day, null);
      assert.deepEqual(u.slots.map((s) => s.state), ["missing", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming"]);
      await shortlineIntraday(ctx3, {}, signal, sh("09:40:30"), bad.fetch);
      assert.equal(bad.calls.filter((c) => c.endpoint === "fetch_trade_calendar").length, 1, "没取到的结果缓存一分钟");
      await shortlineIntraday(ctx3, {}, signal, sh("09:41:30"), bad.fetch);
      assert.equal(bad.calls.filter((c) => c.endpoint === "fetch_trade_calendar").length, 2);
      const down = await shortlineIntraday(ctx3, {}, signal, sh("09:50"), fakeFetch({ fetch_trade_calendar: new Error("断网") }).fetch);
      assert.equal(down.trading_day, null);
    } finally { clean(ctx3); }
  } finally { clean(ctx); }
});

test("视图:各时点状态如实分开(存了 / 没存原因 / 还没到);竞价缺了说补不回来;盘中核验按时点给暂定方向", async () => {
  const ctx = tmpCtx();
  try {
    assert.ok(listViews().some((v) => v.id === "shortline_intraday"));
    const intraday = quoteEnv({ "600825": { price: 11, change_pct: 10, limit_up_price: 11, quote_time: "20261012100103" }, "000001": { price: 9, change_pct: -6, quote_time: "20261012100103" } });
    const f = fakeFetch({ tx_quotes_batch: intraday });
    await captureSnapshot(ctx, "10:00", signal, { fetch: f.fetch, clock: clockSeq("10:01") });
    await intradayBeat({ ctx, signal, gate: async () => ({ status: "open" }) }, { fetch: fakeFetch({ cn_shortline_ladder: new Error("连不上") }).fetch, clock: clockSeq("11:31") });
    ledgerInsertMany(ctx, { kind: "verification", records: [
      { date: PREV, metric: "limit_up_count", direction: "up", reason: "量能回来" },
      { date: PREV, metric: "money_effect_median", direction: "down" },
      { date: PREV, metric: "theme_concentration", direction: "up" },
      { date: "2026-10-08", metric: "highest_board", direction: "up" },
    ] });
    const daily = { status: "ok", evidence: [
      { field: "limit_up_count", value: 40 }, { field: "money_effect_median_ret", value: 3.5 }, { field: "ladder_highest", value: 6 },
    ] };
    const facts = { status: "ok", evidence: [{ field: "theme_concentration", value: 0.4 }] };
    const v = fakeFetch({ cn_shortline_daily: daily, cn_shortline_facts: facts });
    const r = await shortlineIntraday(ctx, {}, signal, sh("11:45"), v.fetch);
    assert.equal(r.date, DAY);
    assert.equal(r.trading_day, true);
    assert.deepEqual(r.slots.map((s) => s.state), ["missing", "missing", "saved", "failed", "upcoming", "upcoming"]);
    assert.match(r.slots[3]!.reason!, /昨日梯队没取到/);
    assert.match(r.auction_reason!, /补不回来/);
    assert.equal(r.checks.set_date, PREV);
    assert.deepEqual(r.checks.items.map((i) => i.metric), ["limit_up_count", "money_effect_median", "theme_concentration"], "只看前一晚写的,按读数顺序");
    const [lu, me, th] = r.checks.items;
    assert.deepEqual([lu!.base_value, lu!.points[0]!.value, lu!.points[0]!.actual, lu!.points[0]!.verified], [40, 52, "up", true]);
    assert.deepEqual([me!.base_value, me!.points[0]!.value, me!.points[0]!.actual, me!.points[0]!.verified], [3.5, 2, "down", true]);
    assert.equal(th!.close_only, true);
    assert.equal(th!.points[0]!.verified, null, "题材集中度盘中没有读数,不判");
    assert.ok(v.calls.filter((c) => c.endpoint !== "fetch_trade_calendar").every((c) => (c.args as { date?: string }).date === PREV));

    const past = await shortlineIntraday(ctx, { date: "2026-10-09" }, signal, sh("11:45"), v.fetch);
    assert.ok(past.slots.every((s) => s.state === "missing"), "过去的日子没存就是没存");
    assert.equal(past.trading_day, null, "过去的工作日不另查日历");
    await assert.rejects(shortlineIntraday(ctx, { date: "2026-10-13" }, signal, sh("11:45"), v.fetch), /还没到/);
    await assert.rejects(shortlineIntraday(ctx, { date: "10-12" }, signal, sh("11:45"), v.fetch), /YYYY-MM-DD/);
  } finally { clean(ctx); }
});

test("手动存:窗口外直接说明;存过的不重抓", async () => {
  const ctx = tmpCtx();
  try {
    const f = fakeFetch({ tx_quotes_batch: quoteEnv({ "600825": { change_pct: 2, quote_time: "20261012140003" } }) });
    await assert.rejects(shortlineIntradayAct(ctx, { action: "capture" }, signal, { fetch: f.fetch, clock: clockSeq("12:10") }),
      (e: unknown) => e instanceof ServiceError && /不在任何快照时点的有效窗口里.*09:25–09:29/.test(e.message));
    await assert.rejects(shortlineIntradayAct(ctx, { action: "nope" }, signal), /只能是 capture/);
    const r = await shortlineIntradayAct(ctx, { action: "capture" }, signal, { fetch: f.fetch, clock: clockSeq("14:03") });
    assert.deepEqual(r, { slot: "14:00", ok: true, already: false, reason: null });
    const n = f.calls.length;
    assert.deepEqual(await shortlineIntradayAct(ctx, { action: "capture" }, signal, { fetch: f.fetch, clock: clockSeq("14:05") }), { slot: "14:00", ok: true, already: true, reason: null });
    assert.equal(f.calls.length, n);
  } finally { clean(ctx); }
});

test("🔴 同一个时点同时存:只取一次数;先存的那张不被换掉;取数期间别处先存上了就报已存(审计 2026-10-11 Codex 范围 2 第 5 条)", async () => {
  const ctx = tmpCtx();
  try {
    let release!: () => void;
    let hold = new Promise<void>((r) => { release = r; });
    const f = fakeFetch({ tx_quotes_batch: quoteEnv({ "600825": { change_pct: 2, quote_time: "20261012140003" } }) });
    const slow: typeof f.fetch = async (c, req) => { if (req.endpoint === "cn_shortline_ladder") await hold; return f.fetch(c, req); };
    const ladders = () => f.calls.filter((c) => c.endpoint === "cn_shortline_ladder").length;

    // 两个手动请求 + 一拍定时任务同时进来
    const p1 = shortlineIntradayAct(ctx, { action: "capture" }, signal, { fetch: slow, clock: clockSeq("14:03") });
    const p2 = shortlineIntradayAct(ctx, { action: "capture" }, signal, { fetch: slow, clock: clockSeq("14:03") });
    const beat = intradayBeat({ ctx, signal, gate: async () => ({ status: "open" }) }, { fetch: slow, clock: clockSeq("14:03") });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [r1, r2] = await Promise.all([p1, p2, beat]);
    assert.deepEqual([r1, r2], [{ slot: "14:00", ok: true, already: false, reason: null }, { slot: "14:00", ok: true, already: true, reason: null }]);
    assert.equal(ladders(), 1, "只取了一次数");
    assert.equal(readStatus(ctx.dataRoot, DAY)["14:00"]?.tries, 1);

    // 取数期间,另一个进程先把 10:00 那张存上了:不覆盖,报已存,状态不由这边记
    hold = new Promise<void>((r) => { release = r; });
    const file = path.join(dayDir(ctx.dataRoot, DAY), "1000.json");
    const p3 = shortlineIntradayAct(ctx, { action: "capture" }, signal, { fetch: slow, clock: clockSeq("10:01") });
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, "先存的那张");
    release();
    assert.deepEqual(await p3, { slot: "10:00", ok: true, already: true, reason: null });
    assert.equal(fs.readFileSync(file, "utf8"), "先存的那张");
    assert.equal(readStatus(ctx.dataRoot, DAY)["10:00"], undefined);
    // 定时任务同样:别处先存上了就不记「失败」(不然下一拍还会再试)
    hold = new Promise<void>((r) => { release = r; });
    const b2 = intradayBeat({ ctx, signal, gate: async () => ({ status: "open" }) }, { fetch: slow, clock: clockSeq("11:31") });
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(dayDir(ctx.dataRoot, DAY), "1130.json"), "先存的那张");
    release();
    await b2;
    assert.equal(readStatus(ctx.dataRoot, DAY)["11:30"], undefined);
    assert.deepEqual(fs.readdirSync(dayDir(ctx.dataRoot, DAY)).filter((n) => n.endsWith(".part")), [], "临时文件都清掉了");
  } finally { clean(ctx); }
});

test("收盘取数:五份逐个现取当天的;取到一部分照实写;全没取到算失败让定时任务重试", async () => {
  const ctx = tmpCtx();
  try {
    const job = (day: string) => ({ ctx, day, now: sh("15:35", day), signal, state: undefined, manual: false }) as JobContext;
    const calls: { endpoint: string; args?: Record<string, unknown>; consistency?: unknown }[] = [];
    const r = await shortlineCloseFetch(job(DAY), async (_c, req) => {
      calls.push(req);
      if (req.endpoint === "cn_shortline_structure") return { envelope: { status: "failed", errors: [{ source: "eastmoney", error: "connection reset" }] } };
      return { envelope: { status: req.endpoint === "cn_shortline_facts" ? "partial" : "ok" } };
    });
    assert.deepEqual(calls.map((c) => c.endpoint), ["cn_shortline_daily", "cn_shortline_settled", "cn_shortline_structure", "cn_shortline_facts", "cn_shortline_board_ladder"]);
    assert.ok(calls.every((c) => (c.args as { date: string }).date === DAY && (c.consistency as { mode: string }).mode === "fresh"));
    assert.deepEqual(r.messages, [], "不推送");
    assert.equal(r.note, `${DAY} 已取好:每日情绪读数、昨日涨停股今日表现、事实表(部分)、连板天梯;没取到:涨停结构(eastmoney 连不上)`);
    await assert.rejects(shortlineCloseFetch(job(DAY), async () => { throw new Error("断网"); }), /都没取到/);
  } finally { clean(ctx); }
});
