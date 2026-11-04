"use client";
import { useMemo, useState } from "react";
import { Field, Icon } from "@/components/ui";
import { money } from "@/lib/format";
import { homeAmount, round2 } from "@/lib/settle";
import { actions } from "@/lib/store";
import { CATEGORIES, type Expense, type Trip } from "@/lib/types";

/**
 * 预算与趋势：账本顶部一条总预算进度；展开看分类预算、按天消费趋势图、预算编辑。
 * 金额全部按本币（外币折算）。
 */
export function BudgetPanel({ trip, expenses }: { trip: Trip; expenses: Expense[] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const confirmed = useMemo(() => expenses.filter((e) => e.status === "confirmed"), [expenses]);
  const spent = round2(confirmed.reduce((a, e) => a + homeAmount(e), 0));
  const budget = trip.budget;
  const total = budget?.total;
  const pct = total ? spent / total : 0;
  const over = total ? spent > total : false;
  const byCat = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of confirmed) m[e.category] = round2((m[e.category] ?? 0) + homeAmount(e));
    return m;
  }, [confirmed]);
  const overCats = CATEGORIES.filter((c) => budget?.byCategory?.[c] && byCat[c] > budget.byCategory[c]);

  if (!budget?.total && !budget?.byCategory && !editing && !open)
    return (
      <button type="button" onClick={() => (setOpen(true), setEditing(true))} className="flex w-full items-center justify-between rounded-xl border border-dashed border-ink-200 px-3 py-2 text-left text-sm text-ink-600 hover:border-brand-500 hover:bg-brand-50">
        <span>设个预算，账本顶部会显示花了多少、还剩多少</span>
        <Icon name="plus" className="h-4 w-4 text-ink-400" />
      </button>
    );

  return (
    <div className="card overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 p-3 text-left" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">
              已花 {money(spent, trip.currency)}
              {total ? <span className="text-ink-400"> / 预算 {money(total, trip.currency)}</span> : null}
            </span>
            {total && (
              <span className={`text-xs font-semibold ${over ? "text-danger-700" : pct > 0.85 ? "text-warn-700" : "text-ink-400"}`}>
                {over ? `超支 ${money(round2(spent - total), trip.currency)}` : `剩 ${money(round2(total - spent), trip.currency)}`}
              </span>
            )}
          </div>
          {total ? <Meter value={pct} /> : <p className="text-xs text-ink-400">未设总预算，{overCats.length ? `${overCats.join("、")} 已超分类预算` : "分类预算正常"}</p>}
          {total && overCats.length > 0 && <p className="mt-1 text-xs text-danger-700">⚠ {overCats.join("、")} 已超分类预算</p>}
        </div>
        <Icon name="chevron" className={`h-4 w-4 shrink-0 text-ink-400 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-ink-100 p-3 sm:p-4">
          {editing ? (
            <BudgetEditor trip={trip} onDone={() => setEditing(false)} />
          ) : (
            <>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-ink-400">分类预算</h3>
                  <button className="text-xs text-brand-700 underline" onClick={() => setEditing(true)}>
                    编辑预算
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CATEGORIES.filter((c) => byCat[c] || budget?.byCategory?.[c]).map((c) => {
                    const b = budget?.byCategory?.[c];
                    const v = byCat[c] ?? 0;
                    return (
                      <div key={c} className="text-xs">
                        <div className="flex justify-between">
                          <span>{c}</span>
                          <span className={b && v > b ? "font-semibold text-danger-700" : "text-ink-600"}>
                            {money(v, trip.currency)}
                            {b ? ` / ${money(b, trip.currency)}` : ""}
                          </span>
                        </div>
                        {b ? <Meter value={v / b} thin /> : <div className="mt-1 h-1 rounded bg-ink-100" />}
                      </div>
                    );
                  })}
                </div>
              </div>
              <TrendChart trip={trip} expenses={confirmed} budget={total} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Meter({ value, thin = false }: { value: number; thin?: boolean }) {
  const w = Math.min(100, Math.round(value * 100));
  const tone = value > 1 ? "bg-danger-700" : value > 0.85 ? "bg-warn-700" : "bg-brand-600";
  return (
    <div className={`mt-1 w-full overflow-hidden rounded-full bg-ink-100 ${thin ? "h-1" : "h-2"}`} role="meter" aria-valuenow={w} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${tone} transition-[width]`} style={{ width: `${w}%` }} />
    </div>
  );
}

function BudgetEditor({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const [total, setTotal] = useState(trip.budget?.total ? String(trip.budget.total) : "");
  const [cats, setCats] = useState<Record<string, string>>(Object.fromEntries(CATEGORIES.map((c) => [c, trip.budget?.byCategory?.[c] ? String(trip.budget.byCategory[c]) : ""])));
  function save() {
    const byCategory: Record<string, number> = {};
    for (const c of CATEGORIES) if (Number(cats[c]) > 0) byCategory[c] = Number(cats[c]);
    const t = Number(total) > 0 ? Number(total) : undefined;
    actions.setBudget(trip.id, t || Object.keys(byCategory).length ? { total: t, byCategory: Object.keys(byCategory).length ? byCategory : undefined } : undefined);
    onDone();
  }
  return (
    <div className="space-y-3">
      <Field label={`总预算（${trip.currency}）`}>
        <input className="input" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="如 8000" />
      </Field>
      <Field label="分类预算（可选）">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <span className="w-8 shrink-0">{c}</span>
              <input className="input py-1" inputMode="decimal" value={cats[c]} onChange={(e) => setCats((v) => ({ ...v, [c]: e.target.value }))} placeholder="—" />
            </label>
          ))}
        </div>
      </Field>
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" onClick={save}>
          保存预算
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onDone}>
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * 按天消费趋势：单系列柱图（本币），悬停显示当天金额与笔数；
 * 有总预算时画一条"日均预算"参考线。附表格视图保证可读性。
 */
