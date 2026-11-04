"use client";
import { useSyncExternalStore } from "react";
import { newId } from "./ids";
import { SEED } from "./seed";
import type { AuditEntry, Expense, ExpensePatch, Prefs, Settlement, Trip } from "./types";

/**
 * 全部数据存在浏览器 localStorage。服务端 AI 接口只接收账本快照并返回建议，
 * 从不写入 —— 这是"Agent 只读账目、用户确认修改"的硬边界。
 * 云同步（lib/sync）是唯一的例外：它把本机变更推到服务端、把别人的变更拉回来，
 * 通过 applyRemote 写入而不产生审计记录。
 */
const KEY = "tripsplit.v1";

export type State = { trips: Trip[]; expenses: Expense[]; audit: AuditEntry[]; prefs: Prefs };

const DEFAULT_PREFS: Prefs = { habits: [], lastReconcile: {} };
const EMPTY: State = { trips: [], expenses: [], audit: [], prefs: DEFAULT_PREFS };
let state: State = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();
/** 本机写入后的回调（云同步用），remote 写入不会触发。 */
let localChangeHook: ((s: State, changed: { tripIds: string[]; deletedExpenseIds?: string[] }) => void) | null = null;

function normalize(raw: Partial<State>): State {
  return {
    trips: raw.trips ?? [],
    expenses: raw.expenses ?? [],
    audit: raw.audit ?? [],
    prefs: { ...DEFAULT_PREFS, ...(raw.prefs ?? {}) },
  };
}

function load(): State {
  if (loaded) return state;
  loaded = true;
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? normalize(JSON.parse(raw) as Partial<State>) : normalize(SEED());
    if (!raw) persist();
  } catch {
    state = normalize(SEED());
  }
  return state;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("localStorage 写入失败", e);
  }
}

