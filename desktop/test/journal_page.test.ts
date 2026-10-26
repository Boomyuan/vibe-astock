// 交易日志页:用后端真算出来的视图(合成交易,不是任何人的持仓)渲染,断言用户看得到什么、隐私模式遮了什么。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { textOf, withRenderer } from "./helpers/render.ts";
import { MASK } from "../src/verticals/finance/lib/privacy.ts";
import {
  boardText, equityChart, fillsPayload, maskJournalText, parseNum, rowState, ruleValueText, violationText,
  type EnvRow, type JournalRow, type JournalView, type Violation,
} from "../src/verticals/finance/lib/journal.ts";

const VIEW = JSON.parse(readFileSync(new URL("./fixtures/journal-view.json", import.meta.url), "utf8")) as Extract<JournalView, { available: true }>;
const keyOf = (symbol: string) => VIEW.rows.find((r) => r.symbol === symbol)!.key;
const envRow = (symbol: string, extra: Partial<EnvRow>): EnvRow => ({
  key: keyOf(symbol), date: VIEW.rows.find((r) => r.symbol === symbol)!.date,
  regime: "情绪中", score: 100, money_effect: null, board: "没碰涨停", boards: null, first_seal: null, broken_times: null, industry: null, ...extra,
});
const ENV = {
  available: true, scored_days: 6, unsettled_trades: 1, scanned: 4, days: 4, gaps: ["1 天的涨停池没取到(东财 502):2026-10-08"], note: "按入场那天的市场环境分组。", source: "测试",
  regime_cuts: { low: 80, high: 160 },
  rows: [
    envRow("600001", { regime: "情绪强", score: 200, money_effect: 1.2, board: "首板", boards: 1, first_seal: "09:31:05", broken_times: 1, industry: "半导体" }),
    envRow("002002", { regime: "情绪弱", score: 40, money_effect: -2.5, board: "炸板", broken_times: 2, industry: "银行" }),
    envRow("300003", { regime: null, score: null, board: null }),
  ],
  by_regime: [{ key: "情绪强", count: 1, scored: 1, money_scored: 1, net_pnl: 984.29, win_rate: 1, avg: 9.84, best: 9.84, worst: 9.84 }],
  by_board: [{ key: "首板", count: 1, scored: 1, money_scored: 1, net_pnl: 984.29, win_rate: 1, avg: 9.84, best: 9.84, worst: 9.84 }],
};
const done = <T>(data: T) => ({ state: "done" as const, data });
const noop = async () => undefined;

async function render(file: string, name: string, props: Record<string, unknown>): Promise<{ html: string; text: string }> {
  return withRenderer(async (r) => {
    const mod = await r.load(`/src/verticals/finance/journal/${file}`);
    const { MemoryRouter } = await r.load("react-router-dom");
    const html = r.html(() => createElement(MemoryRouter, null, createElement(mod[name], props)), {});
    return { html, text: textOf(html) };
  });
}

/* ---------------- 纯函数 ---------------- */

test("成交草稿:整行空的跳过;填了一半报出第几笔、哪里不对;费用可不填", () => {
  const blank = { type: "buy" as const, date: "2026-10-09", price: "", shares: "", fee: "" };
  assert.deepEqual(fillsPayload([blank]), { error: "至少要填一笔成交(价格和股数)" });
  assert.deepEqual(fillsPayload([{ ...blank, price: "10.5", shares: "100" }, blank]), { fills: [{ type: "buy", date: "2026-10-09", price: 10.5, shares: 100 }] });
  assert.deepEqual(fillsPayload([{ ...blank, price: "10", shares: "100", fee: "0" }]), { fills: [{ type: "buy", date: "2026-10-09", price: 10, shares: 100, fee: 0 }] });
  assert.match((fillsPayload([blank, { ...blank, price: "10", shares: "100.5" }]) as { error: string }).error, /^第 2 笔成交:股数要是正整数/);
  assert.match((fillsPayload([{ ...blank, price: "0", shares: "100" }]) as { error: string }).error, /价格要是大于 0/);
  assert.match((fillsPayload([{ ...blank, price: "10", shares: "100", fee: "-1" }]) as { error: string }).error, /费用要是不小于 0/);
  assert.match((fillsPayload([{ ...blank, date: "", price: "10", shares: "100" }]) as { error: string }).error, /日期没填/);
});

test("输入框的数:空是没填,写错是 undefined,盈亏可以带 %", () => {
  assert.equal(parseNum(""), null);
  assert.equal(parseNum("  "), null);
  assert.equal(parseNum("3.2%"), 3.2);
  assert.equal(parseNum("-5 ％"), -5);
  assert.equal(parseNum("abc"), undefined);
});