function TrendChart({ trip, expenses, budget }: { trip: Trip; expenses: Expense[]; budget?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const days = useMemo(() => {
    const m = new Map<string, { total: number; count: number }>();
    for (const e of expenses) {
      const d = e.occurredAt.slice(0, 10);
      const cur = m.get(d) ?? { total: 0, count: 0 };
      m.set(d, { total: round2(cur.total + homeAmount(e)), count: cur.count + 1 });
    }
    // 行程日期范围内补零，让空白日也占一格
    if (trip.startDate && trip.endDate && trip.endDate >= trip.startDate) {
      const d = new Date(trip.startDate + "T00:00:00");
      const end = new Date(trip.endDate + "T00:00:00");
      for (let i = 0; i < 60 && d <= end; i++, d.setDate(d.getDate() + 1)) {
        const k = d.toISOString().slice(0, 10);
        if (!m.has(k)) m.set(k, { total: 0, count: 0 });
      }
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));
  }, [expenses, trip.startDate, trip.endDate]);
  if (days.length === 0) return null;

  const W = 560;
  const H = 160;
  const padL = 8;
  const padB = 22;
  const padT = 14;
  const max = Math.max(...days.map((d) => d.total), 1);
  const nDays = days.length;
  const dailyBudget = budget && nDays ? budget / nDays : undefined;
  const yMax = Math.max(max, dailyBudget ?? 0) * 1.1;
  const slot = (W - padL * 2) / nDays;
  const barW = Math.max(6, Math.min(28, slot - 2));
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / yMax);
  const ticks = [0, 0.5, 1].map((f) => round2(yMax * f));

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-ink-400">按天消费（{trip.currency}）</h3>
        <button className="text-xs text-ink-400 underline" onClick={() => setTable((t) => !t)}>
          {table ? "看图" : "看表"}
        </button>
      </div>
      {table ? (
        <table className="w-full text-xs">
          <thead className="text-ink-400">
            <tr>
              <th className="py-1 text-left font-medium">日期</th>
              <th className="py-1 text-right font-medium">笔数</th>
              <th className="py-1 text-right font-medium">金额</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date} className="border-t border-ink-100">
                <td className="py-1">{d.date.slice(5)}</td>
                <td className="py-1 text-right">{d.count}</td>
                <td className="py-1 text-right tabular-nums">{money(d.total, trip.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" role="img" aria-label={`按天消费柱图，共 ${nDays} 天`} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W - padL} y1={y(t)} y2={y(t)} stroke="var(--c-ink-200)" strokeWidth={1} strokeDasharray={t === 0 ? undefined : "2 4"} />
              </g>
            ))}
            {dailyBudget && (
              <g>
                <line x1={padL} x2={W - padL} y1={y(dailyBudget)} y2={y(dailyBudget)} stroke="var(--c-warn-700)" strokeWidth={1.5} strokeDasharray="4 3" />
                <text x={W - padL} y={y(dailyBudget) - 4} textAnchor="end" fontSize={10} fill="var(--c-warn-700)">
                  日均预算 {money(round2(dailyBudget), trip.currency)}
                </text>
              </g>
            )}
            {days.map((d, i) => {
              const cx = padL + slot * i + slot / 2;
              const top = y(d.total);
              const h = Math.max(0, y(0) - top);
              const on = hover === i;
              return (
                <g key={d.date} onMouseEnter={() => setHover(i)} onClick={() => setHover(on ? null : i)}>
                  <rect x={cx - slot / 2} y={padT} width={slot} height={H - padT - padB} fill="transparent" />
                  {h > 0 && <rect x={cx - barW / 2} y={top} width={barW} height={h} rx={4} fill={dailyBudget && d.total > dailyBudget ? "var(--c-danger-700)" : "var(--c-brand-600)"} opacity={hover == null || on ? 1 : 0.45} />}
                  {h > 0 && <rect x={cx - barW / 2} y={y(0) - Math.min(h, 4)} width={barW} height={Math.min(h, 4)} fill={dailyBudget && d.total > dailyBudget ? "var(--c-danger-700)" : "var(--c-brand-600)"} opacity={hover == null || on ? 1 : 0.45} />}
                  {(nDays <= 10 || i % Math.ceil(nDays / 8) === 0) && (
                    <text x={cx} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--c-ink-400)">
                      {d.date.slice(5)}
                    </text>
                  )}
                  {on && (
                    <text x={cx} y={top - 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--c-ink-900)">
                      {money(d.total, trip.currency)} · {d.count} 笔
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
