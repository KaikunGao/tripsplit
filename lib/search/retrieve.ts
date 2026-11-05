import type { Expense, Trip } from "../types";
import { homeAmount, memberName, splitOf } from "../settle";

/** 解析后的结构化检索条件（由模型从模糊描述中抽出）。 */
export type Filters = {
  date_from?: string | null;
  date_to?: string | null;
  amount_min?: number | null;
  amount_max?: number | null;
  payer?: string | null;
  participants?: string[];
  category?: string | null;
  keywords?: string[];
};

export type Hit = { expense: Expense; score: number; matched: string[] };

/** 把一笔消费渲染成检索文档，也是喂给模型的证据文本。 */
export function renderExpense(trip: Trip, e: Expense): string {
  const names = trip.members;
  /* 外币同时给出折合本币的金额；不均摊时把每人应摊写出来，模型统计时不用自己猜 */
  const foreign = e.currency !== trip.currency;
  const uneven = e.split && e.split.mode !== "equal";
  return [
    `#${e.id}`,
    `${e.occurredAt.slice(0, 16).replace("T", " ")}`,
    e.category,
    e.note,
    foreign ? `${e.currency} ${e.amount}（折合 ¥${homeAmount(e)}）` : `¥${e.amount}`,
    `付款:${memberName(names, e.payerId)}`,
    `参与:${e.participantIds.map((id) => memberName(names, id)).join("、") || "（空）"}`,
    e.treat ? "请客（付款人不分摊）" : "",
    uneven ? `不均摊，每人应摊:${Object.entries(splitOf(e)).map(([id, v]) => `${memberName(names, id)} ¥${v}`).join(" ")}` : "",
    e.status === "pending" ? "待补全" : "",
    e.evidence?.text ? `证据:${e.evidence.text}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

/** 中文字符二元组 + 数字/字母 token。无需分词库，对模糊描述足够。 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  const clean = s.toLowerCase().replace(/[#|:：,，。、()（）¥￥]/g, " ");
  for (const m of clean.match(/[a-z0-9.]+|[一-鿿]+/g) ?? []) {
    if (/^[a-z0-9.]+$/.test(m)) out.push(m);
    else {
      if (m.length === 1) out.push(m);
      for (let i = 0; i < m.length - 1; i++) out.push(m.slice(i, i + 2));
    }
  }
  return out;
}

function tfidfVectors(docs: string[][]): { vecs: Map<string, number>[]; idf: Map<string, number> } {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log(1 + N / c));
  const vecs = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [t, c] of tf) v.set(t, (1 + Math.log(c)) * (idf.get(t) ?? 0));
    return v;
  });
  return { vecs, idf };
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, x] of a) {
    na += x * x;
    const y = b.get(t);
    if (y) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function passes(trip: Trip, e: Expense, f: Filters): { ok: boolean; matched: string[] } {
  const matched: string[] = [];
  const day = e.occurredAt.slice(0, 10);
  if (f.date_from && day < f.date_from) return { ok: false, matched };
  if (f.date_to && day > f.date_to) return { ok: false, matched };
  if (f.date_from || f.date_to) matched.push("日期");
  if (f.amount_min != null && e.amount < f.amount_min) return { ok: false, matched };
  if (f.amount_max != null && e.amount > f.amount_max) return { ok: false, matched };
  if (f.amount_min != null || f.amount_max != null) matched.push("金额");
  if (f.payer) {
    if (memberName(trip.members, e.payerId) !== f.payer) return { ok: false, matched };
    matched.push("付款人");
  }
  if (f.participants?.length) {
    const names = e.participantIds.map((id) => memberName(trip.members, id));
    if (!f.participants.every((p) => names.includes(p))) return { ok: false, matched };
    matched.push("参与人");
  }
  if (f.category) {
    if (e.category !== f.category) return { ok: false, matched };
    matched.push("分类");
  }
  return { ok: true, matched };
}

/**
 * 混合检索：结构化条件硬过滤 → 语义（TF-IDF 余弦）排序。
 * 条件过滤后为空时放宽为纯语义检索并标记 relaxed，避免"查不到"。
 */
export function retrieve(trip: Trip, expenses: Expense[], query: string, filters: Filters, k = 8): { hits: Hit[]; relaxed: boolean } {
  const docsText = expenses.map((e) => renderExpense(trip, e));
  const { vecs, idf } = tfidfVectors(docsText.map(tokenize));
  const qTokens = tokenize([query, ...(filters.keywords ?? [])].join(" "));
  const qtf = new Map<string, number>();
  for (const t of qTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
  const qvec = new Map<string, number>();
  for (const [t, c] of qtf) qvec.set(t, (1 + Math.log(c)) * (idf.get(t) ?? Math.log(2)));

  const score = (i: number) => cosine(qvec, vecs[i]);
  let relaxed = false;
  let pool = expenses.map((e, i) => ({ e, i, ...passes(trip, e, filters) })).filter((x) => x.ok);
  const hasFilter = !!(filters.date_from || filters.date_to || filters.amount_min != null || filters.amount_max != null || filters.payer || filters.participants?.length || filters.category);
  if (pool.length === 0 && hasFilter) {
    relaxed = true;
    pool = expenses.map((e, i) => ({ e, i, ok: true, matched: [] as string[] }));
  }
  const hits = pool
    .map((x) => ({ expense: x.e, score: score(x.i) + x.matched.length * 0.15, matched: x.matched }))
    .sort((a, b) => b.score - a.score || b.expense.occurredAt.localeCompare(a.expense.occurredAt))
    .slice(0, k);
  return { hits, relaxed };
}
