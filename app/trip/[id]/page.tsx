"use client";
import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AvatarStack } from "@/components/Avatar";
import { EntryPanel } from "@/components/EntryPanel";
import { LedgerPanel } from "@/components/LedgerPanel";
import { ReconcilePanel } from "@/components/ReconcilePanel";
import { SearchPanel } from "@/components/SearchPanel";
import { SettlePanel } from "@/components/SettlePanel";
import { SharePanel, SyncChip } from "@/components/SharePanel";
import { Icon, type IconName } from "@/components/ui";
import { actions, fingerprint, useStore } from "@/lib/store";
import { startSync } from "@/lib/sync/client";
import { useDesktop } from "@/lib/use-media";

const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: "entry", label: "录入", icon: "pen" },
  { key: "ledger", label: "账本", icon: "list" },
  { key: "search", label: "查询", icon: "search" },
  { key: "reconcile", label: "核账", icon: "shield" },
  { key: "settle", label: "结算", icon: "scale" },
];
type Tab = "entry" | "ledger" | "search" | "reconcile" | "settle";

export default function TripPage() {
  return (
    <Suspense fallback={null}>
      <TripInner />
    </Suspense>
  );
}

function TripInner() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const tab = (sp.get("tab") as Tab) || "entry";
  const { trips, expenses, audit, prefs } = useStore();
  const desktop = useDesktop();
  const autoReconcile = sp.get("auto") === "1";
  const [share, setShare] = useState(false);
  const shareCode = trips.find((t) => t.id === id)?.shareCode;
  useEffect(() => (shareCode ? startSync(id) : undefined), [id, shareCode]);
  const trip = trips.find((t) => t.id === id);
  if (!trip) return <p className="text-sm text-ink-400">旅行不存在（数据存在本机浏览器，换设备不会同步）。</p>;
  const es = expenses.filter((e) => e.tripId === trip.id);
  const pending = es.filter((e) => e.status === "pending").length;
  const go = (k: Tab) => router.replace(`/trip/${trip.id}?tab=${k}`);
  /* 结算前自动核账：账本指纹和上次核账时不同就提示 */
  const stale = es.length > 0 && prefs.lastReconcile[trip.id] !== fingerprint(es);
  const toReconcile = () => router.replace(`/trip/${trip.id}?tab=reconcile&auto=1`);

  const ledger = <LedgerPanel trip={trip} expenses={es} audit={audit.filter((a) => a.tripId === trip.id)} />;
  const panel = (k: Tab) =>
    k === "entry" ? <EntryPanel trip={trip} expenses={es} /> : k === "search" ? <SearchPanel trip={trip} expenses={es} /> : k === "reconcile" ? <ReconcilePanel trip={trip} expenses={es} autoRun={autoReconcile} /> : k === "settle" ? <SettlePanel trip={trip} expenses={es} onReconcile={stale ? toReconcile : undefined} /> : ledger;
  /* 桌面双栏时账本常驻左栏，右栏显示其余面板；深链到 ?tab=ledger 就在右栏放录入。 */
  const rightTab: Tab = tab === "ledger" ? "entry" : tab;

  return (
    <div className="space-y-4">
      {/* 头部：一行标题 + 日期，右侧头像圈 + 更多菜单 */}
      <div className="flex items-center gap-2">
        <Link href="/" className="-ml-2 grid h-9 w-9 shrink-0 place-items-center rounded-xl text-ink-600 hover:bg-ink-100" aria-label="返回旅行列表">
          <Icon name="back" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold leading-tight">{trip.name}</h1>
          <p className="truncate text-xs text-ink-400">
            {trip.startDate ?? "—"} ~ {trip.endDate ?? "—"}
          </p>
        </div>
        <SyncChip trip={trip} onClick={() => setShare(true)} />
        <AvatarStack members={trip.members} size="md" max={5} />
        <MoreMenu
          items={[
            { label: trip.shareCode ? "邀请链接 / 同步状态" : "邀请同行者（云同步）", onClick: () => setShare(true) },
            { label: "重置为示例数据", onClick: () => confirm("重置为示例数据？本机现有数据会被清空。") && (actions.resetDemo(), router.push("/")) },
            { label: "删除这次旅行", danger: true, onClick: () => confirm(`删除旅行「${trip.name}」及其全部账目？`) && (actions.deleteTrip(trip.id), router.push("/")) },
          ]}
        />
      </div>

      {/* 桌面：下划线式 tab（账本在双栏布局下常驻，lg 以上隐藏它的 tab） */}
      <nav className="hidden border-b border-ink-200 md:flex" role="tablist">
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button key={t.key} role="tab" aria-selected={on} onClick={() => go(t.key)} className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition ${on ? "border-brand-600 text-brand-700" : "border-transparent text-ink-600 hover:text-ink-900"} ${t.key === "ledger" ? "lg:hidden" : ""}`}>
              <Icon name={t.icon} className="h-4 w-4" />
              {t.label}
              {t.key === "ledger" && pending > 0 && <span className="rounded-full bg-warn-100 px-1.5 text-[11px] text-warn-700">{pending}</span>}
            </button>
          );
        })}
      </nav>

      {/* 内容：手机/平板单栏；lg 以上双栏，左账本右面板。只渲染一份，避免两套面板状态 */}
      {desktop ? (
        <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-start gap-6">
          <div>{ledger}</div>
          <div>{panel(rightTab)}</div>
        </div>
      ) : (
        panel(tab)
      )}

      {share && <SharePanel trip={trip} onClose={() => setShare(false)} />}

      {/* 手机：底部固定 tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-ink-200 bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" role="tablist">
        <div className="mx-auto grid max-w-lg grid-cols-5">
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <button key={t.key} role="tab" aria-selected={on} onClick={() => go(t.key)} className={`relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${on ? "text-brand-600" : "text-ink-400"}`}>
                <Icon name={t.icon} className="h-5 w-5" />
                {t.label}
                {t.key === "ledger" && pending > 0 && <span className="absolute right-1/4 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-warn-700 px-1 text-[10px] font-bold text-white">{pending}</span>}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/** "⋯" 下拉菜单：危险操作（删除）收在这里，不占头部位置。 */
function MoreMenu({ items }: { items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => (document.removeEventListener("mousedown", close), document.removeEventListener("keydown", esc));
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="grid h-9 w-9 place-items-center rounded-xl text-ink-600 hover:bg-ink-100" aria-haspopup="menu" aria-expanded={open} aria-label="更多操作">
        <Icon name="more" />
      </button>
      {open && (
        <div role="menu" className="card absolute right-0 top-10 z-30 min-w-44 overflow-hidden py-1 text-sm">
          {items.map((i) => (
              <button key={i.label} role="menuitem" onClick={() => (setOpen(false), i.onClick())} className={`block w-full px-4 py-2 text-left hover:bg-ink-100 ${i.danger ? "text-danger-700" : ""}`}>
                {i.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
