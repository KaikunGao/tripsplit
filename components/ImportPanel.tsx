"use client";
import { useMemo, useRef, useState } from "react";
import { Avatar, AvatarStack } from "@/components/Avatar";
import { ExpenseForm } from "@/components/ExpenseForm";
import { Badge, Icon, Section, Skeleton, Spinner } from "@/components/ui";
import { toolImpl } from "@/lib/agent/tools";
import type { ExtractResponse } from "@/lib/extract/schema";
import { resolveMember } from "@/lib/extract/extract";
import { hhmm, localIso, money } from "@/lib/format";
import { compressImage } from "@/lib/image-client";
import { parseBillCsv } from "@/lib/import/bills";
import type { ImportDraft } from "@/lib/import/import";
import { memberName } from "@/lib/settle";
import { actions, getState } from "@/lib/store";
import type { Category, Expense, Trip } from "@/lib/types";

type Mode = "images" | "bill" | "text";

/** 待确认的草稿：和 Expense 同构，外加来源线索与标记。 */
type Draft = {
  key: string;
  amount: number;
  currency: string;
  payerId: string;
  participantIds: string[];
  treat?: boolean;
  category: Category;
  note: string;
  occurredAt: string;
  confidence: number;
  source: Expense["source"];
  evidence?: Expense["evidence"];
  /** 需要补全的字段 */
  missing: string[];
  /** 模型判断与行程无关 */
  irrelevant?: boolean;
  reason?: string;
  /** 与账本里已有账目疑似重复（id）或批内重复（key） */
  dupOf?: string;
  selected: boolean;
};

/**
 * 批量导入：多张截图 / 支付宝微信账单 CSV / 粘贴订单文本。
 * 流程：解析 → 草稿列表（自动查重、标出缺字段和不相关项）→ 用户勾选确认 → 一次入账。
 */
