import { z } from "zod";
import { CategorySchema, ExpensePatchSchema, TripSchema } from "../types";

/** 录入请求：文字 / 截图(+可选说明) / 语音转写文字。supplement 为追问后的补充回答。 */
export const ExtractRequestSchema = z.object({
  trip: TripSchema,
  kind: z.enum(["text", "image", "voice"]),
  text: z.string().optional(),
  image: z
    .object({ media_type: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.string() })
    .optional(),
  supplement: z.string().optional(),
  /** 上一轮抽取结果（追问场景），让模型在其基础上补全而不是重来 */
  previous: z.unknown().optional(),
  /** 跨行程个人习惯，如"阿强经常只付钱不吃" */
  habits: z.array(z.string()).optional(),
});
export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

/** 模型输出：每个关键字段带置信度；名字用成员名，由服务端解析成 id。 */
export const ModelOutputSchema = z.object({
  is_expense: z.boolean().describe("输入是否描述了一笔可入账的消费（截图不是支付凭证、文字只是闲聊时为 false）"),
  not_expense_reason: z.string().nullable(),
  amount: z.number().nullable().describe("总金额，无法确定填 null"),
  amount_confidence: z.number().min(0).max(1),
  currency: z.string().nullable().describe("币种代码，如 CNY/USD；看不出来填 null"),
  payer: z.string().nullable().describe("付款人，必须是成员名单中的名字；无法确定填 null"),
  payer_confidence: z.number().min(0).max(1),
  participants: z.array(z.string()).describe("参与分摊的成员名；'大家/所有人/AA'时列出全部成员"),
  participants_confidence: z.number().min(0).max(1),
  treat: z.boolean().describe("是否'请客'：付款人明确表示自己不参与分摊（'我请客''小华请大家'）。请客时 participants 不包含付款人"),
  category: CategorySchema,
  category_confidence: z.number().min(0).max(1),
  note: z.string().describe("简短备注：商户/事项，如'春熙路 小龙坎火锅'"),
  occurred_at: z.string().nullable().describe("消费时间 ISO 8601（本地时间，无时区后缀），不确定填 null"),
  questions: z.array(z.string()).describe("对缺失或低置信度字段的追问，用自然中文，一条一个字段，最多 3 条"),
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export const ExtractResponseSchema = z.object({
  ok: z.literal(true),
  /** auto = 自动入账；ask = 需要追问补全；reject = 不是消费 */
  decision: z.enum(["auto", "ask", "reject"]),
  reason: z.string(),
  draft: ExpensePatchSchema.extend({
    currency: z.string(),
    confidence: z.number(),
  }),
  fields: z.object({
    amount: z.number(),
    payer: z.number(),
    participants: z.number(),
    category: z.number(),
  }),
  missing: z.array(z.string()),
  questions: z.array(z.string()),
  raw: ModelOutputSchema,
  usage: z.object({ input: z.number(), output: z.number() }).optional(),
});
export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;
