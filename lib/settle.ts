import type { Expense, Member, Trip } from "./types";

export type Balance = { memberId: string; paid: number; owed: number; net: number };
export type Transfer = { from: string; to: string; amount: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 每人应分摊份额（按 shares 权重，缺省均摊）。付款人不在参与人内时也不分摊。 */
export function splitOf(e: Expense): Record<string, number> {
  const ids = e.participantIds;
  if (ids.length === 0) return {};
  const weights = ids.map((id) => e.shares?.[id] ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  // 分到分，余数给最后一个人，保证合计等于金额。
  let acc = 0;
  ids.forEach((id, i) => {
    if (i === ids.length - 1) {
      out[id] = round2(e.amount - acc);
    } else {
      const part = round2((e.amount * weights[i]) / total);
      out[id] = part;
      acc = round2(acc + part);
    }
  });
  return out;
}

export function computeBalances(trip: Trip, expenses: Expense[]): Balance[] {
  const map = new Map<string, Balance>();
  for (const m of trip.members) map.set(m.id, { memberId: m.id, paid: 0, owed: 0, net: 0 });
  for (const e of expenses) {
    if (e.status !== "confirmed") continue;
    const payer = map.get(e.payerId);
    if (payer) payer.paid = round2(payer.paid + e.amount);
    for (const [id, part] of Object.entries(splitOf(e))) {
      const b = map.get(id);
      if (b) b.owed = round2(b.owed + part);
    }
  }
  for (const b of map.values()) b.net = round2(b.paid - b.owed);
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

export function memberName(members: Member[], id: string): string {
  return members.find((m) => m.id === id)?.name ?? id;
}
