/**
 * 盘中快照与竞价核验(移植自 Vibe AStock v2.0.0 duanxian/intraday.py)。
 *
 * 只做盘后复盘的工具,第二天早上就和用户断线了:昨晚判了「退潮」,今早到底应验没有?
 * 09:25 竞价一出来其实就有一部分答案;同样收盘 40 家涨停,早上 60 家炸到 40 家和 15 家扩散到 40 家含义相反 ——
 * 只有按时点留下快照才看得出来。
 *
 * - 时点:09:25 / 09:35 / 10:00 / 11:30 / 14:00 / 15:00(北京时间),每个时点之后 8 分钟内有效,过了不补。
 *   09:25 只到 09:29(进了连续竞价,竞价读数就没了)。
 * - 拿的是**此刻**的行情,所以只能当天、当场存。🔴 历史日绝不现抓:用今天的价格给过去的日子写快照会永久污染,而且看不出异样。
 * - 每张快照:昨日涨停股(昨日梯队)此刻的整体 / 分板位强弱、最高标读数;09:25 用开盘价,其余用最新价。
 *   除 09:25 外再存盘中情绪(东财三池:涨停、炸板、跌停、最高板、炸板率、1进2)。
 * - 交易日判断两层:定时任务的当日开门判断(周末、节假日);每只行情的时间必须是今天(节假日里腾讯给的是节前收盘价,数字完全合理、看不出异样)。
 * - 只给市场层面的聚合;个股只列客观读数,不排序、不评分。
 *
 * 存储:`<数据目录>/shortline/intraday/<日期>/<HHMM>.json`,各时点的结果另记 `status.json`。
 * 不走台账:机器存的盘面数据,台账是用户自己记的东西(见开发计划「阶段 4 定下的做法」)。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeJson } from "../../fsutil.ts";
import { localClock, type GateResult } from "../../notify.ts";
import { ServiceError, fetchEndpoint, ledgerList, type FetchResult, type ServiceContext } from "../../service.ts";
import { SCHEDULE_TZ, failedNote, pool, rowsOf, symbolOfQuoteKey } from "../schedule.ts";
import { calendarFromEnvelope, type CalendarFacts } from "../session.ts";
import { consistencyFor, median, retentionFloor, roundTo, validDate, valuesOf } from "./history.ts";
import { LEDGER_KIND, actualDirection, factsValuesOf, itemsByDate, metricValues } from "./verification.ts";
import { DIRECTION_LABELS, VERIFY_METRICS, type Direction, type VerifyMetric } from "./verify_metrics.ts";

export const SLOTS = ["09:25", "09:35", "10:00", "11:30", "14:00", "15:00"] as const;
export type Slot = (typeof SLOTS)[number];
/** 时点与真实抓取时刻允许的最大偏差(分钟):10:30 打开页面抓一张标着 09:25 的快照,竞价读数就成了假事实 */
export const MAX_DRIFT_MIN = 8;
/** 快照结构版本,改字段就 +1 */
export const SCHEMA = 1;
/** 一个时点窗口里最多试几次(每分钟一次) */
export const MAX_TRIES = 6;
const QUOTE_BATCH = 50;
export const INTRADAY_DIR_REL = path.join("shortline", "intraday");
export const INTRADAY_SOURCE = "腾讯实时行情(昨日涨停股此刻涨跌)+ 东财涨停 / 炸板 / 跌停池(盘中情绪 cn_shortline_live);名单为昨日梯队 cn_shortline_ladder";

const HM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const isSlot = (s: unknown): s is Slot => typeof s === "string" && (SLOTS as readonly string[]).includes(s);

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** now 距 slot 过了几分钟;还没到 / 格式坏了 = null */
export function driftMinutes(slot: string, hm: string): number | null {
  if (!HM_RE.test(slot) || !HM_RE.test(hm)) return null;
  const d = minutes(hm) - minutes(slot);
  return d >= 0 ? d : null;
}

/** 这个时刻能不能算作这个时点的快照(VA 同口径):只收成交时段,午收 / 日收允许取数晚 8 分钟 */
export function validWindow(slot: string, hm: string): boolean {
  const drift = driftMinutes(slot, hm);
  if (drift === null || drift > MAX_DRIFT_MIN) return false;
  if (slot === "09:25") return hm >= "09:25" && hm < "09:30";
  if (slot === "11:30" || slot === "15:00") return true;
  return (slot >= "09:30" && slot < "11:30" && hm < "11:30") || (slot >= "13:00" && slot < "15:00" && hm < "15:00");
}

