import { after } from "next/server";
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

/*
 * 每百万 token 价格（美元），用于成本估算；未知模型按 Opus 档。
 * 2026-11-13 按官方价目页（platform.claude.com/docs/en/about-claude/pricing）改正：此前这里写的是
 * 15/75、3/15、0.8/4，不是这三个模型的价格，11-13 之前算出来的成本（含 runs 表里已存的 cost_usd、
 * docs/评测-2026-11-10.md 里的美分数）都偏高，Opus 约为实际的 3.75 倍、Sonnet 1.5 倍、Haiku 8 倍。
 * cacheWrite 是 5 分钟缓存写入价，cacheRead 是缓存命中价。Haiku 5.5 的价格只对 10 万 token 以内的提示成立，这里的提示远小于此。
 */
const PRICE: Record<string, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};
/** 粗估：input 不分缓存与否，一律按普通输入价算。缓存命中多时偏高；只写不读缓存时略偏低（写入价是 1.25 倍）。 */
export function estimateCost(model: string, input: number, output: number): number {
  const p = PRICE[model] ?? PRICE["claude-opus-5-5"];
  return Math.round(((input * p.in + output * p.out) / 1e6) * 1e6) / 1e6;
}
/** 按计费类别分开算：普通输入、缓存写入、缓存命中、输出。评测用这个。 */
export function estimateCostDetailed(model: string, u: { input: number; cacheWrite: number; cacheRead: number; output: number }): number {
  const p = PRICE[model] ?? PRICE["claude-opus-5-5"];
  return Math.round(((u.input * p.in + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead + u.output * p.out) / 1e6) * 1e6) / 1e6;
}

const mem: Run[] = [];

/**
 * 记一次模型调用。内存里立刻可见；数据库写入放到响应发出之后（Next 的 after()，OpenNext 在
 * Cloudflare 上接到 waitUntil）。2026-11-10 发现 Workers 上直接 `void` 掉的 Promise 会随请求结束被
 * 回收，线上调用一条都没落库；Vercel 的 Node 进程没这个问题。不在请求上下文里（脚本）时退回直接写。
 */
export function record(r: Omit<Run, "at" | "model" | "cost_usd"> & { model?: string; usageDetail?: { input: number; cacheWrite: number; cacheRead: number; output: number } }): void {
  const { usageDetail, ...rest } = r;
  // 有分项用量就按计费类别算；没有就用粗估（缓存命中多时偏高，只有缓存写入时略偏低）
  const cost_usd = usageDetail ? estimateCostDetailed(r.model ?? MODEL, usageDetail) : estimateCost(r.model ?? MODEL, r.input, r.output);
  const run: Run = { at: new Date().toISOString(), model: r.model ?? MODEL, cost_usd, ...rest };
  mem.unshift(run);
  if (mem.length > 500) mem.length = 500;
  const write = async () => {
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
  };
  try {
    after(write);
  } catch {
    void write();
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
