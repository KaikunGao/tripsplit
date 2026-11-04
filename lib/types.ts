import { z } from "zod";

/** 旅行成员。id 在旅行内唯一；name 用于模型识别("小明")。 */
export const MemberSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
});
export type Member = z.infer<typeof MemberSchema>;

export const CATEGORIES = ["餐饮", "交通", "住宿", "门票", "购物", "娱乐", "其他"] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const SourceSchema = z.enum(["manual", "text", "image", "voice", "agent"]);
export type Source = z.infer<typeof SourceSchema>;

/**
 * 一笔消费。参与人默认均摊；shares 可选，键为 memberId、值为权重（份数），
 * 用于"小明吃了两份"这类不均摊场景。
 */
export const ExpenseSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  amount: z.number().nonnegative(),
  currency: z.string().default("CNY"),
  payerId: z.string(),
  participantIds: z.array(z.string()),
  shares: z.record(z.string(), z.number().positive()).optional(),
  category: CategorySchema,
  note: z.string().default(""),
  /** ISO 日期时间（本地） */
  occurredAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  source: SourceSchema,
  /** 录入置信度（0-1），人工录入为 1 */
  confidence: z.number().min(0).max(1).default(1),
  /** pending = 待补全/待确认，confirmed = 已入账 */
  status: z.enum(["pending", "confirmed"]).default("confirmed"),
  /** 证据：缩略图 dataURL / 原始文字 / 语音转写 */
  evidence: z
    .object({
      kind: SourceSchema,
      text: z.string().optional(),
      thumbnail: z.string().optional(),
    })
    .optional(),
});
export type Expense = z.infer<typeof ExpenseSchema>;

export const TripSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  currency: z.string().default("CNY"),
  members: z.array(MemberSchema).min(1),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  createdAt: z.string(),
  /** 当前使用者（管账人）的 memberId，用于"我付的"默认付款人 */
  selfMemberId: z.string().optional(),
});
export type Trip = z.infer<typeof TripSchema>;

/** 审计记录：谁（用户/Agent 建议经用户确认）在何时改了什么。 */
export const AuditEntrySchema = z.object({
  id: z.string(),
  tripId: z.string(),
  at: z.string(),
  action: z.enum(["create", "update", "delete", "settle"]),
  expenseId: z.string().optional(),
  origin: z.enum(["user", "agent-confirmed", "search-confirmed"]),
  summary: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** 账本快照：发给服务端的只读数据，服务端永远不会持久化或回写。 */
export const LedgerSnapshotSchema = z.object({
  trip: TripSchema,
  expenses: z.array(ExpenseSchema),
});
export type LedgerSnapshot = z.infer<typeof LedgerSnapshotSchema>;

/** 对某笔消费的修改建议（字段级 patch），由用户确认后在客户端应用。 */
export const ExpensePatchSchema = z
  .object({
    amount: z.number().nonnegative().optional(),
    payerId: z.string().optional(),
    participantIds: z.array(z.string()).optional(),
    category: CategorySchema.optional(),
    note: z.string().optional(),
    occurredAt: z.string().optional(),
  })
  .strict();
export type ExpensePatch = z.infer<typeof ExpensePatchSchema>;

export const ProposedChangeSchema = z.object({
  action: z.enum(["update", "delete"]),
  expenseId: z.string(),
  patch: ExpensePatchSchema.optional(),
  reason: z.string(),
});
export type ProposedChange = z.infer<typeof ProposedChangeSchema>;
