import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MODEL, client } from "../claude";
import { ExpensePatchSchema, type LedgerSnapshot, type ProposedChange } from "../types";
import { READ_TOOLS, SUBMIT_TOOL, toolImpl } from "./tools";

/** Agent 链路的可观测轨迹：planning 文本、每次工具调用及回传、最终结构化输出。 */
export type TraceStep =
  | { kind: "plan"; text: string }
  | { kind: "tool"; name: string; input: unknown; output: unknown; ms: number }
  | { kind: "text"; text: string };

const FindingSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  type: z.enum(["duplicate", "participants", "payer", "amount_outlier", "pending", "date", "other"]),
  title: z.string(),
  expense_ids: z.array(z.string()),
  evidence: z.string(),
  suggestion: z.string(),
  proposed_change: z
    .object({
      action: z.enum(["update", "delete"]),
      expenseId: z.string(),
      patch: z
        .object({
          amount: z.number().nullable(),
          payerId: z.string().nullable(),
          participantIds: z.array(z.string()).nullable(),
          category: z.string().nullable(),
          note: z.string().nullable(),
          occurredAt: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
});
const FindingsSchema = z.object({ summary: z.string(), findings: z.array(FindingSchema) });

export type Finding = Omit<z.infer<typeof FindingSchema>, "proposed_change"> & { id: string; proposed_change: ProposedChange | null };
export type ReconcileResult = { ok: true; summary: string; findings: Finding[]; trace: TraceStep[]; usage: { input: number; output: number; turns: number } };

const MAX_TURNS = 12;

function systemPrompt(snap: LedgerSnapshot): string {
  const { trip } = snap;
  return [
    "你是旅行 AA 账本的核账 Agent。目标：找出会导致结算错误的账目问题，并给出可供用户一键确认的修改建议。",
    "",
    "工作方式：",
    "1. 先用一两句话写出核查计划（要查哪些方面、用哪些工具），再开始调用工具。",
    "2. 工具全部是只读的。你不能修改账本；所有修改都以 proposed_change 的形式提交，由用户确认。",
    "3. 每条 finding 必须引用工具返回的具体数据作为证据（金额、时间差、人名等），不要凭印象。",
    "4. 优先级：重复录入 > 参与人/付款人错误 > 金额离群（如疑似多打一个零，可对照 evidence 原文）> 待补全 > 日期异常。",
    "5. 不确定的情况给 low/medium 并在 suggestion 里说明需要用户核实；不要为了凑数报无关问题。",
    "6. 修改建议里的 payerId/participantIds 必须用成员 id；删除重复项时保留证据更完整（有截图/置信度更高）的那条。",
    "7. 核查完毕后调用 submit_findings 提交结论；这是唯一的结束方式。",
    "",
    `旅行：${trip.name}（${trip.startDate ?? "?"} 至 ${trip.endDate ?? "?"}），成员 id 对照：${trip.members.map((m) => `${m.name}=${m.id}`).join("，")}`,
  ].join("\n");
}

export async function reconcile(snap: LedgerSnapshot): Promise<ReconcileResult> {
  const c = client();
  const tools = [...READ_TOOLS, SUBMIT_TOOL];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `请核查这本账（共 ${snap.expenses.length} 笔）。先写计划，再调用工具，最后用 submit_findings 提交。` }];
  const trace: TraceStep[] = [];
  const usage = { input: 0, output: 0, turns: 0 };
  let planned = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: [{ type: "text", text: systemPrompt(snap), cache_control: { type: "ephemeral" } }],
      tools,
      messages,
      output_config: { effort: "medium" },
    });
    usage.turns++;
    usage.input += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    usage.output += res.usage.output_tokens;

    for (const b of res.content) {
      if (b.type === "text" && b.text.trim()) {
        trace.push(planned ? { kind: "text", text: b.text } : { kind: "plan", text: b.text });
        planned = true;
      }
    }
    if (res.stop_reason === "refusal") throw new Error("模型拒绝了该请求");
    if (res.stop_reason === "max_tokens") throw new Error("输出被截断，请重试");

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    messages.push({ role: "assistant", content: res.content });

    const submit = toolUses.find((t) => t.name === SUBMIT_TOOL.name);
    if (submit) {
      const parsed = FindingsSchema.safeParse(submit.input);
      if (!parsed.success) {
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: submit.id, is_error: true, content: "结构不合法：" + parsed.error.message }] });
        continue;
      }
      return { ok: true, summary: parsed.data.summary, findings: normalize(snap, parsed.data.findings), trace, usage };
    }
    if (toolUses.length === 0) {
      if (res.stop_reason === "end_turn") {
        messages.push({ role: "user", content: "请继续：调用工具核查，并最终通过 submit_findings 提交结论。" });
        continue;
      }
      if (res.stop_reason === "pause_turn") continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const t0 = Date.now();
      const impl = toolImpl[t.name];
      let output: unknown;
      let isError = false;
      try {
        output = impl ? impl({ snap }, t.input as Record<string, unknown>) : { error: `unknown tool ${t.name}` };
      } catch (e) {
        output = { error: e instanceof Error ? e.message : String(e) };
        isError = true;
      }
      trace.push({ kind: "tool", name: t.name, input: t.input, output, ms: Date.now() - t0 });
      results.push({ type: "tool_result", tool_use_id: t.id, content: JSON.stringify(output), is_error: isError || undefined });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("核账轮次超限，请重试");
}

/** 把模型的 finding 整理成前端可直接应用的 ProposedChange；过滤掉引用不存在账目的建议。 */
function normalize(snap: LedgerSnapshot, findings: z.infer<typeof FindingSchema>[]): Finding[] {
  const ids = new Set(snap.expenses.map((e) => e.id));
  const memberIds = new Set(snap.trip.members.map((m) => m.id));
  return findings.map((f, i) => {
    let proposed: ProposedChange | null = null;
    const pc = f.proposed_change;
    if (pc && ids.has(pc.expenseId)) {
      if (pc.action === "delete") proposed = { action: "delete", expenseId: pc.expenseId, reason: f.suggestion };
      else if (pc.patch) {
        const raw: Record<string, unknown> = {};
        if (pc.patch.amount != null) raw.amount = pc.patch.amount;
        if (pc.patch.payerId && memberIds.has(pc.patch.payerId)) raw.payerId = pc.patch.payerId;
        if (pc.patch.participantIds) raw.participantIds = pc.patch.participantIds.filter((id) => memberIds.has(id));
        if (pc.patch.category) raw.category = pc.patch.category;
        if (pc.patch.note) raw.note = pc.patch.note;
        if (pc.patch.occurredAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(pc.patch.occurredAt)) raw.occurredAt = pc.patch.occurredAt;
        const p = ExpensePatchSchema.safeParse(raw);
        if (p.success && Object.keys(p.data).length) proposed = { action: "update", expenseId: pc.expenseId, patch: p.data, reason: f.suggestion };
      }
    }
    return { ...f, id: `f${i + 1}`, expense_ids: f.expense_ids.filter((id) => ids.has(id)), proposed_change: proposed };
  });
}
