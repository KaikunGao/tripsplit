import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui";
import { db, ready } from "@/lib/db";
import { listRuns, type Run } from "@/lib/telemetry";

export const metadata = { title: "运营后台 · TripSplit" };

/**
 * 可观测后台：模型调用的次数 / 成功率 / 耗时 / token / 成本，按路由汇总；最近调用明细；评测历史。
 * 设了 ADMIN_TOKEN 时需要 ?token=…；本地开发不设即可直接看。
 */
export default function Admin({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="card p-6">
          <Skeleton lines={5} />
        </div>
      }
    >
      <AdminInner searchParams={searchParams} />
    </Suspense>
  );
}

async function AdminInner({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  await connection(); // 每次请求实时读库，不参与预渲染
  const { token } = await searchParams;
  if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN)
    return (
      <div className="card mx-auto max-w-md p-6 text-sm">
        <p className="font-medium">需要访问令牌</p>
        <p className="mt-1 text-ink-400">在地址后加 ?token=（ADMIN_TOKEN 环境变量的值）。</p>
      </div>
    );

  await ready();
  const { runs, persistent } = await listRuns(300);
  const evals = db() ? (await db()!.execute("SELECT * FROM evals ORDER BY id DESC LIMIT 20")).rows : [];

  const byRoute = new Map<string, { n: number; ok: number; ms: number[]; input: number; output: number; cost: number }>();
  for (const r of runs) {
    const b = byRoute.get(r.route) ?? { n: 0, ok: 0, ms: [], input: 0, output: 0, cost: 0 };
    b.n++;
    if (r.ok) b.ok++;
    b.ms.push(r.ms);
    b.input += r.input;
    b.output += r.output;
    b.cost += r.cost_usd;
    byRoute.set(r.route, b);
  }
  const p = (arr: number[], q: number) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0);
  const totalCost = runs.reduce((a, r) => a + r.cost_usd, 0);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">运营后台</h1>
          <p className="text-sm text-ink-400">{persistent ? "数据来自数据库" : "未配置数据库：只显示本进程内存里最近 500 次调用，重启即清空"}</p>
        </div>
        <div className="text-right text-sm">
          <div className="text-xs text-ink-400">最近 {runs.length} 次调用估算成本</div>
          <div className="text-xl font-bold">${totalCost.toFixed(4)}</div>
        </div>
      </div>

      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">按路由汇总</h2>
        <table className="w-full text-sm">
          <thead className="text-xs text-ink-400">
            <tr>
              <th className="py-1 text-left font-medium">路由</th>
              <th className="py-1 text-right font-medium">次数</th>
              <th className="py-1 text-right font-medium">成功率</th>
              <th className="py-1 text-right font-medium">p50 ms</th>
              <th className="py-1 text-right font-medium">p90 ms</th>
              <th className="py-1 text-right font-medium">入 token</th>
              <th className="py-1 text-right font-medium">出 token</th>
              <th className="py-1 text-right font-medium">成本 $</th>
            </tr>
          </thead>
          <tbody>
            {[...byRoute.entries()].map(([route, b]) => (
              <tr key={route} className="border-t border-ink-100 tabular-nums">
                <td className="py-1.5 font-medium">{route}</td>
                <td className="py-1.5 text-right">{b.n}</td>
                <td className={`py-1.5 text-right ${b.ok < b.n ? "text-danger-700" : ""}`}>{Math.round((b.ok / b.n) * 100)}%</td>
                <td className="py-1.5 text-right">{p(b.ms, 0.5)}</td>
                <td className="py-1.5 text-right">{p(b.ms, 0.9)}</td>
                <td className="py-1.5 text-right">{b.input.toLocaleString()}</td>
                <td className="py-1.5 text-right">{b.output.toLocaleString()}</td>
                <td className="py-1.5 text-right">{b.cost.toFixed(4)}</td>
              </tr>
            ))}
            {byRoute.size === 0 && (
              <tr>
                <td colSpan={8} className="py-3 text-center text-ink-400">
                  还没有调用记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">评测历史（npm run eval）</h2>
        {evals.length === 0 ? (
          <p className="text-sm text-ink-400">{persistent ? "还没跑过评测。" : "需要数据库才能保存评测历史；本地结果在 eval/results/ 目录。"}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-ink-400">
              <tr>
                <th className="py-1 text-left font-medium">时间</th>
                <th className="py-1 text-left font-medium">模型/effort</th>
                <th className="py-1 text-right font-medium">用例</th>
                <th className="py-1 text-right font-medium">决策</th>
                <th className="py-1 text-right font-medium">金额</th>
                <th className="py-1 text-right font-medium">付款人</th>
                <th className="py-1 text-right font-medium">参与人</th>
                <th className="py-1 text-right font-medium">分类</th>
                <th className="py-1 text-right font-medium">成本 $</th>
              </tr>
            </thead>
            <tbody>
              {evals.map((e) => (
                <tr key={String(e.id)} className="border-t border-ink-100 tabular-nums">
                  <td className="py-1.5">{String(e.at).slice(0, 16).replace("T", " ")}</td>
                  <td className="py-1.5">{String(e.model)}</td>
                  <td className="py-1.5 text-right">{Number(e.cases)}</td>
                  <td className="py-1.5 text-right">{Number(e.decision_acc)}%</td>
                  <td className="py-1.5 text-right">{Number(e.amount_acc)}%</td>
                  <td className="py-1.5 text-right">{Number(e.payer_acc)}%</td>
                  <td className="py-1.5 text-right">{Number(e.participants_acc)}%</td>
                  <td className="py-1.5 text-right">{Number(e.category_acc)}%</td>
                  <td className="py-1.5 text-right">{Number(e.cost_usd).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">最近调用</h2>
        <table className="w-full text-xs">
          <thead className="text-ink-400">
            <tr>
              <th className="py-1 text-left font-medium">时间</th>
              <th className="py-1 text-left font-medium">路由</th>
              <th className="py-1 text-left font-medium">模型</th>
              <th className="py-1 text-right font-medium">ms</th>
              <th className="py-1 text-right font-medium">入/出</th>
              <th className="py-1 text-right font-medium">$</th>
              <th className="py-1 text-left font-medium">备注</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 100).map((r: Run, i) => (
              <tr key={r.id ?? i} className={`border-t border-ink-100 tabular-nums ${r.ok ? "" : "text-danger-700"}`}>
                <td className="py-1">{r.at.slice(5, 19).replace("T", " ")}</td>
                <td className="py-1">{r.route}</td>
                <td className="py-1">{r.model}</td>
                <td className="py-1 text-right">{r.ms}</td>
                <td className="py-1 text-right">
                  {r.input}/{r.output}
                </td>
                <td className="py-1 text-right">{r.cost_usd.toFixed(4)}</td>
                <td className="max-w-xs truncate py-1 text-ink-400">{r.error ?? (r.meta ? JSON.stringify(r.meta) : "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
