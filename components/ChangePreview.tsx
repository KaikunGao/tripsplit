"use client";
import { FIELD_LABEL as LABEL, money } from "@/lib/format";
import { memberName } from "@/lib/settle";
import type { Expense, ProposedChange, Trip } from "@/lib/types";

/** 修改预览：逐字段 before → after，用户看清楚再确认。 */
export function ChangePreview({ trip, expense, change, onApply, onIgnore, applied }: { trip: Trip; expense: Expense | undefined; change: ProposedChange; onApply: () => void; onIgnore: () => void; applied?: "applied" | "ignored" }) {
  if (!expense) return <p className="text-xs text-ink-400">{applied === "applied" ? "已应用（该账目已删除）" : "该账目已不存在。"}</p>;
  const fmt = (k: string, v: unknown) => {
    if (v == null) return "—";
    if (k === "amount") return money(v as number, expense.currency);
    if (k === "payerId") return memberName(trip.members, v as string);
    if (k === "participantIds") return (v as string[]).map((id) => memberName(trip.members, id)).join("、") || "（空）";
    if (k === "treat") return v ? "是" : "否";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };
  const rows = change.action === "delete" ? [] : Object.entries(change.patch ?? {}).filter(([k, v]) => JSON.stringify((expense as Record<string, unknown>)[k]) !== JSON.stringify(v));
  return (
    <div className="rounded-xl border border-ink-200 bg-paper p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">
          {change.action === "delete" ? "建议删除" : "建议修改"}：{expense.note || expense.category} · {money(expense.amount, expense.currency)}
        </span>
        {applied === "applied" && <span className="text-xs text-ok-700">已应用</span>}
        {applied === "ignored" && <span className="text-xs text-ink-400">已忽略</span>}
      </div>
      {change.action === "update" && (
        <table className="w-full text-xs">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-t border-ink-100">
                <td className="w-16 py-1 text-ink-400">{LABEL[k] ?? k}</td>
                <td className="py-1 text-ink-400 line-through">{fmt(k, (expense as Record<string, unknown>)[k])}</td>
                <td className="py-1 font-medium">→ {fmt(k, v)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="py-1 text-ink-400">无实际变化</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-ink-600">理由：{change.reason}</p>
      {!applied && (
        <div className="mt-2 flex gap-2">
          <button className={`btn ${change.action === "delete" ? "btn-danger" : "btn-primary"}`} onClick={onApply}>
            确认{change.action === "delete" ? "删除" : "修改"}
          </button>
          <button className="btn btn-ghost" onClick={onIgnore}>
            忽略
          </button>
        </div>
      )}
    </div>
  );
}
