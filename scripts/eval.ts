/**
 * 录入解析评测：对 eval/cases.json 逐条调 extract()，按字段算准确率与成本。
 * 运行：npm run eval [caseId] [--cases eval/cases.json] [--label 说明]
 *   读取 .env.local 里的 ANTHROPIC_API_KEY；TRIPSPLIT_MODEL / TRIPSPLIT_EFFORT 可覆盖模型与 effort。
 * 结果写到 eval/results/<时间>[-label].json，含按 tags（评测维度）汇总的通过率；配置了数据库时同时写入 evals 表，/admin 能看历史。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extract } from "../lib/extract/extract";
import { SEED } from "../lib/seed";
import type { Category } from "../lib/types";

// 手动加载 .env.local（tsx 不会自动读）
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

type Case = { id: string; kind: "text" | "voice"; text: string; tags?: string[]; expected: { decision: "auto" | "ask" | "reject"; amount: number | null; currency?: string; payer: string | null; participants: string[] | null; category: Category | null; treat: boolean } };

async function main() {
  const { EXTRACT_MODEL: MODEL } = await import("../lib/claude");
  const { estimateCost, estimateCostDetailed } = await import("../lib/telemetry");
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const casesFile = opt("--cases") ?? "eval/cases.json";
  const label = opt("--label");
  const only = argv.find((a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--")));
  const { cases } = JSON.parse(readFileSync(casesFile, "utf8")) as { cases: Case[] };
  const list = only ? cases.filter((c) => c.id === only) : cases;
  const trip = SEED().trips[0];
  const nameOf = (id?: string) => trip.members.find((m) => m.id === id)?.name ?? null;

  const rows: Record<string, unknown>[] = [];
  const acc = { decision: 0, amount: 0, payer: 0, participants: 0, category: 0, treat: 0 };
  const n = { decision: 0, amount: 0, payer: 0, participants: 0, category: 0, treat: 0 };
  let input = 0;
  let output = 0;
  const detail = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const t0 = Date.now();

  for (const c of list) {
    const started = Date.now();
    try {
      const r = await extract({ trip, kind: c.kind, text: c.text });
      input += r.usage?.input ?? 0;
      output += r.usage?.output ?? 0;
      if (r.usageDetail) for (const k of ["input", "cacheWrite", "cacheRead", "output"] as const) detail[k] += r.usageDetail[k];
      const got = {
        decision: r.decision,
        amount: r.draft.amount ?? null,
        currency: r.draft.currency,
        payer: nameOf(r.draft.payerId),
        participants: (r.draft.participantIds ?? []).map((id) => nameOf(id)).sort(),
        category: r.draft.category ?? null,
        treat: !!r.draft.treat,
      };
      const e = c.expected;
      const ok = {
        decision: got.decision === e.decision,
        amount: e.amount == null ? null : got.amount === e.amount,
        payer: e.payer === null ? null : got.payer === e.payer,
        participants: e.participants === null ? null : JSON.stringify(got.participants) === JSON.stringify([...e.participants].sort()),
        category: e.category === null ? null : got.category === e.category,
        treat: got.treat === e.treat,
      };
      for (const k of Object.keys(ok) as (keyof typeof ok)[]) {
        if (ok[k] === null) continue;
        n[k]++;
        if (ok[k]) acc[k]++;
      }
      const pass = Object.values(ok).every((v) => v !== false);
      rows.push({ id: c.id, kind: c.kind, tags: c.tags ?? [], pass, ms: Date.now() - started, text: c.text, expected: e, got, ok });
      console.log(`${pass ? "✓" : "✗"} ${c.id} ${c.text.slice(0, 28).padEnd(30)} ${got.decision.padEnd(6)} ${String(got.amount).padEnd(6)} ${String(got.payer).padEnd(4)} ${got.participants.join("/")}${!pass ? "   ← " + Object.entries(ok).filter(([, v]) => v === false).map(([k]) => k).join(",") : ""}`);
    } catch (err) {
      rows.push({ id: c.id, kind: c.kind, tags: c.tags ?? [], pass: false, error: err instanceof Error ? err.message : String(err) });
      console.log(`✗ ${c.id} ERROR ${err instanceof Error ? err.message : err}`);
      n.decision++;
    }
  }

  const pct = (k: keyof typeof acc) => (n[k] ? Math.round((acc[k] / n[k]) * 1000) / 10 : null);
  // 按维度（tags）汇总：每个标签下有多少例、过了多少、没过的是谁
  const byTag: Record<string, { n: number; pass: number; failed: string[] }> = {};
  for (const r of rows) for (const t of (r.tags as string[])) {
    byTag[t] ??= { n: 0, pass: 0, failed: [] };
    byTag[t].n++;
    if (r.pass) byTag[t].pass++; else byTag[t].failed.push(r.id as string);
  }
  const byKind: Record<string, { n: number; pass: number }> = {};
  for (const r of rows) { const k = r.kind as string; byKind[k] ??= { n: 0, pass: 0 }; byKind[k].n++; if (r.pass) byKind[k].pass++; }
  const failures = rows.filter((r) => !r.pass).map((r) => ({ id: r.id, tags: r.tags, wrong: r.ok ? Object.entries(r.ok as Record<string, boolean | null>).filter(([, v]) => v === false).map(([k]) => k) : ["error"], expected: r.expected, got: r.got }));
  const summary = {
    at: new Date().toISOString(),
    label,
    casesFile,
    model: MODEL,
    effort: process.env.TRIPSPLIT_EFFORT ?? "medium",
    cases: list.length,
    passed: rows.filter((r) => r.pass).length,
    decision_acc: pct("decision"),
    amount_acc: pct("amount"),
    payer_acc: pct("payer"),
    participants_acc: pct("participants"),
    category_acc: pct("category"),
    treat_acc: pct("treat"),
    tokens: { input, output },
    /* 三种口径（2026-11-13 起）：
       cost_usd       本次实测：按计费类别分开算，含缓存折扣。评测是连着跑的，系统提示几乎每条都命中缓存，所以是下界。
       cost_usd_cold  每条都没命中缓存时的成本：系统提示按缓存写入价算。真实用户隔很久才记一笔，更接近这个数。
       cost_usd_flat  不开缓存、全部按普通输入价算。 */
    tokens_detail: detail,
    cost_usd: estimateCostDetailed(MODEL, detail),
    cost_usd_cold: estimateCostDetailed(MODEL, { input: detail.input, cacheWrite: detail.cacheWrite + detail.cacheRead, cacheRead: 0, output: detail.output }),
    cost_usd_flat: estimateCost(MODEL, input, output),
    ms: Date.now() - t0,
    byKind,
    byTag,
  };
  console.log("\n" + JSON.stringify({ ...summary, byTag: undefined }, null, 2));
  console.log("\n按维度（未全过的）：");
  for (const [t, v] of Object.entries(byTag).sort((a, b) => b[1].failed.length - a[1].failed.length)) if (v.failed.length) console.log(`  ${t.padEnd(20)} ${v.pass}/${v.n}  ✗ ${v.failed.join(",")}`);

  mkdirSync("eval/results", { recursive: true });
  const file = `eval/results/${summary.at.replace(/[:.]/g, "-")}${label ? "-" + label.replace(/[^\w\u4e00-\u9fa5-]+/g, "_") : ""}.json`;
  writeFileSync(file, JSON.stringify({ summary, failures, rows }, null, 2));
  console.log(`结果已写入 ${file}`);

  try {
    const { ready } = await import("../lib/db");
    const d = await ready();
    if (d) {
      await d.execute({
        sql: "INSERT INTO evals (at, model, cases, decision_acc, amount_acc, payer_acc, participants_acc, category_acc, cost_usd, detail) VALUES (?,?,?,?,?,?,?,?,?,?)",
        args: [summary.at, `${MODEL}/${summary.effort}`, summary.cases, summary.decision_acc ?? 0, summary.amount_acc ?? 0, summary.payer_acc ?? 0, summary.participants_acc ?? 0, summary.category_acc ?? 0, summary.cost_usd, JSON.stringify(rows.filter((r) => !r.pass).map((r) => r.id))],
      });
      console.log("已写入数据库 evals 表");
    }
  } catch (e) {
    console.warn("写入数据库失败（不影响结果文件）", e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
