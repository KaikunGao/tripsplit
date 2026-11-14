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
 * 分摊规则：
 *  - equal   均摊（默认）
 *  - shares  按份数权重（"小明吃了两份"）
 *  - percent 按百分比（values 之和应为 100）
 *  - exact   按指定金额（values 之和应等于 amount；差额归最后一位参与人）
 * values 的键是 memberId；不在 participantIds 里的键会被忽略。
 */
export const SplitSchema = z.object({
  mode: z.enum(["equal", "shares", "percent", "exact"]),
  values: z.record(z.string(), z.number().nonnegative()).optional(),
});
export type Split = z.infer<typeof SplitSchema>;

/**
 * 一笔消费。参与人默认均摊；split 描述不均摊规则；treat=true 表示"请客"：
 * 这笔全额由付款人自己承担，被请的人不欠钱；participantIds 记的是被请的人（核账时不当作异常）。
 * 币种可与旅行本币不同，rate 是 1 单位该币种折合多少本币；结算一律按本币。
 */
export const ExpenseSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  amount: z.number().nonnegative(),
  currency: z.string().default("CNY"),
  /** 折算到旅行本币的汇率；同币种或未设置时视为 1 */
  rate: z.number().positive().optional(),
  payerId: z.string(),
  participantIds: z.array(z.string()),
  /** 旧字段：等价于 split.mode = "shares"，保留以兼容已有数据 */
  shares: z.record(z.string(), z.number().positive()).optional(),
  split: SplitSchema.optional(),
  treat: z.boolean().optional(),
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

/** 已完成的一笔转账（结算方案里被标记"已转"）。 */
export const SettlementSchema = z.object({
  from: z.string(),
  to: z.string(),
  amount: z.number().positive(),
  paidAt: z.string(),
});
export type Settlement = z.infer<typeof SettlementSchema>;

export const BudgetSchema = z.object({
  total: z.number().positive().optional(),
  byCategory: z.record(z.string(), z.number().positive()).optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const TripSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** 本币：结算与预算使用的币种 */
  currency: z.string().default("CNY"),
  members: z.array(MemberSchema).min(1),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  createdAt: z.string(),
  /** 当前使用者（管账人）的 memberId，用于"我付的"默认付款人 */
  selfMemberId: z.string().optional(),
  budget: BudgetSchema.optional(),
  settlements: z.array(SettlementSchema).optional(),
  /** 全部结清后锁定：不再允许增删改账目 */
  locked: z.boolean().optional(),
  /** 用户对核账建议点"忽略"时留下的理由，作为这次旅行的既定规则喂回 Agent */
  rules: z.array(z.string()).optional(),
  /** 云同步：分享码（邀请链接）与最近一次同步时间 */
  shareCode: z.string().optional(),
  syncedAt: z.string().optional(),
});
export type Trip = z.infer<typeof TripSchema>;

/** 跨行程的个人习惯（"阿强经常只付钱不吃"），喂给录入和核账两个模型。 */
export const PrefsSchema = z.object({
  habits: z.array(z.string()).default([]),
  /** 每个行程最近一次核账时的账本指纹，用于"结算前自动核账" */
  lastReconcile: z.record(z.string(), z.string()).default({}),
  /** 云同步身份：本机昵称与设备 id */
  deviceId: z.string().optional(),
});
export type Prefs = z.infer<typeof PrefsSchema>;

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
  /** 可选：跨行程习惯，随快照一起发给模型 */
  habits: z.array(z.string()).optional(),
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
    currency: z.string().optional(),
    rate: z.number().positive().optional(),
    split: SplitSchema.optional(),
    treat: z.boolean().optional(),
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
