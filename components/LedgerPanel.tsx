"use client";
import { useMemo, useState } from "react";
import { BudgetPanel } from "@/components/BudgetPanel";
import { ExpenseCard, SOURCE_LABEL } from "@/components/ExpenseCard";
import { ExpenseForm, type ExpenseFormValue } from "@/components/ExpenseForm";
import { Badge, Empty, Icon, Section } from "@/components/ui";
import { exportLedgerCsv } from "@/lib/export";
import { day, localStamp, money, weekday } from "@/lib/format";
import { homeAmount } from "@/lib/settle";
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

  const total = expenses.filter((e) => e.status === "confirmed").reduce((a, e) => a + homeAmount(e), 0);
  const pending = expenses.filter((e) => e.status === "pending").length;

  function save(v: ExpenseFormValue) {
    if (editing) actions.updateExpense(editing.id, { ...v, status: "confirmed", confidence: 1 });
    else actions.addExpense({ ...v, tripId: trip.id, source: "manual", confidence: 1, status: "confirmed" });
    setEditing(null);
    setAdding(false);
  }

  const chips: { key: string; label: string }[] = [{ key: "all", label: "全部" }, ...(pending > 0 ? [{ key: "pending", label: `待补全 ${pending}` }] : []), ...trip.members.map((m) => ({ key: m.id, label: m.name }))];

  return (
    <div className="relative space-y-4">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-ink-600">
          合计 <b className="text-base text-ink-900">{money(total, trip.currency)}</b> · {expenses.length} 笔
        </span>
      </div>

      <BudgetPanel trip={trip} expenses={expenses} />

      {/* 筛选：单行横向滚动 */}
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5">
        {chips.map((c) => (
          <button key={c.key} className={`chip ${filter === c.key ? "chip-on" : ""}`} onClick={() => setFilter(c.key)}>
            {c.label}
          </button>
        ))}
      </div>

      {(adding || editing) && (
        <Section title={editing ? "编辑消费" : "手动记一笔"}>
          {editing && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
              <Badge tone="brand">{SOURCE_LABEL[editing.source]}录入</Badge>
              {editing.source !== "manual" && <Badge tone={editing.confidence >= 0.8 ? "ok" : editing.confidence >= 0.7 ? "warn" : "danger"}>置信度 {Math.round(editing.confidence * 100)}%</Badge>}
              <span>创建于 {localStamp(editing.createdAt)}</span>
            </div>
          )}
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
            <span className="text-ink-400">{money(es.filter((e) => e.status === "confirmed").reduce((a, e) => a + homeAmount(e), 0), trip.currency)}</span>
          </div>
          <div className="space-y-2">
            {es.map((e) => (
              <ExpenseCard key={e.id} trip={trip} e={e} onClick={() => (setAdding(false), setEditing(e))} />
            ))}
          </div>
        </div>
      ))}

      {expenses.length === 0 && !adding && (
        <div className="card">
          <Empty
            icon={<Icon name="list" className="h-6 w-6" />}
            title="账本还是空的"
            hint="去「录入」用一句话、一张支付截图或一段语音记第一笔，或者在这里手动记。"
            action={
              <button className="btn btn-ghost" onClick={() => setAdding(true)}>
                手动记一笔
              </button>
            }
          />
        </div>
      )}
      {expenses.length > 0 && list.length === 0 && <p className="py-6 text-center text-sm text-ink-400">没有匹配的消费。</p>}

      {expenses.length > 0 && (
        <div className="pt-2">
          <button className="text-xs text-ink-400 underline" onClick={() => setShowAudit((s) => !s)}>
            {showAudit ? "收起" : "查看"}修改记录（{audit.length}）
          </button>
          <button className="ml-3 text-xs text-ink-400 underline" onClick={() => exportLedgerCsv(trip, expenses)}>
            导出 Excel（CSV）
          </button>
          {showAudit && (
            <ul className="mt-2 space-y-1 text-xs text-ink-600">
              {audit.map((a) => (
                <li key={a.id} className="flex gap-2">
                  <span className="mono shrink-0 text-ink-400">{localStamp(a.at)}</span>
                  <Badge tone={a.origin === "user" ? "gray" : "brand"}>{a.origin === "user" ? "用户" : a.origin === "agent-confirmed" ? "核账建议·已确认" : "检索建议·已确认"}</Badge>
                  <span>{a.summary}</span>
                </li>
              ))}
              {audit.length === 0 && <li>暂无。</li>}
            </ul>
          )}
        </div>
      )}

      {/* 悬浮"记一笔"：手机上避开底部 tab bar */}
      {!adding && !editing && (
        <button
          type="button"
          onClick={() => (setEditing(null), setAdding(true), window.scrollTo({ top: 0, behavior: "smooth" }))}
          className="fixed bottom-20 right-4 z-10 flex h-12 items-center gap-1.5 rounded-full bg-brand-600 pl-3.5 pr-4 text-sm font-semibold text-white shadow-card transition hover:bg-brand-700 md:bottom-6 lg:absolute lg:bottom-auto lg:right-0 lg:top-0 lg:h-8 lg:rounded-xl lg:px-3 lg:text-xs"
          aria-label="手动记一笔"
        >
          <Icon name="plus" className="h-4 w-4" /> 记一笔
        </button>
      )}
    </div>
  );
}
