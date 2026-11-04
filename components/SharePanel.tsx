"use client";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Icon, Spinner } from "@/components/ui";
import { localStamp } from "@/lib/format";
import { actions } from "@/lib/store";
import { inviteUrl, pullNow, shareTrip, stopSharing, useSyncStatus } from "@/lib/sync/client";
import type { Trip } from "@/lib/types";

/** 头部的同步状态小圆点 + 文案。 */
export function SyncChip({ trip, onClick }: { trip: Trip; onClick: () => void }) {
  const st = useSyncStatus(trip.id);
  if (!trip.shareCode) return null;
  const dot = { off: "bg-ink-400", syncing: "bg-warn-700 animate-pulse", synced: "bg-ok-700", offline: "bg-ink-400", error: "bg-danger-700" }[st.s];
  const label = { off: "未同步", syncing: "同步中", synced: "已同步", offline: "离线", error: "同步失败" }[st.s];
  return (
    <button type="button" onClick={onClick} className="hidden items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-xs text-ink-600 sm:inline-flex" title={st.error ?? (st.at ? `最近 ${localStamp(st.at)}` : "")}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </button>
  );
}

/** 邀请 / 同步面板（弹层）。 */
export function SharePanel({ trip, onClose }: { trip: Trip; onClose: () => void }) {
  const st = useSyncStatus(trip.id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const url = trip.shareCode ? inviteUrl(trip.shareCode) : "";

  async function enable() {
    setBusy(true);
    setErr("");
    try {
      await shareTrip(trip.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "开启失败");
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    await navigator.clipboard.writeText(`${trip.name} 的分账账本，点链接加入一起记：${url}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink-900/40 p-4 sm:items-center" onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="邀请同行者">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">邀请同行者 · 云同步</h2>
          <button className="text-ink-400" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {!trip.shareCode ? (
          <div className="space-y-3 text-sm">
            <p className="text-ink-600">开启后这次旅行会上传到云端，每个人用自己手机记账，账目实时合并。拿到链接的人都能读写，请只发给同行的人。</p>
            <div className="flex -space-x-1.5">
              {trip.members.map((m) => (
                <Avatar key={m.id} name={m.name} size="md" />
              ))}
            </div>
            {err && <p className="text-danger-700">{err}</p>}
            <button className="btn btn-primary" disabled={busy} onClick={enable}>
              {busy ? <Spinner /> : <Icon name="plus" className="h-4 w-4" />} 开启云同步并生成邀请链接
            </button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="rounded-xl bg-paper p-3">
              <div className="mb-1 text-xs text-ink-400">邀请链接</div>
              <div className="break-all font-mono text-xs">{url}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary btn-sm" onClick={copy}>
                {copied ? "已复制" : "复制链接发群里"}
              </button>
              {"share" in navigator && (
                <button className="btn btn-ghost btn-sm" onClick={() => navigator.share({ title: `${trip.name} 分账账本`, text: "点链接加入一起记账", url })}>
                  系统分享
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => pullNow(trip.id)}>
                立即同步
              </button>
            </div>
            <p className="text-xs text-ink-400">
              状态：{ { off: "未同步", syncing: "同步中…", synced: "已同步", offline: "离线，联网后自动推送", error: `失败：${st.error ?? ""}` }[st.s] }
              {st.at ? ` · 最近 ${localStamp(st.at)}` : ""}
            </p>
            <div className="border-t border-ink-100 pt-3">
              <div className="mb-1 text-xs text-ink-400">我在这次旅行里是</div>
              <div className="flex flex-wrap gap-1.5">
                {trip.members.map((m) => (
                  <button key={m.id} className={`chip ${trip.selfMemberId === m.id ? "chip-on" : ""}`} onClick={() => actions.updateTrip(trip.id, { selfMemberId: m.id })}>
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
            <button className="text-xs text-ink-400 underline" onClick={() => confirm("本机将停止同步，云端数据保留，其他人不受影响。确定？") && (stopSharing(trip.id), onClose())}>
              本机停止同步
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