export function ImportPanel({ trip, expenses }: { trip: Trip; expenses: Expense[] }) {
  const [mode, setMode] = useState<Mode>("images");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [err, setErr] = useState("");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const self = trip.selfMemberId ?? trip.members[0].id;
  const habits = getState().prefs.habits;

  /* ---------- 查重：和账本已有账目比，也在批内比 ---------- */
  function markDuplicates(list: Draft[]): Draft[] {
    const fake: Expense[] = list.map((d) => ({ ...d, id: d.key, tripId: trip.id, createdAt: "", updatedAt: "", status: "confirmed" as const }));
    const snap = { trip, expenses: [...expenses, ...fake] };
    const pairs = toolImpl.find_duplicates({ snap }, { window_minutes: 120, amount_tolerance: 0 }) as { a: string; b: string }[];
    const dup = new Map<string, string>();
    for (const p of pairs) {
      const aNew = p.a.startsWith("d_");
      const bNew = p.b.startsWith("d_");
      if (bNew && !dup.has(p.b)) dup.set(p.b, p.a);
      else if (aNew && !bNew && !dup.has(p.a)) dup.set(p.a, p.b);
    }
    return list.map((d) => ({ ...d, dupOf: dup.get(d.key), selected: d.selected && !dup.get(d.key) }));
  }

  /* ---------- 截图批量 ---------- */
  async function runImages(files: File[]) {
    setBusy(true);
    setErr("");
    setDrafts(null);
    setDone(null);
    const out: Draft[] = [];
    let i = 0;
    const worker = async () => {
      while (i < files.length) {
        const idx = i++;
        const f = files[idx];
        setProgress(`识别第 ${idx + 1} / ${files.length} 张…`);
        try {
          const big = await compressImage(f, 1280, 0.85);
          const small = await compressImage(f, 360, 0.7);
          const res = await fetch("/api/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip, kind: "image", image: { media_type: "image/jpeg", data: big.base64 }, habits }) });
          const data = (await res.json()) as ExtractResponse | { ok: false; error: string };
          if (!data.ok) throw new Error(data.error);
          if (data.decision === "reject") {
            out[idx] = { key: `d_${idx}`, amount: 0, currency: trip.currency, payerId: self, participantIds: [], category: "其他", note: f.name, occurredAt: localIso(), confidence: 0, source: "image", evidence: { kind: "image", thumbnail: small.dataUrl }, missing: ["amount"], irrelevant: true, reason: data.reason, selected: false };
            continue;
          }
          const d = data.draft;
          out[idx] = {
            key: `d_${idx}`,
            amount: d.amount ?? 0,
            currency: d.currency,
            payerId: d.payerId ?? self,
            participantIds: d.participantIds ?? [],
            treat: d.treat || undefined,
            category: d.category ?? "其他",
            note: d.note ?? "",
            occurredAt: d.occurredAt ?? localIso(),
            confidence: d.confidence,
            source: "image",
            evidence: { kind: "image", text: data.raw.note, thumbnail: small.dataUrl },
            missing: data.missing,
            reason: data.reason,
            selected: data.decision === "auto",
          };
        } catch (e) {
          out[idx] = { key: `d_${idx}`, amount: 0, currency: trip.currency, payerId: self, participantIds: [], category: "其他", note: f.name, occurredAt: localIso(), confidence: 0, source: "image", missing: ["amount"], irrelevant: true, reason: e instanceof Error ? e.message : "识别失败", selected: false };
        }
      }
    };
    await Promise.all([worker(), worker()]);
    setDrafts(markDuplicates(out.filter(Boolean)));
    setBusy(false);
    setProgress("");
  }

  /* ---------- 账单 CSV ---------- */
  async function runBill(file: File) {
    setBusy(true);
    setErr("");
    setDrafts(null);
    setDone(null);
    try {
      const buf = await file.arrayBuffer();
      let txt = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      if (!/交易时间/.test(txt)) {
        try {
          txt = new TextDecoder("gbk").decode(buf);
        } catch {}
      }
      const { rows, source, skipped } = parseBillCsv(txt);
      if (rows.length === 0) throw new Error(`没解析出支出明细（跳过 ${skipped} 行）。支持支付宝 / 微信账单导出的 CSV。`);
      // 只保留行程日期范围内（前后各放宽 1 天）
      const lo = trip.startDate ? new Date(new Date(trip.startDate).getTime() - 864e5).toISOString().slice(0, 10) : "";
      const hi = trip.endDate ? new Date(new Date(trip.endDate).getTime() + 864e5).toISOString().slice(0, 10) : "9999";
      const inRange = rows.filter((r) => r.time.slice(0, 10) >= lo && r.time.slice(0, 10) <= hi);
      const use = inRange.length ? inRange : rows;
      setProgress(`${source === "alipay" ? "支付宝" : source === "wechat" ? "微信" : "通用"}账单：${rows.length} 笔支出，行程内 ${inRange.length} 笔，正在分类…`);
      const res = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip, rows: use.slice(0, 200), habits }) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "分类失败");
      const list: Draft[] = (data.drafts as ImportDraft[]).map((d, i) => fromDraft(d, `d_${i}`, use[d.index ?? i]?.method ? `${use[d.index ?? i].method} · ${use[d.index ?? i].merchant}` : undefined));
      setDrafts(markDuplicates(list));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  /* ---------- 粘贴订单文本 ---------- */
  async function runText() {
    if (!text.trim()) return;
    setBusy(true);
    setErr("");
    setDrafts(null);
    setDone(null);
    setProgress("正在从订单文本里抽取消费…");
    try {
      const res = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip, text, habits }) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "抽取失败");
      const list: Draft[] = (data.drafts as ImportDraft[]).map((d, i) => fromDraft(d, `d_${i}`, text.slice(0, 200)));
      if (list.length === 0) setErr("没有抽取到消费，检查文本里有没有金额和事项。");
      setDrafts(markDuplicates(list));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  function fromDraft(d: ImportDraft, key: string, evidenceText?: string): Draft {
    const payer = resolveMember(trip.members, d.payer);
    const parts = d.participants.map((n) => resolveMember(trip.members, n)).filter((m): m is NonNullable<typeof m> => !!m).map((m) => m.id);
    const participantIds = parts.length ? parts : trip.members.map((m) => m.id);
    const missing = parts.length ? [] : ["participants"];
    return {
      key,
      amount: d.amount,
      currency: d.currency || trip.currency,
      payerId: payer?.id ?? self,
      participantIds,
      category: d.category,
      note: d.note,
      occurredAt: d.occurred_at.length === 16 ? d.occurred_at + ":00" : d.occurred_at,
      confidence: d.confidence,
      source: "agent",
      evidence: evidenceText ? { kind: "agent", text: evidenceText } : undefined,
      missing,
      irrelevant: !d.relevant,
      reason: d.reason,
      selected: d.relevant && d.confidence >= 0.6,
    };
  }

  function confirmSelected() {
    if (!drafts) return;
    const chosen = drafts.filter((d) => d.selected && d.amount > 0);
    if (chosen.length === 0) return;
    const es = actions.addExpenses(
      chosen.map((d) => ({
        tripId: trip.id,
        amount: d.amount,
        currency: d.currency,
        payerId: d.payerId,
        participantIds: d.participantIds,
        treat: d.treat,
        category: d.category,
        note: d.note,
        occurredAt: d.occurredAt,
        source: d.source,
        confidence: d.confidence,
        status: d.missing.length ? "pending" : "confirmed",
        evidence: d.evidence,
      })),
    );
    setDone(es.length);
    setDrafts(drafts.filter((d) => !d.selected));
  }

  const stats = useMemo(() => {
    if (!drafts) return null;
    return { total: drafts.length, selected: drafts.filter((d) => d.selected).length, dup: drafts.filter((d) => d.dupOf).length, irrelevant: drafts.filter((d) => d.irrelevant).length, missing: drafts.filter((d) => d.missing.length && !d.irrelevant).length };
  }, [drafts]);

  return (
    <Section title="批量导入">
      <div className="mb-3 grid grid-cols-3 rounded-xl bg-ink-100 p-1 text-sm" role="tablist">
        {(
          [
            ["images", "多张截图", "image"],
            ["bill", "账单文件", "list"],
            ["text", "订单文本", "text"],
          ] as [Mode, string, "image" | "list" | "text"][]
        ).map(([k, label, icon]) => (
          <button key={k} role="tab" aria-selected={mode === k} className={`flex items-center justify-center gap-1.5 rounded-lg py-1.5 font-medium transition ${mode === k ? "bg-surface text-ink-900 shadow-sm" : "text-ink-600"}`} onClick={() => (setMode(k), setDrafts(null), setErr(""), setDone(null))}>
            <Icon name={icon} className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {mode === "images" && (
        <div>
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && runImages([...e.target.files].slice(0, 20))} />
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed border-ink-200 py-5 text-sm text-ink-600 hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50">
            <Icon name="image" className="h-6 w-6 text-ink-400" />
            选择多张支付截图（最多 20 张）
            <span className="text-xs text-ink-400">逐张识别金额、商户、时间，自动和账本查重；付款人默认是你，参与人默认全员</span>
          </button>
        </div>
      )}
      {mode === "bill" && (
        <div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && runBill(e.target.files[0])} />
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed border-ink-200 py-5 text-sm text-ink-600 hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50">
            <Icon name="list" className="h-6 w-6 text-ink-400" />
            选择支付宝 / 微信账单 CSV
            <span className="text-xs text-ink-400">支付宝：我的 → 账单 → 右上角 ··· → 开具交易流水证明 → 用于个人对账；微信：我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单</span>
          </button>
        </div>
      )}
      {mode === "text" && (
        <div className="space-y-2">
          <textarea className="input min-h-28" value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴携程 / 美团 / 航司的订单确认短信或邮件，可以一次贴多条。例如：&#10;【携程】您预订的成都瑞吉酒店 10月1日-10月3日 大床房 2间 已确认，订单金额 ¥2,560…" />
          <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={runText}>
            {busy ? <Spinner /> : null} 抽取消费
          </button>
        </div>
      )}

      {busy && (
        <div className="mt-3">
          <div className="mb-2 flex items-center gap-2 text-sm text-ink-600">
            <Spinner /> {progress || "处理中…"}
          </div>
          <Skeleton lines={3} />
        </div>
      )}
      {err && <p className="mt-2 text-sm text-danger-700">{err}</p>}
      {done != null && <p className="mt-2 text-sm text-ok-700">✓ 已入账 {done} 笔{drafts && drafts.length ? `，还剩 ${drafts.length} 条未处理` : ""}。</p>}

      {drafts && drafts.length > 0 && stats && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge tone="brand">共 {stats.total} 条</Badge>
            {stats.dup > 0 && <Badge tone="danger">{stats.dup} 条疑似重复，已取消勾选</Badge>}
            {stats.irrelevant > 0 && <Badge>{stats.irrelevant} 条可能与行程无关</Badge>}
            {stats.missing > 0 && <Badge tone="warn">{stats.missing} 条缺字段，入账后标为待补全</Badge>}
            <span className="ml-auto flex gap-1">
              <button className="chip" onClick={() => setDrafts(drafts.map((d) => ({ ...d, selected: !d.dupOf && !d.irrelevant && d.amount > 0 })))}>
                勾选可入账
              </button>
              <button className="chip" onClick={() => setDrafts(drafts.map((d) => ({ ...d, selected: false })))}>
                全不选
              </button>
            </span>
          </div>

          <ul className="space-y-2">
            {drafts.map((d) => (
              <li key={d.key} className={`rounded-xl border p-3 ${d.selected ? "border-brand-500 bg-brand-50" : "border-ink-100 bg-surface"} ${d.irrelevant || d.dupOf ? "opacity-80" : ""}`}>
                <div className="flex items-start gap-3">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={d.selected} disabled={d.amount <= 0} onChange={(e) => setDrafts(drafts.map((x) => (x.key === d.key ? { ...x, selected: e.target.checked } : x)))} />
                  {d.evidence?.thumbnail && <img src={d.evidence.thumbnail} alt="" className="h-12 w-12 rounded-lg object-cover" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium">{d.note || d.category}</span>
                      <Badge>{d.category}</Badge>
                      {d.dupOf && <Badge tone="danger">疑似重复：{d.dupOf.startsWith("d_") ? "批内另一条" : expenses.find((e) => e.id === d.dupOf)?.note || "账本已有"}</Badge>}
                      {d.irrelevant && <Badge>可能无关</Badge>}
                      {d.missing.length > 0 && !d.irrelevant && <Badge tone="warn">缺{d.missing.map((m) => ({ amount: "金额", payer: "付款人", participants: "参与人" })[m]).join("、")}</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-600">
                      <span className="text-ink-400">{d.occurredAt.slice(5, 10)} {hhmm(d.occurredAt)}</span>
                      <span className="text-ink-200">·</span>
                      <Avatar name={memberName(trip.members, d.payerId)} size="xs" />
                      <span>付 →</span>
                      {d.participantIds.length ? <AvatarStack members={trip.members} activeIds={d.participantIds} size="xs" /> : <span className="text-danger-700">参与人为空</span>}
                      {d.treat && <Badge tone="brand">请客</Badge>}
                    </div>
                    {d.reason && <p className="mt-1 text-xs text-ink-400">{d.reason}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-semibold tabular-nums">{money(d.amount, d.currency)}</div>
                    <button className="text-xs text-brand-700 underline" onClick={() => setEditing(editing === d.key ? null : d.key)}>
                      {editing === d.key ? "收起" : "改一下"}
                    </button>
                  </div>
                </div>
                {editing === d.key && (
                  <div className="mt-3 border-t border-ink-100 pt-3">
                    <ExpenseForm
                      trip={trip}
                      initial={{ amount: d.amount || undefined, currency: d.currency, payerId: d.payerId, participantIds: d.participantIds, treat: d.treat, category: d.category, note: d.note, occurredAt: d.occurredAt }}
                      missing={d.missing}
                      submitLabel="应用"
                      onCancel={() => setEditing(null)}
                      onSubmit={(v) => {
                        setDrafts(markDuplicates(drafts.map((x) => (x.key === d.key ? { ...x, ...v, missing: [], irrelevant: false, selected: true, confidence: 1 } : x))));
                        setEditing(null);
                      }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2 pt-1">
            <button className="btn btn-primary" disabled={stats.selected === 0} onClick={confirmSelected}>
              <Icon name="check" className="h-4 w-4" /> 入账 {stats.selected} 笔
            </button>
            <button className="btn btn-ghost" onClick={() => (setDrafts(null), setDone(null))}>
              清空
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
