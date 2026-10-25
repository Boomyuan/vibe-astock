import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { API_MODELS, PROVIDER_BASE, SUBSCRIPTION_MODELS } from "../src/verticals/finance/lib/ai-models.ts";
import { aiConnectionLabel, subscriptionConfig, testAndSaveAi } from "../src/verticals/finance/lib/aiConnection.ts";

test("接入标签按来源显示，不泄露模型密钥或地址", () => {
  for (const status of ["none", "broken", "unavailable"] as const) assert.equal(aiConnectionLabel({ status, config: null }), "未接入AI，请设置");
  for (const [provider, label] of Object.entries({ "cli-codex": "Codex订阅版", "cli-claude": "Claude订阅", "cli-codebuddy": "WorkBuddy CLI", deepseek: "DeepSeek API", mimo: "MiMo API", "openai-compatible": "自定义 API" })) {
    assert.equal(aiConnectionLabel({ status: "ok", config: { schemaVersion: 2, source: { provider, apiKey: "secret", baseURL: "private", model: "model" } } }), `已接入AI：${label}`);
  }
});

test("三个快捷订阅使用现有来源，探针通过前不保存", async () => {
  for (const provider of ["cli-codex", "cli-claude", "cli-codebuddy"]) {
    const cfg = subscriptionConfig(provider);
    let saves = 0;
    await testAndSaveAi(cfg, { read: () => null, probe: async (input) => { assert.deepEqual(input, cfg); assert.equal(saves, 0); return { ok: true }; }, save: (input) => { assert.deepEqual(input, cfg); saves++; } });
    assert.equal(saves, 1);
    assert.equal(cfg.apiKey, "");
  }
  assert.throws(() => subscriptionConfig("unknown"));
});

test("探针失败、取消、配置被另一个页面改动时不保存", async () => {
  const cfg = subscriptionConfig("cli-claude");
  const success = { ok: true as const };
  for (const mode of ["failed", "aborted", "changed", "invalid"]) {
    const controller = new AbortController();
    let stored: string | null = null;
    await assert.rejects(testAndSaveAi(cfg, { read: () => stored, probe: async () => {
      if (mode === "failed") throw new Error("failed");
      if (mode === "aborted") controller.abort();
      if (mode === "changed") stored = "another source";
      if (mode === "invalid") return { ...success, ok: false } as unknown as typeof success;
      return success;
    }, save: () => assert.fail("must not save") }, controller.signal));
  }
});

test("无法持久化时不冒充接入成功", async () => {
  await assert.rejects(testAndSaveAi(subscriptionConfig("cli-codex"), { read: () => null, probe: async () => ({ ok: true }), save: () => { throw new Error("storage failed"); } }), /storage failed/);
});

test("API 档预设与 providers/ 模板一致：预填地址相同、模板的默认模型就在清单里（模板改了页面忘改会红）", () => {
  const dir = fileURLToPath(new URL("../../providers/", import.meta.url));
  const templated = API_MODELS.filter((m) => fs.existsSync(path.join(dir, `${m.provider}.json`)));
  const providers = [...new Set(templated.map((m) => m.provider))].sort();
  assert.deepEqual(providers, ["deepseek", "glm", "kimi", "mimo", "openai-api", "qwen"], "有模板的厂商少了一家:路径或清单不对");
  for (const pv of providers) {
    const tpl = JSON.parse(fs.readFileSync(path.join(dir, `${pv}.json`), "utf8")) as { base_url: string; default_model: string };
    assert.equal(PROVIDER_BASE[pv], tpl.base_url, `${pv} 的预填地址和模板不一致`);
    assert.ok(templated.some((m) => m.provider === pv && m.id === tpl.default_model),
      `${pv} 模板的默认模型 ${tpl.default_model} 不在页面清单里`);
  }
});

test("订阅档用的是用户自己登录好的 CLI：不再出现 v1 的「产品自带引擎 / 产品专用登录」，也不替用户推荐某一家", () => {
  assert.deepEqual(SUBSCRIPTION_MODELS.map((m) => m.provider), ["cli-codex", "cli-claude", "cli-codebuddy"]);
  for (const m of SUBSCRIPTION_MODELS) assert.doesNotMatch(m.description, /产品自带|产品专用|推荐/, m.name);
});

// ---------------- 三处状态必须同一句话（2026-10 现场：侧栏「未接入」/ 设置页「等待连接」/ 后端「已配置」） ----------------
import { aiConnectionText, resolveAiConnection } from "../src/verticals/finance/lib/aiConnection.ts";

test("本页有配置：以本页为准", () => {
  const c = resolveAiConnection(
    { status: "ok", config: { schemaVersion: 2, source: { provider: "cli-codebuddy", apiKey: "", baseURL: "", model: "x" } } },
    { profile: "deepseek", label: "DeepSeek API" },
  );
  assert.equal(c.status, "ok");
  assert.equal(c.status === "ok" && c.provider, "cli-codebuddy", "本页存的优先于后端默认");
  assert.equal(aiConnectionText(c), "已接入AI：WorkBuddy CLI");
});

test("本页没配置但后端有默认：既不能说「未接入」，也不能说「已接入」", () => {
  for (const status of ["none", "broken", "unavailable"] as const) {
    const c = resolveAiConnection({ status, config: null }, { profile: "cli-codebuddy", label: "WorkBuddy / CodeBuddy" });
    assert.equal(c.status, "backend_only");
    const text = aiConnectionText(c);
    assert.match(text, /后台默认：WorkBuddy \/ CodeBuddy/, "要说清后台用的是什么");
    assert.match(text, /测试并保存/, "要给出恢复办法");
    assert.doesNotMatch(text, /^未接入AI/, "后端明明配着，不能说未接入");
    assert.doesNotMatch(text, /^已接入AI/, "本页没有配置，页面发出的 AI 请求会被拒，不能说已接入");
  }
});

test("两边都没有才算未接入", () => {
  assert.equal(resolveAiConnection({ status: "none", config: null }, { profile: null }).status, "none");
  assert.equal(aiConnectionText(resolveAiConnection({ status: "none", config: null }, null)), "未接入AI，请设置");
});

test("后端没起来（还没读到）时不编造，仍按本页状态", () => {
  const c = resolveAiConnection({ status: "none", config: null }, null);
  assert.equal(c.status, "none");
  assert.equal(aiConnectionText(c), "未接入AI，请设置");
});

test("读不到本机存储时，后端也没配置要说「读不到」而不是「未接入」", () => {
  const c = resolveAiConnection({ status: "unavailable", config: null }, { profile: null });
  assert.equal(c.status, "unavailable");
  assert.match(aiConnectionText(c), /隐私/);
});
