"use client";
import { useState } from "react";
import { ChangePreview } from "@/components/ChangePreview";
import { ExpenseCard } from "@/components/ExpenseCard";
import { Badge, Empty, Icon, Section, Skeleton, Spinner } from "@/components/ui";
import { DEMO_QUESTIONS, demoResults, type DemoReport } from "@/lib/demo";
import { printReport } from "@/lib/export";
import { money } from "@/lib/format";
import type { SearchResult } from "@/lib/search/answer";
import { actions } from "@/lib/store";
import type { Expense, ProposedChange, Trip } from "@/lib/types";

const EXAMPLES = ["第一天晚上那顿火锅是谁付的？", "小林付的超过 300 的账", "10月2号的门票花了多少", "把钟水饺那笔的参与人改成大家", "这趟餐饮一共花了多少，谁付得最多"];

type Report = DemoReport;

export function SearchPanel({ trip, expenses }: { trip: Trip; expenses: Expense[] }) {
  /* 示例旅行：账本没动过时预填一问一答（和报告），都是预先对示例账真实跑出来的 */
  const [demo] = useState(() => demoResults(trip, expenses));
  const [q, setQ] = useState(demo?.search?.query ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<SearchResult | null>(demo?.search?.result ?? null);
  const [applied, setApplied] = useState<Record<number, "applied" | "ignored">>({});
  const [report, setReport] = useState<Report | null>(demo?.report ?? null);
  const [reportBusy, setReportBusy] = useState(false);

  async function search(query = q) {
    if (!query.trim()) return;
    setBusy(true);
    setErr("");
    setRes(null);
    setApplied({});
    try {
      const r = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip, expenses, query }) });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error ?? "检索失败");
      setRes(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "检索失败");
    } finally {
      setBusy(false);
    }
  }

  async function genReport() {
    setReportBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip, expenses }) });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error ?? "生成失败");
      setReport(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "生成失败");
    } finally {
      setReportBusy(false);
    }
  }

  function apply(i: number, c: ProposedChange) {
    if (c.action === "delete") actions.deleteExpense(c.expenseId, "search-confirmed");
    else if (c.patch) actions.updateExpense(c.expenseId, c.patch, "search-confirmed");
    setApplied((s) => ({ ...s, [i]: "applied" }));
  }

  const byId = (id: string) => expenses.find((e) => e.id === id);

  return (
    <div className="space-y-4">
      <Section title="问账本">
        <div className="flex gap-2">
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="用自然语言描述：那天在景区吃的…" onKeyDown={(e) => e.key === "Enter" && search()} />
          <button className="btn btn-primary" disabled={busy || !q.trim()} onClick={() => search()}>
            {busy ? <Spinner /> : "检索"}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(DEMO_QUESTIONS[trip.id] ?? EXAMPLES).map((x) => (
            <button key={x} className="rounded-full bg-ink-100 px-2.5 py-1 text-xs text-ink-600 hover:bg-ink-200" onClick={() => (setQ(x), search(x))}>
              {x}
            </button>
          ))}
        </div>
        {err && <p className="mt-2 text-sm text-danger-700">{err}</p>}
      </Section>

      {busy && (
        <div className="card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm text-ink-600">
            <Spinner /> 先把问题转成筛选条件，再在账本里做语义检索…
          </div>
          <Skeleton lines={3} />
        </div>
      )}

      {expenses.length === 0 && !res && (
        <div className="card">
          <Empty icon={<Icon name="search" className="h-6 w-6" />} title="账本还没有内容" hint="先录几笔消费，再来用一句话找账、改账或要统计。" compact />
        </div>
      )}

      {res && (
        <Section
          title="回答"
          right={
            <span className="flex gap-1">
              <Badge tone="brand">{{ find: "找账", modify: "改账", summarize: "统计" }[res.filters.intent] ?? res.filters.intent}</Badge>
              {res.relaxed && <Badge tone="warn">条件已放宽</Badge>}
            </span>
          }
        >
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{res.answer.answer}</p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-ink-400">
            {res.filters.date_from && <span>日期 ≥ {res.filters.date_from}</span>}
            {res.filters.date_to && <span>日期 ≤ {res.filters.date_to}</span>}
            {res.filters.amount_min != null && <span>金额 ≥ {res.filters.amount_min}</span>}
            {res.filters.amount_max != null && <span>金额 ≤ {res.filters.amount_max}</span>}
            {res.filters.payer && <span>付款人 {res.filters.payer}</span>}
            {!!res.filters.participants?.length && <span>参与 {res.filters.participants.join("、")}</span>}
            {res.filters.category && <span>分类 {res.filters.category}</span>}
            {!!res.filters.keywords?.length && <span>关键词 {res.filters.keywords.join(" / ")}</span>}
            <span>置信 {Math.round(res.answer.confidence * 100)}%</span>
          </div>

          {res.answer.citations.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold text-ink-400">证据引用（{res.answer.citations.length}）</h3>
              <div className="space-y-2">
                {res.answer.citations.map((id) => {
                  const e = byId(id);
                  return e ? <ExpenseCard key={id} trip={trip} e={e} highlight /> : null;
                })}
              </div>
            </div>
          )}

          {res.answer.proposed_changes.length > 0 && (
            <div className="mt-4 space-y-2">
              <h3 className="text-xs font-semibold text-ink-400">修改预览（需确认）</h3>
              {res.answer.proposed_changes.map((c, i) => (
                <ChangePreview key={i} trip={trip} expense={byId(c.expenseId)} change={c} applied={applied[i]} onApply={() => apply(i, c)} onIgnore={() => setApplied((s) => ({ ...s, [i]: "ignored" }))} />
              ))}
            </div>
          )}

          <details className="mt-4 text-xs text-ink-400">
            <summary className="cursor-pointer">检索候选（{res.hits.length}）</summary>
            <ul className="mt-1 space-y-0.5">
              {res.hits.map((h) => (
                <li key={h.id} className="mono">
                  {h.score.toFixed(3)} {h.matched.length ? `[${h.matched.join(",")}]` : ""} {h.text}
                </li>
              ))}
            </ul>
          </details>
        </Section>
      )}

      <Section
        title="消费报告"
        right={
          <span className="flex gap-1.5">
            {report && (
              <button className="btn btn-ghost btn-sm" onClick={() => printReport(trip, expenses, report.aggregate, report.narrative)}>
                导出 PDF
              </button>
            )}
            <button className="btn btn-ghost btn-sm" disabled={reportBusy || expenses.length === 0} onClick={genReport}>
              {reportBusy ? <Spinner /> : null} {report ? "重新生成" : "生成报告"}
            </button>
          </span>
        }
      >
        {reportBusy ? (
          <Skeleton lines={4} />
        ) : !report ? (
          <p className="text-sm text-ink-400">按分类 / 按天 / 按人聚合，并由模型写成一段小结。数字来自确定性聚合，模型只负责措辞。</p>
        ) : (
          <div className="space-y-3 text-sm">
            <h3 className="font-semibold">{report.narrative?.title}</h3>
            <ul className="list-disc space-y-1 pl-5">{report.narrative?.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
            <p className="text-ink-600">{report.narrative?.narrative}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Table title="按分类" rows={Object.entries(report.aggregate.byCategory)} />
              <Table title="按天" rows={Object.entries(report.aggregate.byDay)} />
              <Table title="谁垫付" rows={Object.entries(report.aggregate.byPayer)} />
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function Table({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div className="rounded-xl bg-paper p-3">
      <div className="mb-1 text-xs font-semibold text-ink-400">{title}</div>
      {rows
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => (
          <div key={k} className="flex justify-between text-xs">
            <span>{k}</span>
            <span>{money(v)}</span>
          </div>
        ))}
    </div>
  );
}
