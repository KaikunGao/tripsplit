"use client";
import Link from "next/link";
import { Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { EntryPanel } from "@/components/EntryPanel";
import { LedgerPanel } from "@/components/LedgerPanel";
import { ReconcilePanel } from "@/components/ReconcilePanel";
import { SearchPanel } from "@/components/SearchPanel";
import { SettlePanel } from "@/components/SettlePanel";
import { actions, useStore } from "@/lib/store";

const TABS = [
  ["entry", "录入"],
  ["ledger", "账本"],
  ["search", "查询"],
  ["reconcile", "核账"],
  ["settle", "结算"],
] as const;
type Tab = (typeof TABS)[number][0];

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
  const { trips, expenses, audit } = useStore();
  const trip = trips.find((t) => t.id === id);
  if (!trip) return <p className="text-sm text-ink-400">旅行不存在（数据存在本机浏览器，换设备不会同步）。</p>;
  const es = expenses.filter((e) => e.tripId === trip.id);
  const pending = es.filter((e) => e.status === "pending").length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{trip.name}</h1>
          <p className="text-sm text-ink-400">
            {trip.startDate ?? "—"} ~ {trip.endDate ?? "—"} · {trip.members.map((m) => m.name).join("、")}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/" className="btn btn-ghost">
            返回
          </Link>
          <button className="btn btn-ghost" onClick={() => confirm(`删除旅行「${trip.name}」及其全部账目？`) && (actions.deleteTrip(trip.id), router.push("/"))}>
            删除
          </button>
        </div>
      </div>

      <nav className="flex gap-1 overflow-x-auto rounded-2xl bg-white p-1 shadow-card">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => router.replace(`/trip/${trip.id}?tab=${k}`)} className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium transition ${tab === k ? "bg-brand-600 text-white" : "text-ink-600 hover:bg-ink-100"}`}>
            {label}
            {k === "ledger" && pending > 0 && <span className="ml-1 rounded-full bg-warn-100 px-1.5 text-xs text-warn-700">{pending}</span>}
          </button>
        ))}
      </nav>

      {tab === "entry" && <EntryPanel trip={trip} expenses={es} />}
      {tab === "ledger" && <LedgerPanel trip={trip} expenses={es} audit={audit.filter((a) => a.tripId === trip.id)} />}
      {tab === "search" && <SearchPanel trip={trip} expenses={es} />}
      {tab === "reconcile" && <ReconcilePanel trip={trip} expenses={es} />}
      {tab === "settle" && <SettlePanel trip={trip} expenses={es} />}
    </div>
  );
}
