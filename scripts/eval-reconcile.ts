/**
 * 核账对照评测：同一批埋了问题的账本（eval/reconcile-cases.ts），分别用固定流程（pipeline）和 Agent 循环（agent）跑，
 * 比查全、误报、修改建议对不对、耗时、成本。
 *
 * 运行：
 *   npx tsx scripts/eval-reconcile.ts --selftest                       只做自检：账本合法、标注自洽、评分器对已知好坏答案打分正确，不调模型
 *   npx tsx scripts/eval-reconcile.ts --rules-only [--label v2]        纯规则基线（不调模型），写 rules-only.json 或 rules-only-<标签>.json
 *   npx tsx scripts/eval-reconcile.ts --mode pipeline --model claude-sonnet-5-5 [--cases c01,c02] [--reps 1] [--label 说明] [--concurrency 3]
 *   npx tsx scripts/eval-reconcile.ts --mode agent    --model claude-opus-5-5
 * 读取 .env.local 里的 ANTHROPIC_API_KEY。结果写到 eval/results/reconcile/<时间>-<mode>-<model>[-label].json（不入库），
 * 里面带账本内容的哈希；汇总脚本（eval-reconcile-report.ts）只汇总和当前账本同一版的结果。
 *
 * 评分口径（2026-11-13 复查后改的）：
 *  - 一条 finding 算查出某个问题：它列的账目至少一半落在这个问题的账目里。列了一大堆账目、其中碰巧有一笔是问题的，不算（fp-09）。
 *  - 误报：没有查出任何问题的 finding；或者列了 3 个以上不属于任何问题的账目的 finding（哪怕它同时说中了一个）。
 *  - 报了干扰项：一条误报的账目全部落在同一个干扰项里才算，按干扰项类型记。
 *  - 不该给修改却给了：没有依据能确定新值的问题（truth.noFix），查出它的 finding 带了 proposed_change。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DECOY_KINDS, DECOY_LABEL, casesHash, reconcileCases, type DecoyKind, type Fix, type ReconcileCase, type Truth } from "../eval/reconcile-cases";
import type { Finding, ReconcileResult, UsageDetail } from "../lib/agent/run";
import { toolImpl } from "../lib/agent/tools";
import { LedgerSnapshotSchema, type Expense } from "../lib/types";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

/* 结果文件里每条 finding 存这些：evidence / suggestion 是模型写的原文，复查误报时要看（fp-06） */
type F = Pick<Finding, "severity" | "type" | "title" | "expense_ids" | "proposed_change"> & Partial<Pick<Finding, "evidence" | "suggestion">>;

/* 模型报的类型和埋的问题算不算对得上（主口径只看账目 id；这张表用于更严的副口径）。 */
const TYPE_OK: Record<string, string[]> = {
  duplicate: ["duplicate"],
  participants: ["participants"],
  payer: ["payer", "participants"],
  amount_outlier: ["amount_outlier", "other"],
  pending: ["pending", "amount_outlier"],
  date: ["date"],
  other: ["other", "participants", "payer"],
};
const sameSet = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && [...a].sort().join() === [...b].sort().join();
const uniq = (xs: string[]) => [...new Set(xs)];

type Patch = NonNullable<NonNullable<F["proposed_change"]>["patch"]>;
function patchOk(fix: Extract<Fix, { action: "update" }>, patch: Patch): boolean {
  if (fix.amount !== undefined && !(patch.amount !== undefined && Math.abs(patch.amount - fix.amount) <= 0.011)) return false;
  if (fix.payerId !== undefined && patch.payerId !== fix.payerId) return false;
  if (fix.participantIds !== undefined && !sameSet(patch.participantIds, fix.participantIds)) return false;
  if (fix.treat !== undefined && patch.treat !== fix.treat) return false;
  return true;
}
/** fs：查出这个问题的那些 finding。删除类看删的是不是该删的那条；修改类看标准修改里的每个字段。 */
function fixOk(fix: Fix, fs: F[]): boolean {
  if (fix.action === "delete") return fs.some((f) => f.proposed_change?.action === "delete" && fix.anyOf.includes(f.proposed_change.expenseId));
  const patches = fs.flatMap((f) => (f.proposed_change?.action === "update" && f.proposed_change.expenseId === fix.id && f.proposed_change.patch ? [f.proposed_change.patch] : []));
  if (patches.some((p) => patchOk(fix, p))) return true;
  // 同一笔账的修改拆在几条 finding 里（比如一条去掉请客、一条补参与人），合起来对也算对
  return patches.length > 1 && patchOk(fix, Object.assign({}, ...patches) as Patch);
}

/** 一条 finding 里不属于任何问题的账目超过这个数，另记一条误报。 */
const STRAY_MAX = 2;
/** 这条 finding 算不算在说这个问题：它列的账目至少一半落在这个问题的账目里。 */
function fits(ids: string[], t: Truth): boolean {
  const k = ids.filter((id) => t.ids.includes(id)).length;
  return k > 0 && k * 2 >= ids.length;
}

