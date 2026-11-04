"use client";
import { useSyncExternalStore } from "react";
import { newId } from "../ids";
import { actions, getState, setLocalChangeHook } from "../store";
import type { AuditEntry, Expense, Trip } from "../types";

/**
 * 云同步（客户端）：
 *  - 本机变更 → 800ms 防抖后 push（全量账目 + 删除墓碑 + 审计）
 *  - 每 8s 轮询 pull；页面回到前台时立刻 pull
 *  - 服务端返回合并后的全量状态，用 applyRemote 覆盖本机（不产生审计记录、不再触发 push）
 */
type Status = "off" | "syncing" | "synced" | "offline" | "error";
export type SyncState = { s: Status; at?: string; error?: string };
const status = new Map<string, SyncState>();
const OFF: SyncState = { s: "off" };
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, Set<string>>(); // tripId -> deleted expense ids waiting to be pushed
const pollers = new Map<string, ReturnType<typeof setInterval>>();
let hooked = false;

function emit(tripId: string, s: Status, extra: { at?: string; error?: string } = {}) {
  status.set(tripId, { s, ...extra });
  listeners.forEach((l) => l());
}

export function useSyncStatus(tripId: string): SyncState {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => status.get(tripId) ?? OFF,
    () => OFF,
  );
}

function tripData(tripId: string): { trip: Trip; expenses: Expense[]; audit: AuditEntry[] } | null {
  const s = getState();
  const trip = s.trips.find((t) => t.id === tripId);
  if (!trip) return null;
  return { trip, expenses: s.expenses.filter((e) => e.tripId === tripId), audit: s.audit.filter((a) => a.tripId === tripId).slice(0, 200) };
}

function applyPull(tripId: string, r: { trip: Trip; expenses: Expense[]; audit: AuditEntry[] }, startedAt: string) {
  const local = tripData(tripId);
  // "我是谁"保留本机选择；其余旅行字段以服务端为准
  const trip: Trip = { ...r.trip, selfMemberId: local?.trip.selfMemberId ?? r.trip.selfMemberId, syncedAt: startedAt };
  // 合并账目：服务端为基准；本机比服务端新的版本、以及上次同步后新建还没推上去的，保留等下次 push
  const lastSync = local?.trip.syncedAt ?? "";
  const merged = new Map(r.expenses.map((e) => [e.id, e]));
  const deleted = pending.get(tripId) ?? new Set<string>();
  for (const l of local?.expenses ?? []) {
    if (deleted.has(l.id)) continue;
    const remote = merged.get(l.id);
    if (!remote) {
      if (l.updatedAt > lastSync) merged.set(l.id, l);
    } else if (l.updatedAt > remote.updatedAt) merged.set(l.id, l);
  }
  actions.applyRemote(tripId, { trip, expenses: [...merged.values()], audit: r.audit });
}

async function pushNow(tripId: string, includeTrip: boolean) {
  const d = tripData(tripId);
  if (!d?.trip.shareCode) return;
  if (!navigator.onLine) return emit(tripId, "offline");
  emit(tripId, "syncing");
  const deleted = [...(pending.get(tripId) ?? [])];
  const startedAt = new Date().toISOString();
  try {
    const r = await fetch(`/api/sync/${d.trip.shareCode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trip: includeTrip ? d.trip : undefined, expenses: d.expenses, deletedIds: deleted, audit: d.audit }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error ?? "同步失败");
    pending.get(tripId)?.clear();
    applyPull(tripId, j, startedAt);
    emit(tripId, "synced", { at: startedAt });
  } catch (e) {
    emit(tripId, "error", { error: e instanceof Error ? e.message : "同步失败" });
  }
}

export async function pullNow(tripId: string) {
  const d = tripData(tripId);
  if (!d?.trip.shareCode) return;
  if (!navigator.onLine) return emit(tripId, "offline");
  // 有未推送的删除/修改时先推，推完服务端会返回合并结果
  if (pending.get(tripId)?.size) return pushNow(tripId, false);
  emit(tripId, "syncing");
  const startedAt = new Date().toISOString();
  try {
    const r = await fetch(`/api/sync/${d.trip.shareCode}`, { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error ?? "同步失败");
    applyPull(tripId, j, startedAt);
    emit(tripId, "synced", { at: startedAt });
  } catch (e) {
    emit(tripId, "error", { error: e instanceof Error ? e.message : "同步失败" });
  }
}

function schedulePush(tripId: string, includeTrip: boolean) {
  clearTimeout(timers.get(tripId));
  timers.set(
    tripId,
    setTimeout(() => void pushNow(tripId, includeTrip), 800),
  );
}

function ensureHook() {
  if (hooked) return;
  hooked = true;
  setLocalChangeHook((s, changed) => {
    for (const id of changed.tripIds) {
      const trip = s.trips.find((t) => t.id === id);
      if (!trip?.shareCode) continue;
      if (changed.deletedExpenseIds?.length) {
        const set = pending.get(id) ?? new Set<string>();
        changed.deletedExpenseIds.forEach((x) => set.add(x));
        pending.set(id, set);
      }
      schedulePush(id, true);
    }
  });
}

/** 页面挂载时调用：开启轮询；返回停止函数。 */
export function startSync(tripId: string): () => void {
  ensureHook();
  const d = tripData(tripId);
  if (!d?.trip.shareCode) return () => {};
  void pullNow(tripId);
  const iv = setInterval(() => void pullNow(tripId), 8000);
  pollers.set(tripId, iv);
  const onVis = () => document.visibilityState === "visible" && void pullNow(tripId);
  const onOnline = () => void pushNow(tripId, true);
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("online", onOnline);
  return () => {
    clearInterval(iv);
    pollers.delete(tripId);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("online", onOnline);
  };
}

/** 开启云同步：上传本机数据，拿到分享码并写回 trip。返回邀请链接。 */
export async function shareTrip(tripId: string): Promise<string> {
  ensureHook();
  const d = tripData(tripId);
  if (!d) throw new Error("旅行不存在");
  if (d.trip.shareCode) return inviteUrl(d.trip.shareCode);
  const r = await fetch("/api/sync/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? "开启同步失败");
  actions.updateTrip(tripId, { shareCode: j.shareCode, syncedAt: new Date().toISOString() });
  emit(tripId, "synced", { at: new Date().toISOString() });
  return inviteUrl(j.shareCode);
}

export const inviteUrl = (code: string) => `${location.origin}/join/${code}`;

/** 通过邀请码加入：拉取并写入本机。返回 trip。 */
export async function joinTrip(code: string): Promise<Trip> {
  ensureHook();
  const r = await fetch(`/api/sync/${code}`, { cache: "no-store" });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? "邀请码无效");
  const trip: Trip = { ...j.trip, shareCode: code, syncedAt: new Date().toISOString() };
  // 本机已有同 id 但不是这个分享的旅行（典型：双方都有示例旅行 t_demo）→ 本机那份换个 id 让路
  const clash = getState().trips.find((t) => t.id === trip.id && t.shareCode !== code);
  if (clash) actions.renameTrip(clash.id, newId("t"));
  actions.applyRemote(trip.id, { trip, expenses: j.expenses, audit: j.audit });
  return trip;
}

/** 关闭本机的同步（不删服务端数据）。 */
export function stopSharing(tripId: string) {
  clearInterval(pollers.get(tripId));
  pollers.delete(tripId);
  actions.updateTrip(tripId, { shareCode: undefined, syncedAt: undefined });
  emit(tripId, "off");
}
