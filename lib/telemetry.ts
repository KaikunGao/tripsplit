import { MODEL } from "./claude";
import { db } from "./db";

/**
 * 可观测：每次模型调用记一行（路由、耗时、token、成本估算、是否成功、附加信息）。
 * 有数据库就写库；没有就留在进程内存里（最近 500 条），/admin 两种都能看。
 */
export type Run = {
  id?: number;
  at: string;
  route: string;
  model: string;
  ok: boolean;
  ms: number;
  input: number;
  output: number;
  cost_usd: number;
  error?: string;
  meta?: Record<string, unknown>;
};

/* 每百万 token 价格（美元），用于成本估算；未知模型按 Opus 档。 */
const PRICE: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 15, out: 75 },
  "claude-sonnet-5-5": { in: 3, out: 15 },
  "claude-haiku-5-5": { in: 0.8, out: 4 },
};
export function estimateCost(model: string, input: number, output: number): number {
  const p = PRICE[model] ?? PRICE["claude-opus-5-5"];
  return Math.round(((input * p.in + output * p.out) / 1e6) * 1e6) / 1e6;
}

const mem: Run[] = [];

export async function record(r: Omit<Run, "at" | "model" | "cost_usd"> & { model?: string }): Promise<void> {
  const run: Run = { at: new Date().toISOString(), model: r.model ?? MODEL, cost_usd: estimateCost(r.model ?? MODEL, r.input, r.output), ...r };
  mem.unshift(run);
  if (mem.length > 500) mem.length = 500;
  const d = await db();
  if (!d) return;
  try {
    await d.execute({
      sql: "INSERT INTO runs (at, route, model, ok, ms, input, output, cost_usd, error, meta) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [run.at, run.route, run.model, run.ok ? 1 : 0, run.ms, run.input, run.output, run.cost_usd, run.error ?? null, run.meta ? JSON.stringify(run.meta) : null],
    });
  } catch (e) {
    console.warn("telemetry write failed", e);
  }
}

export async function listRuns(limit = 200): Promise<{ runs: Run[]; persistent: boolean }> {
  const d = await db();
  if (!d) return { runs: mem.slice(0, limit), persistent: false };
  const rs = await d.execute({ sql: "SELECT * FROM runs ORDER BY id DESC LIMIT ?", args: [limit] });
  return {
    persistent: true,
    runs: rs.rows.map((row) => ({
      id: Number(row.id),
      at: String(row.at),
      route: String(row.route),
      model: String(row.model),
      ok: Number(row.ok) === 1,
      ms: Number(row.ms),
      input: Number(row.input),
      output: Number(row.output),
      cost_usd: Number(row.cost_usd),
      error: row.error ? String(row.error) : undefined,
      meta: row.meta ? (JSON.parse(String(row.meta)) as Record<string, unknown>) : undefined,
    })),
  };
}