export function score(c: ReconcileCase, findings: F[]) {
  const truthIds = new Set(c.truth.flatMap((t) => t.ids));
  const fs = findings.map((f) => {
    const ids = uniq(f.expense_ids);
    return { f, ids, hit: c.truth.filter((t) => fits(ids, t)), stray: ids.filter((id) => !truthIds.has(id)).length };
  });
  const truths = c.truth.map((t) => {
    const mine = fs.filter((x) => x.hit.includes(t)).map((x) => x.f);
    return {
      key: t.key,
      kind: t.kind,
      ids: t.ids,
      caught: mine.length > 0,
      typeOk: mine.some((f) => (TYPE_OK[t.type] ?? [t.type]).includes(f.type)),
      hasFix: !!t.fix,
      fixOk: t.fix ? fixOk(t.fix, mine) : null,
      noFix: !!t.noFix,
      /** 只对 noFix 的问题有值：查出它的 finding 里有没有带修改建议 */
      fixGiven: t.noFix ? mine.some((f) => !!f.proposed_change) : null,
    };
  });
  const fp = fs
    .filter((x) => x.hit.length === 0 || x.stray > STRAY_MAX)
    .map((x) => {
      const decoy = x.ids.length ? c.decoys.find((d) => x.ids.every((id) => d.ids.includes(id))) : undefined;
      return {
        severity: x.f.severity,
        type: x.f.type,
        title: x.f.title,
        expense_ids: x.f.expense_ids,
        /** none = 一个问题都没碰到；loose = 碰到了问题的账目但不到一半；spray = 说中了一个问题，但另外列了一堆不相干的账目 */
        why: (x.hit.length ? "spray" : x.ids.some((id) => truthIds.has(id)) ? "loose" : "none") as "none" | "loose" | "spray",
        decoy: (decoy?.kind ?? null) as DecoyKind | null,
        decoyKey: decoy ? `${decoy.kind}:${decoy.ids.join("+")}` : null,
        withChange: !!x.f.proposed_change,
      };
    });
  return { truths, fp };
}

/** 模型把原始标记写进了文字里（比如 summary 末尾带着 </summary> 和 <parameter name="findings">），这段会原样显示给用户（fp-13）。 */
const RAW_MARKUP = /<\/?\s*(?:antml:)?(?:summary|parameter|invoke|function_calls|findings|tool_use|tool_call)\b/i;
export const hasRawMarkup = (summary: string, findings: F[]) => [summary, ...findings.flatMap((f) => [f.title, f.evidence ?? "", f.suggestion ?? ""])].some((s) => RAW_MARKUP.test(s));

/** 一次成功的运行在结果文件里存成什么样。每条 finding 连同模型写的 evidence、suggestion 原文一起存（fp-06）。 */
export function rowOf(c: ReconcileCase, rep: number, r: ReconcileResult, ms: number, costOf: (u: UsageDetail) => number) {
  const usageDetail = r.usageDetail ?? { input: r.usage.input, cacheWrite: 0, cacheRead: 0, output: r.usage.output };
  const findings: F[] = r.findings.map((f) => ({ severity: f.severity, type: f.type, title: f.title, expense_ids: f.expense_ids, evidence: f.evidence, suggestion: f.suggestion, proposed_change: f.proposed_change }));
  const toolCalls = r.trace.flatMap((t) => (t.kind === "tool" ? [{ name: t.name, input: t.input }] : []));
  return { case: c.id, rep, size: c.size, expenses: c.snap.expenses.length, ok: true as const, ms, turns: r.usage.turns, toolCalls, servedModel: r.model, usageDetail, cost: costOf(usageDetail), summary: r.summary, rawMarkup: hasRawMarkup(r.summary, findings), findings, score: score(c, findings) };
}

/* ---------- 规则检查 ---------- */
function ruleFlags(c: ReconcileCase) {
  const snap = c.snap;
  const issues = toolImpl.check_integrity({ snap }, {}) as { id: string; problem: string }[];
  const dups = toolImpl.find_duplicates({ snap }, { window_minutes: 120, amount_tolerance: 0 }) as { a: string; b: string }[];
  return { issues, dups, ids: new Set([...issues.map((i) => i.id), ...dups.flatMap((d) => [d.a, d.b])]) };
}
/** 纯规则基线：不调模型，把规则体检和查重的命中原样当成发现。回答「没有大模型怎么办」。 */
export function rulesOnlyFindings(c: ReconcileCase): F[] {
  const { issues, dups } = ruleFlags(c);
  const map: Record<string, F["type"]> = { participants_empty: "participants", payer_not_member: "payer", participant_not_member: "participants", payer_not_in_participants: "payer", pending_incomplete: "pending", amount_zero: "pending", outside_trip_dates: "date" };
  const out: F[] = [];
  const seen = new Set<string>();
  for (const i of issues) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    out.push({ severity: "medium", type: map[i.problem] ?? "other", title: i.problem, expense_ids: [i.id], proposed_change: null });
  }
  for (const d of dups) out.push({ severity: "high", type: "duplicate", title: "duplicate", expense_ids: [d.a, d.b], proposed_change: { action: "delete", expenseId: d.b, reason: "" } });
  return out;
}

/* ---------- 自检 ---------- */
const majority = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0][0];
const minutesApart = (a: Expense, b: Expense) => Math.abs(new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()) / 60000;

/**
 * 把一笔账的原话和账面逐项对一遍（金额、付款人、参与人、请客、分摊、币种），返回对不上的地方。
 * 这是独立于生成器写的一遍「读原话」：背景和干扰项应该一处矛盾都没有，证据矛盾类的问题至少有一处矛盾。
 */
