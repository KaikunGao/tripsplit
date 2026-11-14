"use client";
import { Avatar, AvatarStack } from "@/components/Avatar";
import { Badge } from "@/components/ui";
import { hhmm, money } from "@/lib/format";
import { homeAmount, memberName } from "@/lib/settle";
import type { Expense, Trip } from "@/lib/types";

export const SOURCE_LABEL: Record<Expense["source"], string> = { manual: "手动", text: "文字", image: "截图", voice: "语音", agent: "核账" };

/**
 * 账目卡：只显示"需要你处理"的状态（待补全 / 参与人为空 / 不在行程日期内），
 * 来源、置信度等元信息放到编辑态里看。参与人用头像圈，缺席者灰显。
 */
export function ExpenseCard({ trip, e, onClick, highlight }: { trip: Trip; e: Expense; onClick?: () => void; highlight?: boolean }) {
  const d = e.occurredAt.slice(0, 10);
  const outside = (trip.startDate && d < trip.startDate) || (trip.endDate && d > trip.endDate);
  const payer = memberName(trip.members, e.payerId);
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), onClick()) : undefined}
      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${highlight ? "border-brand-500 bg-brand-50" : "border-ink-100 bg-surface"} ${onClick ? "cursor-pointer hover:border-ink-200" : ""}`}
    >
      <div className="w-11 shrink-0 text-xs tabular-nums text-ink-400">{hhmm(e.occurredAt)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{e.note || e.category}</span>
          {e.status === "pending" && <Badge tone="warn">待补全</Badge>}
          {outside && <Badge tone="warn">不在行程内</Badge>}
          {e.treat && <Badge tone="brand">请客</Badge>}
          {e.split && e.split.mode !== "equal" && <Badge>{{ shares: "按份", percent: "按比例", exact: "指定额" }[e.split.mode]}</Badge>}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-ink-600">
          <span className="text-ink-400">{e.category}</span>
          <span className="text-ink-200">·</span>
          <Avatar name={payer} size="xs" title={`${payer} 付`} />
          <span>付</span>
          <span className="text-ink-400">→</span>
          {e.participantIds.length ? <AvatarStack members={trip.members} activeIds={e.participantIds} size="xs" /> : <span className="text-danger-700">参与人为空</span>}
        </div>
      </div>
      <div className={`shrink-0 text-right font-semibold tabular-nums ${e.status === "pending" ? "text-ink-400" : ""}`}>
        {money(e.amount, e.currency)}
        {e.currency !== trip.currency && <div className="text-[11px] font-normal text-ink-400">≈ {money(homeAmount(e), trip.currency)}</div>}
      </div>
    </div>
  );
}
