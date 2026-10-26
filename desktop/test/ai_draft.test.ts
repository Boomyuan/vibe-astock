import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("页面放进 AI 输入框的文字：只填当前这一页放的；输入框按行数撑高，最多 8 行", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
  try {
    const { draftFor } = await server.ssrLoadModule("/src/core/ai/pageContext.tsx");
    const d = { text: "第 1 步", seq: 3, key: "sector:pcb" };
    assert.equal(draftFor(d, "sector:pcb"), "第 1 步");
    assert.equal(draftFor(d, "sector:hbm"), null, "换了页才收到的丢掉，不填进另一页的对话");
    assert.equal(draftFor(d, ""), null, "当前没有可聊的页面");
    assert.equal(draftFor({ ...d, key: "" }, ""), null);
    assert.equal(draftFor(null, "sector:pcb"), null);

    const { AiComposer } = await server.ssrLoadModule("/src/core/ai/AiMessages.tsx");
    const rows = (value?: string) => /rows="(\d+)"/.exec(renderToStaticMarkup(createElement(AiComposer, {
      placeholder: "问", disabled: false, onSend: () => {}, value, onValueChange: () => {},
    })))?.[1];
    assert.equal(rows(undefined), "1");
    assert.equal(rows(""), "1");
    assert.equal(rows("一行"), "1");
    assert.equal(rows("第一行\n第二行\n第三行"), "3");
    assert.equal(rows(Array.from({ length: 20 }, (_, i) => `第 ${i} 行`).join("\n")), "8");
  } finally { await server.close(); }
});

test("AI 入口收件：先收走再判断；填进输入框、打开面板，但不替用户发送；输入框里的字按页记", () => {
  const dock = read("core/ai/AiDock.tsx");
  const eff = dock.slice(dock.indexOf("const [draft, takeDraft] = useAiDraftInbox();"), dock.indexOf("}, [draft, pageKey, takeDraft]);"));
  assert.ok(eff.length > 0, "找不到收件的那段");
  assert.ok(eff.indexOf("takeDraft(draft.seq)") >= 0 && eff.indexOf("takeDraft(draft.seq)") < eff.indexOf("draftFor(draft, pageKey)"),
    "丢掉的也要先收走，不然留在那里，换到别的页面又被拿出来判断");
  assert.match(eff, /setOpen\(true\)/);
  assert.doesNotMatch(eff, /submit|send\(/, "不替用户发送：发出去会用掉用户 AI 的额度");
  assert.match(dock, /const text = input\.key === pageKey \? input\.text : "";/, "换页不显示上一页没发出去的字");
  assert.match(dock, /value=\{text\}\s*onValueChange=\{setText\}/);
  const ctx = read("core/ai/pageContext.tsx");
  assert.match(ctx, /setDraft\(\{ text, seq: seq\.current, key: pageKey \}\)/, "放的时候记下是哪一页放的");
  assert.match(ctx, /setDraft\(\(d\) => \(d\?\.seq === n \? null : d\)\)/, "只收走自己拿到的那一份，紧接着又放进来的不被误清");
  assert.match(ctx, /return useContext\(DraftCtx\)\?\.put \?\? null;/, "没挂 Provider 时给 null，让页面把按钮藏起来");
});

test("「问 Agent」没内容时要说得清原因，不能只灰着（2026-10-26 现场）", () => {
  // 现场：/watch、/watch/intraday、/shortline、/journal 四页按钮灰掉，其余七页可用，
  // 用户第一反应是「AI 坏了」。原因其实是页面没登记上下文（数据没取到 / 个人数据不提供），
  // 而原因只写在 hover tooltip 里 —— 没人会去悬停一个灰按钮。
  const dock = read("core/ai/AiDock.tsx");
  assert.match(dock, /disabled=\{!wired\}/, "只有接线没接上才真禁用；页面没内容时按钮要能点开看原因");
  assert.match(dock, /aria-disabled=\{!page\}/, "仍然要告诉读屏软件这一页问不了");
  assert.match(dock, /\{open && !page && \(/, "没有页面上下文时也要能开面板说原因");
  assert.match(dock, /data-ai-idle-note/, "原因要落在可断言、可读的节点上");
  assert.match(dock, /idleReason \?\? "这一页暂时没有可聊的内容/, "没登记原因时给默认说法");

  const ctx = read("core/ai/pageContext.tsx");
  assert.match(ctx, /export function useAiPageIdle\(reason: string \| null\): void/, "页面要能登记「为什么不能问」");
  assert.match(ctx, /idle: string \| null;/, "原因存在上下文里，跟 page 分开（page=null 时仍然要有）");

  // 交易日志是**故意**不给 AI 的：不是故障，要明说
  const journal = read("verticals/finance/pages/Journal.tsx");
  assert.match(journal, /useAiPageIdle\("交易日志属于个人数据，不提供给 AI。"\)/);
  assert.doesNotMatch(journal, /useAiPage\(/, "个人交易数据仍然不进任何提示词");
});
