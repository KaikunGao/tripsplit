import { NextResponse } from "next/server";

/**
 * 汇率：按消费日取欧洲央行参考汇率（frankfurter.dev，免费无 key）。
 * 周末/节假日自动回退到最近交易日；币种不支持时返回 ok:false，前端让用户手填。
 * 进程内缓存，同一 (from,to,date) 只查一次。
 */
const cache = new Map<string, { rate: number; date: string }>();

export async function GET(req: Request) {
  const u = new URL(req.url);
  const from = (u.searchParams.get("from") ?? "").toUpperCase();
  const to = (u.searchParams.get("to") ?? "CNY").toUpperCase();
  const date = u.searchParams.get("date") ?? "latest";
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return NextResponse.json({ ok: false, error: "币种代码无效" }, { status: 400 });
  if (from === to) return NextResponse.json({ ok: true, rate: 1, date, source: "same" });
  const key = `${from}:${to}:${date}`;
  const hit = cache.get(key);
  if (hit) return NextResponse.json({ ok: true, ...hit, source: "cache" });
  try {
    const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= new Date().toISOString().slice(0, 10) ? date : "latest";
    const r = await fetch(`https://api.frankfurter.dev/v1/${safeDate}?base=${from}&symbols=${to}`, { next: { revalidate: 86400 } });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const j = (await r.json()) as { date: string; rates: Record<string, number> };
    const rate = j.rates?.[to];
    if (!rate) throw new Error("unsupported");
    const out = { rate: Math.round(rate * 1e6) / 1e6, date: j.date };
    cache.set(key, out);
    return NextResponse.json({ ok: true, ...out, source: "ecb" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `暂时取不到 ${from}→${to} 的汇率，请手动填写（${e instanceof Error ? e.message : "unknown"}）` }, { status: 200 });
  }
}
