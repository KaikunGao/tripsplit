import type Anthropic from "@anthropic-ai/sdk";
import { computeBalances, memberName, settle, splitOf } from "../settle";
import type { Expense, LedgerSnapshot } from "../types";

/**
 * 核账 Agent 的工具集。全部是对账本快照的纯函数：没有任何写操作，
 * 这是"Agent 只读账目、提出建议、由用户确认修改"的技术保证。
 */
export type ToolCtx = { snap: LedgerSnapshot };

const brief = (snap: LedgerSnapshot, e: Expense) => ({
  id: e.id,
  time: e.occurredAt.slice(0, 16),
  amount: e.amount,
  category: e.category,
  note: e.note,
  payer: memberName(snap.trip.members, e.payerId),
  participants: e.participantIds.map((id) => memberName(snap.trip.members, id)),
  status: e.status,
  source: e.source,
  confidence: e.confidence,
  evidence: e.evidence?.text ?? null,
});

export const toolImpl: Record<string, (ctx: ToolCtx, input: Record<string, unknown>) => unknown> = {
  get_trip({ snap }) {
    return { name: snap.trip.name, dates: [snap.trip.startDate, snap.trip.endDate], members: snap.trip.members, currency: snap.trip.currency, expense_count: snap.expenses.length };
  },
  list_expenses({ snap }, input) {
    let list = snap.expenses;
    const f = input as { date?: string; payer?: string; category?: string; status?: string; min_amount?: number };
    if (f.date) list = list.filter((e) => e.occurredAt.startsWith(f.date!));
    if (f.payer) list = list.filter((e) => memberName(snap.trip.members, e.payerId) === f.payer);
    if (f.category) list = list.filter((e) => e.category === f.category);
    if (f.status) list = list.filter((e) => e.status === f.status);
    if (f.min_amount != null) list = list.filter((e) => e.amount >= f.min_amount!);
    return list.map((e) => brief(snap, e));
  },
  get_expense({ snap }, input) {
    const e = snap.expenses.find((x) => x.id === (input as { id: string }).id);
    return e ? { ...brief(snap, e), split: Object.fromEntries(Object.entries(splitOf(e)).map(([id, v]) => [memberName(snap.trip.members, id), v])) } : { error: "not found" };
  },
  find_duplicates({ snap }, input) {
    const { window_minutes = 120, amount_tolerance = 0 } = input as { window_minutes?: number; amount_tolerance?: number };
    const out: { a: string; b: string; minutes_apart: number; same_payer: boolean }[] = [];
    const es = snap.expenses;
    for (let i = 0; i < es.length; i++)
      for (let j = i + 1; j < es.length; j++) {
        const a = es[i];
        const b = es[j];
        if (Math.abs(a.amount - b.amount) > amount_tolerance) continue;
        const mins = Math.abs(new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()) / 60000;
        if (mins <= window_minutes) out.push({ a: a.id, b: b.id, minutes_apart: Math.round(mins), same_payer: a.payerId === b.payerId });
      }
    return out;
  },
  check_integrity({ snap }) {
    const memberIds = new Set(snap.trip.members.map((m) => m.id));
    const issues: { id: string; problem: string }[] = [];
    for (const e of snap.expenses) {
      if (e.participantIds.length === 0) issues.push({ id: e.id, problem: "participants_empty" });
      if (!memberIds.has(e.payerId)) issues.push({ id: e.id, problem: "payer_not_member" });
      if (e.participantIds.some((id) => !memberIds.has(id))) issues.push({ id: e.id, problem: "participant_not_member" });
      if (e.participantIds.length > 0 && !e.participantIds.includes(e.payerId)) issues.push({ id: e.id, problem: "payer_not_in_participants" });
      if (e.status === "pending") issues.push({ id: e.id, problem: "pending_incomplete" });
      if (e.amount <= 0) issues.push({ id: e.id, problem: "amount_zero" });
      if (e.confidence < 0.75) issues.push({ id: e.id, problem: `low_confidence_${e.confidence}` });
      const d = e.occurredAt.slice(0, 10);
      if ((snap.trip.startDate && d < snap.trip.startDate) || (snap.trip.endDate && d > snap.trip.endDate)) issues.push({ id: e.id, problem: "outside_trip_dates" });
    }
    return issues;
  },
  category_stats({ snap }) {
    const by: Record<string, { count: number; total: number; max: number; avg: number }> = {};
    for (const e of snap.expenses) {
      const s = (by[e.category] ??= { count: 0, total: 0, max: 0, avg: 0 });
      s.count++;
      s.total += e.amount;
      s.max = Math.max(s.max, e.amount);
    }
    for (const s of Object.values(by)) s.avg = Math.round(s.total / s.count);
    return by;
  },
  get_balances({ snap }) {
    const balances = computeBalances(snap.trip, snap.expenses);
    return {
      balances: balances.map((b) => ({ ...b, name: memberName(snap.trip.members, b.memberId) })),
      transfers: settle(balances).map((t) => ({ from: memberName(snap.trip.members, t.from), to: memberName(snap.trip.members, t.to), amount: t.amount })),
    };
  },
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export const READ_TOOLS: Anthropic.Tool[] = [
  { name: "get_trip", description: "旅行基本信息：成员、日期范围、币种、账目条数。", strict: true, input_schema: obj({}) },
  {
    name: "list_expenses",
    description: "按条件列出账目摘要（不传条件=全部）。",
    strict: true,
    input_schema: obj({
      date: { type: ["string", "null"], description: "YYYY-MM-DD 前缀匹配" },
      payer: { type: ["string", "null"], description: "付款人成员名" },
      category: { type: ["string", "null"] },
      status: { type: ["string", "null"], description: "pending 或 confirmed" },
      min_amount: { type: ["number", "null"] },
    }, ["date", "payer", "category", "status", "min_amount"]),
  },
  { name: "get_expense", description: "单笔账目详情，含每人分摊与原始证据文本。", strict: true, input_schema: obj({ id: { type: "string" } }, ["id"]) },
  {
    name: "find_duplicates",
    description: "找金额相同（允许误差）且时间相近的成对账目，疑似重复录入。",
    strict: true,
    input_schema: obj({ window_minutes: { type: "number", description: "时间窗口（分钟），默认 120" }, amount_tolerance: { type: "number", description: "金额误差，默认 0" } }, ["window_minutes", "amount_tolerance"]),
  },
  { name: "check_integrity", description: "规则体检：参与人为空、付款人不在参与人内、非成员、待补全、零金额、低置信度、日期超出旅行范围。", strict: true, input_schema: obj({}) },
  { name: "category_stats", description: "各分类的笔数、合计、最大值、均值，用于发现金额离群。", strict: true, input_schema: obj({}) },
  { name: "get_balances", description: "当前每人已付/应摊/净额与最少转账方案。", strict: true, input_schema: obj({}) },
];

/** 结构化输出工具：Agent 调用它来提交核账结论，循环随之结束。 */
export const SUBMIT_TOOL: Anthropic.Tool = {
  name: "submit_findings",
  description: "提交核账结论。每条 finding 必须引用账目 id 作为证据；可附带一条修改建议（patch 仅含要改字段），由用户确认后生效。",
  strict: true,
  input_schema: obj(
    {
      summary: { type: "string", description: "一两句话总结账本健康状况" },
      findings: {
        type: "array",
        items: obj(
          {
            severity: { type: "string", enum: ["high", "medium", "low"] },
            type: { type: "string", enum: ["duplicate", "participants", "payer", "amount_outlier", "pending", "date", "other"] },
            title: { type: "string" },
            expense_ids: { type: "array", items: { type: "string" } },
            evidence: { type: "string", description: "引用工具返回的具体数据说明为什么可疑" },
            suggestion: { type: "string", description: "给用户的处理建议" },
            proposed_change: {
              type: ["object", "null"],
              properties: {
                action: { type: "string", enum: ["update", "delete"] },
                expenseId: { type: "string" },
                patch: {
                  type: ["object", "null"],
                  properties: {
                    amount: { type: ["number", "null"] },
                    payerId: { type: ["string", "null"] },
                    participantIds: { type: ["array", "null"], items: { type: "string" } },
                    category: { type: ["string", "null"] },
                    note: { type: ["string", "null"] },
                    occurredAt: { type: ["string", "null"], description: "ISO 8601 本地时间，如 2025-10-02T18:30:00" },
                  },
                  required: ["amount", "payerId", "participantIds", "category", "note", "occurredAt"],
                  additionalProperties: false,
                },
              },
              required: ["action", "expenseId", "patch"],
              additionalProperties: false,
            },
          },
          ["severity", "type", "title", "expense_ids", "evidence", "suggestion", "proposed_change"],
        ),
      },
    },
    ["summary", "findings"],
  ),
};
