/**
 * 把核账对照评测的结果汇总成对照表（markdown，打到标准输出）。
 * 运行：npx tsx scripts/eval-reconcile-report.ts [标签，默认 full] [--dir 结果目录，默认 eval/results/reconcile]
 *
 * 只汇总账本哈希和当前生成器（eval/reconcile-cases.ts）一致的结果：
 *  - 同一标签下各配置最新一份结果的哈希互相不一致，说明混了两版账本，报错退出；
 *  - 哈希一致但不是当前这版账本（或者是没有哈希的旧结果），也不汇总，报错退出。
 * 纯规则基线读 rules-only-<标签>.json，没有就读 rules-only.json；哈希对不上就略过并提示重新生成。
 */
import { readdirSync, readFileSync } from "node:fs";
import { DECOY_KINDS, DECOY_LABEL, casesHash, reconcileCases, type DecoyKind } from "../eval/reconcile-cases";
import { estimateCostDetailed } from "../lib/telemetry";

type TruthHit = { key: string; kind: "rule" | "evidence" | "judgment"; caught: boolean; typeOk: boolean; hasFix: boolean; fixOk: boolean | null; noFix?: boolean; fixGiven?: boolean | null };
type Fp = { severity: string; type: string; title: string; expense_ids: string[]; why?: "none" | "loose" | "spray"; decoy: DecoyKind | null; decoyKey?: string | null; withChange: boolean };
type Usage = { input: number; cacheWrite: number; cacheRead: number; output: number };
type ToolCall = { name: string; input: Record<string, unknown> };
type Row = { case: string; rep?: number; size: string; expenses: number; ok: boolean; ms: number; turns: number; error?: string; rawMarkup?: boolean; toolCalls: ToolCall[]; cost: number; usageDetail: Usage; score: { truths: TruthHit[]; fp: Fp[] } };
type Run = { mode: string; model: string; reps: number; label?: string | null; casesHash?: string; rows: Row[]; file: string };

const args = process.argv.slice(2);
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? args[dirAt + 1] : "eval/results/reconcile";
const label = args.find((a, i) => !a.startsWith("--") && (dirAt < 0 || i !== dirAt + 1)) ?? "full";

const cases = reconcileCases();
const current = casesHash(cases);
const NO_HASH = "没有哈希（旧版结果）";

const names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const load = (f: string): Run => ({ ...(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as Omit<Run, "file">), file: f });
/* 新结果文件里存了标签，按它认；旧文件没存，按文件名结尾认 */
const runs = names.filter((f) => !f.startsWith("rules-only") && f.endsWith(`-${label}.json`)).map(load).filter((r) => r.label === undefined || r.label === label);
/* 同一配置如果跑了多次，只取最新的一份（文件名以时间开头，已按时间排好） */
const latest = new Map<string, Run>();
for (const r of runs) latest.set(`${r.mode}|${r.model}`, r);

const hashes = new Map<string, string[]>();
for (const r of latest.values()) hashes.set(r.casesHash ?? NO_HASH, [...(hashes.get(r.casesHash ?? NO_HASH) ?? []), r.file]);
if (hashes.size > 1) {
  console.error(`标签 ${label} 下各配置的结果不是同一版账本跑出来的，不能放进同一张表：`);
  for (const [h, files] of hashes) console.error(`  账本 ${h}${h === current ? "（当前）" : ""}：\n    ${files.join("\n    ")}`);
  console.error("把旧账本的那几个配置重跑一遍，或者换一个新标签整轮重跑。");
  process.exit(1);
}
if (latest.size && !hashes.has(current)) {
  console.error(`标签 ${label} 的结果对应的账本是「${[...hashes.keys()][0]}」，当前生成器的账本是 ${current}，不是同一版，不汇总。`);
  console.error("账本改过以后要用新标签整轮重跑；旧结果文件留着不用删。");
  process.exit(1);
}