function evidenceIssues(c: ReconcileCase, e: Expense): string[] {
  const out: string[] = [];
  const text = e.evidence?.text;
  if (!text) return out;
  const members = c.snap.trip.members;
  const all = members.length;
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const named = (s: string) => members.filter((m) => s.includes(m.name)).map((m) => m.id);
  const spoken = e.evidence?.kind === "text" || e.evidence?.kind === "voice";
  const hasNumber = (n: number) => new RegExp(`(?<![\\d.])${n}(?![\\d.])`).test(text);
  if (spoken) {
    if (e.status === "confirmed" && !hasNumber(e.amount)) out.push("原话里的金额和账面不一样");
    if (!text.includes(nameOf(e.payerId))) out.push("原话里付钱的不是账面上的付款人");
    const home = majority(c.snap.expenses.map((x) => x.currency));
    const unit = e.currency === "JPY" ? "日元" : e.currency === "THB" ? "泰铢" : "人民币";
    for (const u of ["日元", "泰铢", "人民币"]) if (text.includes(u) && u !== unit) out.push("原话里的币种和账面不一样");
    if (home !== "CNY" && e.status === "confirmed" && !text.includes(unit)) out.push("外币行程里原话没带币种");
  } else if (e.amount > 0 && hasNumber(e.amount) && !new RegExp(`(?<![\\d.])${e.amount}(?![\\d.])`).test(e.note)) out.push("截图证据文本里带了金额（产品里存的是附言或备注，不会有）");
  if (text.includes("只有") && !sameSet(named(text.slice(text.indexOf("只有"))), e.participantIds)) out.push("原话说只有某两个人，账面参与人不是这两个人");
  if ((text.includes("大家一起") || text.includes(`${all} 个人`)) && (e.participantIds.length !== all || e.treat)) out.push("原话说大家一起，账面参与人不是全员");
  if (text.includes("请大家") !== !!e.treat && (spoken || text.includes("请大家"))) out.push("原话和账面在是不是请客上不一致");
  if (text.includes("先垫") && (e.treat || e.participantIds.length !== all)) out.push("原话说先垫着回头平摊，账面不是全员均摊");
  if (text.includes("两份") !== !!e.split && (spoken || text.includes("两份"))) out.push("原话和账面在分摊份数上不一致");
  const adv = text.match(/帮(.+?)垫付的/);
  if (adv && (e.treat || e.participantIds.includes(e.payerId) || !sameSet(named(adv[1]), e.participantIds))) out.push("原话说替别人垫付，账面参与人对不上");
  if (spoken && !e.treat && e.participantIds.length > 0 && e.participantIds.length < all && !text.includes("只有") && !adv) out.push("账面参与人不是全员，原话没这么说");
  return out;
}

/**
 * 表面特征基线：不比对任何语义，只看 source / confidence 的取值、备注和原话里的固定字眼、同名同额这类表面特征去猜。
 * 第一版账本里这样能零误报猜中 46/51（非规则类 23/28）。这里要求：零误报能猜中的非规则类问题不超过一成。
 */
function surfaceBaseline(cases: ReconcileCase[], fail: (msg: string) => void) {
  type Unit = { c: ReconcileCase; ids: string[] };
  const single = (name: string, test: (e: Expense, c: ReconcileCase) => boolean) => ({ name, units: (c: ReconcileCase): Unit[] => c.snap.expenses.filter((e) => test(e, c)).map((e) => ({ c, ids: [e.id] })) });
  const pairs = (name: string, test: (a: Expense, b: Expense) => boolean) => ({
    name,
    units: (c: ReconcileCase): Unit[] => {
      const out: Unit[] = [];
      const es = c.snap.expenses;
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if (test(es[i], es[j])) out.push({ c, ids: [es[i].id, es[j].id] });
      return out;
    },
  });
  const words = (e: Expense) => `${e.note}\n${e.evidence?.text ?? ""}`;
  const day = (e: Expense) => e.occurredAt.slice(0, 10);
  const PHRASES = ["只有", "两个人", "大家一起", "个人", "不用 A", "请大家", "先垫", "回头", "平摊", "垫付", "差不多", "两份", "买的", "付了", "付的", "日元", "泰铢", "人民币", "携程", "提前", "出发前", "上山", "下山", "两辆", "金额回头补"];
  // source + confidence 的取值：哪些取值的账目全是问题（待补全的低置信度除外，规则本来就查它）
  const valueOf = (e: Expense) => `${e.source}/${e.confidence}`;
  const truthIdsOf = (c: ReconcileCase) => new Set(c.truth.flatMap((t) => t.ids));
  const byValue = new Map<string, { all: number; truth: number }>();
  for (const c of cases) {
    const ti = truthIdsOf(c);
    for (const e of c.snap.expenses) {
      if (e.status === "pending") continue;
      const v = byValue.get(valueOf(e)) ?? { all: 0, truth: 0 };
      v.all++;
      if (ti.has(e.id)) v.truth++;
      byValue.set(valueOf(e), v);
    }
  }
  const features = [
    single("source + confidence 取值只出现在问题里", (e) => e.status !== "pending" && byValue.get(valueOf(e))?.all === byValue.get(valueOf(e))?.truth),
    ...PHRASES.map((p) => single(`字眼「${p}」`, (e) => words(e).includes(p))),
    single("没有原话", (e) => !e.evidence?.text),
    single("参与人不是全员", (e, c) => e.participantIds.length > 0 && e.participantIds.length < c.snap.trip.members.length),
    single("标了请客", (e) => !!e.treat),
    single("带分摊规则", (e) => !!e.split),
    single("币种和多数账目不同", (e, c) => e.currency !== majority(c.snap.expenses.map((x) => x.currency))),
    single("金额带小数", (e) => !Number.isInteger(e.amount)),
    single("早上 8 点前", (e) => e.occurredAt.slice(11, 13) < "08"),
    pairs("同名同额（不限间隔）", (a, b) => a.note === b.note && a.amount === b.amount),
    pairs("同日同名（不限金额）", (a, b) => a.note === b.note && day(a) === day(b)),
    pairs("同名（不限日期金额）", (a, b) => a.note === b.note),
    pairs("同日同额", (a, b) => a.amount === b.amount && day(a) === day(b)),
    pairs("同额（不限日期）", (a, b) => a.amount === b.amount),
  ];
  const nonRule = cases.flatMap((c) => c.truth.filter((t) => t.kind !== "rule").map((t) => ({ c, t })));
  const rows = features.map((f) => {
    const units = cases.flatMap((c) => f.units(c));
    const hits = nonRule.filter(({ c, t }) => units.some((u) => u.c === c && u.ids.some((id) => t.ids.includes(id))));
    const fp = units.filter((u) => !u.ids.some((id) => truthIdsOf(u.c).has(id))).length;
    return { name: f.name, hits, fp };
  });
  console.log("表面特征基线（不比对语义；命中 = 猜中的非规则类问题数，误报 = 特征落在正常账目上的次数）：");
  for (const r of rows.filter((x) => x.hits.length).sort((a, b) => b.hits.length / (b.hits.length + b.fp) - a.hits.length / (a.hits.length + a.fp)))
    console.log(`    ${r.name}：命中 ${r.hits.length}，误报 ${r.fp}`);
  const free = new Set(rows.filter((r) => r.fp === 0).flatMap((r) => r.hits.map((h) => `${h.c.id}:${h.t.key}:${h.t.ids.join()}`)));
  const cheap = rows.filter((r) => r.hits.length > 0 && r.hits.length >= r.fp);
  const cheapHits = new Set(cheap.flatMap((r) => r.hits.map((h) => `${h.c.id}:${h.t.key}:${h.t.ids.join()}`)));
  const limit = Math.floor(nonRule.length * 0.1);
  console.log(`  表面特征基线：零误报能猜中非规则类 ${free.size}/${nonRule.length}（第一版 23/28；上限 ${limit}）；放宽到「命中不少于误报」的特征，能猜中 ${cheapHits.size}/${nonRule.length}，搭上误报 ${cheap.reduce((a, r) => a + r.fp, 0)}`);
  if (free.size > limit) fail(`表面特征零误报就能猜中 ${free.size} 处非规则类问题，超过上限 ${limit}`);
  if (cheapHits.size > nonRule.length * 0.25) fail(`命中不少于误报的表面特征合计能猜中 ${cheapHits.size} 处非规则类问题，超过四分之一`);
}

