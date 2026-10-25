import { SUBSCRIPTION_MODELS } from "./ai-models.ts";
import type { AiRuntimeRead, LlmConfig } from "./llmStore.ts";

const SOURCE_LABELS: Record<string, string> = {
  "cli-codex": "Codex订阅版", "cli-claude": "Claude订阅", "cli-codebuddy": "WorkBuddy CLI",
  deepseek: "DeepSeek API", mimo: "MiMo API", "openai-api": "OpenAI API", silicon: "硅基流动 API",
  minimax: "MiniMax API", openrouter: "OpenRouter API", groq: "Groq API", together: "Together API",
  glm: "智谱 GLM API", kimi: "Kimi API", qwen: "通义千问 API",
};

/** 接的是哪家(给人看的名字);认不出的一律叫「自定义 API」 */
export function aiSourceName(provider: string): string {
  return SOURCE_LABELS[provider] ?? "自定义 API";
}

/** Saved connection identity, not a claim that the remote subscription never expires. */
export function aiConnectionLabel(runtime: AiRuntimeRead): string {
  if (runtime.status !== "ok" || !runtime.config) return "未接入AI，请设置";
  return `已接入AI：${aiSourceName(runtime.config.source.provider)}`;
}

/**
 * 当前到底用哪个 AI —— **一个判定，三处显示**。
 *
 * 🔴 原来侧栏只看 localStorage（`readAiRuntime`），设置页另有一套 `configured` 状态，后端又只报自己的
 *    `.local/config.json`。三处各说各的：侧栏「未接入」、设置页「等待连接」、后端「已配置」，
 *    而研究实际跑得通（2026-10 现场）。
 *
 * 🔴 根因：页面把「本页存过的连接」当成「当前连接」。localStorage 是按**源**（scheme+host+port）隔离的，
 *    而启动脚本在 5940 被占用时会换端口 —— 换个端口就是换一个源，之前存的配置整个消失。
 *    这时请求会退回后端默认来源（照常能用），界面却报「未接入」。
 *
 * 所以：**本页有就用本页的，本页没有就看后端默认**；两边都没有才算没接入。
 */
export type AiConnection =
  | { status: "ok"; provider: string; label: string; from: "local" }
  | { status: "backend_only"; provider: string; label: string }
  | { status: "none" | "broken" | "unavailable" };

export interface BackendProvider {
  profile: string | null;
  label?: string | null;
}

export function resolveAiConnection(runtime: AiRuntimeRead, backend?: BackendProvider | null): AiConnection {
  if (runtime.status === "ok" && runtime.config) {
    const provider = runtime.config.source.provider;
    return { status: "ok", provider, label: `已接入AI：${aiSourceName(provider)}`, from: "local" };
  }
  // 本页没存，但后台有默认来源：**不能说「未接入」**（研究/命令行确实在用它），
  // 也不能说「已接入」（页面发出的 AI 请求会因为本页没有配置被后端拒绝）。
  // 如实说：后台默认是谁 + 怎么恢复。
  if (backend?.profile) {
    return {
      status: "backend_only", provider: backend.profile,
      label: `${backend.label || aiSourceName(backend.profile)}（后台默认）`,
    };
  }
  if (runtime.status === "unavailable") return { status: "unavailable" };
  if (runtime.status === "broken") return { status: "broken" };
  return { status: "none" };
}

/** 连接状态的**唯一**文案出口：侧栏、设置页、提示卡都用它，不再各写一句。 */
export function aiConnectionText(c: AiConnection): string {
  switch (c.status) {
    case "ok": return c.label;
    case "backend_only": return `本页未连接 AI（后台默认：${c.label}）— 到「接入 AI」点一次「测试并保存」即可恢复`;
    case "broken": return "接入配置读不懂，请重新设置";
    case "unavailable": return "读不到本机配置，请检查浏览器隐私设置";
    default: return "未接入AI，请设置";
  }
}

export function subscriptionConfig(provider: string): LlmConfig {
  const model = SUBSCRIPTION_MODELS.find((entry) => entry.provider === provider);
  if (!model) throw new Error("不支持的快捷接入方式");
  return { provider: model.provider, model: model.id, baseURL: "", apiKey: "" };
}

interface ConnectionActions {
  read: () => string | null;
  probe: (config: LlmConfig, signal?: AbortSignal) => Promise<{ ok: true }>;
  save: (config: LlmConfig) => void;
}

/** Settings and home share the same probe-before-save contract. Never overwrite a newer choice. */
export async function testAndSaveAi(config: LlmConfig, actions: ConnectionActions, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const previous = actions.read();
  const probe = await actions.probe(config, signal);
  signal?.throwIfAborted();
  if (probe.ok !== true) throw new Error("连接测试未成功，请重试");
  if (actions.read() !== previous) throw new Error("AI 接入配置已在其他页面更改，请重新确认当前选择");
  actions.save(config);
}
