"use client";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Field } from "@/components/ui";
import { CURRENCIES, fetchRate } from "@/lib/currency";
import { localIso, money } from "@/lib/format";
import { homeAmount, round2, splitOf, validateSplit } from "@/lib/settle";
import { CATEGORIES, type Category, type Expense, type Split, type Trip } from "@/lib/types";

export type ExpenseFormValue = {
  amount: number;
  currency: string;
  rate?: number;
  payerId: string;
  participantIds: string[];
  split?: Split;
  treat?: boolean;
  category: Category;
  note: string;
  occurredAt: string;
};

const MODES: { key: Split["mode"]; label: string; hint: string }[] = [
  { key: "equal", label: "均摊", hint: "参与人平均分" },
  { key: "shares", label: "按份数", hint: "如小明吃了 2 份" },
  { key: "percent", label: "按比例", hint: "百分比合计 100" },
  { key: "exact", label: "指定金额", hint: "没填的人分剩余" },
];

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
  const [currency, setCurrency] = useState(initial?.currency ?? trip.currency);
  const [rate, setRate] = useState(initial?.rate ? String(initial.rate) : "");
  const [rateInfo, setRateInfo] = useState("");
  const [payerId, setPayerId] = useState(initial?.payerId ?? trip.selfMemberId ?? trip.members[0].id);
  const [participantIds, setP] = useState<string[]>(initial?.participantIds ?? trip.members.map((m) => m.id));
  const [treat, setTreat] = useState(!!initial?.treat);
  const [mode, setMode] = useState<Split["mode"]>(initial?.split?.mode ?? (initial?.shares ? "shares" : "equal"));
  const [values, setValues] = useState<Record<string, string>>(() => {
    const src = initial?.split?.values ?? initial?.shares ?? {};
    return Object.fromEntries(Object.entries(src).map(([k, v]) => [k, String(v)]));
  });
  const [category, setCategory] = useState<Category>(initial?.category ?? "餐饮");
  const [note, setNote] = useState(initial?.note ?? "");
  const [occurredAt, setOccurredAt] = useState((initial?.occurredAt ?? localIso()).slice(0, 16));
  const [err, setErr] = useState("");

  const foreign = currency !== trip.currency;
  const miss = (k: string) => (missing.includes(k) ? "ring-2 ring-warn-700/60 rounded-xl" : "");

  /* 请客：付款人自动移出参与人；取消请客时加回去 */
  function toggleTreat(on: boolean) {
    setTreat(on);
    setP((ids) => (on ? ids.filter((id) => id !== payerId) : ids.includes(payerId) ? ids : [...ids, payerId]));
  }
  function choosePayer(id: string) {
    setPayerId(id);
    if (treat) setP((ids) => ids.filter((x) => x !== id));
  }

  /* 外币：币种或日期变化时自动取汇率（已手填的不覆盖） */
  useEffect(() => {
    if (!foreign) return;
    let alive = true;
    fetchRate(currency, trip.currency, occurredAt.slice(0, 10)).then((r) => {
      if (!alive) return;
      if (r) {
        setRate((cur) => (cur && initial?.rate && String(initial.rate) === cur ? cur : String(r.rate)));
        setRateInfo(r.source === "ecb" ? `欧洲央行 ${r.date} 参考汇率` : r.source === "cache" ? `参考汇率（${r.date}）` : "");
      } else setRateInfo("取不到参考汇率，请手动填写");
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, occurredAt.slice(0, 10), foreign]);

  const split: Split | undefined =
    mode === "equal"
      ? undefined
      : { mode, values: Object.fromEntries(participantIds.map((id) => [id, Number(values[id]) || 0])) };
  const draft: Pick<Expense, "amount" | "rate" | "participantIds" | "split" | "payerId" | "treat"> = { amount: Number(amount) || 0, rate: foreign ? Number(rate) || undefined : undefined, participantIds, split, payerId, treat };
  const preview = draft.amount > 0 && participantIds.length > 0 ? splitOf({ ...draft, id: "", tripId: "", currency, category, note, occurredAt, createdAt: "", updatedAt: "", source: "manual", confidence: 1, status: "confirmed" }) : null;
  const splitErr = validateSplit({ amount: draft.amount, participantIds, split });

  function submit() {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return setErr("金额必须大于 0");
    if (foreign && !(Number(rate) > 0)) return setErr("请填写汇率（1 外币 = ? 本币）");
    if (participantIds.length === 0) return setErr("至少选择一位参与人");
    if (splitErr) return setErr(splitErr);
    if (!occurredAt) return setErr("请填写时间");
    onSubmit({
      amount: round2(a),
      currency,
      rate: foreign ? Number(rate) : undefined,
      payerId,
      participantIds,
      split,
      treat: treat || undefined,
      category,
      note: note.trim(),
      occurredAt: occurredAt.length === 16 ? occurredAt + ":00" : occurredAt,
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div className={miss("amount")}>
          <Field label="金额">
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </Field>
        </div>
        <Field label="币种">
          <select className="input w-28" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {foreign && (
        <div className="grid grid-cols-[1fr_auto] items-end gap-3 rounded-xl bg-paper p-3">
          <Field label={`汇率：1 ${currency} = ? ${trip.currency}`} hint={rateInfo}>
            <input className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="如 0.048" />
          </Field>
          <div className="pb-5 text-sm text-ink-600">
            ≈ <b className="text-ink-900">{money(round2((Number(amount) || 0) * (Number(rate) || 0)), trip.currency)}</b>
          </div>
        </div>
      )}
      <Field label="分类">
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button key={c} type="button" onClick={() => setCategory(c)} className={`chip ${category === c ? "chip-on" : ""}`}>
              {c}
            </button>
          ))}
        </div>
      </Field>

      <div className={miss("payer")}>
        <Field label="付款人">
          <div className="flex flex-wrap gap-2">
            {trip.members.map((m) => (
              <button key={m.id} type="button" onClick={() => choosePayer(m.id)} className={`btn btn-sm ${payerId === m.id ? "btn-primary" : "btn-ghost"}`}>
                <Avatar name={m.name} size="xs" /> {m.name}
              </button>
            ))}
          </div>
        </Field>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-ink-600">
          <input type="checkbox" checked={treat} onChange={(e) => toggleTreat(e.target.checked)} className="h-4 w-4 accent-brand-600" />
          请客：付款人自己不分摊
        </label>
      </div>

      <div className={miss("participants")}>
        <Field label="参与分摊">
          <div className="flex flex-wrap gap-2">
            {trip.members.map((m) => {
              const on = participantIds.includes(m.id);
              const blocked = treat && m.id === payerId;
              return (
                <button key={m.id} type="button" disabled={blocked} title={blocked ? "请客的人不分摊" : undefined} onClick={() => setP(on ? participantIds.filter((x) => x !== m.id) : [...participantIds, m.id])} className={`btn btn-sm ${on ? "btn-primary" : "btn-ghost"}`}>
                  {on ? "✓ " : ""}
                  {m.name}
                </button>
              );
            })}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setP(trip.members.map((m) => m.id).filter((id) => !(treat && id === payerId)))}>
              全员
            </button>
          </div>
        </Field>
      </div>

      <Field label="分摊方式">
        <div className="flex flex-wrap gap-1.5">
          {MODES.map((m) => (
            <button key={m.key} type="button" onClick={() => setMode(m.key)} className={`chip ${mode === m.key ? "chip-on" : ""}`} title={m.hint}>
              {m.label}
            </button>
          ))}
        </div>
        {mode !== "equal" && (
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {participantIds.map((id) => {
              const m = trip.members.find((x) => x.id === id)!;
              return (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <Avatar name={m.name} size="xs" />
                  <span className="w-10 shrink-0">{m.name}</span>
                  <input className="input py-1" inputMode="decimal" value={values[id] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [id]: e.target.value }))} placeholder={{ shares: "份数", percent: "%", exact: currency }[mode]} />
                  {preview && <span className="w-20 shrink-0 text-right text-xs text-ink-400">{money(preview[id] ?? 0, trip.currency)}</span>}
                </label>
              );
            })}
            <p className="text-xs text-ink-400 sm:col-span-2">{MODES.find((m) => m.key === mode)?.hint}{splitErr ? ` · ${splitErr}` : ""}</p>
          </div>
        )}
        {mode === "equal" && preview && participantIds.length > 0 && (
          <p className="mt-1 text-xs text-ink-400">
            每人 {money(preview[participantIds[0]] ?? 0, trip.currency)}
            {foreign ? `（按汇率折算，合计 ${money(homeAmount(draft), trip.currency)}）` : ""}
          </p>
        )}
      </Field>

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
