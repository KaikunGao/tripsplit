import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { RECONCILE_MODEL, client } from "../claude";
import { CategorySchema, ExpensePatchSchema, type LedgerSnapshot, type ProposedChange } from "../types";
import { READ_TOOLS, SUBMIT_TOOL, toolImpl } from "./tools";

/** Agent 链路的可观测轨迹：planning 文本、每次工具调用及回传、最终结构化输出。 */
export type TraceStep =
  | { kind: "plan"; text: string }
  | { kind: "tool"; name: string; input: unknown; output: unknown; ms: number }
  | { kind: "text"; text: string };

export const FindingSchema = z.object({
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
          treat: z.boolean().nullable(),
        })
        .nullable(),
    })
    .nullable(),
});
export const FindingsSchema = z.object({ summary: z.string(), findings: z.array(FindingSchema) });

export type Finding = Omit<z.infer<typeof FindingSchema>, "proposed_change"> & { id: string; proposed_change: ProposedChange | null };
/** 按计费类别拆开的 token 用量（usage.input 是三类输入之和）；评测算成本要分开，因为缓存读写和普通输入单价不同。 */
export type UsageDetail = { input: number; cacheWrite: number; cacheRead: number; output: number };
/** mode：这次结果是 Agent 循环跑出来的，还是固定流程（lib/agent/pipeline.ts）跑出来的；model 是实际应答的模型。 */
export type ReconcileResult = { ok: true; summary: string; findings: Finding[]; trace: TraceStep[]; usage: { input: number; output: number; turns: number }; mode?: "agent" | "pipeline"; model?: string; usageDetail?: UsageDetail };

const MAX_TURNS = 12;

/**
 * 判断规则：Agent 循环和固定流程（pipeline.ts）共用同一份，对照评测比的是「谁决定调什么」，不是提示词。
 * 2026-11-13 按第一轮评测的复查补了后四条：原话逐项对照、判断为正常的不写成 finding、没证据不给具体修改值、删重复时留哪条。
 */
export const JUDGE_RULES = [
  "每条 finding 必须引用具体数据作为证据（金额、时间差、人名等），不要凭印象。",
  "优先级：重复录入 > 参与人/付款人错误 > 金额离群（如疑似多打一个零）> 待补全 > 日期异常。",
  "有原话（evidence）的账目，把原话和账面逐项对一遍：金额、币种、谁付的、哪些人参与（「只有…」）、是不是请客。对不上的就是问题，金额再小也要报。",
  "不确定的情况给 low/medium 并在 suggestion 里说明需要用户核实；不要为了凑数报无关问题。金额只是在同类里偏大、又和自己的原话一致的，不报。",
  "findings 只放需要用户处理的问题。检查后判断为正常的情况（比如金额相同但确实是往返两笔、已标请客、已按规则或原话分摊、出发前的预订）不要写成 finding，也不要用 low 级别「提示一下」；这类在 summary 里一句话带过即可。",
  "修改建议里的 payerId/participantIds 必须用成员 id。没有依据能确定新值时（没有原话的非成员付款人、没有凭证的离群金额、待补全的金额）不要给 proposed_change，在 suggestion 里请用户补。",
  "删除重复项时保留金额精确的那条（另一条是「差不多」的约数时删约数）；都精确时保留有原话或截图的那条。",
];

/** 旅行背景：成员对照、字段含义、用户确认过的规则和习惯。两种模式共用。 */
export function TRIP_CONTEXT(snap: LedgerSnapshot): string[] {
  const { trip } = snap;
  return [
    `旅行：${trip.name}（${trip.startDate ?? "?"} 至 ${trip.endDate ?? "?"}，本币 ${trip.currency}），成员 id 对照：${trip.members.map((m) => `${m.name}=${m.id}`).join("，")}`,
    "账目字段说明：treat=true 表示请客：这笔全额由付款人自己承担，被请的人不欠钱，participantIds 记的是被请的人（付款人不在其中是对的，不算异常）；没标请客而付款人不在参与人里，是替别人垫付。split 是不均摊规则；currency/rate 是外币与折算汇率，结算按本币。",
    trip.rules?.length ? `\n用户已确认的本次旅行规则（这些情况不要再报）：\n${trip.rules.map((r) => "- " + r).join("\n")}` : "",
    snap.habits?.length ? `\n用户的长期习惯（可作为判断依据）：\n${snap.habits.map((h) => "- " + h).join("\n")}` : "",
  ];
}

function systemPrompt(snap: LedgerSnapshot): string {
  return [
    "你是旅行 AA 账本的核账 Agent。目标：找出会导致结算错误的账目问题，并给出可供用户一键确认的修改建议。",
    "",
    "工作方式：",
    "1. 先用一两句话写出核查计划（要查哪些方面、用哪些工具），再开始调用工具。",
    "2. 工具全部是只读的。你不能修改账本；所有修改都以 proposed_change 的形式提交，由用户确认。",
    ...JUDGE_RULES.map((r, i) => `${i + 3}. ${r}`),
    `${JUDGE_RULES.length + 3}. 核查完毕后调用 submit_findings 提交结论；这是唯一的结束方式。没有发现问题时 findings 传空数组。`,
    "",
    ...TRIP_CONTEXT(snap),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function reconcile(snap: LedgerSnapshot, opts: { model?: string } = {}): Promise<ReconcileResult> {
  const c = client();
  const model = opts.model ?? RECONCILE_MODEL;
  const tools = [...READ_TOOLS, SUBMIT_TOOL];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `请核查这本账（共 ${snap.expenses.length} 笔）。先写计划，再调用工具，最后用 submit_findings 提交。` }];
  const trace: TraceStep[] = [];
  const usage = { input: 0, output: 0, turns: 0 };
  const usageDetail: UsageDetail = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let planned = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await c.messages.create({
      model,
      max_tokens: 8000,
      system: [{ type: "text", text: systemPrompt(snap), cache_control: { type: "ephemeral" } }],
      tools,
      messages,
      output_config: { effort: "medium" },
    });
    usage.turns++;
    usage.input += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    usage.output += res.usage.output_tokens;
    usageDetail.input += res.usage.input_tokens;
    usageDetail.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
    usageDetail.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    usageDetail.output += res.usage.output_tokens;

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
      return { ok: true, summary: parsed.data.summary, findings: normalize(snap, parsed.data.findings), trace, usage, mode: "agent", model: res.model, usageDetail };
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
export function normalize(snap: LedgerSnapshot, findings: z.infer<typeof FindingSchema>[]): Finding[] {
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
        // 参与人里只要有一个认不出的 id（模型写成了人名之类），就不动参与人：过滤后再应用可能把人删掉甚至清空
        if (pc.patch.participantIds && pc.patch.participantIds.every((id) => memberIds.has(id))) raw.participantIds = pc.patch.participantIds;
        if (pc.patch.category && CategorySchema.safeParse(pc.patch.category).success) raw.category = pc.patch.category;
        if (pc.patch.note) raw.note = pc.patch.note;
        if (pc.patch.occurredAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(pc.patch.occurredAt)) raw.occurredAt = pc.patch.occurredAt;
        if (pc.patch.treat != null) raw.treat = pc.patch.treat;
        const p = ExpensePatchSchema.safeParse(raw);
        if (p.success && Object.keys(p.data).length) proposed = { action: "update", expenseId: pc.expenseId, patch: p.data, reason: f.suggestion };
      }
    }
    return { ...f, id: `f${i + 1}`, expense_ids: f.expense_ids.filter((id) => ids.has(id)), proposed_change: proposed };
  });
}
