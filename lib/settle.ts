import type { Expense, Member, Settlement, Trip } from "./types";

export type Balance = { memberId: string; paid: number; owed: number; net: number };
export type Transfer = { from: string; to: string; amount: number };

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** 折算到旅行本币的金额（rate 缺省为 1）。 */
export const homeAmount = (e: Pick<Expense, "amount" | "rate">) => round2(e.amount * (e.rate ?? 1));

/**
 * 每人应分摊份额（本币）。规则优先级：split > 旧 shares > 均摊。
 * 分到分，余数给最后一个参与人，保证合计等于金额。付款人不在参与人内时不分摊（请客）。
 */
export function splitOf(e: Expense): Record<string, number> {
  const ids = e.participantIds;
  if (ids.length === 0) return {};
  const total = homeAmount(e);
  const mode = e.split?.mode ?? (e.shares ? "shares" : "equal");
  const values = e.split?.values ?? e.shares ?? {};
  const out: Record<string, number> = {};

  if (mode === "exact") {
    // 指定金额：原币金额按汇率折算；未指定的人分剩余部分。
    let acc = 0;
    const unspecified = ids.filter((id) => values[id] == null);
    const specifiedSum = ids.reduce((a, id) => a + (values[id] ?? 0), 0);
    const rest = Math.max(0, round2(e.amount - specifiedSum));
    ids.forEach((id, i) => {
      let part: number;
      if (i === ids.length - 1) part = round2(total - acc);
      else if (values[id] != null) part = round2(values[id] * (e.rate ?? 1));
      else part = round2(((rest / Math.max(1, unspecified.length)) * (e.rate ?? 1)));
      out[id] = part;
      acc = round2(acc + part);
    });
    return out;
  }

  const weights = ids.map((id) => (mode === "equal" ? 1 : (values[id] ?? (mode === "percent" ? 0 : 1))));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  ids.forEach((id, i) => {
    if (i === ids.length - 1) out[id] = round2(total - acc);
    else {
      const part = round2((total * weights[i]) / wsum);
      out[id] = part;
      acc = round2(acc + part);
    }
  });
  return out;
}

/** 校验不均摊规则是否自洽；返回错误文案或 null。 */
export function validateSplit(e: Pick<Expense, "amount" | "participantIds" | "split">): string | null {
  const s = e.split;
  if (!s || s.mode === "equal") return null;
  const vals = e.participantIds.map((id) => s.values?.[id] ?? 0);
  if (s.mode === "shares" && vals.every((v) => v <= 0)) return "按份数分摊时至少一人份数大于 0";
  if (s.mode === "percent" && Math.abs(vals.reduce((a, b) => a + b, 0) - 100) > 0.01) return "百分比之和需等于 100";
  if (s.mode === "exact" && round2(vals.reduce((a, b) => a + b, 0)) > round2(e.amount) + 0.005) return "指定金额之和不能超过总额";
  return null;
}

/** 每人已付 / 应摊 / 净额（本币）。settlements 里已转的钱会计入：转出方 net 增加、转入方 net 减少。 */
export function computeBalances(trip: Trip, expenses: Expense[], settlements: Settlement[] = trip.settlements ?? []): Balance[] {
  const map = new Map<string, Balance>();
  for (const m of trip.members) map.set(m.id, { memberId: m.id, paid: 0, owed: 0, net: 0 });
  for (const e of expenses) {
    if (e.status !== "confirmed") continue;
    const payer = map.get(e.payerId);
    if (payer) payer.paid = round2(payer.paid + homeAmount(e));
    for (const [id, part] of Object.entries(splitOf(e))) {
      const b = map.get(id);
      if (b) b.owed = round2(b.owed + part);
    }
  }
  for (const b of map.values()) b.net = round2(b.paid - b.owed);
  for (const s of settlements) {
    const f = map.get(s.from);
    const t = map.get(s.to);
    if (f) f.net = round2(f.net + s.amount);
    if (t) t.net = round2(t.net - s.amount);
  }
  return [...map.values()];
}

/** 贪心最少转账：债务人按欠款降序对债权人按应收降序逐一清偿。 */
export function settle(balances: Balance[]): Transfer[] {
  const debtors = balances.filter((b) => b.net < -0.005).map((b) => ({ id: b.memberId, amt: -b.net }));
  const creditors = balances.filter((b) => b.net > 0.005).map((b) => ({ id: b.memberId, amt: b.net }));
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  const out: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const amt = round2(Math.min(d.amt, c.amt));
    if (amt > 0) out.push({ from: d.id, to: c.id, amount: amt });
    d.amt = round2(d.amt - amt);
    c.amt = round2(c.amt - amt);
    if (d.amt <= 0.005) i++;
    if (c.amt <= 0.005) j++;
  }
  return out;
}

/** 结算方案 = 已转记录 + 剩余转账（剩余部分按扣除已转后的净额重新贪心）。 */
export function settlePlan(trip: Trip, expenses: Expense[]) {
  const paid = trip.settlements ?? [];
  const balances = computeBalances(trip, expenses, paid);
  const remaining = settle(balances);
  const raw = computeBalances(trip, expenses, []);
  return { paid, remaining, balances: raw, allClear: remaining.length === 0 && expenses.some((e) => e.status === "confirmed") };
}

export function memberName(members: Member[], id: string): string {
  return members.find((m) => m.id === id)?.name ?? id;
}
