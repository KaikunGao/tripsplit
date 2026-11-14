"use client";
import { useEffect, useRef, useState } from "react";
import { ChangePreview } from "@/components/ChangePreview";
import { ExpenseCard } from "@/components/ExpenseCard";
import { Badge, Empty, Icon, Section, Skeleton, SkeletonCard, Spinner } from "@/components/ui";
import type { ReconcileResult } from "@/lib/agent/run";
import { demoResults } from "@/lib/demo";
import { actions, fingerprint, useStore } from "@/lib/store";
import type { Expense, ProposedChange, Trip } from "@/lib/types";

const SEV = { high: "danger", medium: "warn", low: "gray" } as const;
const SEV_LABEL = { high: "高", medium: "中", low: "低" } as const;
const TYPE: Record<string, string> = { duplicate: "重复录入", participants: "参与人", payer: "付款人", amount_outlier: "金额异常", pending: "待补全", date: "日期", other: "其他" };

type Finding = ReconcileResult["findings"][number];

export function ReconcilePanel({ trip, expenses, autoRun = false }: { trip: Trip; expenses: Expense[]; autoRun?: boolean }) {
  const { prefs } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /* 示例旅行：账本没动过时直接展示预先跑好的一次真实核账结果，不用先等 30 秒 */
  const [res, setRes] = useState<ReconcileResult | null>(() => demoResults(trip, expenses)?.reconcile ?? null);
  const [preset, setPreset] = useState(() => res != null);
  const [applied, setApplied] = useState<Record<string, "applied" | "ignored">>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showTrace, setShowTrace] = useState(false);

  async function run() {
    setBusy(true);
    setErr("");
    setRes(null);
    setPreset(false);
    setApplied({});
    setOpen({});
    try {
      const r = await fetch("/api/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip, expenses, habits: prefs.habits }) });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error ?? "核账失败");
      setRes(data);
      actions.setLastReconcile(trip.id, fingerprint(expenses));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "核账失败");
    } finally {
      setBusy(false);
    }
  }

  /* 从结算页跳过来的"先核账"：挂载后自动跑一次（ref 防重复，不用 state） */
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoRun && !autoStarted.current && expenses.length > 0) {
      autoStarted.current = true;
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  /** 忽略并把理由记成规则：本次旅行规则（Agent 下次不再报）或长期习惯（录入和核账都参考）。 */
  function ignore(f: Finding, reason: string, scope: "none" | "trip" | "habit") {
    setApplied((s) => ({ ...s, [f.id]: "ignored" }));
    const text = reason.trim();
    if (!text || scope === "none") return;
    if (scope === "trip") actions.addRule(trip.id, text);
    else actions.addHabit(text);
  }

  function apply(fid: string, c: ProposedChange) {
    if (c.action === "delete") actions.deleteExpense(c.expenseId, "agent-confirmed");
    else if (c.patch) actions.updateExpense(c.expenseId, c.patch, "agent-confirmed");
    setApplied((s) => ({ ...s, [fid]: "applied" }));
  }

  /** 一键接受：只处理高危且带修改建议、且还没被处理过的条目。 */
  const highTodo = (res?.findings ?? []).filter((f) => f.severity === "high" && f.proposed_change && !applied[f.id]);
  function applyAllHigh() {
    if (!confirm(`接受 ${highTodo.length} 条高危建议并立即应用？每条都会写入修改记录，可在账本里再改回来。`)) return;
    for (const f of highTodo) apply(f.id, f.proposed_change!);
  }

  const byId = (id: string) => expenses.find((e) => e.id === id);
  const counts = (res?.findings ?? []).reduce((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {} as Record<string, number>);
  const done = Object.values(applied).length;

  return (
    <div className="space-y-4">
      <Section
        title="核账"
        right={
          <button className="btn btn-primary" disabled={busy || expenses.length === 0} onClick={run}>
            {busy ? <Spinner /> : <Icon name="shield" className="h-4 w-4" />} {busy ? "核查中…" : res ? "重新核账" : "开始核账"}
          </button>
        }
      >
        <p className="text-sm text-ink-600">
          核账<b>只读不写</b>：先跑规则体检、查重、分类统计和结算预览，再由模型把结果和全部账目逐项核对，提交带证据的结论。所有修改建议都要你逐条确认才会生效。
        </p>
        {preset && res && <p className="mt-2 rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-700">下面是对这本示例账跑出的一次真实核账结果，可以直接逐条确认或忽略，账本、预算和结算会跟着变。点「重新核账」会现场再跑一遍，约 30 秒。</p>}
        {err && <p className="mt-2 text-sm text-danger-700">{err}</p>}
      </Section>

      {busy && (
        <>
          <div className="card p-4">
            <div className="mb-2 flex items-center gap-2 text-sm text-ink-600">
              <Spinner /> 正在核查，通常需要 20 到 40 秒
            </div>
            <Skeleton lines={2} />
          </div>
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </>
      )}

      {!busy && !res && (trip.rules?.length || prefs.habits.length) ? <RulesSection trip={trip} habits={prefs.habits} /> : null}

      {!busy && !res && expenses.length === 0 && (
        <div className="card">
          <Empty icon={<Icon name="shield" className="h-6 w-6" />} title="还没有可核的账" hint="先录几笔消费，再来查重、查漏、查异常。" compact />
        </div>
      )}

      {res && (
        <>
          {/* 摘要行：结论 + 按严重度计数 + 一键接受 */}
          <Section
            title="结论"
            right={
              <span className="hidden text-xs text-ink-400 sm:inline">
                {res.mode === "pipeline" ? `${res.trace.filter((t) => t.kind === "tool" && t.name !== "get_trip" && t.name !== "list_expenses").length} 项检查 · 1 次模型调用` : `${res.usage.turns} 轮 · ${res.trace.filter((t) => t.kind === "tool").length} 次工具调用`}
              </span>
            }
          >
            <p className="text-sm">{res.summary}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {(["high", "medium", "low"] as const).map((s) => counts[s] > 0 && (
                <Badge key={s} tone={SEV[s]}>
                  {SEV_LABEL[s]} {counts[s]}
                </Badge>
              ))}
              {res.findings.length === 0 && <Badge tone="ok">没有发现问题</Badge>}
              {done > 0 && <span className="text-xs text-ink-400">已处理 {done} / {res.findings.length}</span>}
              {highTodo.length > 0 && (
                <button className="btn btn-danger btn-sm ml-auto" onClick={applyAllHigh}>
                  <Icon name="check" className="h-3.5 w-3.5" /> 一键接受 {highTodo.length} 条高危建议
                </button>
              )}
            </div>
          </Section>

          {res.findings.map((f) => (
            <FindingCard key={f.id} f={f} trip={trip} byId={byId} open={!!open[f.id]} onToggle={() => setOpen((s) => ({ ...s, [f.id]: !s[f.id] }))} applied={applied[f.id]} onApply={() => apply(f.id, f.proposed_change!)} onIgnore={(reason, scope) => ignore(f, reason, scope)} />
          ))}

          <RulesSection trip={trip} habits={prefs.habits} />

          <div>
            <button className="text-xs text-ink-400 underline" onClick={() => setShowTrace((s) => !s)}>
              {showTrace ? "收起" : "查看"}{res.mode === "pipeline" ? "检查过程" : " Agent 执行轨迹"}（{(res.usage.input / 1000).toFixed(1)}k 入 / {res.usage.output} 出）
            </button>
            {showTrace && (
              <ol className="mt-2 space-y-2">
                {res.trace.map((t, i) => (
                  <li key={i} className="rounded-xl bg-surface p-3 text-xs shadow-sm">
                    {t.kind === "plan" && (
                      <>
                        <Badge tone="brand">Planning</Badge>
                        <p className="mt-1 whitespace-pre-wrap">{t.text}</p>
                      </>
                    )}
                    {t.kind === "text" && <p className="whitespace-pre-wrap text-ink-600">{t.text}</p>}
                    {t.kind === "tool" && (
                      <>
                        <div className="flex items-center gap-2">
                          <Badge>{res.mode === "pipeline" ? "检查" : "工具"}</Badge>
                          <span className="mono font-semibold">{t.name}</span>
                          <span className="text-ink-400">{t.ms}ms</span>
                        </div>
                        <pre className="mono mt-1 overflow-x-auto text-ink-400">入参 {JSON.stringify(t.input)}</pre>
                        <pre className="mono mt-1 max-h-40 overflow-auto text-ink-600">回传 {JSON.stringify(t.output, null, 1)}</pre>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 发现卡：默认折叠成一行标题 + 一句建议 + 操作；展开看证据、相关账目和字段级预览。 */
function FindingCard({ f, trip, byId, open, onToggle, applied, onApply, onIgnore }: { f: Finding; trip: Trip; byId: (id: string) => Expense | undefined; open: boolean; onToggle: () => void; applied?: "applied" | "ignored"; onApply: () => void; onIgnore: (reason: string, scope: "none" | "trip" | "habit") => void }) {
  const state = applied === "applied" ? "border-ok-700/30" : applied === "ignored" ? "opacity-60" : "";
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const ignoreUi = (
    <div className="mt-2 space-y-2 rounded-xl bg-paper p-3 text-sm">
      <p className="text-xs text-ink-600">为什么忽略？写一句，下次核账就不再报这种情况（可不填）。</p>
      <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`例：${f.type === "payer" ? "阿强只付钱不吃，是请客" : f.type === "duplicate" ? "这两笔确实是两顿" : "这笔没问题"}`} autoFocus />
      <div className="flex flex-wrap gap-1.5">
        <button className="btn btn-ghost btn-sm" onClick={() => onIgnore(reason, "trip")} disabled={!reason.trim()}>
          记为本次旅行规则
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => onIgnore(reason, "habit")} disabled={!reason.trim()}>
          记为长期习惯
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => onIgnore("", "none")}>
          仅忽略
        </button>
        <button className="btn btn-sm ml-auto text-ink-400" onClick={() => setAsking(false)}>
          取消
        </button>
      </div>
    </div>
  );
  return (
    <section className={`card overflow-hidden ${state}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 p-4 text-left" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={SEV[f.severity]}>{SEV_LABEL[f.severity]}</Badge>
            <Badge>{TYPE[f.type] ?? f.type}</Badge>
            {applied === "applied" && <Badge tone="ok">已应用</Badge>}
            {applied === "ignored" && <Badge>已忽略</Badge>}
          </div>
          <h3 className="mt-1 font-semibold leading-snug">{f.title}</h3>
          {!open && <p className="mt-1 line-clamp-2 text-sm text-ink-600">{f.suggestion}</p>}
        </div>
        <Icon name="chevron" className={`mt-1 h-4 w-4 shrink-0 text-ink-400 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-ink-100 px-4 pb-4 pt-3">
          <p className="text-sm text-ink-600">
            <b>证据：</b>
            {f.evidence}
          </p>
          <p className="text-sm text-ink-600">
            <b>建议：</b>
            {f.suggestion}
          </p>
          {f.expense_ids.length > 0 && (
            <div className="space-y-1.5">
              {f.expense_ids.map((id) => {
                const e = byId(id);
                return e ? <ExpenseCard key={id} trip={trip} e={e} /> : <p key={id} className="text-xs text-ink-400">#{id} 已不存在</p>;
              })}
            </div>
          )}
        </div>
      )}

      {!f.proposed_change && !applied && (
        <div className="px-4 pb-4">
          <div className="flex gap-2">
            <button className="btn btn-ghost btn-sm" onClick={() => setAsking((a) => !a)}>
              忽略
            </button>
            {!open && (
              <button className="btn btn-ghost btn-sm ml-auto" onClick={onToggle}>
                看证据
              </button>
            )}
          </div>
          {asking && ignoreUi}
        </div>
      )}
      {f.proposed_change && (
        <div className={`px-4 pb-4 ${open ? "" : "pt-0"}`}>
          {open ? (
            <>
              <ChangePreview trip={trip} expense={byId(f.proposed_change.expenseId)} change={f.proposed_change} applied={applied} onApply={onApply} onIgnore={() => setAsking(true)} />
              {asking && !applied && ignoreUi}
            </>
          ) : (
            !applied && (
              <>
                <div className="flex gap-2">
                  <button className={`btn btn-sm ${f.proposed_change.action === "delete" ? "btn-danger" : "btn-primary"}`} onClick={onApply}>
                    确认{f.proposed_change.action === "delete" ? "删除" : "修改"}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAsking((a) => !a)}>
                    忽略
                  </button>
                  <button className="btn btn-ghost btn-sm ml-auto" onClick={onToggle}>
                    看证据
                  </button>
                </div>
                {asking && ignoreUi}
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}

/** Agent 记忆：本次旅行规则（忽略理由回流）+ 跨行程长期习惯，都可手动增删。 */
function RulesSection({ trip, habits }: { trip: Trip; habits: string[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"trip" | "habit">("habit");
  const rules = trip.rules ?? [];
  return (
    <section className="card p-4">
      <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="font-semibold">
          核账记忆 <span className="ml-1 text-xs font-normal text-ink-400">本次规则 {rules.length} · 长期习惯 {habits.length}</span>
        </span>
        <Icon name="chevron" className={`h-4 w-4 text-ink-400 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-xs text-ink-400">忽略建议时填写的理由会落到这里：本次规则只影响这次旅行的核账；长期习惯会同时喂给录入解析和核账。</p>
          <div>
            <h4 className="mb-1 text-xs font-semibold text-ink-400">本次旅行规则</h4>
            {rules.length === 0 && <p className="text-xs text-ink-400">暂无</p>}
            <ul className="space-y-1">
              {rules.map((r) => (
                <li key={r} className="flex items-start justify-between gap-2 rounded-lg bg-paper px-2.5 py-1.5">
                  <span>{r}</span>
                  <button className="shrink-0 text-xs text-ink-400 underline" onClick={() => actions.removeRule(trip.id, r)}>
                    删除
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold text-ink-400">长期习惯（跨行程）</h4>
            {habits.length === 0 && <p className="text-xs text-ink-400">暂无，例如「阿强经常只付钱不吃」「住宿都是我用信用卡付」</p>}
            <ul className="space-y-1">
              {habits.map((h) => (
                <li key={h} className="flex items-start justify-between gap-2 rounded-lg bg-paper px-2.5 py-1.5">
                  <span>{h}</span>
                  <button className="shrink-0 text-xs text-ink-400 underline" onClick={() => actions.removeHabit(h)}>
                    删除
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex gap-2">
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="手动添加一条" onKeyDown={(e) => e.key === "Enter" && text.trim() && ((scope === "trip" ? actions.addRule(trip.id, text) : actions.addHabit(text)), setText(""))} />
            <select className="input w-28" value={scope} onChange={(e) => setScope(e.target.value as "trip" | "habit")}>
              <option value="habit">长期习惯</option>
              <option value="trip">本次规则</option>
            </select>
            <button className="btn btn-ghost" disabled={!text.trim()} onClick={() => ((scope === "trip" ? actions.addRule(trip.id, text) : actions.addHabit(text)), setText(""))}>
              添加
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
