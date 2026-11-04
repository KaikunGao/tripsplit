"use client";
import { useSyncExternalStore } from "react";
import { newId } from "./ids";
import { SEED } from "./seed";
import type { AuditEntry, Expense, ExpensePatch, Trip } from "./types";

/**
 * 全部数据存在浏览器 localStorage。服务端 API 只接收账本快照并返回建议，
 * 从不写入 —— 这是"Agent 只读账目、用户确认修改"的硬边界。
 */
const KEY = "tripsplit.v1";

export type State = { trips: Trip[]; expenses: Expense[]; audit: AuditEntry[] };

const EMPTY: State = { trips: [], expenses: [], audit: [] };
let state: State = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function load(): State {
  if (loaded) return state;
  loaded = true;
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? (JSON.parse(raw) as State) : SEED();
    if (!raw) persist();
  } catch {
    state = SEED();
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

function set(next: State) {
  state = next;
  persist();
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore(): State {
  return useSyncExternalStore(subscribe, load, () => EMPTY);
}

const now = () => new Date().toISOString();

function log(entry: Omit<AuditEntry, "id" | "at">): AuditEntry {
  return { id: newId("a"), at: now(), ...entry };
}

export const actions = {
  createTrip(input: Omit<Trip, "id" | "createdAt">): Trip {
    const trip: Trip = { ...input, id: newId("t"), createdAt: now() };
    set({ ...load(), trips: [trip, ...state.trips] });
    return trip;
  },
  updateTrip(id: string, patch: Partial<Trip>) {
    set({ ...load(), trips: state.trips.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  },
  deleteTrip(id: string) {
    const s = load();
    set({
      trips: s.trips.filter((t) => t.id !== id),
      expenses: s.expenses.filter((e) => e.tripId !== id),
      audit: s.audit.filter((a) => a.tripId !== id),
    });
  },
  addExpense(input: Omit<Expense, "id" | "createdAt" | "updatedAt">, origin: AuditEntry["origin"] = "user"): Expense {
    const e: Expense = { ...input, id: newId("e"), createdAt: now(), updatedAt: now() };
    const s = load();
    set({
      ...s,
      expenses: [e, ...s.expenses],
      audit: [
        log({ tripId: e.tripId, action: "create", expenseId: e.id, origin, summary: `新增 ${e.note || e.category} ¥${e.amount}`, after: e }),
        ...s.audit,
      ],
    });
    return e;
  },
  updateExpense(id: string, patch: ExpensePatch & Partial<Pick<Expense, "status" | "shares" | "confidence">>, origin: AuditEntry["origin"] = "user") {
    const s = load();
    const before = s.expenses.find((e) => e.id === id);
    if (!before) return;
    const after: Expense = { ...before, ...patch, updatedAt: now() };
    set({
      ...s,
      expenses: s.expenses.map((e) => (e.id === id ? after : e)),
      audit: [
        log({ tripId: before.tripId, action: "update", expenseId: id, origin, summary: describePatch(before, patch), before, after }),
        ...s.audit,
      ],
    });
  },
  deleteExpense(id: string, origin: AuditEntry["origin"] = "user") {
    const s = load();
    const before = s.expenses.find((e) => e.id === id);
    if (!before) return;
    set({
      ...s,
      expenses: s.expenses.filter((e) => e.id !== id),
      audit: [
        log({ tripId: before.tripId, action: "delete", expenseId: id, origin, summary: `删除 ${before.note || before.category} ¥${before.amount}`, before }),
        ...s.audit,
      ],
    });
  },
  resetDemo() {
    set(SEED());
  },
};

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
  return String(v);
}
