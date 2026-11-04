"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Field } from "@/components/ui";
import { money } from "@/lib/format";
import { newId } from "@/lib/ids";
import { actions, useStore } from "@/lib/store";

export default function Home() {
  const { trips, expenses } = useStore();
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">我的旅行</h1>
          <p className="mt-1 text-sm text-ink-600">创建旅行 → 消费录入 → 账本管理 → 核账 → 结算</p>
        </div>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          + 创建旅行
        </button>
      </div>

      {open && <CreateTrip onClose={() => setOpen(false)} />}

      <div className="grid gap-4 sm:grid-cols-2">
        {trips.map((t) => {
          const es = expenses.filter((e) => e.tripId === t.id);
          const total = es.filter((e) => e.status === "confirmed").reduce((a, e) => a + e.amount, 0);
          const pending = es.filter((e) => e.status === "pending").length;
          return (
            <Link key={t.id} href={`/trip/${t.id}`} className="card block p-5 transition hover:-translate-y-0.5">
              <div className="flex items-start justify-between">
                <h2 className="text-lg font-semibold">{t.name}</h2>
                {pending > 0 && <Badge tone="warn">{pending} 笔待补全</Badge>}
              </div>
              <p className="mt-1 text-sm text-ink-400">
                {t.startDate ?? "—"} ~ {t.endDate ?? "—"} · {t.members.map((m) => m.name).join("、")}
              </p>
              <p className="mt-3 text-2xl font-bold">{money(total, t.currency)}</p>
              <p className="text-xs text-ink-400">{es.length} 笔消费</p>
            </Link>
          );
        })}
        {trips.length === 0 && <p className="text-sm text-ink-400">还没有旅行，先创建一个。</p>}
      </div>

      <p className="text-xs text-ink-400">
        数据保存在本机浏览器；AI 功能只接收账本快照、只返回建议，不会替你改账。{" "}
        <button className="underline" onClick={() => confirm("重置为示例数据？本机现有数据会被清空。") && actions.resetDemo()}>
          重置为示例数据
        </button>
      </p>
    </div>
  );
}

function CreateTrip({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [members, setMembers] = useState("我, ");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [err, setErr] = useState("");

  function submit() {
    const names = members.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!name.trim()) return setErr("请填写旅行名称");
    if (names.length < 2) return setErr("至少两位成员");
    if (new Set(names).size !== names.length) return setErr("成员名不能重复");
    if (start && end && end < start) return setErr("结束日期早于开始日期");
    const ms = names.map((n) => ({ id: newId("m"), name: n }));
    const trip = actions.createTrip({ name: name.trim(), currency: "CNY", members: ms, startDate: start || undefined, endDate: end || undefined, selfMemberId: ms[0].id });
    router.push(`/trip/${trip.id}`);
  }

  return (
    <div className="card space-y-3 p-5">
      <h2 className="font-semibold">创建旅行</h2>
      <Field label="旅行名称">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：成都四日游" />
      </Field>
      <Field label="成员（逗号分隔，第一位是你自己）" hint="录入时说“我付的”会默认指向第一位成员">
        <input className="input" value={members} onChange={(e) => setMembers(e.target.value)} placeholder="我, 小明, 小华" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="开始日期">
          <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="结束日期">
          <input className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      {err && <p className="text-sm text-danger-700">{err}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary" onClick={submit}>
          创建
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}
