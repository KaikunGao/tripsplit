"use client";
import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { Field, Skeleton } from "@/components/ui";
import { newId } from "@/lib/ids";
import { actions, useStore } from "@/lib/store";
import { joinTrip } from "@/lib/sync/client";
import type { Trip } from "@/lib/types";

/** 邀请链接落地页：拉取旅行 → 选"我是谁"（或加一个新成员）→ 进入账本。 */
export default function JoinPage() {
  return (
    <Suspense fallback={null}>
      <JoinInner />
    </Suspense>
  );
}

function JoinInner() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const { trips } = useStore();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [err, setErr] = useState("");
  const [me, setMe] = useState("");
  const [newName, setNewName] = useState("");

  useEffect(() => {
    joinTrip(code)
      .then((t) => {
        setTrip(t);
        setMe(t.selfMemberId ?? "");
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "加入失败"));
  }, [code]);

  const already = trips.some((t) => t.shareCode === code);

  function enter() {
    if (!trip) return;
    let selfMemberId = me;
    if (me === "__new") {
      const name = newName.trim();
      if (!name) return setErr("请填写你的名字");
      if (trip.members.some((m) => m.name === name)) return setErr("已有同名成员，直接选那一个即可");
      const member = { id: newId("m"), name };
      actions.updateTrip(trip.id, { members: [...trip.members, member], selfMemberId: member.id });
      selfMemberId = member.id;
    } else {
      if (!selfMemberId) return setErr("先选一下你是谁");
      actions.updateTrip(trip.id, { selfMemberId });
    }
    router.push(`/trip/${trip.id}`);
  }

  if (err && !trip)
    return (
      <div className="card mx-auto max-w-md p-6 text-center">
        <p className="font-medium">加入失败</p>
        <p className="mt-1 text-sm text-danger-700">{err}</p>
      </div>
    );
  if (!trip)
    return (
      <div className="card mx-auto max-w-md p-6">
        <Skeleton lines={4} />
      </div>
    );

  return (
    <div className="card mx-auto max-w-md space-y-4 p-6">
      <div>
        <p className="text-xs text-ink-400">你被邀请加入</p>
        <h1 className="text-xl font-bold">{trip.name}</h1>
        <p className="text-sm text-ink-400">
          {trip.startDate ?? "—"} ~ {trip.endDate ?? "—"} · {trip.members.length} 人{already ? " · 本机已加入" : ""}
        </p>
      </div>
      <Field label="你是谁？">
        <div className="flex flex-wrap gap-2">
          {trip.members.map((m) => (
            <button key={m.id} type="button" onClick={() => setMe(m.id)} className={`btn btn-sm ${me === m.id ? "btn-primary" : "btn-ghost"}`}>
              <Avatar name={m.name} size="xs" /> {m.name}
            </button>
          ))}
          <button type="button" onClick={() => setMe("__new")} className={`btn btn-sm ${me === "__new" ? "btn-primary" : "btn-ghost"}`}>
            + 我不在名单里
          </button>
        </div>
      </Field>
      {me === "__new" && (
        <Field label="你的名字" hint="别人录入时说到这个名字就会算到你头上">
          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如：小张" autoFocus />
        </Field>
      )}
      {err && <p className="text-sm text-danger-700">{err}</p>}
      <button className="btn btn-primary w-full" onClick={enter}>
        进入账本
      </button>
      <p className="text-xs text-ink-400">加入后这次旅行会和其他人实时同步；你在本机的其他旅行不受影响。</p>
    </div>
  );
}
