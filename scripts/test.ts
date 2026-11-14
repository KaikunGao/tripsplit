/* 纯函数单测：结算、录入决策、检索。运行：npm test */
import assert from "node:assert/strict";
import { decide, resolveMember } from "../lib/extract/extract";
import { retrieve, tokenize } from "../lib/search/retrieve";
import { SEED } from "../lib/seed";
import { computeBalances, settle, settlePlan, splitOf, validateSplit } from "../lib/settle";
import type { Expense, Trip } from "../lib/types";

/* 示例数据有两趟旅行；单测都按第一趟（成都四日游）的成员和账目写 */
const seed = SEED();
const trip: Trip = seed.trips[0];
const expenses = seed.expenses.filter((e) => e.tripId === trip.id);
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
  // 新分摊规则：份数 / 百分比 / 指定金额
  const sh = splitOf({ ...e, split: { mode: "shares", values: { [ming]: 2, [hua]: 1, [qiang]: 1 } } });
  assert.deepEqual([sh[ming], sh[hua], sh[qiang]], [50, 25, 25]);
  const pc = splitOf({ ...e, split: { mode: "percent", values: { [ming]: 50, [hua]: 30, [qiang]: 20 } } });
  assert.deepEqual([pc[ming], pc[hua], pc[qiang]], [50, 30, 20]);
  const ex = splitOf({ ...e, split: { mode: "exact", values: { [ming]: 70 } } });
  assert.deepEqual([ex[ming], ex[hua], ex[qiang]], [70, 15, 15]);
  assert.equal(validateSplit({ amount: 100, participantIds: [ming, hua], split: { mode: "percent", values: { [ming]: 60, [hua]: 30 } } }), "百分比之和需等于 100");
  assert.equal(validateSplit({ amount: 100, participantIds: [ming, hua], split: { mode: "exact", values: { [ming]: 80, [hua]: 30 } } }), "指定金额之和不能超过总额");
  assert.equal(validateSplit({ amount: 100, participantIds: [ming, hua], split: { mode: "equal" } }), null);
  // 外币：按汇率折算后再分
  const fx = splitOf({ ...e, amount: 3000, currency: "JPY", rate: 0.048, participantIds: [ming, hua] });
  assert.deepEqual([fx[ming], fx[hua]], [72, 72]);
  // 请客：全额由付款人自己承担，被请的人不欠钱
  const tr = splitOf({ ...e, payerId: lin, treat: true, participantIds: [ming, hua] });
  assert.deepEqual(tr, { [lin]: 100 });
  // 垫付（没标请客、付款人不在参与人里）：参与人照摊，付款人不摊
  const adv = splitOf({ ...e, payerId: lin, participantIds: [ming, hua] });
  assert.equal(adv[lin], undefined);
  assert.equal(adv[ming] + adv[hua], 100);
}

// --- settlePlan: 标记已转后剩余转账减少，全部转完 allClear
{
  const sane = expenses.filter((e) => e.participantIds.length > 0);
  const plan0 = settlePlan(trip, sane);
  assert.ok(plan0.remaining.length > 0);
  const first = plan0.remaining[0];
  const t2: Trip = { ...trip, settlements: [{ ...first, paidAt: "2025-10-05T00:00:00Z" }] };
  const plan1 = settlePlan(t2, sane);
  assert.equal(plan1.paid.length, 1);
  assert.ok(plan1.remaining.length < plan0.remaining.length || plan1.remaining.every((r) => !(r.from === first.from && r.to === first.to && r.amount === first.amount)));
  const t3: Trip = { ...trip, settlements: plan0.remaining.map((r) => ({ ...r, paidAt: "2025-10-05T00:00:00Z" })) };
  assert.equal(settlePlan(t3, sane).remaining.length, 0);
  assert.equal(settlePlan(t3, sane).allClear, true);
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
const base = { is_expense: true, not_expense_reason: null, amount: 412, amount_confidence: 0.95, currency: "CNY", payer: "阿强", payer_confidence: 0.9, participants: ["小明", "小华", "阿强", "小林"], participants_confidence: 0.9, treat: false, category: "餐饮" as const, category_confidence: 0.9, note: "火锅", occurred_at: "2025-10-01T19:30:00", questions: [] };
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
{
  // 请客：付款人从参与人里去掉，treat 透传
  const r = decide(trip, { ...base, treat: true, payer: "小华", participants: ["小明", "小华", "阿强", "小林"] });
  assert.equal(r.decision, "auto");
  assert.deepEqual(r.draft.participantIds, [ming, qiang, lin]);
  assert.equal(r.draft.treat, true);
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
