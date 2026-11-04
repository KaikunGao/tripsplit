"use client";
import { useState } from "react";
import { Badge, Section } from "@/components/ui";
import { money } from "@/lib/format";
import { computeBalances, memberName, settle } from "@/lib/settle";
import type { Expense, Trip } from "@/lib/types";

export function SettlePanel({ trip, expenses }: { trip: Trip; expenses: Expense[] }) {
  const balances = computeBalances(trip, expenses);
  const transfers = settle(balances);
  const pending = expenses.filter((e) => e.status === "pending").length;
  const total = balances.reduce((a, b) => a + b.paid, 0);
  const [copied, setCopied] = useState(false);

  const text = [`【${trip.name}】结算方案（合计 ${money(total)}）`, ...transfers.map((t) => `${memberName(trip.members, t.from)} → ${memberName(trip.members, t.to)}：${money(t.amount)}`)].join("\n");

  return (
    <div className="space-y-4">
      {pending > 0 && (
        <div className="rounded-xl bg-warn-100 p-3 text-sm text-warn-700">还有 {pending} 笔待补全的消费未计入结算，建议先在账本里补全或删除。</div>
      )}
      <Section title="每人收支">
        <table className="w-full text-sm">
          <thead className="text-xs text-ink-400">
            <tr>
              <th className="py-1 text-left font-medium">成员</th>
              <th className="py-1 text-right font-medium">已垫付</th>
              <th className="py-1 text-right font-medium">应分摊</th>
              <th className="py-1 text-right font-medium">净额</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((b) => (
              <tr key={b.memberId} className="border-t border-ink-100">
                <td className="py-2">{memberName(trip.members, b.memberId)}</td>
                <td className="py-2 text-right">{money(b.paid)}</td>
                <td className="py-2 text-right">{money(b.owed)}</td>
                <td className={`py-2 text-right font-semibold ${b.net > 0 ? "text-ok-700" : b.net < 0 ? "text-danger-700" : ""}`}>
                  {b.net > 0 ? "+" : ""}
                  {money(b.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-400">净额为正表示应收，为负表示应付。合计 {money(total)}，人均 {money(trip.members.length ? Math.round((total / trip.members.length) * 100) / 100 : 0)}。</p>
      </Section>
      <Section
        title={`最少转账方案（${transfers.length} 笔）`}
        right={
          <button
            className="btn btn-ghost"
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "已复制" : "复制到群里"}
          </button>
        }
      >
        {transfers.length === 0 ? (
          <p className="text-sm text-ink-400">已经平了，不需要转账。</p>
        ) : (
          <ul className="space-y-2">
            {transfers.map((t, i) => (
              <li key={i} className="flex items-center justify-between rounded-xl bg-paper px-3 py-2 text-sm">
                <span>
                  <Badge tone="danger">{memberName(trip.members, t.from)}</Badge> <span className="mx-1 text-ink-400">转给</span> <Badge tone="ok">{memberName(trip.members, t.to)}</Badge>
                </span>
                <span className="font-semibold">{money(t.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
