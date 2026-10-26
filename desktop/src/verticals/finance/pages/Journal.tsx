import { useNavigate, useParams } from "react-router-dom";
import { BookOpenCheck, Layers, RefreshCw, SearchCheck, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageTabs, type PageTab } from "@/components/ui/PageTabs";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { cn } from "@/lib/utils";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";
import { useAiPageIdle } from "../../../core/ai/pageContext";
import type { AttributionView, EnvView, ExcursionView } from "@/lib/journal";
import { useJournal, useJournalExtra } from "@/journal/useJournal";
import { Panel } from "@/journal/bits";
import { FeeSettings, RulesEditor } from "@/journal/forms";
import { RecordsTab } from "@/journal/RecordsTab";
import { RiskTab } from "@/journal/RiskTab";
import { ReviewTab } from "@/journal/ReviewTab";
import { ModesTab } from "@/journal/ModesTab";

type Tab = "records" | "risk" | "review" | "modes";
const TABS: PageTab<Tab>[] = [
  { key: "records", label: "交易记录", icon: BookOpenCheck },
  { key: "risk", label: "风险与纪律", icon: ShieldAlert },
  { key: "review", label: "复查", icon: SearchCheck },
  { key: "modes", label: "模式卡", icon: Layers },
];
const isTab = (v: string | undefined): v is Tab => TABS.some((t) => t.key === v);

/**
 * 交易日志:自己的每笔交易对上入场那天的情绪和板位,时间久了能回答「我在情绪弱的日子是不是明显更差」。
 * 🔴 个人交易数据只给这一页看:不登记 AI 页面上下文(不调 useAiPage),不进任何 AI 提问,也不进 MCP。
 * 🔴 只统计自己的历史行为,不预测市场、不给下一笔建议。
 */
export function Journal() {
  // 🔴 这一页**故意**不登记 AI 页面上下文（个人交易数据不进任何提示词，见文件头）。
  //    但要登记「为什么不能问」：否则「问 Agent」只是灰着，看起来像坏了。
  useAiPageIdle("交易日志属于个人数据，不提供给 AI。");
  const { tab: rawTab } = useParams();
  const tab: Tab = isTab(rawTab) ? rawTab : "records";
  const navigate = useNavigate();
  const { on: hide } = usePrivacyMode();
  const { st, staleWhy, busy, revision, reload, act } = useJournal();
  const ready = st.state === "done" && st.data.available;
  // 三个要取行情的视图只在用到它的分页取;记了一笔、改了设置(revision 变了)跟着重取
  const env = useJournalExtra<EnvView>("journal_env", revision, ready && tab === "records");
  const excursion = useJournalExtra<ExcursionView>("journal_excursion", revision, ready && tab === "review");
  const attribution = useJournalExtra<AttributionView>("journal_attribution", revision, ready && tab === "review");
  const extraBusy = (tab === "records" && env.busy) || (tab === "review" && (excursion.busy || attribution.busy));
  const pick = (t: Tab) => navigate(t === "records" ? "/journal" : `/journal/${t}`);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="交易日志"
        subtitle="每笔交易自动对上入场那天的情绪和板位;时间久了能回答「我在情绪弱的日子是不是明显更差」这类问题。数据只存在本机。"
        actions={(
          <button type="button" onClick={reload} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
            <RefreshCw className={cn("h-3.5 w-3.5", (busy || extraBusy) && "animate-spin")} /> 刷新
          </button>
        )}
      />
      {staleWhy && st.state === "done" && (
        <p role="status" className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">这次没读到最新数据({staleWhy}),下面是上一次读到的。</p>
      )}
      <PageTabs label="交易日志的分页" value={tab} onChange={pick} options={TABS} />

      {st.state === "loading" ? <p role="status" className="glass p-6 text-sm text-muted-foreground">交易日志加载中…</p>
        : st.state === "failed" ? <p role="status" className="glass p-6 text-sm text-muted-foreground">交易日志没读到:{st.why}。可点右上角刷新重试。</p>
        : !st.data.available ? (
          <div className="space-y-4">
            <Panel title="交易日志的设置有问题,先修好才能算" hint="读到的设置不完整或不合规则。原来的记录没有动;按自己的账户把费率和规矩重新填一遍、保存,就能恢复。">
              <p role="status" className="text-[12px] text-warning">⚠️ {st.data.reason}</p>
            </Panel>
            <section className="glass p-4 sm:p-5"><FeeSettings settings={st.data.settings} act={act} /></section>
            <Panel title="你自己的规矩"><RulesEditor settings={st.data.settings} act={act} /></Panel>
          </div>
        )
        : tab === "records" ? <RecordsTab v={st.data} env={env.st} hide={hide} act={act} />
        : tab === "risk" ? <RiskTab v={st.data} hide={hide} act={act} />
        : tab === "review" ? <ReviewTab inbox={st.data.inbox} excursion={excursion.st} attribution={attribution.st} hide={hide} />
        : <ModesTab modes={st.data.modes} playbooks={st.data.playbooks} act={act} />}

      <p className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground/80">
        交易日志只存在本机的数据目录里,不上传,也不发给 AI。本页只统计你自己记下的历史行为,不构成投资建议。
      </p>
      <Disclaimer />
    </div>
  );
}
