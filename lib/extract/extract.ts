import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { EFFORT, MODEL, client } from "../claude";
import type { Member, Trip } from "../types";
import { systemPrompt, userContent } from "./prompt";
import { ModelOutputSchema, type ExtractRequest, type ExtractResponse, type ModelOutput } from "./schema";

// 自动入账阈值：三项核心字段都过线才自动入账，否则追问。分类低置信只降级，不追问。
export const THRESHOLD = { amount: 0.8, payer: 0.7, participants: 0.7 } as const;

/** 成员名解析：精确 → 包含 → 去掉"小/阿"前缀后比较。 */
export function resolveMember(members: Member[], name: string | null): Member | null {
  if (!name) return null;
  const n = name.trim();
  const strip = (s: string) => s.replace(/^(小|阿|老)/, "");
  return (
    members.find((m) => m.name === n) ??
    members.find((m) => n.includes(m.name) || m.name.includes(n)) ??
    members.find((m) => strip(m.name) === strip(n)) ??
    null
  );
}

/** 纯函数：模型输出 → 入账决策。独立出来方便单测与 eval。 */
export function decide(trip: Trip, out: ModelOutput): ExtractResponse {
  if (!out.is_expense) {
    return {
      ok: true,
      decision: "reject",
      reason: out.not_expense_reason || "未识别出消费",
      draft: { currency: trip.currency, confidence: 0 },
      fields: { amount: 0, payer: 0, participants: 0, category: 0 },
      missing: [],
      questions: [],
      raw: out,
    };
  }
  const payer = resolveMember(trip.members, out.payer);
  const participants = out.participants
    .map((n) => resolveMember(trip.members, n))
    .filter((m): m is Member => !!m);
  let uniq = [...new Set(participants.map((m) => m.id))];
  // 请客：付款人不分摊。模型若把付款人也列进来，这里去掉。
  if (out.treat && payer) uniq = uniq.filter((id) => id !== payer.id);

  const fields = {
    amount: out.amount != null && out.amount > 0 ? out.amount_confidence : 0,
    payer: payer ? out.payer_confidence : 0,
    participants: uniq.length > 0 ? out.participants_confidence : 0,
    category: out.category_confidence,
  };
  const missing: string[] = [];
  if (fields.amount < THRESHOLD.amount) missing.push("amount");
  if (fields.payer < THRESHOLD.payer) missing.push("payer");
  if (fields.participants < THRESHOLD.participants) missing.push("participants");

  const questions = [...out.questions];
  // 模型没问但我们判定缺失的字段，补一条兜底追问。
  const fallback: Record<string, string> = {
    amount: "这笔的实付金额是多少？",
    payer: `这笔是谁付的？（${trip.members.map((m) => m.name).join("/")}）`,
    participants: "有谁参与分摊？说“大家”即全员。",
  };
  for (const f of missing) if (!questions.some((q) => q.includes(fallback[f].slice(0, 2)))) questions.push(fallback[f]);

  const confidence = Math.min(fields.amount || 0, fields.payer || 0, fields.participants || 0);
  return {
    ok: true,
    decision: missing.length ? "ask" : "auto",
    reason: missing.length ? `待补全：${missing.map((m) => ({ amount: "金额", payer: "付款人", participants: "参与人" })[m]).join("、")}` : "字段完整且置信度达标",
    draft: {
      amount: out.amount ?? undefined,
      payerId: payer?.id,
      participantIds: uniq,
      category: out.category,
      note: out.note,
      occurredAt: out.occurred_at ?? undefined,
      currency: out.currency ?? trip.currency,
      treat: out.treat || undefined,
      confidence,
    },
    fields,
    missing,
    questions: questions.slice(0, 3),
    raw: out,
  };
}

export async function extract(req: ExtractRequest): Promise<ExtractResponse> {
  const res = await client().messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: [{ type: "text", text: systemPrompt(req.trip, req.habits ?? []), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent(req) }],
    output_config: { effort: EFFORT, format: zodOutputFormat(ModelOutputSchema) },
  });
  if (res.stop_reason === "refusal") throw new Error("模型拒绝处理该输入");
  const out = res.parsed_output;
  if (!out) throw new Error("模型输出不符合结构");
  return { ...decide(req.trip, out), usage: { input: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0), output: res.usage.output_tokens } };
}
