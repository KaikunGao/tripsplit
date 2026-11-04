/* 纯函数单测：结算、录入决策、检索。运行：npm test */
import assert from "node:assert/strict";
import { decide, resolveMember } from "../lib/extract/extract";
import { retrieve, tokenize } from "../lib/search/retrieve";
import { SEED } from "../lib/seed";
import { computeBalances, settle, splitOf } from "../lib/settle";
import type { Expense, Trip } from "../lib/types";

const { trips, expenses } = SEED();
const trip: Trip = trips[0];
const [ming, hua, qiang, lin] = trip.members.map((m) => m.id);

// --- splitOf: 均摊分到分且合计等于金额；权重分摊
{
  const e: Expense = { ...expenses[0], amount: 100, participantIds: [ming, hua, qiang] };
  const s = splitOf(e);
  assert.equal(Object.values(s).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(Object.values(s), [33.33, 33.33, 33.34]);
  const w = splitOf({ ...e, shares: { [ming]: 2 } });
  assert.deepEqual([w[ming], w[hua], w[qiang]], [50, 25, 25]);
  assert.deepEqual(splitOf({ ...e, participantIds: [] }), {});
}

// --- balances + settle: 净额合计为 0，转账后全部清零，转账数 ≤ n-1
{
  // 示例数据里 e_empty 参与人为空（故意埋的异常），它只计已付不分摊，所以守恒性只对参与人非空的账目成立。
  const sane = expenses.filter((e) => e.participantIds.length > 0);
  const bal = computeBalances(trip, sane);
  assert.ok(Math.abs(bal.reduce((a, b) => a + b.net, 0)) < 0.01, "净额合计应为 0");
  const tr = settle(bal);
  assert.ok(tr.length <= trip.members.length - 1);
  const after = new Map(bal.map((b) => [b.memberId, b.net]));
  for (const t of tr) {
    after.set(t.from, (after.get(t.from) ?? 0) + t.amount);
    after.set(t.to, (after.get(t.to) ?? 0) - t.amount);
  }
  for (const v of after.values()) assert.ok(Math.abs(v) < 0.01);
  // pending 不计入
  const bal2 = computeBalances(trip, sane.filter((e) => e.id !== "e_pending"));
  assert.deepEqual(bal, bal2);
}

// --- resolveMember
assert.equal(resolveMember(trip.members, "小明")?.id, ming);
assert.equal(resolveMember(trip.members, "明")?.id, ming);
assert.equal(resolveMember(trip.members, "阿林")?.id, lin);
assert.equal(resolveMember(trip.members, "老王"), null);

// --- decide: 阈值与追问
const base = { is_expense: true, not_expense_reason: null, amount: 412, amount_confidence: 0.95, currency: "CNY", payer: "阿强", payer_confidence: 0.9, participants: ["小明", "小华", "阿强", "小林"], participants_confidence: 0.9, category: "餐饮" as const, category_confidence: 0.9, note: "火锅", occurred_at: "2025-10-01T19:30:00", questions: [] };
{
  const r = decide(trip, base);
  assert.equal(r.decision, "auto");
  assert.deepEqual(r.draft.participantIds, [ming, hua, qiang, lin]);
  assert.equal(r.draft.payerId, qiang);
}
{
  const r = decide(trip, { ...base, participants: [], participants_confidence: 0.2 });
  assert.equal(r.decision, "ask");
  assert.deepEqual(r.missing, ["participants"]);
  assert.ok(r.questions.some((q) => q.includes("参与")));
}
{
  const r = decide(trip, { ...base, payer: "老王", payer_confidence: 0.95 });
  assert.equal(r.decision, "ask", "非成员付款人应追问");
  assert.deepEqual(r.missing, ["payer"]);
}
{
  const r = decide(trip, { ...base, amount: null, amount_confidence: 0 });
  assert.equal(r.decision, "ask");
  assert.equal(r.missing[0], "amount");
}
{
  const r = decide(trip, { ...base, is_expense: false, not_expense_reason: "风景照" });
  assert.equal(r.decision, "reject");
}

// --- tokenize + retrieve
assert.deepEqual(tokenize("小龙坎火锅 412"), ["小龙", "龙坎", "坎火", "火锅", "412"]);
{
  const { hits, relaxed } = retrieve(trip, expenses, "第一天晚上的火锅", { date_from: "2025-10-01", date_to: "2025-10-01", keywords: ["火锅"] });
  assert.equal(relaxed, false);
  assert.ok(["e_03", "e_dup2"].includes(hits[0].expense.id), "火锅应排第一");
  assert.ok(hits.every((h) => h.expense.occurredAt.startsWith("2025-10-01")));
}
{
  const { hits } = retrieve(trip, expenses, "小林付的大额", { payer: "小林", amount_min: 300 });
  assert.deepEqual(hits.map((h) => h.expense.id).sort(), ["e_09", "e_big"]);
}
{
  const { relaxed, hits } = retrieve(trip, expenses, "火锅", { payer: "不存在的人" });
  assert.equal(relaxed, true);
  assert.ok(hits.length > 0);
}

console.log("all tests passed");
