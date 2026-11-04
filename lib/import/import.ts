import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { EFFORT, MODEL, client } from "../claude";
import { todayLocal } from "../format";
import { CATEGORIES, CategorySchema, TripSchema } from "../types";

/**
 * 自动导入：两种输入
 *  - rows：账单 CSV 已解析出的明细（时间/商户/商品/金额），模型只做分类 + 备注 + 是否像旅行消费
 *  - text：粘贴的订单确认文本（携程/美团/航司邮件等），模型抽取多笔消费
 * 输出都是账目草稿，由用户逐条确认后才入账。
 */
export const ImportRequestSchema = z.object({
  trip: TripSchema,
  rows: z
    .array(z.object({ time: z.string(), merchant: z.string(), item: z.string(), amount: z.number(), method: z.string().optional() }))
    .max(200)
    .optional(),
  text: z.string().max(20000).optional(),
  habits: z.array(z.string()).optional(),
});
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

const DraftSchema = z.object({
  index: z.number().nullable().describe("对应输入 rows 的下标；文本抽取时为 null"),
  amount: z.number(),
  currency: z.string().describe("ISO 币种代码"),
  note: z.string().describe("简短事项：商户 + 商品，如'携程 成都瑞吉酒店 2 晚'"),
  category: CategorySchema,
  occurred_at: z.string().describe("ISO 8601 本地时间"),
  payer: z.string().nullable().describe("付款人成员名，看不出来填 null（默认当前使用者）"),
  participants: z.array(z.string()).describe("参与人成员名；订单明确写了人数/人名就填，否则留空"),
  relevant: z.boolean().describe("是否像这次旅行的共同消费（个人消费、与行程无关、日期明显不在行程内的填 false）"),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe("一句话说明判断依据"),
});
const OutSchema = z.object({ drafts: z.array(DraftSchema) });
export type ImportDraft = z.infer<typeof DraftSchema>;

function systemPrompt(req: ImportRequest): string {
  const { trip } = req;
  const self = trip.members.find((m) => m.id === trip.selfMemberId)?.name;
  return [
    "你是多人旅行 AA 记账助手的批量导入解析器。把账单明细或订单文本整理成账目草稿，用户会逐条确认。",
    `旅行：${trip.name}（${trip.startDate ?? "?"} 至 ${trip.endDate ?? "?"}，本币 ${trip.currency}）；成员：${trip.members.map((m) => m.name).join("、")}${self ? `；当前使用者是 ${self}` : ""}`,
    `分类只能是：${CATEGORIES.join("/")}`,
    "规则：",
    "- rows 模式：每一行输出一条草稿，index 填该行下标，不要漏行、不要合并；note 用商户+商品改写成人能读懂的事项；交通/住宿/餐饮按商户名判断。",
    "- text 模式：从订单文本里抽取所有独立消费（一张订单一条；多间房/多张票若分开列价就分开），index 为 null。",
    "- relevant：地铁/打车/餐厅/酒店/门票这类在行程日期内的都算相关；转账给个人、理财、话费、与行程无关的网购填 false。",
    "- participants 只在文本明确说明时填写，否则留空；payer 只在明确时填，否则 null。",
    "- 金额保持原币；外币按 ISO 代码。时间不确定用行程内最可能的日期并降低 confidence。",
    req.habits?.length ? `已知个人习惯：\n${req.habits.map((h) => "- " + h).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function importDrafts(req: ImportRequest): Promise<{ drafts: ImportDraft[]; usage: { input: number; output: number } }> {
  const content = req.rows
    ? `今天：${todayLocal()}\n账单明细（JSON 数组，index 即下标）：\n${JSON.stringify(req.rows.map((r, index) => ({ index, ...r })))}`
    : `今天：${todayLocal()}\n订单文本：\n${req.text}`;
  const res = await client().messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: systemPrompt(req), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    output_config: { effort: req.rows ? "low" : EFFORT, format: zodOutputFormat(OutSchema) },
  });
  if (res.stop_reason === "refusal") throw new Error("模型拒绝处理该输入");
  const out = res.parsed_output;
  if (!out) throw new Error("模型输出不符合结构");
  return { drafts: out.drafts, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
}
