"use client";
import { useMemo, useState } from "react";
import { ExpenseCard } from "@/components/ExpenseCard";
import { ExpenseForm, type ExpenseFormValue } from "@/components/ExpenseForm";
import { Badge, Section } from "@/components/ui";
import { day, localStamp, money, weekday } from "@/lib/format";
import { actions } from "@/lib/store";
import type { AuditEntry, Expense, Trip } from "@/lib/types";

export function LedgerPanel({ trip, expenses, audit }: { trip: Trip; expenses: Expense[]; audit: AuditEntry[] }) {
  const [editing, setEditing] = useState<Expense | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | string>("all");
  const [showAudit, setShowAudit] = useState(false);

  const list = useMemo(() => {
    let l = expenses;
    if (filter === "pending") l = l.filter((e) => e.status === "pending");
    else if (filter !== "all") l = l.filter((e) => e.payerId === filter || e.participantIds.includes(filter));
    return [...l].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }, [expenses, filter]);

  const groups = useMemo(() => {
    const m = new Map<string, Expense[]>();
    for (const e of list) m.set(day(e.occurredAt), [...(m.get(day(e.occurredAt)) ?? []), e]);
    return [...m.entries()];
  }, [list]);

  const total = expenses.filter((e) => e.status === "confirmed").reduce((a, e) => a + e.amount, 0);
  const pending = expenses.filter((e) => e.status === "pending").length;

  function save(v: ExpenseFormValue) {
    if (editing) actions.updateExpense(editing.id, { ...v, status: "confirmed", confidence: 1 });
    else actions.addExpense({ ...v, tripId: trip.id, currency: trip.currency, source: "manual", confidence: 1, status: "confirmed" });
    setEditing(null);
    setAdding(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-2 text-sm text-ink-600">
          合计 <b>{money(total, trip.currency)}</b> · {expenses.length} 笔
        </span>
        {(["all", "pending", ...trip.members.map((m) => m.id)] as string[]).map((f) => (
          <button key={f} className={`btn ${filter === f ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(f)}>
            {f === "all" ? "全部" : f === "pending" ? `待补全 ${pending}` : trip.members.find((m) => m.id === f)?.name}
          </button>
        ))}
        <button className="btn btn-ghost ml-auto" onClick={() => setAdding(true)}>
          + 手动记一笔
        </button>
      </div>

      {(adding || editing) && (
        <Section title={editing ? "编辑消费" : "手动记一笔"}>
          {editing?.evidence?.text && <p className="mb-3 rounded-lg bg-paper p-2 text-xs text-ink-600">原始证据：{editing.evidence.text}</p>}
          {editing?.evidence?.thumbnail && <img src={editing.evidence.thumbnail} alt="凭证" className="mb-3 max-h-40 rounded-lg" />}
          <ExpenseForm
            key={editing?.id ?? "new"}
            trip={trip}
            initial={editing ?? undefined}
            missing={editing?.status === "pending" ? ["amount", "participants"].filter((k) => (k === "amount" ? !editing.amount : editing.participantIds.length === 0)) : []}
            onSubmit={save}
            onCancel={() => {
              setEditing(null);
              setAdding(false);
            }}
            onDelete={editing ? () => (actions.deleteExpense(editing.id), setEditing(null)) : undefined}
          />
        </Section>
      )}

      {groups.map(([d, es]) => (
        <div key={d}>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">
              {d} 周{weekday(d)}
            </span>
            <span className="text-ink-400">{money(es.filter((e) => e.status === "confirmed").reduce((a, e) => a + e.amount, 0))}</span>
          </div>
          <div className="space-y-2">
            {es.map((e) => (
              <ExpenseCard key={e.id} trip={trip} e={e} onClick={() => (setAdding(false), setEditing(e))} />
            ))}
          </div>
        </div>
      ))}
      {list.length === 0 && <p className="text-sm text-ink-400">没有匹配的消费。</p>}

      <div className="pt-2">
        <button className="text-xs text-ink-400 underline" onClick={() => setShowAudit((s) => !s)}>
          {showAudit ? "收起" : "查看"}修改记录（{audit.length}）
        </button>
        {showAudit && (
          <ul className="mt-2 space-y-1 text-xs text-ink-600">
            {audit.map((a) => (
              <li key={a.id} className="flex gap-2">
                <span className="mono shrink-0 text-ink-400">{localStamp(a.at)}</span>
                <Badge tone={a.origin === "user" ? "gray" : "brand"}>{a.origin === "user" ? "用户" : a.origin === "agent-confirmed" ? "Agent 建议·已确认" : "检索建议·已确认"}</Badge>
                <span>{a.summary}</span>
              </li>
            ))}
            {audit.length === 0 && <li>暂无。</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
