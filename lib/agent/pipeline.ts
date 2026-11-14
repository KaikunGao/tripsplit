import { RECONCILE_MODE, RECONCILE_MODEL, client, type ReconcileMode } from "../claude";
import type { LedgerSnapshot } from "../types";
import { FindingsSchema, JUDGE_RULES, TRIP_CONTEXT, normalize, reconcile, type ReconcileResult, type TraceStep, type UsageDetail } from "./run";
import { SUBMIT_TOOL, toolImpl } from "./tools";

/**
 * 固定流程版核账（2026-11-13）。
 *
 * 核账要查什么其实是确定的：规则体检、查重、分类统计、结算预览四项检查，再把整本账看一遍。
 * 所以这里由代码按固定顺序把检查跑完，模型只调用一次，负责判断、解释和给修改建议。
 * 和 Agent 版（run.ts）用的是同一批只读函数、同一份输出结构、同样的判断规则，
 * 区别只在「谁决定调什么」：这里是代码，Agent 版是模型。对照评测见 docs/评测-核账-2026-11-13.md。
 */
const CHECKS: { name: keyof typeof LABEL; input: Record<string, unknown> }[] = [
  { name: "get_trip", input: {} },
  { name: "check_integrity", input: {} },
  { name: "find_duplicates", input: { window_minutes: 120, amount_tolerance: 0 } },
  { name: "category_stats", input: {} },
  { name: "get_balances", input: {} },
  { name: "list_expenses", input: {} },
];

/* 给模型看的材料里每一块叫什么。说明文字沿用 tools.ts 里对应工具的描述，不额外给提示。 */
const LABEL = {
  get_trip: "trip",
  check_integrity: "integrity_issues",
  find_duplicates: "duplicate_candidates",
  category_stats: "category_stats",
  get_balances: "balances",
  list_expenses: "expenses",
} as const;

/** 纯函数：把固定的几项检查跑一遍，返回给模型看的材料和可展示的轨迹。不调模型。 */
export function runChecks(snap: LedgerSnapshot): { material: Record<string, unknown>; trace: TraceStep[] } {
  const material: Record<string, unknown> = {};
  const trace: TraceStep[] = [];
  for (const c of CHECKS) {
    const t0 = Date.now();
    const output = toolImpl[c.name]({ snap }, c.input);
    material[LABEL[c.name]] = output;
    trace.push({ kind: "tool", name: c.name, input: c.input, output, ms: Date.now() - t0 });
  }
  return { material, trace };
}

function systemPrompt(snap: LedgerSnapshot): string {
  return [
    "你负责核查一本旅行 AA 账本。目标：找出会导致结算错误的账目问题，并给出可供用户一键确认的修改建议。",
    "",
    "你会收到一份 JSON，里面是代码已经跑完的检查结果和全部账目：",
    "- trip：旅行基本信息：成员、日期范围、币种、账目条数。",
    "- integrity_issues：规则体检：参与人为空、付款人不在参与人内、非成员、待补全、零金额、低置信度、日期超出旅行范围。",
    "- duplicate_candidates：金额相同且时间相近（120 分钟内）的成对账目，疑似重复录入。",
    "- category_stats：各分类的笔数、合计、最大值、均值（已折算成本币），用于发现金额离群。",
    "- balances：当前每人已付/应摊/净额与最少转账方案。",
    "- expenses：全部账目摘要，含原始证据文本 evidence。",
    "",
    "要求：",
    "1. 你不能修改账本；所有修改都以 proposed_change 的形式给出，由用户确认。",
    ...JUDGE_RULES.map((r, i) => `${i + 2}. ${r}`),
    `${JUDGE_RULES.length + 2}. 没有发现问题时 findings 返回空数组。`,
    "",
    ...TRIP_CONTEXT(snap),
  ]
    .filter(Boolean)
    .join("\n");
}

/** 一次调用要装下全部思考和结论，给得比 Agent 每轮的 8000 宽一些 */
const MAX_TOKENS = 12000;

export async function reconcilePipeline(snap: LedgerSnapshot, opts: { model?: string } = {}): Promise<ReconcileResult> {
  const { material, trace } = runChecks(snap);
  const usageDetail: UsageDetail = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let servedModel: string | undefined;
  // 输出结构和 Agent 版的提交工具用同一份 JSON Schema（字段说明、枚举都一样），自己解析和校验：
  // SDK 的 parse() 在输出被截断或结构不对时抛的是英文原始错误。结构不合法时重试一次。
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client().messages.create({
      model: opts.model ?? RECONCILE_MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: systemPrompt(snap), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `请核查这本账（共 ${snap.expenses.length} 笔）。检查结果和全部账目如下：\n${JSON.stringify(material)}` }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SUBMIT_TOOL.input_schema as Record<string, unknown> } },
    });
    servedModel = res.model;
    usageDetail.input += res.usage.input_tokens;
    usageDetail.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
    usageDetail.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    usageDetail.output += res.usage.output_tokens;
    if (res.stop_reason === "refusal") throw new Error("模型拒绝了该请求");
    if (res.stop_reason === "max_tokens") throw new Error("这本账要说的太多，输出被截断了。先处理掉一部分问题再核一次");
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const out = FindingsSchema.safeParse(json);
    if (!out.success) continue;
    return {
      ok: true,
      summary: out.data.summary,
      findings: normalize(snap, out.data.findings),
      trace,
      usage: { input: usageDetail.input + usageDetail.cacheWrite + usageDetail.cacheRead, output: usageDetail.output, turns: attempt + 1 },
      mode: "pipeline",
      model: servedModel,
      usageDetail,
    };
  }
  throw new Error("模型输出不符合结构，请重试");
}

/** 核账入口：按 TRIPSPLIT_RECONCILE_MODE（或显式传入的 mode）选固定流程或 Agent 循环。 */
export function runReconcile(snap: LedgerSnapshot, opts: { mode?: ReconcileMode; model?: string } = {}): Promise<ReconcileResult> {
  return (opts.mode ?? RECONCILE_MODE) === "pipeline" ? reconcilePipeline(snap, opts) : reconcile(snap, opts);
}