test("隐私模式:后端句子里的「N 元」和「中位仓位(N)」遮掉,百分比和笔数不遮", () => {
  assert.equal(maskJournalText("另有 1 笔没写计划止损、占用本金 4,500 元,最坏情况无从估计", true), `另有 1 笔没写计划止损、占用本金 ${MASK} 元,最坏情况无从估计`);
  assert.equal(maskJournalText("占用 12,000.5 元,是你中位仓位(8,000)的 1.5 倍", true), `占用 ${MASK} 元,是你中位仓位(${MASK})的 1.5 倍`);
  assert.equal(maskJournalText("亏 -7.6%,超过你自己写的单笔上限 5%", true), "亏 -7.6%,超过你自己写的单笔上限 5%");
  assert.equal(maskJournalText("占用 12,000 元", false), "占用 12,000 元");
  const day: Violation = { date: "2026-09-10", rule: "max_loss_per_day_pct", label: "单日最大亏损", limit: 8, actual: 9.1, detail: "当日净亏 18,200 元,占账户 9.1%" };
  assert.equal(violationText(day, true), "2026-09-10 当日净亏占账户 9.1%");
  assert.equal(violationText(day, false), day.detail);
});

test("板位、规矩的写法和行状态", () => {
  assert.equal(boardText(undefined), "—");
  assert.equal(boardText(ENV.rows[0]), "首板 · 首封 09:31 · 炸 1 次 · 半导体");
  assert.equal(boardText({ ...ENV.rows[0]!, board: "3板及以上", boards: 4, first_seal: null, broken_times: 0, industry: null }), "4板");
  assert.equal(boardText({ ...ENV.rows[0]!, board: "2板", boards: 2, broken_times: null }), "2板 · 首封 09:31 · 半导体");
  assert.equal(boardText(ENV.rows[1]), "炸板 2 次 · 银行");
  assert.equal(boardText({ ...ENV.rows[1]!, broken_times: null, industry: null }), "炸板");
  assert.equal(boardText(ENV.rows[2]), "—");
  assert.equal(ruleValueText("max_unplanned_ratio", 0.2), "20%");
  assert.equal(ruleValueText("max_positions", 3), "3 只");
  assert.equal(ruleValueText("max_loss_per_trade_pct", 5), "5%");
  const states = VIEW.rows.map((r: JournalRow) => [r.symbol, rowState(r)]);
  assert.deepEqual(states, [["600004", "open"], ["300003", "open"], ["002002", "closed"], ["600001", "closed"], ["000001", "manual"]]);
});

/* ---------------- 交易记录 ---------------- */

test("交易记录:体检读数、分组表、逐笔里的情绪和板位都画出来,红涨绿跌", async () => {
  const { html, text } = await render("RecordsTab.tsx", "RecordsTab", { v: VIEW, env: done(ENV), hide: false, act: noop });
  assert.match(text, /自我体检/);
  assert.match(text, /共 5 笔\(3 笔有盈亏\)/);
  // 净盈亏是亏的:绿色;最好一笔是赚的:红色
  assert.match(html, /class="[^"]*text-success[^"]*">-2,055\.71</);
  assert.match(html, /class="[^"]*text-danger[^"]*">\+9\.84%</);
  // 分组:情绪环境、板位来自环境视图;打法组里只有 1 笔的标「样本少」
  for (const t of ["按情绪环境", "按当时板位", "按打法", "按是否按计划", "按持有周期"]) assert.match(text, new RegExp(t));
  assert.match(text, /打板 1\/1 样本少/);
  assert.match(text, /1 天的涨停池没取到/);
  assert.match(text, /1 笔入场日当天还没收盘/);
  // 逐笔:情绪 + 赚钱效应、板位、没卖完的股数、补记、事后补
  assert.match(text, /情绪强 · 赚钱效应 \+1\.20%/);
  assert.match(text, /首板 · 首封 09:31 · 炸 1 次 · 半导体/);
  assert.match(text, /炸板 2 次 · 银行/);
  assert.match(text, /情绪弱 · 赚钱效应 -2\.50%/);
  assert.match(text, /当天未收盘/);
  // 一笔都没卖的写占用(VA 同),卖过一部分的写已卖部分
  assert.match(text, /没卖完 · 300 股 · 占用 4,500/);
  assert.match(text, /没卖完 · 500 股 · 占用 15,000/);
  assert.match(text, /示例银行 000001 半路 [^|]*\+3\.20% 补记/);
  assert.match(text, /止损 9\.5/);
  // 两笔没卖完的才有「补成交」
  assert.equal((text.match(/补成交/g) ?? []).length, 2);
  assert.match(html, /href="\/my-stocks\?tab=hold"/);
  // 费率还是初值要标出来;新记一笔的打法默认不填
  assert.match(text, /还在用初值/);
  assert.match(html, /<option value="" selected="">打法\(不填\)<\/option>/);
});