export function selftest(cases: ReconcileCase[], rebuild: () => ReconcileCase[] = reconcileCases): boolean {
  let ok = true;
  const fail = (msg: string) => { ok = false; console.log("  ✗ " + msg); };
  const kinds = (c: ReconcileCase) => DECOY_KINDS.filter((k) => c.decoys.some((d) => d.kind === k)).map((k) => `${k}×${c.decoys.filter((d) => d.kind === k).length}`).join(" ");
  console.log("账本 | 规模 | 账目 | 埋的问题（规则/证据矛盾/判断）| 干扰项（按类型）");
  for (const c of cases) {
    const parsed = LedgerSnapshotSchema.safeParse(c.snap);
    if (!parsed.success) fail(`${c.id} 账本结构不合法: ${parsed.error.message.slice(0, 120)}`);
    const k = (kind: string) => c.truth.filter((t) => t.kind === kind).length;
    console.log(`${c.id} | ${c.size} | ${c.snap.expenses.length} | ${c.truth.length}（${k("rule")}/${k("evidence")}/${k("judgment")}）| ${c.decoys.length}（${kinds(c)}）  ${c.title}`);
    const es = c.snap.expenses;
    const byId = new Map(es.map((e) => [e.id, e]));
    const all = c.snap.trip.members.length;
    const home = majority(es.map((e) => e.currency));
    const { issues, dups, ids } = ruleFlags(c);
    const truthIds = new Set(c.truth.flatMap((t) => t.ids));
    const decoyIds = new Set(c.decoys.flatMap((d) => d.ids));
    const decoyOf = (id: string) => c.decoys.find((d) => d.ids.includes(id));

    /* 标注和账目对得上 */
    for (const t of c.truth) for (const id of t.ids) if (!byId.has(id)) fail(`${c.id} ${t.key} 引用了不存在的账目 ${id}`);
    for (const d of c.decoys) for (const id of d.ids) if (!byId.has(id)) fail(`${c.id} 干扰项 ${d.kind} 引用了不存在的账目 ${id}`);
    const overlap = [...truthIds].filter((id) => decoyIds.has(id));
    if (overlap.length) fail(`${c.id} 同一笔账既是问题又是干扰项: ${overlap.join(",")}`);
    if (c.decoys.flatMap((d) => d.ids).length !== decoyIds.size) fail(`${c.id} 同一笔账登记在两个干扰项里`);
    if (c.truth.flatMap((t) => t.ids).length !== truthIds.size) fail(`${c.id} 同一笔账登记在两个问题里`);
    for (const t of c.truth) if (t.fix && t.noFix) fail(`${c.id} ${t.key} 既有标准修改又标了不该给修改`);

    /* kind 的定义：rule 必须被规则命中，其余不得被规则命中；规则命中的正常账目都要登记成干扰项 */
    for (const t of c.truth) {
      const flagged = t.ids.some((id) => ids.has(id));
      if (t.kind === "rule" && !flagged) fail(`${c.id} ${t.key} 标成 rule，但规则检查没命中`);
      if (t.kind !== "rule" && flagged) fail(`${c.id} ${t.key} 标成 ${t.kind}，但规则检查命中了 ${t.ids.join(",")}`);
    }
    for (const id of ids) if (!truthIds.has(id) && !decoyIds.has(id)) fail(`${c.id} 背景账目 ${id} 被规则检查命中，背景不干净`);
    for (const i of issues) if (i.problem.startsWith("low_confidence") && byId.get(i.id)?.status !== "pending") fail(`${c.id} ${i.id} 触发了低置信度规则（只有待补全的可以）`);
    for (const d of dups) {
      const same = c.truth.some((t) => t.ids.includes(d.a) && t.ids.includes(d.b)) || c.decoys.some((x) => x.ids.includes(d.a) && x.ids.includes(d.b));
      if (!same) fail(`${c.id} 查重配出了一对不属于同一个问题或干扰项的账目 ${d.a},${d.b}`);
    }
    const ruleHit: DecoyKind[] = ["shuttle", "twoCars", "pretrip", "advance"];
    for (const d of c.decoys) {
      const flagged = d.ids.some((id) => ids.has(id));
      if (ruleHit.includes(d.kind) !== flagged) fail(`${c.id} 干扰项 ${d.kind}（${d.ids.join(",")}）${flagged ? "被规则命中了，这一类不该被命中" : "没被规则命中，这一类应该被命中"}`);
    }

    /* gen-13：时间不重；往返的去和回之间不夹别的账目 */
    if (new Set(es.map((e) => e.occurredAt)).size !== es.length) fail(`${c.id} 有两笔账落在同一分钟`);
    for (const d of c.decoys.filter((x) => x.kind === "shuttle")) {
      const [a, b] = d.ids.map((id) => byId.get(id)!);
      const between = es.filter((e) => e.occurredAt > a.occurredAt && e.occurredAt < b.occurredAt);
      if (between.length) fail(`${c.id} 往返 ${d.ids.join(",")} 之间夹了别的账目 ${between.map((e) => e.id).join(",")}`);
    }
    /* gen-05：同一天内金额不撞，除非是登记过的同一个问题或干扰项（跨天允许自然撞数） */
    for (let i = 0; i < es.length; i++)
      for (let j = i + 1; j < es.length; j++) {
        if (es[i].amount !== es[j].amount || es[i].occurredAt.slice(0, 10) !== es[j].occurredAt.slice(0, 10)) continue;
        const same = c.truth.some((t) => t.ids.includes(es[i].id) && t.ids.includes(es[j].id)) || c.decoys.some((x) => x.ids.includes(es[i].id) && x.ids.includes(es[j].id));
        if (!same) fail(`${c.id} ${es[i].id} 和 ${es[j].id} 同一天金额相同（${es[i].amount}），又不是登记过的一对`);
      }
    /* gen-01：备注不重名，除非整组都登记在同一个问题或同一个干扰项里 */
    const byNote = new Map<string, string[]>();
    for (const e of es) byNote.set(e.note, [...(byNote.get(e.note) ?? []), e.id]);
    for (const [note, group] of byNote) {
      if (group.length < 2) continue;
      const covered = c.truth.some((t) => group.every((id) => t.ids.includes(id))) || c.decoys.some((d) => group.every((id) => d.ids.includes(id)));
      if (!covered) fail(`${c.id} 备注「${note}」重名（${group.join(",")}），又没登记成重复类问题或干扰项`);
    }
    /* gen-02：每条规则带日期和金额，只对得上一笔账，而且就是登记的那笔 */
    const rules = c.snap.trip.rules ?? [];
    const ruleDecoys = c.decoys.filter((d) => d.kind === "rule");
    if (rules.length !== ruleDecoys.length || ruleDecoys.some((d) => !d.rule || !rules.includes(d.rule))) fail(`${c.id} 规则和登记的规则类干扰项对不上`);
    for (const rule of rules) {
      const dateText = (e: Expense) => `${Number(e.occurredAt.slice(5, 7))} 月 ${Number(e.occurredAt.slice(8, 10))} 日`;
      const match = es.filter((e) => rule.includes(e.note) && rule.includes(dateText(e)) && new RegExp(`（${e.amount}(?!\\d)`).test(rule));
      const target = ruleDecoys.find((d) => d.rule === rule)?.ids[0];
      if (match.length !== 1 || match[0].id !== target) fail(`${c.id} 规则「${rule}」对得上 ${match.length} 笔账（应该正好 1 笔，且是 ${target}）`);
      else if (es.filter((e) => e.note === match[0].note).length !== 1) fail(`${c.id} 规则「${rule}」指的备注在账本里不止一笔`);
    }

    /* gen-06 / gen-07：背景和干扰项的原话和账面没有矛盾；证据矛盾类至少有一处矛盾；看着特别的字段都有登记 */
    for (const e of es) {
      const t = c.truth.find((x) => x.ids.includes(e.id));
      const problems = evidenceIssues(c, e);
      if (!t && problems.length) fail(`${c.id} ${e.id} 不是问题，但原话和账面对不上：${problems.join("；")}（${e.evidence?.text}）`);
      if (!Number.isInteger(e.amount)) fail(`${c.id} ${e.id} 金额带小数`);
      if (t) continue;
      const kind = decoyOf(e.id)?.kind;
      if (e.treat && kind !== "treat") fail(`${c.id} ${e.id} 标了请客，没登记成干扰项`);
      if (e.split && kind !== "shares") fail(`${c.id} ${e.id} 带分摊规则，没登记成干扰项`);
      if (!e.treat && e.participantIds.length !== all && !["twoPerson", "rule", "advance"].includes(kind ?? "")) fail(`${c.id} ${e.id} 参与人不是全员，没登记成干扰项`);
      if (e.currency !== home && !["lodging", "pretrip", "cnyOrder"].includes(kind ?? "")) fail(`${c.id} ${e.id} 币种和多数账目不同，没登记成干扰项`);
      if (e.category === "住宿" && kind !== "lodging") fail(`${c.id} ${e.id} 是住宿，没登记成干扰项（gen-14）`);
    }
    for (const t of c.truth.filter((x) => x.kind === "evidence")) if (!t.ids.some((id) => evidenceIssues(c, byId.get(id)!).length)) fail(`${c.id} ${t.key} 标成证据矛盾，但原话和账面逐项对下来没有矛盾`);

    /* 各类埋点自己的约束 */
    const step = home === "JPY" ? 10 : home === "THB" ? 5 : 1;
    const roundness = (a: number) => (a % (100 * step) === 0 ? 3 : a % (50 * step) === 0 ? 2 : a % (10 * step) === 0 ? 1 : 0);
    for (const t of c.truth) {
      const [a, b] = t.ids.map((id) => byId.get(id)!);
      if (t.key === "dupExact" && all >= 5 && a.category === "交通") fail(`${c.id} dupExact 选了五人以上行程里的交通费（gen-11）`);
      if (t.key === "dupExact" && !(a.amount === b.amount && minutesApart(a, b) <= 120)) fail(`${c.id} dupExact 不是同额且在 120 分钟内`);
      if (t.key === "dupNear" && !(a.amount !== b.amount && roundness(b.amount) > roundness(a.amount))) fail(`${c.id} dupNear 的约数 ${b.amount} 不比原数 ${a.amount} 更整（gen-10）`);
      if ((t.key === "dupFar" || t.key === "dupLate") && !(a.amount === b.amount && a.note === b.note && minutesApart(a, b) > 120)) fail(`${c.id} ${t.key} 不是同名同额且隔了 120 分钟以上`);
    }
    /* gen-12：住宿 = 每间每晚（整十）× 晚数 × 间数 */
    for (const e of es.filter((x) => x.category === "住宿")) {
      const m = e.note.match(/(\d+) 晚 (\d+) 间/);
      if (!m || Number(m[2]) !== Math.ceil(all / 2) || e.amount % (Number(m[1]) * Number(m[2]) * 10) !== 0) fail(`${c.id} ${e.id} 住宿金额 ${e.amount} 和「${e.note}」的晚数、间数对不上`);
    }
  }

  /* 整体：12 本、两本干净账本、出发前预订至少 5 本（gen-15） */
  const T = cases.flatMap((c) => c.truth);
  const D = cases.flatMap((c) => c.decoys);
  if (cases.length !== 12) fail(`账本数是 ${cases.length}，应该是 12`);
  if (cases.filter((c) => c.truth.length === 0).length !== 2) fail("干净账本应该正好两本");
  if (cases.filter((c) => c.decoys.some((d) => d.kind === "pretrip")).length < 5) fail("出发前预订的干扰项不到 5 本账");
  console.log(`合计：账目 ${cases.reduce((a, c) => a + c.snap.expenses.length, 0)} 笔；问题 ${T.length} 处（规则 ${T.filter((t) => t.kind === "rule").length} / 证据矛盾 ${T.filter((t) => t.kind === "evidence").length} / 判断 ${T.filter((t) => t.kind === "judgment").length}），其中有标准修改的 ${T.filter((t) => t.fix).length}、不该给修改的 ${T.filter((t) => t.noFix).length}、不评修改的 ${T.filter((t) => !t.fix && !t.noFix).length}`);
  const keys = [...new Set(T.map((t) => t.key))];
  console.log(`      问题按类型：${(["rule", "evidence", "judgment"] as const).map((kind) => `${kind}（${keys.filter((k) => T.some((t) => t.key === k && t.kind === kind)).map((k) => `${k} ${T.filter((t) => t.key === k).length}`).join("，")}）`).join("；")}`);
  console.log(`      干扰项 ${D.length} 处：${DECOY_KINDS.map((k) => `${DECOY_LABEL[k]} ${D.filter((d) => d.kind === k).length}`).join("；")}`);
  console.log(`      账本哈希 ${casesHash(cases)}`);
  if (casesHash(cases) !== casesHash(rebuild())) fail("同样的代码生成了两份不一样的账本（生成器不是确定性的）");

  /* gen-03：除了待补全，任何 source + confidence 取值不能只出现在问题里，也不能只出现在干扰项里 */
  const byValue = new Map<string, { all: number; truth: number; decoy: number }>();
  for (const c of cases) {
    const ti = new Set(c.truth.flatMap((t) => t.ids));
    const di = new Set(c.decoys.flatMap((d) => d.ids));
    for (const e of c.snap.expenses) {
      if (e.status === "pending") continue;
      const key = `${e.source}/${e.confidence}`;
      const v = byValue.get(key) ?? { all: 0, truth: 0, decoy: 0 };
      v.all++;
      if (ti.has(e.id)) v.truth++;
      if (di.has(e.id)) v.decoy++;
      byValue.set(key, v);
    }
  }
  for (const [key, v] of byValue) {
    if (v.truth === v.all) fail(`source/confidence 取值 ${key} 只出现在问题里（${v.all} 笔）`);
    if (v.decoy === v.all) fail(`source/confidence 取值 ${key} 只出现在干扰项里（${v.all} 笔）`);
  }
  const bySource = (s: string) => { const vs = [...byValue].filter(([k]) => k.startsWith(s + "/")); return `${s} ${vs.length} 个取值 ${vs.reduce((a, [, v]) => a + v.all, 0)} 笔（问题 ${vs.reduce((a, [, v]) => a + v.truth, 0)}、干扰项 ${vs.reduce((a, [, v]) => a + v.decoy, 0)}）`; };
  console.log(`      来源和置信度：${["manual", "text", "voice", "image"].map(bySource).join("；")}`);

  /* 评分器对已知答案 */
  const agg = (name: string, make: (c: ReconcileCase) => F[]) => {
    let caught = 0, total = 0, fp = 0, fixes = 0, fixOkN = 0, fixGiven = 0, decoyFp = 0;
    for (const c of cases) {
      const s = score(c, make(c));
      total += s.truths.length; caught += s.truths.filter((t) => t.caught).length; fp += s.fp.length;
      fixes += s.truths.filter((t) => t.hasFix).length; fixOkN += s.truths.filter((t) => t.fixOk).length;
      fixGiven += s.truths.filter((t) => t.fixGiven).length; decoyFp += s.fp.filter((f) => f.decoy).length;
    }
    console.log(`  ${name}: 查出 ${caught}/${total}，误报 ${fp}（其中报了干扰项 ${decoyFp}），修改建议对 ${fixOkN}/${fixes}，不该给修改却给了 ${fixGiven}`);
    return { caught, total, fp, fixes, fixOkN, fixGiven, decoyFp };
  };
  const change = (t: Truth): F["proposed_change"] => (t.fix ? (t.fix.action === "delete" ? { action: "delete", expenseId: t.fix.anyOf[0], reason: "" } : { action: "update", expenseId: t.fix.id, patch: { amount: t.fix.amount, payerId: t.fix.payerId, participantIds: t.fix.participantIds, treat: t.fix.treat }, reason: "" }) : null);
  const answer = (t: Truth, pc: F["proposed_change"]): F => ({ severity: "high", type: (TYPE_OK[t.type] ?? [t.type])[0] as F["type"], title: t.key, expense_ids: t.ids, proposed_change: pc });
  console.log("评分器自检：");
  const oracle = agg("标准答案", (c) => c.truth.map((t) => answer(t, change(t))));
  if (oracle.caught !== oracle.total || oracle.fp !== 0 || oracle.fixOkN !== oracle.fixes || oracle.fixGiven !== 0) fail("标准答案没有拿到满分");
  const empty = agg("空答案", () => []);
  if (empty.caught !== 0 || empty.fp !== 0) fail("空答案不是零分");
  const forced = agg("标准答案，但每条都硬给一个修改", (c) => c.truth.map((t) => answer(t, change(t) ?? { action: "update", expenseId: t.ids[0], patch: { amount: 1 }, reason: "" })));
  if (forced.fixGiven !== T.filter((t) => t.noFix).length) fail("「不该给修改却给了」没有数对");
  const all = agg("每笔都报（一笔一条）", (c) => c.snap.expenses.map((e) => ({ severity: "low", type: "other", title: "x", expense_ids: [e.id], proposed_change: null })));
  if (all.caught !== all.total || all.fp === 0) fail("每笔都报的基线不符合预期");
  const dump = agg("每本账只交一条、列出全部账目", (c) => [{ severity: "low", type: "other", title: "x", expense_ids: c.snap.expenses.map((e) => e.id), proposed_change: null }]);
  if (dump.caught !== 0 || dump.fp !== cases.length) fail("一条列全部的基线应该查出 0、每本账记 1 条误报");
  const decoys = agg("把干扰项全报一遍", (c) => c.decoys.map((d) => ({ severity: "low", type: "other", title: d.kind, expense_ids: d.ids, proposed_change: null })));
  if (decoys.caught !== 0 || decoys.fp !== D.length || decoys.decoyFp !== D.length) fail("干扰项全报的基线应该查出 0，误报数等于干扰项数，且每条都记到干扰项上");
  const rules = agg("纯规则（不调模型）", rulesOnlyFindings);
  const byKind = (kind: string) => cases.reduce((a, c) => a + score(c, rulesOnlyFindings(c)).truths.filter((t) => t.kind === kind && t.caught).length, 0);
  console.log(`    其中规则类 ${byKind("rule")}/${T.filter((t) => t.kind === "rule").length}，证据矛盾类 ${byKind("evidence")}/${T.filter((t) => t.kind === "evidence").length}，判断类 ${byKind("judgment")}/${T.filter((t) => t.kind === "judgment").length}`);
  if (byKind("rule") !== T.filter((t) => t.kind === "rule").length || byKind("evidence") !== 0 || byKind("judgment") !== 0) fail("纯规则基线应该正好查出全部规则类、其余一处都查不出");
  if (rules.fp !== rules.decoyFp) fail("纯规则基线的误报应该全部落在登记过的干扰项上");
  // 第一版里，加两条字面过滤（查重只认备注相同的、备注带「出发前」的不报日期）就能把纯规则基线的误报从 16 清到 0：答案写在备注里。这一版应该清不掉。
  const literal = agg("纯规则 + 两条字面过滤（查重只认备注相同的；备注带「出发前」的不报日期）", (c) => {
    const noteOf = (id: string) => c.snap.expenses.find((e) => e.id === id)?.note ?? "";
    return rulesOnlyFindings(c).filter((f) => (f.type === "duplicate" ? noteOf(f.expense_ids[0]) === noteOf(f.expense_ids[1]) : !(f.type === "date" && /出发前|提前/.test(noteOf(f.expense_ids[0])))));
  });
  if (literal.fp < rules.fp * 0.8) fail(`两条字面过滤就把纯规则基线的误报从 ${rules.fp} 降到了 ${literal.fp}：干扰项的答案还写在备注里`);

  surfaceBaseline(cases, fail);
  console.log(ok ? "自检通过" : "自检未通过");
  return ok;
}

