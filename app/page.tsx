"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AvatarStack } from "@/components/Avatar";
import { Empty, Field, Icon } from "@/components/ui";
import { money } from "@/lib/format";
import { health } from "@/lib/health";
import { newId } from "@/lib/ids";
import { actions, useStore } from "@/lib/store";

export default function Home() {
  const { trips, expenses } = useStore();
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">我的旅行</h1>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          <Icon name="plus" className="h-4 w-4" /> 创建旅行
        </button>
      </div>

      {open && <CreateTrip onClose={() => setOpen(false)} />}

      {trips.length === 0 && !open ? (
        <div className="card">
          <Empty
            icon={<Icon name="map" className="h-6 w-6" />}
            title="还没有旅行"
            hint="创建一次旅行，拉上同行的人，之后每笔消费用一句话、一张截图或一段语音就能记下。"
            action={
              <div className="flex gap-2">
                <button className="btn btn-primary" onClick={() => setOpen(true)}>
                  创建旅行
                </button>
                <button className="btn btn-ghost" onClick={() => actions.resetDemo()}>
                  看看示例
                </button>
              </div>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {trips.map((t) => {
            const es = expenses.filter((e) => e.tripId === t.id);
            const h = health(t, es);
            const todo = h.pending + h.flagged;
            return (
              <Link key={t.id} href={`/trip/${t.id}`} className="card block p-5 transition hover:-translate-y-0.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-semibold">{t.name}</h2>
                    <p className="mt-0.5 text-xs text-ink-400">
                      {t.startDate ?? "—"} ~ {t.endDate ?? "—"}
                    </p>
                  </div>
                  <AvatarStack members={t.members} size="sm" max={4} />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <Stat label="总支出" value={money(h.total, t.currency)} sub={`${h.count} 笔`} />
                  <Stat
                    label={h.myNet == null ? "我的净额" : h.myNet > 0 ? "我应收" : h.myNet < 0 ? "我应付" : "我已结清"}
                    value={h.myNet == null ? "—" : money(Math.abs(h.myNet), t.currency)}
                    tone={h.myNet == null || h.myNet === 0 ? "" : h.myNet > 0 ? "text-ok-700" : "text-danger-700"}
                    sub={h.myNet === 0 ? "不用转账" : undefined}
                  />
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
                  {h.pending > 0 && <span className="badge bg-warn-100 text-warn-700">{h.pending} 笔待补全</span>}
                  {h.flagged > 0 && <span className="badge bg-danger-100 text-danger-700">{h.flagged} 笔待核账</span>}
                  {h.duplicates > 0 && <span className="badge bg-danger-100 text-danger-700">{h.duplicates} 组疑似重复</span>}
                  {todo === 0 && h.duplicates === 0 && h.count > 0 && <span className="badge bg-ok-100 text-ok-700">账本干净</span>}
                  {h.count === 0 && <span className="badge bg-ink-100 text-ink-600">还没有消费</span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <JoinByCode />

      {trips.length > 0 && (
        <p className="text-xs text-ink-400">
          数据保存在本机浏览器；AI 功能只接收账本快照、只返回建议，不会替你改账。{" "}
          <button className="underline" onClick={() => confirm("重置为示例数据？本机现有数据会被清空。") && actions.resetDemo()}>
            重置为示例数据
          </button>
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-paper px-3 py-2.5">
      <div className="text-[11px] text-ink-400">{label}</div>
      <div className={`text-xl font-bold leading-tight ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-ink-400">{sub}</div>}
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
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：成都四日游" autoFocus />
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

/** 收到邀请链接的人也可以直接贴链接或邀请码加入。 */
function JoinByCode() {
  const router = useRouter();
  const [v, setV] = useState("");
  const code = v.trim().match(/([a-z2-9]{10})\s*$/)?.[1] ?? "";
  return (
    <div className="flex items-center gap-2 text-sm">
      <input className="input max-w-xs" value={v} onChange={(e) => setV(e.target.value)} placeholder="粘贴邀请链接或邀请码加入旅行" onKeyDown={(e) => e.key === "Enter" && code && router.push(`/join/${code}`)} />
      <button className="btn btn-ghost" disabled={!code} onClick={() => router.push(`/join/${code}`)}>
        加入
      </button>
    </div>
  );
}
