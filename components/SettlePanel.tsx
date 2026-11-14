"use client";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Badge, Empty, Icon, Section } from "@/components/ui";
import { shareSettlementCard } from "@/lib/export";
import { localStamp, money } from "@/lib/format";
import { memberName, settlePlan } from "@/lib/settle";
import { actions } from "@/lib/store";
import type { Expense, Trip } from "@/lib/types";

export function SettlePanel({ trip, expenses, onReconcile }: { trip: Trip; expenses: Expense[]; onReconcile?: () => void }) {
  const { paid, remaining, balances, allClear } = settlePlan(trip, expenses);
  const pending = expenses.filter((e) => e.status === "pending").length;
  const total = balances.reduce((a, b) => a + b.paid, 0);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState("");

  if (expenses.length === 0)
    return (
      <div className="card">
        <Empty icon={<Icon name="scale" className="h-6 w-6" />} title="还没有可结算的消费" hint="录入几笔后，这里会算出每人收支和最少转账方案。" compact />
      </div>
    );

  const text = [
    `【${trip.name}】结算方案（合计 ${money(total, trip.currency)}）`,
    ...remaining.map((t) => `${memberName(trip.members, t.from)} → ${memberName(trip.members, t.to)}：${money(t.amount, trip.currency)}`),
    ...paid.map((t) => `${memberName(trip.members, t.from)} → ${memberName(trip.members, t.to)}：${money(t.amount, trip.currency)} ✓已转`),
  ].join("\n");

  /* 还没转钱的人：提醒文案 */
  const owing = [...new Set(remaining.map((t) => t.from))].map((id) => ({ id, name: memberName(trip.members, id), amount: remaining.filter((t) => t.from === id).reduce((a, t) => a + t.amount, 0) }));

  return (
    <div className="space-y-4">
      {trip.locked && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-ok-100 p-3 text-sm text-ok-700">
          <span>✓ 已全部结清，账本已锁定，不能再增删改账目。</span>
          <button className="btn btn-ghost btn-sm" onClick={() => confirm("解锁后可以继续改账，之前的已转记录会保留。确定解锁？") && actions.setLocked(trip.id, false)}>
            解锁
          </button>
        </div>
      )}
      {pending > 0 && <div className="rounded-xl bg-warn-100 p-3 text-sm text-warn-700">还有 {pending} 笔待补全的消费未计入结算，建议先在账本里补全或删除。</div>}
      {onReconcile && !trip.locked && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-brand-50 p-3 text-sm text-brand-700">
          <span>账本自上次核账后有改动，结算前建议再核一遍账，查查重复和异常。</span>
          <button className="btn btn-primary btn-sm shrink-0" onClick={onReconcile}>
            <Icon name="shield" className="h-3.5 w-3.5" /> 先核账
          </button>
        </div>
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
                <td className="py-2">
                  <span className="inline-flex items-center gap-2">
                    <Avatar name={memberName(trip.members, b.memberId)} size="sm" />
                    {memberName(trip.members, b.memberId)}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums">{money(b.paid, trip.currency)}</td>
                <td className="py-2 text-right tabular-nums">{money(b.owed, trip.currency)}</td>
                <td className={`py-2 text-right font-semibold tabular-nums ${b.net > 0 ? "text-ok-700" : b.net < 0 ? "text-danger-700" : ""}`}>
                  {b.net > 0 ? "+" : ""}
                  {money(b.net, trip.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-400">
          净额为正表示应收，为负表示应付。合计 {money(total, trip.currency)}，人均 {money(trip.members.length ? Math.round((total / trip.members.length) * 100) / 100 : 0, trip.currency)}。
        </p>
      </Section>

      <Section
        title={allClear ? "已全部结清" : `还需转账（${remaining.length} 笔）`}
        right={
          <span className="flex gap-1.5">
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "已复制" : "复制文字"}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                const r = await shareSettlementCard(trip, remaining, paid, total);
                setShared(r === "shared" ? "已分享" : "图片已保存");
                setTimeout(() => setShared(""), 2000);
              }}
            >
              <Icon name="image" className="h-3.5 w-3.5" /> {shared || "生成图片发群里"}
            </button>
          </span>
        }
      >
        {remaining.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-ok-700">✓ {paid.length ? "所有转账都已完成。" : "已经平了，不需要转账。"}</p>
            {allClear && !trip.locked && (
              <button className="btn btn-primary btn-sm" onClick={() => actions.setLocked(trip.id, true)}>
                锁定账本，防止误改
              </button>
            )}
          </div>
        ) : (
          <ul className="space-y-2">
            {remaining.map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-xl bg-paper px-3 py-2 text-sm">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Avatar name={memberName(trip.members, t.from)} size="sm" />
                  <span className="font-medium">{memberName(trip.members, t.from)}</span>
                  <span className="mx-1 text-ink-400">→</span>
                  <Avatar name={memberName(trip.members, t.to)} size="sm" />
                  <span className="font-medium">{memberName(trip.members, t.to)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-semibold tabular-nums">{money(t.amount, trip.currency)}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => actions.markPaid(trip.id, t)} disabled={trip.locked}>
                    <Icon name="check" className="h-3.5 w-3.5" /> 已转
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {owing.length > 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-ink-200 p-3 text-xs text-ink-600">
            <span className="font-semibold">还没转的人：</span>
            {owing.map((o) => (
              <Badge key={o.id} tone="warn">
                {o.name} {money(o.amount, trip.currency)}
              </Badge>
            ))}
            <button
              className="ml-2 underline"
              onClick={async () => {
                await navigator.clipboard.writeText(`提醒一下～${trip.name}的账还差：${owing.map((o) => `${o.name} ${money(o.amount, trip.currency)}`).join("，")}，转完回个消息哈`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              复制催款文案
            </button>
          </div>
        )}

        {paid.length > 0 && (
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-semibold text-ink-400">已转（{paid.length}）</h3>
            <ul className="space-y-1">
              {paid.map((p, i) => (
                <li key={i} className="flex items-center justify-between text-xs text-ink-600">
                  <span>
                    {memberName(trip.members, p.from)} → {memberName(trip.members, p.to)} {money(p.amount, trip.currency)} <span className="text-ink-400">· {localStamp(p.paidAt)}</span>
                  </span>
                  {!trip.locked && (
                    <button className="text-ink-400 underline" onClick={() => actions.unmarkPaid(trip.id, i)}>
                      撤销
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </div>
  );
}
