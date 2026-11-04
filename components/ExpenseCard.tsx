"use client";
import { Badge } from "@/components/ui";
import { hhmm, money } from "@/lib/format";
import { memberName } from "@/lib/settle";
import type { Expense, Trip } from "@/lib/types";

const SOURCE: Record<Expense["source"], string> = { manual: "手动", text: "文字", image: "截图", voice: "语音", agent: "Agent" };

export function ExpenseCard({ trip, e, onClick, highlight }: { trip: Trip; e: Expense; onClick?: () => void; highlight?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${highlight ? "border-brand-500 bg-brand-50" : "border-ink-100 bg-white hover:border-ink-200"}`}
    >
      <div className="w-12 shrink-0 text-xs text-ink-400">{hhmm(e.occurredAt)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium">{e.note || e.category}</span>
          <Badge>{e.category}</Badge>
          {e.status === "pending" && <Badge tone="warn">待补全</Badge>}
          {e.source !== "manual" && <Badge tone="brand">{SOURCE[e.source]}</Badge>}
          {e.confidence < 0.75 && e.status === "confirmed" && <Badge tone="warn">置信 {Math.round(e.confidence * 100)}%</Badge>}
        </div>
        <div className="mt-0.5 truncate text-xs text-ink-600">
          {memberName(trip.members, e.payerId)} 付 → {e.participantIds.length ? e.participantIds.map((id) => memberName(trip.members, id)).join("、") : <span className="text-danger-700">参与人为空</span>}
        </div>
      </div>
      <div className="shrink-0 text-right font-semibold">{money(e.amount, e.currency)}</div>
    </button>
  );
}
