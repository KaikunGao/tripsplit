"use client";
import { useState } from "react";
import { Field } from "@/components/ui";
import { localIso } from "@/lib/format";
import { CATEGORIES, type Category, type Expense, type Trip } from "@/lib/types";

export type ExpenseFormValue = {
  amount: number;
  payerId: string;
  participantIds: string[];
  category: Category;
  note: string;
  occurredAt: string;
};

export function ExpenseForm({
  trip,
  initial,
  onSubmit,
  onCancel,
  onDelete,
  submitLabel = "保存",
  missing = [],
}: {
  trip: Trip;
  initial?: Partial<Expense>;
  onSubmit: (v: ExpenseFormValue) => void;
  onCancel?: () => void;
  onDelete?: () => void;
  submitLabel?: string;
  missing?: string[];
}) {
  const [amount, setAmount] = useState(initial?.amount ? String(initial.amount) : "");
  const [payerId, setPayerId] = useState(initial?.payerId ?? trip.selfMemberId ?? trip.members[0].id);
  const [participantIds, setP] = useState<string[]>(initial?.participantIds ?? trip.members.map((m) => m.id));
  const [category, setCategory] = useState<Category>(initial?.category ?? "餐饮");
  const [note, setNote] = useState(initial?.note ?? "");
  const [occurredAt, setOccurredAt] = useState((initial?.occurredAt ?? localIso()).slice(0, 16));
  const [err, setErr] = useState("");

  const miss = (k: string) => (missing.includes(k) ? "ring-2 ring-warn-700/60 rounded-xl" : "");

  function submit() {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return setErr("金额必须大于 0");
    if (participantIds.length === 0) return setErr("至少选择一位参与人");
    if (!occurredAt) return setErr("请填写时间");
    onSubmit({ amount: Math.round(a * 100) / 100, payerId, participantIds, category, note: note.trim(), occurredAt: occurredAt.length === 16 ? occurredAt + ":00" : occurredAt });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className={miss("amount")}>
          <Field label="金额">
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </Field>
        </div>
        <Field label="分类">
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className={miss("payer")}>
        <Field label="付款人">
          <div className="flex flex-wrap gap-2">
            {trip.members.map((m) => (
              <button key={m.id} type="button" onClick={() => setPayerId(m.id)} className={`btn ${payerId === m.id ? "btn-primary" : "btn-ghost"}`}>
                {m.name}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <div className={miss("participants")}>
        <Field label="参与分摊">
          <div className="flex flex-wrap gap-2">
            {trip.members.map((m) => {
              const on = participantIds.includes(m.id);
              return (
                <button key={m.id} type="button" onClick={() => setP(on ? participantIds.filter((x) => x !== m.id) : [...participantIds, m.id])} className={`btn ${on ? "btn-primary" : "btn-ghost"}`}>
                  {on ? "✓ " : ""}
                  {m.name}
                </button>
              );
            })}
            <button type="button" className="btn btn-ghost" onClick={() => setP(trip.members.map((m) => m.id))}>
              全员
            </button>
          </div>
        </Field>
      </div>
      <Field label="备注">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="商户 / 事项" />
      </Field>
      <Field label="时间">
        <input className="input" type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </Field>
      {err && <p className="text-sm text-danger-700">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={submit}>
          {submitLabel}
        </button>
        {onCancel && (
          <button className="btn btn-ghost" onClick={onCancel}>
            取消
          </button>
        )}
        {onDelete && (
          <button className="btn btn-danger ml-auto" onClick={() => confirm("确定删除这笔消费？") && onDelete()}>
            删除
          </button>
        )}
      </div>
    </div>
  );
}