/** 此刻落在哪个时点的窗口里(没有 = null) */
export const slotDue = (hm: string): Slot | null => SLOTS.find((s) => validWindow(s, hm)) ?? null;

/** 这个时点的窗口最后一分钟 */
export const windowEnd = (slot: Slot): string => (slot === "09:25" ? "09:29" : hmOf(minutes(slot) + MAX_DRIFT_MIN));

/** 北京时间的日期、时分、时分秒 */
export function clockOf(now: Date): { day: string; hm: string; hms: string } {
  const { day, hm } = localClock(now, SCHEDULE_TZ);
  const hms = new Intl.DateTimeFormat("en-GB", { timeZone: SCHEDULE_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now);
  return { day, hm, hms };
}

// ---------------------------------------------------------------- 纯计算

export type Basis = "open" | "latest";
export const BASIS_LABELS: Record<Basis, string> = { open: "当日开盘价 ÷ 昨收", latest: "抓取时最新价 ÷ 昨收" };

export interface Quote { name: string; price: number | null; change_pct: number | null; open: number | null; last_close: number | null; limit_up: number | null; quote_time: string }
export interface LadderStock { code: string; name: string; boards: number; sector: string }
export interface TierStat { sample: number; avg: number; median: number; up_rate: number }
export interface TopBoard { code: string; name: string; boards: number; sector: string; pct: number | null; at_limit: boolean | null }
export interface Cohort {
  expected: number; sample: number; coverage_rate: number;
  avg: number; median: number; up_count: number; down_count: number; up_rate: number; deep_loss_5: number;
  by_tier: Record<string, TierStat>;
  top_board_level: number; top_boards: TopBoard[];
}
export interface LiveCounts {
  limit_up: number | null; broken: number | null; limit_down: number | null; highest_board: number | null; consec_count: number | null;
  seal_rate: number | null; broken_rate: number | null; promotion_1to2: number | null; promotion_all: number | null;
}
export interface Snapshot {
  schema: typeof SCHEMA;
  date: string; slot: Slot;
  /** ISO 时间 + 北京时间的时分秒(界面显示用) */
  captured_at: string; clock: string; drift_minutes: number;
  basis: Basis; prev_date: string;
  cohort: Cohort;
  live: LiveCounts | null;
  live_reason?: string;
  gaps: string[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const tierOf = (boards: number) => (boards <= 1 ? "首板" : boards === 2 ? "2板" : "3板及以上");
export const TIER_ORDER = ["首板", "2板", "3板及以上"];

/** 腾讯批量行情信封 → 6 位代码 → 读数(名单里只有个股,6 位码不会和指数撞) */
export function quotesOf(envs: readonly unknown[]): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const env of envs) {
    for (const r of rowsOf(env)) {
      const code = symbolOfQuoteKey(r.key);
      if (!/^\d{6}$/.test(code)) continue;
      out.set(code, {
        name: str(r.f.security_name?.value), price: num(r.f.price?.value), change_pct: num(r.f.change_pct?.value),
        open: num(r.f.open?.value), last_close: num(r.f.last_close?.value), limit_up: num(r.f.limit_up_price?.value),
        quote_time: str(r.f.quote_time?.value),
      });
    }
  }
  return out;
}

/** 一只票在这个口径下的涨跌幅;行情时间不是这一天(节假日、停牌、取数失败)一律不算 */
export function quotePct(q: Quote | undefined, basis: Basis, day: string): number | null {
  if (!q || !q.quote_time.startsWith(day.replaceAll("-", ""))) return null;
  if (basis === "open") {
    if (q.quote_time.slice(8, 12) < "0925" || q.open === null || q.last_close === null || q.open <= 0 || q.last_close <= 0) return null;
    return (q.open / q.last_close - 1) * 100;
  }
  return q.change_pct;
}

const stat = (vs: number[]): TierStat => ({
  sample: vs.length, avg: roundTo(vs.reduce((a, b) => a + b, 0) / vs.length, 2), median: roundTo(median(vs), 2),
  up_rate: roundTo(vs.filter((v) => v > 0).length / vs.length, 3),
});

/** 昨日涨停股此刻的强弱。一只都没取到 = null(不存快照) */
export function cohortStats(stocks: readonly LadderStock[], quotes: ReadonlyMap<string, Quote>, basis: Basis, day: string): Cohort | null {
  const got = stocks.flatMap((s) => { const v = quotePct(quotes.get(s.code), basis, day); return v === null ? [] : [{ s, v }]; });
  if (!got.length) return null;
  const vals = got.map((x) => x.v);
  const tiers = new Map<string, number[]>();
  for (const { s, v } of got) tiers.set(tierOf(s.boards), [...(tiers.get(tierOf(s.boards)) ?? []), v]);
  const top = Math.max(...stocks.map((s) => s.boards));
  const pctOf = new Map(got.map(({ s, v }) => [s.code, v]));
  const all = stat(vals);
  return {
    expected: stocks.length, sample: vals.length, coverage_rate: roundTo(vals.length / stocks.length, 3),
    avg: all.avg, median: all.median, up_count: vals.filter((v) => v > 0).length, down_count: vals.filter((v) => v < 0).length,
    up_rate: all.up_rate, deep_loss_5: vals.filter((v) => v <= -5).length,
    by_tier: Object.fromEntries(TIER_ORDER.flatMap((k) => (tiers.has(k) ? [[k, stat(tiers.get(k)!)]] : []))),
    top_board_level: top,
    top_boards: stocks.filter((s) => s.boards === top).map((s) => {
      const q = quotes.get(s.code);
      const v = pctOf.get(s.code);
      // 封没封只在最新价口径下说;竞价价位碰到涨停价不等于封住
      const limit = basis === "latest" && v !== undefined && q?.price != null && q.limit_up != null && q.limit_up > 0 ? q.price >= q.limit_up - 1e-6 : null;
      return { code: s.code, name: s.name || q?.name || s.code, boards: s.boards, sector: s.sector, pct: v === undefined ? null : roundTo(v, 2), at_limit: limit };
    }),
  };
}

const LIVE_KEYS = ["limit_up", "broken", "limit_down", "highest_board", "consec_count", "seal_rate", "broken_rate", "promotion_1to2", "promotion_all"] as const;

const resultOf = (env: unknown): Record<string, unknown> | null => {
  const r = (env as { extra?: { result?: unknown } } | null)?.extra?.result;
  return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
};
const failed = (env: unknown) => !env || typeof env !== "object" || (env as { status?: unknown }).status === "failed";

/** 盘中情绪信封 → 家数;取不到的项是 null,不当 0 */
export function liveOf(env: unknown, day: string): { live: LiveCounts | null; reason?: string } {
  if (failed(env)) return { live: null, reason: `盘中情绪没取到${failedNote(env) ? `(${failedNote(env)})` : ""}` };
  const r = resultOf(env);
  const v = r?.live;
  if (!r || r.date !== day || !v || typeof v !== "object") return { live: null, reason: `盘中情绪的日期(${str(r?.date) || "缺失"})不是 ${day}` };
  const live = Object.fromEntries(LIVE_KEYS.map((k) => [k, num((v as Record<string, unknown>)[k])])) as unknown as LiveCounts;
  return { live };
}

/** 昨日梯队信封 → 名单(盯哪一场、样本日) */
export function ladderOf(env: unknown): { quote_date: string; sample_date: string; stocks: LadderStock[] } | null {
  if (failed(env)) return null;
  const r = resultOf(env);
  if (!r || !Array.isArray(r.stocks)) return null;
  const stocks = r.stocks.flatMap((x): LadderStock[] => {
    const s = x as Record<string, unknown>;
    const code = str(s.code), boards = num(s.boards);
    return /^\d{6}$/.test(code) && boards !== null && boards >= 1 ? [{ code, name: str(s.name), boards, sector: str(s.sector) }] : [];
  });
  return { quote_date: str(r.quote_date), sample_date: str(r.sample_date), stocks };
}

// ---------------------------------------------------------------- 存储

export const dayDir = (dataRoot: string, day: string) => path.join(dataRoot, INTRADAY_DIR_REL, day);
const slotFile = (dataRoot: string, day: string, slot: Slot) => path.join(dayDir(dataRoot, day), `${slot.replace(":", "")}.json`);
const statusFile = (dataRoot: string, day: string) => path.join(dayDir(dataRoot, day), "status.json");

/**
 * 只新建、不覆盖:先写临时文件,再硬链接成正式文件名(同名文件已在时链接失败)。返回 false = 已经有人存了这张。
 * 🔴 存档前查一次「有没有」不够:取数要好几秒,定时和手动(或两个页面)同时进来时都查到「没有」,
 *    后存完的会把先存的那张悄悄换掉(审计 2026-10-11 Codex 范围 2 第 5 条)。
 */
export function writeNewJson(file: string, obj: unknown): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.part`;
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeSync(fd, `${JSON.stringify(obj, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** 同一个数据目录、同一天、同一个时点同时只取一次数:后来的等先来的结果 */
const capturing = new Map<string, Promise<CaptureResult>>();
function captureOnce(ctx: ServiceContext, day: string, slot: Slot, signal: AbortSignal, deps: CaptureDeps): { mine: boolean; run: Promise<CaptureResult> } {
  const key = `${path.resolve(ctx.dataRoot)}|${day}|${slot}`;
  const cur = capturing.get(key);
  if (cur) return { mine: false, run: cur };
  const run = captureSnapshot(ctx, slot, signal, deps).finally(() => capturing.delete(key));
  capturing.set(key, run);
  return { mine: true, run };
}

export type SlotState = "saved" | "failed" | "skipped";
export interface SlotStatus { state: SlotState; reason?: string; at: string; tries: number }

export function readStatus(dataRoot: string, day: string): Partial<Record<Slot, SlotStatus>> {
  try {
    const raw = JSON.parse(fs.readFileSync(statusFile(dataRoot, day), "utf8")) as { slots?: unknown };
    const out: Partial<Record<Slot, SlotStatus>> = {};
    for (const [k, v] of Object.entries(raw.slots && typeof raw.slots === "object" ? raw.slots : {})) {
      const s = v as Record<string, unknown>;
      if (isSlot(k) && ["saved", "failed", "skipped"].includes(String(s.state)) && typeof s.at === "string" && typeof s.tries === "number") {
        out[k] = { state: s.state as SlotState, at: s.at, tries: s.tries, ...(typeof s.reason === "string" ? { reason: s.reason } : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStatus(dataRoot: string, day: string, slot: Slot, st: SlotStatus): void {
  const all = readStatus(dataRoot, day);
  all[slot] = st;
  writeJson(statusFile(dataRoot, day), { slots: all });
}

/** 当天留下的有效快照(按时点升序)。坏的、不在有效窗口里的原件保留,不纳入,写进 warnings */
export function loadDay(dataRoot: string, day: string): { snapshots: Snapshot[]; warnings: string[] } {
  const snapshots: Snapshot[] = [];
  const warnings: string[] = [];
  for (const slot of SLOTS) {
    const f = slotFile(dataRoot, day, slot);
    if (!fs.existsSync(f)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(f, "utf8")) as Snapshot;
      const hm = typeof s.clock === "string" ? s.clock.slice(0, 5) : "";
      const capturedDay = typeof s.captured_at === "string" && Number.isFinite(Date.parse(s.captured_at)) ? localClock(new Date(s.captured_at), SCHEDULE_TZ).day : "";
      if (s.schema !== SCHEMA || s.date !== day || s.slot !== slot || capturedDay !== day || !validWindow(slot, hm)
        || s.basis !== (slot === "09:25" ? "open" : "latest") || !s.cohort || typeof s.cohort.median !== "number" || !Array.isArray(s.gaps)) {
        warnings.push(`${slot} 的快照不是这个时点当场存的(或格式不对),原件保留,没算进来`);
        continue;
      }
      snapshots.push(s);
    } catch {
      warnings.push(`${slot} 的快照读不出来,原件保留,没算进来`);
    }
  }
  return { snapshots, warnings };
}

// ---------------------------------------------------------------- 抓取

type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope">>;
export interface CaptureDeps { fetch?: Fetch; clock?: () => Date }
/** `already` = 这个时点在取数期间已经被别的请求存上了;先存的那张保留,这次的不写 */
export type CaptureResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: string; already?: true };

/** 时点和此刻对不上的原因;对得上 = null */
export function timingProblem(slot: Slot, hm: string): string | null {
  if (hm < slot) return `现在 ${hm},还没到 ${slot}`;
  if (slot === "09:25" && hm >= "09:30") return "已进入连续竞价,09:25 竞价快照补不回来";
  const drift = driftMinutes(slot, hm);
  if (drift === null || drift > MAX_DRIFT_MIN) return `现在 ${hm},距 ${slot} 已超过 ${MAX_DRIFT_MIN} 分钟,不能当作这个时点的快照`;
  if (!validWindow(slot, hm)) return "现在不在有效成交时段,午休的行情不能存成盘中快照";
  return null;
}

export async function captureSnapshot(ctx: ServiceContext, slot: Slot, signal: AbortSignal, deps: CaptureDeps = {}): Promise<CaptureResult> {
  const fetch: Fetch = deps.fetch ?? fetchEndpoint;
  const clock = deps.clock ?? (() => new Date());
  const start = clockOf(clock());
  const day = start.day;
  const early = timingProblem(slot, start.hm);
  if (early) return { ok: false, reason: early };

  let ladder: ReturnType<typeof ladderOf> = null;
  let ladderNote = "";
  try {
    const r = await fetch(ctx, { endpoint: "cn_shortline_ladder", args: { date: day }, signal });
    ladder = ladderOf(r.envelope);
    if (!ladder) ladderNote = failedNote(r.envelope);
  } catch (e) {
    if (signal.aborted) throw e;
    ladderNote = e instanceof Error ? e.message.slice(0, 80) : "";
  }
  if (!ladder) return { ok: false, reason: `昨日梯队没取到${ladderNote ? `(${ladderNote})` : ""}` };
  if (ladder.quote_date !== day) return { ok: false, reason: `昨日梯队盯的是 ${ladder.quote_date || "未知"} 这一场,不是今天(${day}),可能今天没开市` };
  if (!ladder.stocks.length) return { ok: false, reason: `${ladder.sample_date} 没有涨停股,没有可看的样本` };

  const basis: Basis = slot === "09:25" ? "open" : "latest";
  const codes = ladder.stocks.map((s) => s.code);
  const batches: string[][] = [];
  for (let i = 0; i < codes.length; i += QUOTE_BATCH) batches.push(codes.slice(i, i + QUOTE_BATCH));
  const gaps: string[] = [];
  const envs = await pool(batches, 2, async (b) => {
    try {
      const r = await fetch(ctx, { endpoint: "tx_quotes_batch", args: { codes: b }, consistency: { mode: "fresh" }, signal });
      return failed(r.envelope) ? undefined : r.envelope;
    } catch (e) {
      if (signal.aborted) throw e;
      return undefined;
    }
  });
  const missingBatches = envs.filter((e) => !e).length;
  if (missingBatches) gaps.push(`行情分 ${batches.length} 批取(每批最多 ${QUOTE_BATCH} 只),其中 ${missingBatches} 批没取到`);
  const cohort = cohortStats(ladder.stocks, quotesOf(envs.filter(Boolean)), basis, day);
  if (!cohort) {
    return { ok: false, reason: basis === "open" ? "没取到今天 09:25 的开盘价(可能还没出,窗口内会再试)" : "行情时间都不是今天(可能今天没开市,或行情没取到)" };
  }
  if (cohort.coverage_rate < 1) gaps.push(`昨日涨停 ${cohort.expected} 只,取到今天行情的 ${cohort.sample} 只`);

  let live: LiveCounts | null = null;
  let liveReason: string | undefined;
  if (basis === "latest") {
    try {
      const r = await fetch(ctx, { endpoint: "cn_shortline_live", signal });
      ({ live, reason: liveReason } = liveOf(r.envelope, day));
    } catch (e) {
      if (signal.aborted) throw e;
      liveReason = `盘中情绪没取到(${e instanceof Error ? e.message.slice(0, 60) : ""})`;
    }
  } else {
    liveReason = "集合竞价阶段还没有当天的涨停 / 炸板池";
  }

  // 取数可能跨过窗口(尤其 09:25 跨进连续竞价):按取完的时刻再核一次,跨了就不存
  const end = clockOf(clock());
  if (end.day !== day) return { ok: false, reason: "取数跨过了零点,本次没存" };
  const late = timingProblem(slot, end.hm);
  if (late) return { ok: false, reason: `取数用了太久:${late},本次没存` };

  const snapshot: Snapshot = {
    schema: SCHEMA, date: day, slot, captured_at: clock().toISOString(), clock: end.hms, drift_minutes: driftMinutes(slot, end.hm) ?? 0,
    basis, prev_date: ladder.sample_date, cohort, live, ...(liveReason ? { live_reason: liveReason } : {}), gaps,
  };
  try {
    if (!writeNewJson(slotFile(ctx.dataRoot, day, slot), snapshot)) return { ok: false, reason: "这个时点已经有一张了(别的请求先存上),保留先存的那张", already: true };
  } catch {
    return { ok: false, reason: "快照没存上(检查数据目录的权限或磁盘空间)" };
  }
  return { ok: true, snapshot };
}

/** 定时任务每一拍调一次:到了某个时点的窗口、今天这个时点还没存、没试满次数,就存一张 */
export async function intradayBeat(
  b: { ctx: ServiceContext; signal: AbortSignal; gate: () => Promise<GateResult> },
  deps: CaptureDeps = {},
): Promise<string | void> {
  const clock = deps.clock ?? (() => new Date());
  const { day, hm } = clockOf(clock());
  const slot = slotDue(hm);
  if (!slot || fs.existsSync(slotFile(b.ctx.dataRoot, day, slot))) return;
  const prev = readStatus(b.ctx.dataRoot, day)[slot];
  if (prev && (prev.state !== "failed" || prev.tries >= MAX_TRIES)) return;
  const tries = (prev?.tries ?? 0) + 1;
  const at = clock().toISOString();
  // 门判断取不到(unavailable)照样试:每只行情的时间必须是今天,节假日存不进去
  const gate = await b.gate();
  if (gate.status === "closed") {
    writeStatus(b.ctx.dataRoot, day, slot, { state: "skipped", reason: gate.reason, at, tries });
    return;
  }
  const r = await captureOnce(b.ctx, day, slot, b.signal, deps).run;
  if (!r.ok && r.already) return;
  writeStatus(b.ctx.dataRoot, day, slot, r.ok ? { state: "saved", at, tries } : { state: "failed", reason: r.reason, at, tries });
  return `盘中快照 ${slot}:${r.ok ? `已存(昨日涨停 ${r.snapshot.cohort.sample}/${r.snapshot.cohort.expected} 只)` : `没存,${r.reason}`}`;
}

// ---------------------------------------------------------------- 开不开市

/** 查交易日历:「今天是不是交易日」那条的日期必须就是今天,对不上就当没取到(与定时任务的门判断同口径)。盯盘也用它 */
export async function fetchTodayCalendar(ctx: ServiceContext, day: string, fetch: Fetch, signal: AbortSignal): Promise<CalendarFacts | null> {
  try {
    const r = await fetch(ctx, { endpoint: "fetch_trade_calendar", symbol: "300308", consistency: { mode: "fresh" }, signal });
    const env = r.envelope as { evidence?: { field?: string; value?: unknown; period?: string }[] };
    const period = (env.evidence ?? []).find((e) => e.field === "is_today_trading_day")?.period;
    return !failed(env) && period === day ? calendarFromEnvelope(env) : null;
  } catch (e) {
    if (signal.aborted) throw e;
    return null;
  }
}

export function isWeekend(day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * 页面没指定日期时该看哪一天。
 *
 * 🔴 **只在「今天不是交易日」时改口径**：退回最近一个交易日。
 *    非交易日拿"今天"只会得到一片空白（2026-10 现场：周日打开显示"这一天休市,没有盘中路径"），
 *    而这一页是复盘用的，用户想看的就是最近那个真实交易日。
 * 🔴 交易日**不动**：盘前/盘中的"今天"是活数据（09:25 自动存竞价快照），
 *    改成上一个交易日反而把正在盯的盘藏起来。
 * 🔴 拿不到日历就退回今天：这一页不该因为日历取不到而打不开，
 *    对不对由 `trading_day` 字段和页面说明交代。
 */
async function defaultReviewDate(ctx: ServiceContext, today: string, nowMs: number, fetch: Fetch, signal: AbortSignal): Promise<string> {
  // 缓存口径与 tradingDayOf 一致：取到了 30 分钟，没取到 1 分钟后再试
  const c = reviewDateCache.get(ctx.dataRoot);
  if (c && c.day === today && nowMs - c.at < (c.fetched ? 30 * 60_000 : 60_000)) return c.date;
  const facts = await fetchTodayCalendar(ctx, today, fetch, signal);
  let date = today;
  if (facts && !facts.is_today_trading_day) {
    const last = String(facts.last_trading_day ?? "");
    // 日历给的日子比今天还晚 = 数据不可信（或跨年边界），不拿它去猜，按今天显示
    if (validDate(last) && last <= today) date = last;
  }
  // 🔴 同一次取数顺手把「今天开不开市」告诉 tradingDayOf：
  //    否则这一页每次打开都要为同一个事实查两遍日历（注册表里这份日历是 cache_max_age_sec: 0，不便宜）。
  tradingCache.set(ctx.dataRoot, { day: today, at: nowMs, value: facts ? facts.is_today_trading_day : null });
  reviewDateCache.set(ctx.dataRoot, { day: today, at: nowMs, date, fetched: Boolean(facts) });
  return date;
}

const tradingCache = new Map<string, { day: string; at: number; value: boolean | null }>();
const reviewDateCache = new Map<string, { day: string; at: number; date: string; fetched: boolean }>();
export function resetIntradayCalendar(): void { tradingCache.clear(); reviewDateCache.clear(); }

/** 这一天开不开市:周末直接判;今天查日历(取到缓存 30 分钟,没取到 1 分钟后再查);过去的工作日不另查 → null(照「没存到」说) */
async function tradingDayOf(ctx: ServiceContext, date: string, today: string, nowMs: number, fetch: Fetch, signal: AbortSignal): Promise<boolean | null> {
  if (isWeekend(date)) return false;
  if (date !== today) return null;
  const c = tradingCache.get(ctx.dataRoot);
  if (c && c.day === date && nowMs - c.at < (c.value !== null ? 30 * 60_000 : 60_000)) return c.value;
  const facts = await fetchTodayCalendar(ctx, date, fetch, signal);
  const value = facts ? facts.is_today_trading_day : null;
  tradingCache.set(ctx.dataRoot, { day: date, at: nowMs, value });
  return value;
}

// ---------------------------------------------------------------- 视图

/** 快照里能给出明日验证某项的盘中读数吗(题材集中度只有收盘后才有) */
export function slotReading(s: Snapshot, metric: string): number | null {
  switch (metric) {
    case "money_effect_median": return s.cohort.median;
    case "deep_loss_count": return s.cohort.deep_loss_5;
    case "limit_up_count": return s.live?.limit_up ?? null;
    case "highest_board": return s.live?.highest_board ?? null;
    case "promotion_1to2": return s.live?.promotion_1to2 ?? null;
    case "broken_rate": return s.live?.broken_rate ?? null;
    case "market_limit_down": return s.live?.limit_down ?? null;
    default: return null;
  }
}
export const CLOSE_ONLY = new Set(["theme_concentration"]);

export interface SlotRow { slot: Slot; window_end: string; state: SlotState | "missing" | "upcoming"; reason: string | null; snapshot: Snapshot | null }
export interface CheckPoint { slot: Slot; value: number | null; actual: Direction | null; actual_label: string | null; verified: boolean | null }
export interface CheckItem {
  id: string; metric: string; label: string; unit: string; kind: VerifyMetric["kind"]; eps: number;
  direction: Direction; direction_label: string; reason: string;
  base_value: number | null; close_only: boolean; points: CheckPoint[];
}
export interface IntradayView {
  date: string; today: boolean;
  /** 这一天开不开市;null = 没查到(过去的工作日不另查) */
  trading_day: boolean | null;
  slots: SlotRow[];
  /** 09:25 竞价:有快照才有 */
  auction: Snapshot | null;
  auction_reason: string | null;
  checks: { set_date: string | null; items: CheckItem[] };
  warnings: string[];
  gaps: string[];
  basis_labels: Record<Basis, string>;
  source: string;
  generated_at: string;
}

const MISSING_REASON = "这个时点没存到快照(当时程序没开着、不是交易日,或取数失败)";

export async function shortlineIntraday(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date(), fetch: Fetch = fetchEndpoint): Promise<IntradayView> {
  const { day: today, hm } = clockOf(now);
  // 🔴 没指定日期时看**复盘页那一天**，不是「今天」。
  //    这一页是复盘用的：非交易日 / 盘前拿"今天"只会得到一片空白
  //    （2026-10 现场：周日打开显示"这一天休市,没有盘中路径"）。
  //    日期口径与复盘页共用 resolveSession，避免两页各算一天。
  const date = query.date ?? await defaultReviewDate(ctx, today, now.getTime(), fetch, signal);
  if (!validDate(date)) throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD");
  if (date > today) throw new ServiceError("bad_query", `${date} 还没到`);
  const { snapshots, warnings } = loadDay(ctx.dataRoot, date);
  const status = readStatus(ctx.dataRoot, date);
  const bySlot = new Map(snapshots.map((s) => [s.slot, s]));
  const tradingDay = await tradingDayOf(ctx, date, today, now.getTime(), fetch, signal);
  const closed = tradingDay === false ? (isWeekend(date) ? "周末休市" : "休市") : null;
  const slots: SlotRow[] = SLOTS.map((slot) => {
    const snap = bySlot.get(slot) ?? null;
    const st = status[slot];
    const past = date < today || hm > windowEnd(slot);
    const state: SlotRow["state"] = snap ? "saved" : st && st.state !== "saved" ? st.state : closed ? "skipped" : past ? "missing" : "upcoming";
    const reason = snap ? null : st && st.state !== "saved" ? st.reason ?? null : closed ?? (past ? MISSING_REASON : null);
    return { slot, window_end: windowEnd(slot), state, reason, snapshot: snap };
  });

  const auction = bySlot.get("09:25") ?? null;
  const auctionRow = slots[0]!;
  const auctionReason = auction ? null
    : closed ? `${closed},没有竞价`
    : auctionRow.state === "upcoming" ? "09:25 竞价结果出来后自动存(09:25–09:29)"
    : `09:25 竞价快照没有:${auctionRow.reason ?? MISSING_REASON}。过了时点补不回来`;

  // 盘中核验:前一晚写下的条件,逐个时点给读数(暂定)
  const gaps: string[] = [];
  const setDate = snapshots.find((s) => s.prev_date)?.prev_date ?? null;
  let items: CheckItem[] = [];
  if (setDate) {
    const { byDate } = itemsByDate(ledgerList(ctx, LEDGER_KIND)[LEDGER_KIND] ?? []);
    const conds = byDate.get(setDate) ?? [];
    if (conds.length) {
      const how = consistencyFor(setDate, retentionFloor(now), false);
      const grab = async (endpoint: string) => {
        try {
          const r = await fetch(ctx, { endpoint, args: { date: setDate }, consistency: how, signal });
          if (failed(r.envelope)) { gaps.push(`${setDate} 的${endpoint === "cn_shortline_daily" ? "每日读数" : "事实表"}没取到,对应条件没有基准值`); return undefined; }
          return r.envelope;
        } catch (e) {
          if (signal.aborted) throw e;
          gaps.push(`${setDate} 的${endpoint === "cn_shortline_daily" ? "每日读数" : "事实表"}没取到,对应条件没有基准值`);
          return undefined;
        }
      };
      const byKey = new Map(VERIFY_METRICS.map((m) => [m.key, m]));
      const needsFacts = conds.some((c) => byKey.get(c.metric)?.facts_field);
      const [daily, facts] = await Promise.all([grab("cn_shortline_daily"), needsFacts ? grab("cn_shortline_facts") : Promise.resolve(undefined)]);
      const base = metricValues(daily ? { values: valuesOf(daily), status: "ok" } : undefined, facts ? factsValuesOf(facts) : undefined);
      items = conds.flatMap((c): CheckItem[] => {
        const m = byKey.get(c.metric);
        if (!m) return [];
        const baseValue = base[m.key] ?? null;
        const closeOnly = CLOSE_ONLY.has(m.key);
        return [{
          id: c.id, metric: m.key, label: m.label, unit: m.unit, kind: m.kind, eps: m.eps,
          direction: c.direction, direction_label: DIRECTION_LABELS[c.direction], reason: c.reason,
          base_value: baseValue, close_only: closeOnly,
          points: snapshots.map((s) => {
            const value = closeOnly ? null : slotReading(s, m.key);
            const actual = actualDirection(value, baseValue, m.eps);
            return { slot: s.slot, value, actual, actual_label: actual ? DIRECTION_LABELS[actual] : null, verified: actual === null ? null : actual === c.direction };
          }),
        }];
      });
    }
  }

  return {
    date, today: date === today, trading_day: tradingDay, slots, auction, auction_reason: auctionReason,
    checks: { set_date: setDate, items }, warnings, gaps,
    basis_labels: BASIS_LABELS, source: INTRADAY_SOURCE, generated_at: now.toISOString(),
  };
}

/**
 * 手动存一张:`{ action: "capture" }`。只能存此刻所在时点的那张(窗口外直接说明);已经存过的不重抓。
 * 给定时任务关着、或者刚好错过一拍时用。
 */
export async function shortlineIntradayAct(ctx: ServiceContext, body: Record<string, unknown>, signal: AbortSignal, deps: CaptureDeps = {}): Promise<{ slot: Slot; ok: boolean; already: boolean; reason: string | null }> {
  if (body.action !== "capture") throw new ServiceError("bad_request", "action 只能是 capture");
  const clock = deps.clock ?? (() => new Date());
  const { day, hm } = clockOf(clock());
  const slot = slotDue(hm);
  if (!slot) throw new ServiceError("bad_request", `现在(${hm})不在任何快照时点的有效窗口里:${SLOTS.map((s) => `${s}–${windowEnd(s)}`).join("、")}`);
  if (fs.existsSync(slotFile(ctx.dataRoot, day, slot))) return { slot, ok: true, already: true, reason: null };
  const prev = readStatus(ctx.dataRoot, day)[slot];
  const c = captureOnce(ctx, day, slot, signal, deps);
  const r = await c.run;
  // 别的请求正在存或刚存上:不重抓、不改它记的状态,照它的结果说
  if (!c.mine) return { slot, ok: r.ok, already: r.ok, reason: r.ok ? null : r.reason };
  if (!r.ok && r.already) return { slot, ok: true, already: true, reason: null };
  writeStatus(ctx.dataRoot, day, slot, r.ok ? { state: "saved", at: clock().toISOString(), tries: (prev?.tries ?? 0) + 1 } : { state: "failed", reason: r.reason, at: clock().toISOString(), tries: (prev?.tries ?? 0) + 1 });
  return { slot, ok: r.ok, already: false, reason: r.ok ? null : r.reason };
}
