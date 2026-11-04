"use client";
import { useState } from "react";
import { ChangePreview } from "@/components/ChangePreview";
import { ExpenseCard } from "@/components/ExpenseCard";
import { Badge, Section, Spinner } from "@/components/ui";
import type { ReconcileResult } from "@/lib/agent/run";
import { actions } from "@/lib/store";
import type { Expense, ProposedChange, Trip } from "@/lib/types";

const SEV = { high: "danger", medium: "warn", low: "gray" } as const;
const TYPE: Record<string, string> = { duplicate: "重复录入", participants: "参与人", payer: "付款人", amount_outlier: "金额异常", pending: "待补全", date: "日期", other: "其他" };

export function ReconcilePanel({ trip, expenses }: { trip: Trip; expenses: Expense[] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<ReconcileResult | null>(null);
  const [applied, setApplied] = useState<Record<string, "applied" | "ignored">>({});
  const [showTrace, setShowTrace] = useState(false);

  async function run() {
    setBusy(true);
    setErr("");
    setRes(null);
    setApplied({});
    try {
      const r = await fetch("/api/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip, expenses }) });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error ?? "核账失败");
      setRes(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "核账失败");
    } finally {
      setBusy(false);
    }
  }

  function apply(fid: string, c: ProposedChange) {
    if (c.action === "delete") actions.deleteExpense(c.expenseId, "agent-confirmed");
    else if (c.patch) actions.updateExpense(c.expenseId, c.patch, "agent-confirmed");
    setApplied((s) => ({ ...s, [fid]: "applied" }));
  }

  const byId = (id: string) => expenses.find((e) => e.id === id);

  return (
    <div className="space-y-4">
      <Section
        title="核账 Agent"
        right={
          <button className="btn btn-primary" disabled={busy || expenses.length === 0} onClick={run}>
            {busy ? <Spinner /> : null} {busy ? "核查中…" : res ? "重新核账" : "开始核账"}
          </button>
        }
      >
        <p className="text-sm text-ink-600">
          Agent 只持有对账本的<b>只读</b>工具（列账、查重、规则体检、分类统计、结算预览），逐项核查后提交带证据的结论。所有修改建议都要你在下面逐条确认才会生效。
        </p>
        {err && <p className="mt-2 text-sm text-danger-700">{err}</p>}
      </Section>

      {res && (
        <>
          <Section title="结论" right={<span className="text-xs text-ink-400">{res.usage.turns} 轮 · {res.trace.filter((t) => t.kind === "tool").length} 次工具调用 · {(res.usage.input / 1000).toFixed(1)}k 入 / {res.usage.output} 出</span>}>
            <p className="text-sm">{res.summary}</p>
          </Section>

          {res.findings.map((f) => (
            <section key={f.id} className="card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEV[f.severity]}>{{ high: "高", medium: "中", low: "低" }[f.severity]}</Badge>
                <Badge>{TYPE[f.type] ?? f.type}</Badge>
                <h3 className="font-semibold">{f.title}</h3>
              </div>
              <p className="mt-2 text-sm text-ink-600">
                <b>证据：</b>
                {f.evidence}
              </p>
              <p className="mt-1 text-sm text-ink-600">
                <b>建议：</b>
                {f.suggestion}
              </p>
              {f.expense_ids.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {f.expense_ids.map((id) => {
                    const e = byId(id);
                    return e ? <ExpenseCard key={id} trip={trip} e={e} /> : <p key={id} className="text-xs text-ink-400">#{id} 已不存在</p>;
                  })}
                </div>
              )}
              {f.proposed_change && (
                <div className="mt-3">
                  <ChangePreview trip={trip} expense={byId(f.proposed_change.expenseId)} change={f.proposed_change} applied={applied[f.id]} onApply={() => apply(f.id, f.proposed_change!)} onIgnore={() => setApplied((s) => ({ ...s, [f.id]: "ignored" }))} />
                </div>
              )}
            </section>
          ))}
          {res.findings.length === 0 && <p className="text-sm text-ink-400">没有发现问题。</p>}

          <div>
            <button className="text-xs text-ink-400 underline" onClick={() => setShowTrace((s) => !s)}>
              {showTrace ? "收起" : "查看"} Agent 执行轨迹
            </button>
            {showTrace && (
              <ol className="mt-2 space-y-2">
                {res.trace.map((t, i) => (
                  <li key={i} className="rounded-xl bg-white p-3 text-xs shadow-sm">
                    {t.kind === "plan" && (
                      <>
                        <Badge tone="brand">Planning</Badge>
                        <p className="mt-1 whitespace-pre-wrap">{t.text}</p>
                      </>
                    )}
                    {t.kind === "text" && <p className="whitespace-pre-wrap text-ink-600">{t.text}</p>}
                    {t.kind === "tool" && (
                      <>
                        <div className="flex items-center gap-2">
                          <Badge>工具</Badge>
                          <span className="mono font-semibold">{t.name}</span>
                          <span className="text-ink-400">{t.ms}ms</span>
                        </div>
                        <pre className="mono mt-1 overflow-x-auto text-ink-400">入参 {JSON.stringify(t.input)}</pre>
                        <pre className="mono mt-1 max-h-40 overflow-auto text-ink-600">回传 {JSON.stringify(t.output, null, 1)}</pre>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}