const notes: string[] = [];
const rulesName = [`rules-only-${label}.json`, "rules-only.json"].find((f) => names.includes(f));
if (rulesName) {
  const r = load(rulesName);
  if (r.casesHash === current) latest.set("rules-only|none", r);
  else notes.push(`纯规则基线 ${rulesName} 对应的账本是「${r.casesHash ?? NO_HASH}」，不是当前这版，已略过。重新生成：npx tsx scripts/eval-reconcile.ts --rules-only --label ${label}`);
} else notes.push(`没有纯规则基线文件。生成：npx tsx scripts/eval-reconcile.ts --rules-only --label ${label}`);
if (!latest.size) {
  console.error(`${dir} 下没有标签为 ${label}、且和当前账本（${current}）同一版的结果文件。`);
  for (const n of notes) console.error(n);
  process.exit(1);
}

const order = ["rules-only|none", "pipeline|claude-haiku-5-5", "agent|claude-haiku-5-5", "pipeline|claude-sonnet-5-5", "agent|claude-sonnet-5-5", "pipeline|claude-opus-5-5", "agent|claude-opus-5-5"];
const list = [...order.filter((k) => latest.has(k)), ...[...latest.keys()].filter((k) => !order.includes(k)).sort()].map((k) => latest.get(k)!);
const models = list.filter((r) => r.mode !== "rules-only");

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const name = (r: Run) => (r.mode === "rules-only" ? "纯规则（不调模型）" : `${r.mode === "pipeline" ? "固定流程" : "Agent"} · ${r.model.replace("claude-", "").replace("-5-5", "")}`);
const good = (r: Run) => r.rows.filter((x) => x.ok);
const repsOf = (r: Run) => [...new Set(r.rows.map((x) => x.rep ?? 0))].sort((a, b) => a - b);
const table = (head: string[], rows: string[][]) => {
  console.log(`| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
};

/* 成本的另外两种口径。实测成本里，同一本账连着跑第二遍时系统提示词会命中上一遍留下的缓存，比线上单次核账便宜。
 * coldRun：每遍都从冷启动算。固定流程只有一次调用，缓存读全部改按写入价；Agent 一遍里第一轮写缓存、后面几轮照常读，
 *          所以只把一轮的量（缓存读 ÷ 轮次）改按写入价。已经是冷启动的运行（本来就有缓存写入）不变。
 * coldAll：缓存读全部按写入价算。对 Agent 是上界（等于每一轮都冷启动），对固定流程和 coldRun 相同。 */
const coldRun = (model: string, x: Row) => {
  const u = x.usageDetail;
  if (u.cacheWrite > 0 || u.cacheRead === 0) return estimateCostDetailed(model, u);
  const first = u.cacheRead / Math.max(1, x.turns);
  return estimateCostDetailed(model, { input: u.input, cacheWrite: first, cacheRead: u.cacheRead - first, output: u.output });
};
const coldAll = (model: string, x: Row) => estimateCostDetailed(model, { input: x.usageDetail.input, cacheWrite: x.usageDetail.cacheWrite + x.usageDetail.cacheRead, cacheRead: 0, output: x.usageDetail.output });

console.log(`# 核账对照评测汇总（标签 ${label}）\n`);
console.log(`账本哈希 ${current}：${cases.length} 本账、${sum(cases.map((c) => c.snap.expenses.length))} 笔，埋了 ${sum(cases.map((c) => c.truth.length))} 处问题、${sum(cases.map((c) => c.decoys.length))} 处干扰项。`);
console.log(`用到的结果文件：${list.map((r) => r.file).join("、")}`);
for (const n of notes) console.log(`\n> ${n}`);

console.log("\n## 查出了多少\n");
console.log("一条 finding 算查出某个问题：它列的账目至少一半落在这个问题的账目里。「不该给修改却给了」：没有依据能确定新值的问题（非成员付款人且没有原话、没有凭证的离群金额、待补全的金额），查出它的 finding 带了修改建议。\n");
table(
  ["配置", "成功", "输出带原始标记", "查出（各遍）", "规则类", "证据矛盾类", "判断类", "类型也对", "修改建议对", "不该给修改却给了"],
  list.map((r) => {
    const ok = good(r);
    const T = ok.flatMap((x) => x.score.truths);
    const kind = (k: string) => { const t = T.filter((x) => x.kind === k); return `${t.filter((x) => x.caught).length}/${t.length}`; };
    const perRep = repsOf(r).map((rep) => { const t = ok.filter((x) => (x.rep ?? 0) === rep).flatMap((x) => x.score.truths); return `${t.filter((x) => x.caught).length}/${t.length}`; });
    const fixable = T.filter((x) => x.hasFix);
    const noFix = T.filter((x) => x.noFix);
    return [name(r), `${ok.length}/${r.rows.length}`, r.mode === "rules-only" ? "—" : String(ok.filter((x) => x.rawMarkup).length), `${pct(T.filter((x) => x.caught).length, T.length)}（${perRep.join("、")}）`, kind("rule"), kind("evidence"), kind("judgment"), pct(T.filter((x) => x.typeOk).length, T.length), `${fixable.filter((x) => x.fixOk).length}/${fixable.length}`, `${noFix.filter((x) => x.fixGiven).length}/${noFix.filter((x) => x.caught).length}（查出的里面；共 ${noFix.length}）`];
  }),
);

console.log("\n### 各类问题查出了几次\n");
console.log("每格是「查出次数 / 机会数」（这类问题的个数 × 成功跑完的遍数）。\n");
const KIND_LABEL = { rule: "规则", evidence: "证据矛盾", judgment: "判断" };
const truthKeys = [...new Map(cases.flatMap((c) => c.truth.map((t) => [t.key, t.kind] as const))).entries()].sort((x, y) => Object.keys(KIND_LABEL).indexOf(x[1]) - Object.keys(KIND_LABEL).indexOf(y[1]));
table(
  ["问题类型", "类别", "个数", ...list.map(name)],
  truthKeys.map(([key, kind]) => [
    key,
    KIND_LABEL[kind],
    String(sum(cases.map((c) => c.truth.filter((t) => t.key === key).length))),
    ...list.map((r) => {
      const t = good(r).flatMap((x) => x.score.truths.filter((y) => y.key === key));
      return `${t.filter((y) => y.caught).length}/${t.length}`;
    }),
  ]),
);

console.log("\n## 误报\n");
console.log("误报 = 没有查出任何问题的 finding，加上列了 3 个以上不相干账目的 finding。「报了干扰项」= 这条误报的账目全部落在同一个登记过的干扰项里。\n");
table(
  ["配置", "误报总数（各遍）", "其中报了干扰项", "其中带修改建议", "干净账本上的误报"],
  list.map((r) => {
    const ok = good(r);
    const F = ok.flatMap((x) => x.score.fp);
    const perRep = repsOf(r).map((rep) => sum(ok.filter((x) => (x.rep ?? 0) === rep).map((x) => x.score.fp.length)));
    return [name(r), `${F.length}（${perRep.join("、")}）`, String(F.filter((x) => x.decoy).length), String(F.filter((x) => x.withChange).length), String(sum(ok.filter((x) => x.score.truths.length === 0).map((x) => x.score.fp.length)))];
  }),
);

console.log("\n### 各类干扰项被报了几次\n");
console.log("每格是「被报次数 / 机会数」：机会数 = 这类干扰项的个数 × 成功跑完的遍数；同一遍里同一个干扰项被报几条都只算一次。\n");
const decoyCount = (caseId: string, k: DecoyKind) => cases.find((c) => c.id === caseId)?.decoys.filter((d) => d.kind === k).length ?? 0;
table(
  ["干扰项类型", "个数", ...list.map(name)],
  DECOY_KINDS.map((k) => [
    DECOY_LABEL[k],
    String(sum(cases.map((c) => decoyCount(c.id, k)))),
    ...list.map((r) => {
      const ok = good(r);
      const reported = new Set(ok.flatMap((x) => x.score.fp.filter((f) => f.decoy === k).map((f) => `${x.case}#${x.rep ?? 0}:${f.decoyKey}`))).size;
      return `${reported}/${sum(ok.map((x) => decoyCount(x.case, k)))}`;
    }),
  ]),
);

if (models.length) {
  console.log("\n## 耗时和成本\n");
  console.log("成本三种口径：实测（同一本账连着跑第二遍时会命中上一遍的缓存，比线上便宜）；每遍冷启动（第一次调用按缓存写入价，Agent 后面几轮照常读缓存）；缓存读全按写入价（Agent 的上界，等于每一轮都冷启动；固定流程只有一次调用，和前一种相同）。\n");
  table(
    ["配置", "每本账耗时 均值 / 中位 / 最长", "小账 / 中账 / 大账 均值", "每本账成本（实测）", "每本账成本（每遍冷启动）", "每本账成本（缓存读全按写入价）", "一遍 12 本合计（每遍冷启动）", "输入 / 输出 token（每本均值）", "轮次 均值（分布）", "工具调用 均值"],
    models.map((r) => {
      const ok = good(r);
      const ms = ok.map((x) => x.ms / 1000);
      const bySize = (s: string) => mean(ok.filter((x) => x.size === s).map((x) => x.ms / 1000)).toFixed(1);
      const turnsDist: Record<number, number> = {};
      for (const x of ok) turnsDist[x.turns] = (turnsDist[x.turns] ?? 0) + 1;
      const inTok = mean(ok.map((x) => x.usageDetail.input + x.usageDetail.cacheWrite + x.usageDetail.cacheRead));
      const cold = mean(ok.map((x) => coldRun(r.model, x)));
      return [name(r), `${mean(ms).toFixed(1)}s / ${median(ms).toFixed(1)}s / ${Math.max(0, ...ms).toFixed(1)}s`, `${bySize("small")}s / ${bySize("medium")}s / ${bySize("large")}s`, `$${mean(ok.map((x) => x.cost)).toFixed(4)}`, `$${cold.toFixed(4)}`, `$${mean(ok.map((x) => coldAll(r.model, x))).toFixed(4)}`, `$${(cold * cases.length).toFixed(2)}`, `${Math.round(inTok)} / ${Math.round(mean(ok.map((x) => x.usageDetail.output)))}`, `${mean(ok.map((x) => x.turns)).toFixed(2)}（${Object.entries(turnsDist).map(([k, v]) => `${k} 轮×${v}`).join("，")}）`, mean(ok.map((x) => x.toolCalls.length)).toFixed(1)];
    }),
  );

  console.log("\n## Agent 实际是怎么调工具的\n");
  /* list_expenses 的筛选条件：至少有一个参数非空才算带了条件；min_amount 要大于 0 才算（传 0 等于没筛）。 */
  const filtered = (t: ToolCall) => ["date", "payer", "category", "status"].some((k) => typeof t.input?.[k] === "string" && (t.input[k] as string).trim() !== "") || (typeof t.input?.min_amount === "number" && (t.input.min_amount as number) > 0);
  for (const r of models.filter((x) => x.mode === "agent")) {
    const ok = good(r);
    const has = (f: (t: ToolCall) => boolean) => ok.filter((x) => x.toolCalls.some(f)).length;
    const six = ["get_trip", "list_expenses", "find_duplicates", "check_integrity", "category_stats", "get_balances"];
    const exactlySix = ok.filter((x) => x.toolCalls.length === 6 && six.every((n) => x.toolCalls.some((t) => t.name === n)) && x.turns === 2).length;
    const noFull = ok.filter((x) => !x.toolCalls.some((t) => t.name === "list_expenses" && !filtered(t)));
    const missed = sum(noFull.map((x) => x.score.truths.filter((t) => !t.caught).length));
    const missedAll = sum(ok.map((x) => x.score.truths.filter((t) => !t.caught).length));
    console.log(`- ${name(r)}：${ok.length} 次运行里，${exactlySix} 次是「第一轮把六个工具各调一遍、第二轮提交」；调过 get_expense 逐笔查看的 ${has((t) => t.name === "get_expense")} 次；list_expenses 带了有效筛选条件的 ${has((t) => t.name === "list_expenses" && filtered(t))} 次；find_duplicates 换过参数的 ${has((t) => t.name === "find_duplicates" && (t.input.window_minutes !== 120 || t.input.amount_tolerance !== 0))} 次。没取过全量账目的运行 ${noFull.length} 次（${noFull.map((x) => `${x.case}#${x.rep ?? 0}`).join("、") || "无"}），这些运行里漏了 ${missed} 处，全部运行共漏 ${missedAll} 处。`);
  }

  console.log("\n## 同一模型下，固定流程对 Agent（按 账本×遍 配对）\n");
  for (const model of [...new Set(models.map((r) => r.model))]) {
    const p = latest.get(`pipeline|${model}`);
    const a = latest.get(`agent|${model}`);
    if (!p || !a) continue;
    let pw = 0, aw = 0, tie = 0, fpP = 0, fpA = 0;
    for (const x of good(p)) {
      const y = a.rows.find((r) => r.ok && r.case === x.case && (r.rep ?? 0) === (x.rep ?? 0));
      if (!y) continue;
      const cx = x.score.truths.filter((t) => t.caught).length;
      const cy = y.score.truths.filter((t) => t.caught).length;
      if (cx > cy) pw++; else if (cy > cx) aw++; else tie++;
      fpP += x.score.fp.length; fpA += y.score.fp.length;
    }
    const sp = mean(good(p).map((r) => r.ms)); const sa = mean(good(a).map((r) => r.ms));
    const cp = mean(good(p).map((r) => r.cost)); const ca = mean(good(a).map((r) => r.cost));
    const kp = mean(good(p).map((r) => coldRun(model, r))); const ka = mean(good(a).map((r) => coldRun(model, r)));
    console.log(`- ${model.replace("claude-", "")}：查出数 固定流程更多 ${pw} 对、Agent 更多 ${aw} 对、相同 ${tie} 对；误报 ${fpP} 对 ${fpA}；耗时 ${(sp / 1000).toFixed(1)}s 对 ${(sa / 1000).toFixed(1)}s（固定流程是 Agent 的 ${pct(sp, sa)}）；成本 实测 $${cp.toFixed(4)} 对 $${ca.toFixed(4)}（${pct(cp, ca)}），每遍冷启动 $${kp.toFixed(4)} 对 $${ka.toFixed(4)}（${pct(kp, ka)}）。`);
  }
}

console.log("\n## 没查出来的（各配置，按 账本:问题 计次）\n");
for (const r of list) {
  const miss: Record<string, number> = {};
  for (const x of good(r)) for (const t of x.score.truths) if (!t.caught) miss[`${x.case}:${t.key}`] = (miss[`${x.case}:${t.key}`] ?? 0) + 1;
  console.log(`- ${name(r)}：${Object.keys(miss).length ? Object.entries(miss).map(([k, v]) => `${k}×${v}`).join("，") : "无"}`);
}

console.log("\n## 不该给修改却给了的（各配置，按 账本:问题 计次）\n");
for (const r of models) {
  const hit: Record<string, number> = {};
  for (const x of good(r)) for (const t of x.score.truths) if (t.fixGiven) hit[`${x.case}:${t.key}`] = (hit[`${x.case}:${t.key}`] ?? 0) + 1;
  console.log(`- ${name(r)}：${Object.keys(hit).length ? Object.entries(hit).map(([k, v]) => `${k}×${v}`).join("，") : "无"}`);
}

console.log("\n## 误报明细\n");
const WHY = { none: "", loose: "·沾到问题账目但不到一半", spray: "·说中了问题但另列了一堆账目" };
for (const r of models) {
  const items = good(r).flatMap((x) => x.score.fp.map((f) => `${x.case}#${x.rep ?? 0} [${f.severity}${f.decoy ? `·干扰项：${DECOY_LABEL[f.decoy] ?? f.decoy}` : ""}${f.withChange ? "·带修改" : ""}${WHY[f.why ?? "none"]}] ${f.expense_ids.join(",")} ${f.title}`));
  console.log(`- ${name(r)}（${items.length}）${items.length ? "：\n  - " + items.join("\n  - ") : ""}`);
}

const raw = models.flatMap((r) => good(r).filter((x) => x.rawMarkup).map((x) => `${name(r)} ${x.case}#${x.rep ?? 0}`));
console.log(`\n## 输出里带了原始标记的运行（这些仍计入成功）\n\n${raw.length ? raw.map((e) => "- " + e).join("\n") : "无"}`);
const errs = list.flatMap((r) => r.rows.filter((x) => !x.ok).map((x) => `${name(r)} ${x.case}#${x.rep ?? 0}: ${x.error}`));
console.log(`\n## 出错的运行\n\n${errs.length ? errs.map((e) => "- " + e).join("\n") : "无"}`);
