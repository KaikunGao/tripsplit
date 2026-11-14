/**
 * 给示例账本真实跑一遍核账 / 检索 / 报告，把输出存成 lib/demo-results.json。
 * 示例旅行的核账页、查询页首次打开时直接展示这份结果（见 lib/demo.ts）。
 * 示例数据（lib/seed.ts）改过以后要重跑：npm run demo:snapshot  （读取 .env.local 里的 ANTHROPIC_API_KEY）
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEMO_QUESTIONS } from "../lib/demo";
import { DEMO_DONE_TRIP_ID, DEMO_TRIP_ID, SEED } from "../lib/seed";
import { fingerprint } from "../lib/store";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

/* 每趟旅行跑哪些：待核账的那趟展示核账和找账，已结清的那趟展示统计和报告 */
const PLAN: Record<string, { reconcile?: boolean; search?: boolean; report?: boolean }> = {
  [DEMO_TRIP_ID]: { reconcile: true, search: true },
  [DEMO_DONE_TRIP_ID]: { search: true, report: true },
};

async function main() {
  const { MODEL } = await import("../lib/claude");
  const { runReconcile: reconcile } = await import("../lib/agent/pipeline");
  const { search } = await import("../lib/search/answer");
  const { report } = await import("../lib/report");
  const seed = SEED();
  const only = process.argv[2];
  const out = JSON.parse(readFileSync("lib/demo-results.json", "utf8")) as { model: string; generatedAt: string; trips: Record<string, Record<string, unknown>> };

  for (const trip of seed.trips) {
    const plan = PLAN[trip.id];
    if (!plan || (only && only !== trip.id)) continue;
    const expenses = seed.expenses.filter((e) => e.tripId === trip.id);
    const snap = { trip, expenses, habits: seed.prefs.habits };
    const entry: Record<string, unknown> = { fingerprint: fingerprint(expenses) };
    if (plan.reconcile) {
      const r = await reconcile(snap);
      console.log(`[${trip.name}] 核账：${r.findings.length} 条发现，${r.usage.turns} 轮\n  ${r.summary}`);
      for (const f of r.findings) console.log(`  - [${f.severity}] ${f.title} ${f.proposed_change ? JSON.stringify(f.proposed_change.patch ?? f.proposed_change.action) : ""}`);
      entry.reconcile = r;
    }
    if (plan.search) {
      const query = DEMO_QUESTIONS[trip.id][0];
      const r = await search(snap, query);
      console.log(`[${trip.name}] 检索「${query}」\n  ${r.answer.answer}\n  引用 ${r.answer.citations.join(",")}`);
      entry.search = { query, result: r };
    }
    if (plan.report) {
      const { aggregate, narrative } = await report(snap);
      console.log(`[${trip.name}] 报告：${narrative?.title}\n  ${narrative?.highlights.join("\n  ")}\n  ${narrative?.narrative}`);
      entry.report = { aggregate, narrative };
    }
    out.trips[trip.id] = entry;
  }
  out.model = MODEL;
  out.generatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync("lib/demo-results.json", JSON.stringify(out, null, 1) + "\n");
  console.log("已写入 lib/demo-results.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
