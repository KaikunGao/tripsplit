import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODEL, client } from "../claude";
import { todayLocal } from "../format";
import { CATEGORIES, LedgerSnapshotSchema, ProposedChangeSchema, type LedgerSnapshot } from "../types";
import { renderExpense, retrieve, type Filters, type Hit } from "./retrieve";

export const SearchRequestSchema = LedgerSnapshotSchema.extend({ query: z.string().min(1) });

/** 第一步：模糊描述 → 结构化条件 + 意图。小而快的一次调用。 */
const QuerySchema = z.object({
  intent: z.enum(["find", "modify", "summarize"]).describe("find=找账；modify=用户想改/删某笔；summarize=要统计或总结"),
  date_from: z.string().nullable().describe("YYYY-MM-DD，相对日期按旅行日期与今天换算；无则 null"),
  date_to: z.string().nullable(),
  amount_min: z.number().nullable(),
  amount_max: z.number().nullable(),
  payer: z.string().nullable().describe("付款人成员名；无则 null"),
  participants: z.array(z.string()).describe("必须参与的成员名"),
  category: z.enum(CATEGORIES).nullable(),
  keywords: z.array(z.string()).describe("商户/事项同义词扩展，如'火锅'→['火锅','小龙坎','串串']"),
});

const AnswerSchema = z.object({
  answer: z.string().describe("用中文回答用户，引用具体账目时写明日期/金额/付款人"),
  citations: z.array(z.string()).describe("支撑回答的账目 id（必须来自候选列表）"),
  proposed_changes: z.array(ProposedChangeSchema).describe("仅当用户明确要修改/删除时给出；否则为空数组"),
  confidence: z.number().min(0).max(1),
});

export type SearchResult = {
  ok: true;
  filters: Filters & { intent: string };
  relaxed: boolean;
  hits: { id: string; score: number; matched: string[]; text: string }[];
  answer: z.infer<typeof AnswerSchema>;
};

export async function search(snap: LedgerSnapshot, query: string): Promise<SearchResult> {
  const { trip, expenses } = snap;
  const c = client();
  const ctx = `旅行「${trip.name}」${trip.startDate ?? ""}~${trip.endDate ?? ""}，成员：${trip.members.map((m) => m.name).join("、")}，今天 ${todayLocal()}。`;

  const q = await c.messages.parse({
    model: MODEL,
    max_tokens: 1024,
    system: "你把用户对历史账目的模糊描述解析成结构化检索条件。只抽取用户明确提到的条件，不要臆测；成员名只能用名单里的。\n" + ctx,
    messages: [{ role: "user", content: query }],
    output_config: { effort: "low", format: zodOutputFormat(QuerySchema) },
  });
  const filters = q.parsed_output;
  if (!filters) throw new Error("条件解析失败");

  const { hits, relaxed } = retrieve(trip, expenses, query, filters, 8);
  const evidence = hits.map((h: Hit) => renderExpense(trip, h.expense)).join("\n");

  const a = await c.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: [
      "你是旅行记账助手，根据检索到的账目候选回答用户。",
      "- 只依据候选列表作答；候选里没有就如实说没找到，不要编造。",
      "- citations 只能填候选中的 id（不带 #）。",
      "- 用户要求修改/删除时才给 proposed_changes；patch 只包含要改的字段，payerId/participantIds 用成员 id。永远不要自行决定改账，只给建议，由用户确认。",
      "- summarize 意图下给出合计与按人/按类的简要统计。",
      ctx,
      `成员 id 对照：${trip.members.map((m) => `${m.name}=${m.id}`).join("，")}`,
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: `用户问题：${query}\n解析条件：${JSON.stringify(filters)}${relaxed ? "\n（条件过滤为空，已放宽为语义检索）" : ""}\n\n候选账目（${hits.length} 条）：\n${evidence || "（无）"}`,
      },
    ],
    output_config: { effort: "medium", format: zodOutputFormat(AnswerSchema) },
  });
  const answer = a.parsed_output;
  if (!answer) throw new Error("回答生成失败");
  const ids = new Set(hits.map((h) => h.expense.id));
  answer.citations = answer.citations.map((x) => x.replace(/^#/, "")).filter((x) => ids.has(x));
  answer.proposed_changes = answer.proposed_changes.filter((p) => expenses.some((e) => e.id === p.expenseId));

  return {
    ok: true,
    filters: { ...filters, intent: filters.intent },
    relaxed,
    hits: hits.map((h) => ({ id: h.expense.id, score: Math.round(h.score * 1000) / 1000, matched: h.matched, text: renderExpense(trip, h.expense) })),
    answer,
  };
}