/* ---------- 跑模型 ---------- */
const DIR = "eval/results/reconcile";

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const all = reconcileCases();
  const hash = casesHash(all);
  const label = opt("--label");
  if (argv.includes("--selftest")) { process.exit(selftest(all) ? 0 : 1); }
  if (argv.includes("--rules-only")) {
    const rows = all.map((c) => ({ case: c.id, rep: 0, size: c.size, expenses: c.snap.expenses.length, ok: true, ms: 0, turns: 0, toolCalls: [], cost: 0, usageDetail: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, findings: rulesOnlyFindings(c), score: score(c, rulesOnlyFindings(c)) }));
    mkdirSync(DIR, { recursive: true });
    const file = `${DIR}/rules-only${label ? "-" + label : ""}.json`;
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), mode: "rules-only", model: "none", reps: 1, label: label ?? null, casesHash: hash, rows }, null, 1));
    const T = rows.flatMap((r) => r.score.truths);
    console.log(`纯规则：查出 ${T.filter((t) => t.caught).length}/${T.length}；误报 ${rows.reduce((a, r) => a + r.score.fp.length, 0)}；账本哈希 ${hash}`);
    console.log("已写入 " + file);
    return;
  }
  const mode = opt("--mode") as "pipeline" | "agent" | undefined;
  if (!mode || !opt("--model")) throw new Error("需要 --mode pipeline|agent 和 --model <id>");
  const model = opt("--model") as string;
  const only = opt("--cases")?.split(",");
  const reps = Number(opt("--reps") ?? 1);
  const conc = Number(opt("--concurrency") ?? 3);
  const cases = only ? all.filter((c) => only.includes(c.id)) : all;
  const { runReconcile } = await import("../lib/agent/pipeline");
  const { estimateCostDetailed } = await import("../lib/telemetry");

  const jobs = cases.flatMap((c) => Array.from({ length: reps }, (_, rep) => ({ c, rep })));
  const rows: Record<string, unknown>[] = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { c, rep } = jobs[next++];
      const t0 = Date.now();
      try {
        const r: ReconcileResult = await runReconcile(c.snap, { mode, model });
        const row = rowOf(c, rep, r, Date.now() - t0, (u) => estimateCostDetailed(model, u));
        if (r.model && !r.model.startsWith(model)) console.warn(`  ! ${c.id} 应答模型 ${r.model} 与请求的 ${model} 不一致`);
        rows.push(row);
        console.log(`${c.id}#${rep} ${mode} ${(row.ms / 1000).toFixed(1)}s 轮次 ${row.turns} 查出 ${row.score.truths.filter((t) => t.caught).length}/${row.score.truths.length} 误报 ${row.score.fp.length}${row.rawMarkup ? " ！输出里带了原始标记" : ""}`);
      } catch (e) {
        rows.push({ case: c.id, rep, size: c.size, expenses: c.snap.expenses.length, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
        console.log(`${c.id}#${rep} ${mode} 出错：${e instanceof Error ? e.message : e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, worker));
  rows.sort((a, b) => String(a.case).localeCompare(String(b.case)) || Number(a.rep) - Number(b.rep));
  mkdirSync(DIR, { recursive: true });
  const at = new Date().toISOString();
  const file = `${DIR}/${at.replace(/[:.]/g, "-")}-${mode}-${model.replace("claude-", "")}${label ? "-" + label : ""}.json`;
  writeFileSync(file, JSON.stringify({ at, mode, model, reps, label: label ?? null, casesHash: hash, rows }, null, 1));
  const good = rows.filter((r) => r.ok) as { score: ReturnType<typeof score>; ms: number; cost: number; rawMarkup: boolean }[];
  const T = good.flatMap((r) => r.score.truths);
  console.log(`\n${mode} / ${model}：${good.length}/${rows.length} 次成功（输出带原始标记 ${good.filter((r) => r.rawMarkup).length} 次）；查出 ${T.filter((t) => t.caught).length}/${T.length}；误报 ${good.reduce((a, r) => a + r.score.fp.length, 0)}；不该给修改却给了 ${T.filter((t) => t.fixGiven).length}/${T.filter((t) => t.noFix).length}；平均 ${(good.reduce((a, r) => a + r.ms, 0) / Math.max(1, good.length) / 1000).toFixed(1)}s；合计 $${good.reduce((a, r) => a + r.cost, 0).toFixed(3)}`);
  console.log(`账本哈希 ${hash}；已写入 ${file}`);
}

/* 直接运行这个文件时才执行；被别的脚本引用（只为了用 score / rowOf）时不跑 */
if ((process.argv[1] ?? "").replace(/\\/g, "/").endsWith("scripts/eval-reconcile.ts")) main().catch((e) => { console.error(e); process.exit(1); });