test("交易记录:隐私模式下金额、股数、止损价遮掉,百分比照常", async () => {
  const { text } = await render("RecordsTab.tsx", "RecordsTab", { v: VIEW, env: done(ENV), hide: true, act: noop });
  for (const s of ["2,055.71", "984.29", "3,040", "300 股", "9.5", "4,500", "15,000"]) assert.ok(!text.includes(s), `隐私模式下还露出 ${s}`);
  assert.match(text, new RegExp(`没卖完 · ${MASK} 股 · 占用 ${MASK}`));
  assert.match(text, new RegExp(`止损 ${MASK}`));
  assert.match(text, /\+9\.84%/);
  assert.match(text, /-7\.60%/);
});

test("交易记录:环境视图还在取写「加载中」,没取到写原因;其余照常", async () => {
  const loading = await render("RecordsTab.tsx", "RecordsTab", { v: VIEW, env: { state: "loading" }, hide: false, act: noop });
  assert.match(loading.text, /按入场日环境分组加载中…/);
  assert.match(loading.text, /按打法/);
  const failed = await render("RecordsTab.tsx", "RecordsTab", { v: VIEW, env: { state: "failed", why: "东财接口 502" }, hide: false, act: noop });
  assert.match(failed.text, /按入场日环境分组这次没取到:东财接口 502/);
  assert.doesNotMatch(failed.text, /情绪强/);
});

test("交易记录:读数取到但天数太少写「不分强中弱」;没填简称只写一次代码", async () => {
  const v = { ...VIEW, rows: VIEW.rows.map((r) => (r.symbol === "600004" ? { ...r, name: "" } : r)) };
  const env = { ...ENV, rows: [envRow("600004", { regime: "环境未覆盖", score: 120, money_effect: -1.85 }), envRow("300003", { regime: "环境未覆盖", score: null })] };
  const { text } = await render("RecordsTab.tsx", "RecordsTab", { v, env: done(env), hide: false, act: noop });
  assert.match(text, /天数少 · 不分强中弱 · 赚钱效应 -1\.85%/);
  assert.match(text, /示例丙 300003 [^|]*环境未覆盖/);
  assert.doesNotMatch(text, /600004 600004/);
  assert.match(text, /2026-\d\d-\d\d 600004 /);
});

/* ---------------- 风险与纪律 ---------------- */

test("交易记录:没卖完但卖过一部分的写已卖部分,不写占用", async () => {
  const v = { ...VIEW, rows: VIEW.rows.map((r) => (r.symbol === "600004" && r.episode ? { ...r, episode: { ...r.episode, realized_pnl: 120 } } : r)) };
  const { text } = await render("RecordsTab.tsx", "RecordsTab", { v, env: done(ENV), hide: false, act: noop });
  assert.match(text, /没卖完 · 300 股 · 已卖部分 \+120/);
  assert.doesNotMatch(text, /占用 4,500/);
  assert.match(text, /没卖完 · 500 股 · 占用 15,000/);
});

test("风险与纪律:在险资金、权益曲线、纪律、规矩都在;亏损是绿色;隐私模式遮掉金额", async () => {
  const shown = await render("RiskTab.tsx", "RiskTab", { v: VIEW, hide: false, act: noop });
  assert.match(shown.text, /按计划止损估算的在险资金/);
  assert.match(shown.text, /占用本金 4,500 元/);
  assert.match(shown.text, /权益曲线的形状/);
  assert.match(shown.html, /class="[^"]*text-success[^"]*">−3,040</, "回撤用跌色");
  assert.match(shown.text, /计划外交易的代价/);
  assert.match(shown.text, /示例乙 亏 -7\.6%/);
  assert.match(shown.text, /最多同时持仓没法完整核对/);
  assert.match(shown.text, /还在用初值 · 改成你自己的/);

  const hidden = await render("RiskTab.tsx", "RiskTab", { v: VIEW, hide: true, act: noop });
  for (const s of ["4,500", "3,040", "2,055.71", "984.29", "200000", "28"]) assert.ok(!hidden.text.includes(s), `隐私模式下还露出 ${s}`);
  assert.match(hidden.text, new RegExp(`占用本金 ${MASK} 元`));
  assert.match(hidden.text, /−8\.33%|-7\.6%/);
  assert.match(hidden.html, /type="password"/, "账户规模输入框换成密码样式");
  // 🔴 金额曲线的形状本身就是金额大小:隐私模式下不画,也不往图表里传金额序列
  assert.match(hidden.text, /隐私模式下不画曲线/);
  assert.doesNotMatch(shown.text, /隐私模式下不画曲线/);
  const pts = [{ date: "2026-10-08", cum_pnl: 984.29, drawdown: 0 }, { date: "2026-10-09", cum_pnl: -2055.71, drawdown: 3040 }];
  assert.equal(equityChart(pts, {} as never, true), null);
  assert.ok(JSON.stringify(equityChart(pts, {} as never, false)).includes("984.29"));
});

