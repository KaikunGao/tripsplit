import { toolImpl } from "./agent/tools";
import { computeBalances, homeAmount } from "./settle";
import type { Expense, Trip } from "./types";

/**
 * 账本健康度：复用核账 Agent 的两个只读工具（规则体检 + 查重）做一次本地快速扫描，
 * 给首页和账本页一个"有多少笔值得看一眼"的数字。不调模型。
 */
export type Health = {
  total: number;
  count: number;
  pending: number;
  /** 规则体检命中的账目数（去重后），不含"待补全"和低置信度本身。 */
  flagged: number;
  /** 疑似重复的账目对数 */
  duplicates: number;
  /** "我"的净额（selfMemberId），正数应收、负数应付 */
  myNet: number | null;
};

export function health(trip: Trip, expenses: Expense[]): Health {
  const snap = { trip, expenses };
  const issues = toolImpl.check_integrity({ snap }, {}) as { id: string; problem: string }[];
  const flagged = new Set(issues.filter((i) => i.problem !== "pending_incomplete" && !i.problem.startsWith("low_confidence")).map((i) => i.id));
  const dups = toolImpl.find_duplicates({ snap }, { window_minutes: 120, amount_tolerance: 0 }) as unknown[];
  const confirmed = expenses.filter((e) => e.status === "confirmed");
  const me = trip.selfMemberId ? computeBalances(trip, expenses).find((b) => b.memberId === trip.selfMemberId) : undefined;
  return {
    total: confirmed.reduce((a, e) => a + homeAmount(e), 0),
    count: expenses.length,
    pending: expenses.length - confirmed.length,
    flagged: flagged.size,
    duplicates: dups.length,
    myNet: me ? me.net : null,
  };
}
