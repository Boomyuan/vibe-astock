import { useEffect, useState } from "react";

import { AI_RUNTIME_CHANGED, LLM_KEY, readAiRuntime } from "@/lib/llmStore";
import { resolveAiConnection, type AiConnection, type BackendProvider } from "@/lib/aiConnection";
import { backend } from "@/lib/backend";

export function useAiRuntime() {
  const [runtime, setRuntime] = useState(() => readAiRuntime());
  useEffect(() => {
    const refresh = () => setRuntime(readAiRuntime());
    const storage = (event: StorageEvent) => { if (event.key === LLM_KEY) refresh(); };
    globalThis.addEventListener(AI_RUNTIME_CHANGED, refresh);
    globalThis.addEventListener("storage", storage);
    return () => {
      globalThis.removeEventListener(AI_RUNTIME_CHANGED, refresh);
      globalThis.removeEventListener("storage", storage);
    };
  }, []);
  return runtime;
}

/**
 * 当前连接（本页配置 + 后端默认），**侧栏与设置页共用这一个**。
 *
 * 🔴 只读 localStorage 是不够的：本页存的配置按源（scheme+host+port）隔离，
 *    启动脚本在 5940 被占用时会换端口 —— 换端口就是换源，之前存的配置整份消失；
 *    而请求会退回后端默认来源照常可用。界面不能因为「本页没存」就报「未接入」。
 *    后端那份读不到（API 没起来）时不编造，仍按本页状态显示。
 */
export function useAiConnection(): AiConnection {
  const runtime = useAiRuntime();
  const [backendProvider, setBackendProvider] = useState<BackendProvider | null>(null);
  useEffect(() => {
    let alive = true;
    backend.product()
      .then((info) => {
        if (!alive) return;
        setBackendProvider({ profile: info.provider.profile, label: info.provider.label });
      })
      .catch(() => { /* 后端没起来：不编造，按本页状态显示 */ });
    return () => { alive = false; };
  }, []);
  return resolveAiConnection(runtime, backendProvider);
}