/* ---------------- 复查 / 模式卡 ---------------- */

test("复查:收件箱的标记、慢视图的加载和没数据", async () => {
  const { text } = await render("ReviewTab.tsx", "ReviewTab", {
    inbox: VIEW.inbox, hide: false,
    excursion: { state: "loading" },
    attribution: done({ available: false, reason: "最近还没有对完账的验证条件", gaps: [], skipped_no_read: 2 }),
  });
  assert.match(text, /值得回头看一眼的 2 \/ 5 笔/);
  assert.match(text, /还在手上,但没写计划止损/);
  assert.match(text, /亏 -7\.6%,超过你自己写的单笔上限 5%/);
  assert.match(text, /最大浮盈浮亏加载中…/);
  assert.match(text, /最近还没有对完账的验证条件/);
  assert.match(text, /2 笔那天前一晚没写验证条件/);
});

test("模式卡:版本表、样本不足不比较", async () => {
  const { text } = await render("ModesTab.tsx", "ModesTab", { modes: VIEW.modes, playbooks: VIEW.playbooks, act: noop });
  assert.match(text, /我这套打法/);
  assert.match(text, /首板早封 打板 1 个版本 · 对上 1 笔/);
  assert.match(text, /v1 2026-08-25 打板 1\*/);
  assert.match(text, /不到 \d+ 笔/);
  assert.match(text, /\+ 新建模式卡/);
});

/* ---------------- 合规 ---------------- */

test("交易日志不登记 AI 页面上下文:个人交易数据不进 AI", () => {
  const dir = new URL("../src/verticals/finance/journal/", import.meta.url);
  const files = [new URL("../src/verticals/finance/pages/Journal.tsx", import.meta.url), ...readdirSync(dir).map((f) => new URL(f, dir))];
  // 注释里会写「不调 useAiPage」,所以只查真正的调用。
  // 🔴 允许 `useAiPageIdle`（只说「这一页为什么不提供给 AI」，不带任何数据）——
  //    原来连模块都不许导入，结果按钮只能灰着，用户以为 AI 坏了（2026-10-26 现场）。
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /\buseAiPage\s*\(/, `${f.pathname} 不该登记 AI 页面上下文（那是数据通道）`);
    assert.doesNotMatch(src, /\buseAiDraft\s*\(/, `${f.pathname} 不该往 AI 输入框里塞交易数据`);
  }
});

test("🔴 隐私模式:编辑标注、补成交、记一笔里的价位 / 股数 / 费用输入框换成密码样式(2026-10-11 审计)", async () => {
  const row = { ...VIEW.rows.find((r) => r.episode && r.episode.open_shares > 0)!, planned_stop: 9.5, planned_target: 12.3 };
  const typeOf = (html: string, label: string) => {
    const tag = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0];
    assert.ok(tag, `没找到输入框 ${label}`);
    return tag.match(/type="(\w+)"/)?.[1];
  };
  for (const hide of [true, false]) {
    const want = hide ? "password" : "text";
    const tag = await render("forms.tsx", "TagEditor", { row, playbooks: VIEW.playbooks, hide, act: noop, onDone: noop });
    assert.equal(typeOf(tag.html, "计划止损价"), want);
    assert.equal(typeOf(tag.html, "计划目标价"), want);
    const fill = await render("forms.tsx", "AppendFill", { row, today: VIEW.today, hide, act: noop, onDone: noop });
    for (const label of ["成交价", "股数", "费用"]) assert.equal(typeOf(fill.html, label), want, label);
    assert.equal(fill.text.includes(MASK), hide, "旁边的「现在还有 N 股」跟着遮");
    const rec = await render("forms.tsx", "RecordForm", { today: VIEW.today, playbooks: VIEW.playbooks, hide, act: noop, openShares: () => undefined });
    for (const label of ["计划止损价", "计划目标价", "第 1 笔成交价", "第 1 笔股数", "第 1 笔费用"]) assert.equal(typeOf(rec.html, label), want, label);
    // 代码、日期、备注不是金额,不遮
    assert.notEqual(typeOf(rec.html, "代码"), "password");
  }
});