function set(next: State, changedTripIds?: string[], deletedExpenseIds?: string[]) {
  state = next;
  persist();
  listeners.forEach((l) => l());
  if (changedTripIds?.length) localChangeHook?.(state, { tripIds: changedTripIds, deletedExpenseIds });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore(): State {
  return useSyncExternalStore(subscribe, load, () => EMPTY);
}
export const getState = () => load();
export const subscribeStore = subscribe;
export function setLocalChangeHook(h: typeof localChangeHook) {
  localChangeHook = h;
}

const now = () => new Date().toISOString();

function log(entry: Omit<AuditEntry, "id" | "at">): AuditEntry {
  return { id: newId("a"), at: now(), ...entry };
}

/** 账本锁定后拒绝增删改；返回 true 表示被拒。 */
function lockedGuard(tripId: string): boolean {
  const t = load().trips.find((x) => x.id === tripId);
  if (t?.locked) {
    if (typeof window !== "undefined") alert("这次旅行已全部结清并锁定，先在「结算」里解锁再改账。");
    return true;
  }
  return false;
}

export const actions = {
  createTrip(input: Omit<Trip, "id" | "createdAt">): Trip {
    const trip: Trip = { ...input, id: newId("t"), createdAt: now() };
    set({ ...load(), trips: [trip, ...state.trips] }, [trip.id]);
    return trip;
  },
  updateTrip(id: string, patch: Partial<Trip>) {
    set({ ...load(), trips: state.trips.map((t) => (t.id === id ? { ...t, ...patch } : t)) }, [id]);
  },
  deleteTrip(id: string) {
    const s = load();
    set(
      {
        ...s,
        trips: s.trips.filter((t) => t.id !== id),
        expenses: s.expenses.filter((e) => e.tripId !== id),
        audit: s.audit.filter((a) => a.tripId !== id),
      },
      [id],
    );
  },
  addExpense(input: Omit<Expense, "id" | "createdAt" | "updatedAt">, origin: AuditEntry["origin"] = "user"): Expense {
    if (lockedGuard(input.tripId)) throw new Error("locked");
    const e: Expense = { ...input, id: newId("e"), createdAt: now(), updatedAt: now() };
    const s = load();
    set(
      {
        ...s,
        expenses: [e, ...s.expenses],
        audit: [log({ tripId: e.tripId, action: "create", expenseId: e.id, origin, summary: `新增 ${e.note || e.category} ${e.currency === "CNY" ? "¥" : e.currency + " "}${e.amount}`, after: e }), ...s.audit],
      },
      [e.tripId],
    );
    return e;
  },
  /** 批量入账（截图批量导入 / 账单导入），一条审计记录。 */
  addExpenses(inputs: Omit<Expense, "id" | "createdAt" | "updatedAt">[], origin: AuditEntry["origin"] = "user"): Expense[] {
    if (inputs.length === 0) return [];
    if (lockedGuard(inputs[0].tripId)) throw new Error("locked");
    const es: Expense[] = inputs.map((i) => ({ ...i, id: newId("e"), createdAt: now(), updatedAt: now() }));
    const s = load();
    set(
      {
        ...s,
        expenses: [...es, ...s.expenses],
        audit: [log({ tripId: es[0].tripId, action: "create", origin, summary: `批量新增 ${es.length} 笔（${es.map((e) => e.note || e.category).slice(0, 3).join("、")}${es.length > 3 ? "…" : ""}）` }), ...s.audit],
      },
      [es[0].tripId],
    );
    return es;
  },
  updateExpense(id: string, patch: ExpensePatch & Partial<Pick<Expense, "status" | "shares" | "confidence" | "evidence">>, origin: AuditEntry["origin"] = "user") {
    const s = load();
    const before = s.expenses.find((e) => e.id === id);
    if (!before) return;
    if (lockedGuard(before.tripId)) return;
    const after: Expense = { ...before, ...patch, updatedAt: now() };
    set(
      {
        ...s,
        expenses: s.expenses.map((e) => (e.id === id ? after : e)),
        audit: [log({ tripId: before.tripId, action: "update", expenseId: id, origin, summary: describePatch(before, patch), before, after }), ...s.audit],
      },
      [before.tripId],
    );
  },
  deleteExpense(id: string, origin: AuditEntry["origin"] = "user") {
    const s = load();
    const before = s.expenses.find((e) => e.id === id);
    if (!before) return;
    if (lockedGuard(before.tripId)) return;
    set(
      {
        ...s,
        expenses: s.expenses.filter((e) => e.id !== id),
        audit: [log({ tripId: before.tripId, action: "delete", expenseId: id, origin, summary: `删除 ${before.note || before.category} ¥${before.amount}`, before }), ...s.audit],
      },
      [before.tripId],
      [id],
    );
  },

  /* ---------- 结算 / 还款跟踪 ---------- */
  markPaid(tripId: string, t: Omit<Settlement, "paidAt">) {
    const s = load();
    const trip = s.trips.find((x) => x.id === tripId);
    if (!trip) return;
    const settlements = [...(trip.settlements ?? []), { ...t, paidAt: now() }];
    set(
      {
        ...s,
        trips: s.trips.map((x) => (x.id === tripId ? { ...x, settlements } : x)),
        audit: [log({ tripId, action: "settle", origin: "user", summary: `标记已转：${t.from} → ${t.to} ¥${t.amount}` }), ...s.audit],
      },
      [tripId],
    );
  },
  unmarkPaid(tripId: string, index: number) {
    const s = load();
    const trip = s.trips.find((x) => x.id === tripId);
    if (!trip) return;
    const settlements = (trip.settlements ?? []).filter((_, i) => i !== index);
    set({ ...s, trips: s.trips.map((x) => (x.id === tripId ? { ...x, settlements, locked: false } : x)) }, [tripId]);
  },
  setLocked(tripId: string, locked: boolean) {
    const s = load();
    set(
      {
        ...s,
        trips: s.trips.map((x) => (x.id === tripId ? { ...x, locked } : x)),
        audit: [log({ tripId, action: "settle", origin: "user", summary: locked ? "全部结清，账本已锁定" : "账本已解锁" }), ...s.audit],
      },
      [tripId],
    );
  },

  /* ---------- 预算 / 规则 / 习惯 ---------- */
  setBudget(tripId: string, budget: Trip["budget"]) {
    actions.updateTrip(tripId, { budget });
  },
  addRule(tripId: string, rule: string) {
    const s = load();
    const trip = s.trips.find((x) => x.id === tripId);
    if (!trip || !rule.trim()) return;
    const rules = Array.from(new Set([...(trip.rules ?? []), rule.trim()]));
    set({ ...s, trips: s.trips.map((x) => (x.id === tripId ? { ...x, rules } : x)) }, [tripId]);
  },
  removeRule(tripId: string, rule: string) {
    const s = load();
    set({ ...s, trips: s.trips.map((x) => (x.id === tripId ? { ...x, rules: (x.rules ?? []).filter((r) => r !== rule) } : x)) }, [tripId]);
  },
  addHabit(habit: string) {
    const s = load();
    if (!habit.trim()) return;
    set({ ...s, prefs: { ...s.prefs, habits: Array.from(new Set([...s.prefs.habits, habit.trim()])) } });
  },
  removeHabit(habit: string) {
    const s = load();
    set({ ...s, prefs: { ...s.prefs, habits: s.prefs.habits.filter((h) => h !== habit) } });
  },
  setLastReconcile(tripId: string, fingerprint: string) {
    const s = load();
    set({ ...s, prefs: { ...s.prefs, lastReconcile: { ...s.prefs.lastReconcile, [tripId]: fingerprint } } });
  },
  setPrefs(patch: Partial<Prefs>) {
    const s = load();
    set({ ...s, prefs: { ...s.prefs, ...patch } });
  },

  /** 本机换 id（加入别人分享的旅行时，本机同 id 的示例旅行让路）。不触发同步。 */
  renameTrip(oldId: string, newId: string) {
    const s = load();
    set({
      ...s,
      trips: s.trips.map((t) => (t.id === oldId ? { ...t, id: newId } : t)),
      expenses: s.expenses.map((e) => (e.tripId === oldId ? { ...e, tripId: newId } : e)),
      audit: s.audit.map((a) => (a.tripId === oldId ? { ...a, tripId: newId } : a)),
      prefs: { ...s.prefs, lastReconcile: Object.fromEntries(Object.entries(s.prefs.lastReconcile).map(([k, v]) => [k === oldId ? newId : k, v])) },
    });
  },

  /* ---------- 云同步写入：不产生审计记录、不触发本机变更回调 ---------- */
  applyRemote(tripId: string, remote: { trip: Trip; expenses: Expense[]; audit: AuditEntry[] }) {
    const s = load();
    const others = <T extends { tripId: string }>(list: T[]): T[] => list.filter((x) => x.tripId !== tripId);
    set({
      ...s,
      trips: s.trips.some((t) => t.id === tripId) ? s.trips.map((t) => (t.id === tripId ? remote.trip : t)) : [remote.trip, ...s.trips],
      expenses: [...remote.expenses, ...others(s.expenses)],
      audit: [...remote.audit, ...others(s.audit)].sort((a, b) => b.at.localeCompare(a.at)),
    });
  },

  resetDemo() {
    set(normalize(SEED()));
  },
};

/** 账本指纹：账目 id + updatedAt 的摘要，变了就说明核账结论可能过期。 */
export function fingerprint(expenses: Expense[]): string {
  return expenses
    .map((e) => `${e.id}@${e.updatedAt}`)
    .sort()
    .join("|");
}

export function describePatch(before: Expense, patch: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const old = (before as Record<string, unknown>)[k];
    if (JSON.stringify(old) !== JSON.stringify(v)) parts.push(`${k}: ${fmt(old)} → ${fmt(v)}`);
  }
  return parts.length ? `修改 ${before.note || before.category}：${parts.join("；")}` : "无变化";
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) return `[${v.join(",")}]`;
  if (v == null) return "空";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
