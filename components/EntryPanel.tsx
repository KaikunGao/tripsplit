"use client";
import { useEffect, useRef, useState } from "react";
import { ExpenseCard } from "@/components/ExpenseCard";
import { ExpenseForm } from "@/components/ExpenseForm";
import { ImportPanel } from "@/components/ImportPanel";
import { Badge, ConfidenceBar, Icon, Section, Skeleton, Spinner } from "@/components/ui";
import type { ExtractResponse } from "@/lib/extract/schema";
import { localIso } from "@/lib/format";
import { compressImage } from "@/lib/image-client";
import { actions, getState } from "@/lib/store";
import { Recorder, dequeueVoice, enqueueVoice, listQueued, serverSttEnabled, transcribe, type QueuedVoice } from "@/lib/voice";
import type { Expense, Trip } from "@/lib/types";

type Kind = "text" | "image" | "voice";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Recognition = { start(): void; stop(): void; lang: string; interimResults: boolean; continuous: boolean; onresult: (e: any) => void; onend: () => void; onerror: (e: any) => void };

/**
 * 多模态录入：文字 / 截图 / 语音统一走 /api/extract。
 * 语音在浏览器端用 Web Speech API 转写成文字（不上传音频），再与文字同路。
 */
export function EntryPanel({ trip, expenses }: { trip: Trip; expenses: Expense[] }) {
  const [kind, setKind] = useState<Kind>("text");
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ base64: string; dataUrl: string; thumb: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [supplement, setSupplement] = useState("");
  const [recorded, setRecorded] = useState<Expense | null>(null);
  const [listening, setListening] = useState(false);
  const [manual, setManual] = useState(false);
  const recRef = useRef<Recognition | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const holdRef = useRef<{ at: number; held: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const browserSpeech = typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const [serverStt, setServerStt] = useState<boolean | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [queued, setQueued] = useState<QueuedVoice[]>([]);
  const [online, setOnline] = useState(true);
  const speechOk = serverStt === true || browserSpeech;

  useEffect(() => {
    let alive = true;
    serverSttEnabled().then((v) => alive && setServerStt(v));
    listQueued(trip.id).then((q) => alive && setQueued(q));
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      alive = false;
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      recRef.current?.stop();
    };
  }, [trip.id]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    const big = await compressImage(f, 1280, 0.85);
    const small = await compressImage(f, 360, 0.7);
    setImage({ base64: big.base64, dataUrl: big.dataUrl, thumb: small.dataUrl });
    setResult(null);
    setRecorded(null);
  }

  async function startVoice() {
    if (listening) return;
    setErr("");
    setText("");
    setResult(null);
    setRecorded(null);
    if (serverStt) {
      try {
        const r = new Recorder();
        await r.start();
        recorderRef.current = r;
        setListening(true);
      } catch (e) {
        setErr(e instanceof Error && /NotAllowed|Permission/i.test(e.message + e.name) ? "麦克风权限被拒绝" : "无法开始录音");
      }
      return;
    }
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec: Recognition = new Ctor();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = true;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setText(finalText + interim);
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e) => {
      setListening(false);
      setErr(e.error === "not-allowed" ? "麦克风权限被拒绝" : e.error === "no-speech" ? "没听到声音，再试一次" : `语音识别出错：${e.error}`);
    };
    recRef.current = rec;
    setErr("");
    setText("");
    setResult(null);
    setRecorded(null);
    setListening(true);
    rec.start();
  }
  async function stopVoice() {
    if (recorderRef.current) {
      const r = recorderRef.current;
      recorderRef.current = null;
      setListening(false);
      const blob = await r.stop();
      if (blob.size < 1000) return setErr("录音太短，再试一次");
      if (!navigator.onLine) {
        await enqueueVoice(trip.id, blob);
        setQueued(await listQueued(trip.id));
        setErr("当前离线，这段录音已存入队列，联网后点「处理离线录音」。");
        return;
      }
      setTranscribing(true);
      try {
        setText(await transcribe(blob));
      } catch (e) {
        await enqueueVoice(trip.id, blob);
        setQueued(await listQueued(trip.id));
        setErr(`${e instanceof Error ? e.message : "识别失败"}，录音已存入离线队列，稍后可重试。`);
      } finally {
        setTranscribing(false);
      }
      return;
    }
    recRef.current?.stop();
  }

  /** 处理离线队列：逐条识别 → 解析；auto 直接入账，其余存为待补全并带上转写证据。 */
  async function processQueue() {
    setBusy(true);
    setErr("");
    let ok = 0;
    for (const q of queued) {
      try {
        const t = await transcribe(q.blob);
        const res = await fetch("/api/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip, kind: "voice", text: t, habits: getState().prefs.habits }) });
        const data = (await res.json()) as ExtractResponse | { ok: false; error: string };
        if (!data.ok) throw new Error(data.error);
        if (data.decision !== "reject") {
          const d = data.draft;
          actions.addExpense({ tripId: trip.id, amount: d.amount ?? 0, currency: d.currency, payerId: d.payerId ?? trip.selfMemberId ?? trip.members[0].id, participantIds: d.participantIds ?? [], treat: d.treat || undefined, category: d.category ?? "其他", note: d.note ?? "", occurredAt: d.occurredAt ?? q.at.slice(0, 19), source: "voice", confidence: d.confidence, status: data.decision === "auto" ? "confirmed" : "pending", evidence: { kind: "voice", text: t } });
        }
        await dequeueVoice(q.id);
        ok++;
      } catch (e) {
        setErr(`处理离线录音失败：${e instanceof Error ? e.message : "未知错误"}`);
        break;
      }
    }
    setQueued(await listQueued(trip.id));
    setBusy(false);
    if (ok) setErr(`✓ 已处理 ${ok} 条离线录音，需要补全的已标为待补全。`);
  }
  /* 按住说话：按下开始；松开时若已按住超过 400ms 就停止（按住模式），否则保持录音等下一次点按（点按模式）。 */
  function micDown() {
    holdRef.current = { at: Date.now(), held: false };
    if (listening) return stopVoice();
    startVoice();
  }
  function micUp() {
    const h = holdRef.current;
    holdRef.current = null;
    if (h && Date.now() - h.at > 400 && listening) stopVoice();
  }

  async function run(extra?: { supplement: string; previous: unknown }) {
    setBusy(true);
    setErr("");
    setRecorded(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trip, kind, text: text || undefined, image: kind === "image" && image ? { media_type: "image/jpeg", data: image.base64 } : undefined, habits: getState().prefs.habits, ...extra }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "解析失败");
      const r = data as ExtractResponse;
      setResult(r);
      setSupplement("");
      if (r.decision === "auto") record(r, "confirmed");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "解析失败");
    } finally {
      setBusy(false);
    }
  }

  function record(r: ExtractResponse, status: Expense["status"]) {
    const d = r.draft;
    const e = actions.addExpense({
      tripId: trip.id,
      amount: d.amount ?? 0,
      currency: d.currency,
      payerId: d.payerId ?? trip.selfMemberId ?? trip.members[0].id,
      participantIds: d.participantIds ?? [],
      treat: d.treat || undefined,
      category: d.category ?? "其他",
      note: d.note ?? "",
      occurredAt: d.occurredAt ?? localIso(),
      source: kind,
      confidence: d.confidence,
      status,
      evidence: { kind, text: text || r.raw.note, thumbnail: image?.thumb },
    });
    setRecorded(e);
  }

  function reset() {
    setText("");
    setImage(null);
    setResult(null);
    setRecorded(null);
    setSupplement("");
    setManual(false);
    setErr("");
  }

  const canRun = !busy && (kind === "image" ? !!image : !!text.trim());
  const recent = [...expenses].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);

  return (
    <div className="space-y-4">
      <Section title="记一笔">
        {/* 分段控件切换模式 */}
        <div className="mb-3 grid grid-cols-3 rounded-xl bg-ink-100 p-1 text-sm" role="tablist">
          {(
            [
              ["text", "文字", "text"],
              ["image", "截图", "image"],
              ["voice", "语音", "mic"],
            ] as [Kind, string, "text" | "image" | "mic"][]
          ).map(([k, label, icon]) => (
            <button key={k} role="tab" aria-selected={kind === k} className={`flex items-center justify-center gap-1.5 rounded-lg py-1.5 font-medium transition ${kind === k ? "bg-surface text-ink-900 shadow-sm" : "text-ink-600"}`} onClick={() => (setKind(k), setResult(null), setRecorded(null), setErr(""))}>
              <Icon name={icon} className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {kind === "image" && (
          <div className="mb-3">
            <input ref={fileRef} type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0])} className="hidden" />
            {image ? (
              <div className="relative">
                <img src={image.dataUrl} alt="截图" className="max-h-56 rounded-xl border border-ink-100" />
                <button className="btn btn-ghost btn-sm absolute right-2 top-2" onClick={() => (setImage(null), fileRef.current && (fileRef.current.value = ""))}>
                  换一张
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed border-ink-200 py-6 text-sm text-ink-600 hover:border-brand-500 hover:bg-brand-50">
                <Icon name="image" className="h-6 w-6 text-ink-400" />
                选择支付截图
                <span className="text-xs text-ink-400">微信 / 支付宝账单截图都行，图片会在本机压缩后再上传</span>
              </button>
            )}
          </div>
        )}

        {kind === "voice" && (
          <div className="mb-3 flex flex-col items-center py-2">
            <button
              type="button"
              disabled={!speechOk}
              onPointerDown={micDown}
              onPointerUp={micUp}
              onPointerLeave={micUp}
              onPointerCancel={micUp}
              onContextMenu={(e) => e.preventDefault()}
              className={`relative grid h-20 w-20 touch-none select-none place-items-center rounded-full text-white shadow-card transition ${listening ? "pulse-ring bg-danger-700 scale-105" : "bg-brand-600 hover:bg-brand-700"} disabled:opacity-40`}
              aria-pressed={listening}
              aria-label={listening ? "停止录音" : "按住说话"}
            >
              <Icon name="mic" className="h-8 w-8" />
            </button>
            <p className="mt-2 text-xs text-ink-400">
              {serverStt == null ? "检查语音服务…" : !speechOk ? "当前浏览器不支持语音识别，请改用 Chrome，或直接输入文字" : transcribing ? "正在识别…" : listening ? "正在听… 松开或再点一下结束" : `按住说话，或点一下开始${serverStt ? "（服务端识别，离线会先存队列）" : "（浏览器识别）"}`}
              {!online && " · 当前离线"}
            </p>
            {queued.length > 0 && (
              <button className="btn btn-ghost btn-sm mt-2" disabled={busy || !online} onClick={processQueue}>
                {busy ? <Spinner /> : null} 处理 {queued.length} 条离线录音
              </button>
            )}
          </div>
        )}

        <textarea
          className="input min-h-20"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={{ text: "例：阿强付的火锅 412，大家 AA", image: "可选：补充说明，如“我付的，四个人”", voice: "转写结果会出现在这里，也可以直接改" }[kind]}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={!canRun} onClick={() => run()}>
            {busy ? <Spinner /> : null} 解析并入账
          </button>
          <button className="btn btn-ghost" onClick={reset}>
            清空
          </button>
        </div>
        {err && <p className="mt-2 text-sm text-danger-700">{err}</p>}
      </Section>

      {busy && !result && (
        <div className="card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm text-ink-600">
            <Spinner /> 正在抽取金额、付款人、参与人…
          </div>
          <Skeleton lines={3} />
        </div>
      )}

      {result && (
        <Section
          title={result.decision === "auto" ? "已自动入账" : result.decision === "ask" ? "需要补全" : "未识别为消费"}
          right={<Badge tone={result.decision === "auto" ? "ok" : result.decision === "ask" ? "warn" : "danger"}>{result.reason}</Badge>}
        >
          {result.decision !== "reject" && (
            <div className="mb-3 grid gap-1.5 sm:grid-cols-2">
              <ConfidenceBar label="金额" value={result.fields.amount} />
              <ConfidenceBar label="付款人" value={result.fields.payer} />
              <ConfidenceBar label="参与人" value={result.fields.participants} />
              <ConfidenceBar label="分类" value={result.fields.category} />
            </div>
          )}
          {recorded && (
            <div className="space-y-2">
              <ExpenseCard trip={trip} e={recorded} highlight />
              <div className="flex gap-2">
                <button className="btn btn-ghost" onClick={() => (actions.deleteExpense(recorded.id), reset())}>
                  撤销
                </button>
                <button className="btn btn-primary" onClick={reset}>
                  继续记下一笔
                </button>
              </div>
            </div>
          )}
          {result.decision === "ask" && !recorded && !manual && (
            <div className="space-y-3">
              <ul className="space-y-1 text-sm">
                {result.questions.map((q, i) => (
                  <li key={i}>• {q}</li>
                ))}
              </ul>
              <div className="flex gap-2">
                <input className="input" value={supplement} onChange={(e) => setSupplement(e.target.value)} placeholder="回答补充，例：小华付的，四个人" onKeyDown={(e) => e.key === "Enter" && supplement.trim() && run({ supplement, previous: result.raw })} />
                <button className="btn btn-primary" disabled={busy || !supplement.trim()} onClick={() => run({ supplement, previous: result.raw })}>
                  {busy ? <Spinner /> : "补充"}
                </button>
              </div>
              <div className="flex flex-wrap gap-2 text-sm">
                <button className="btn btn-ghost" onClick={() => setManual(true)}>
                  手动补全
                </button>
                <button className="btn btn-ghost" onClick={() => record(result, "pending")}>
                  先存为待补全
                </button>
              </div>
            </div>
          )}
          {manual && !recorded && (
            <ExpenseForm
              trip={trip}
              initial={{ amount: result.draft.amount, currency: result.draft.currency, payerId: result.draft.payerId, participantIds: result.draft.participantIds, treat: result.draft.treat, category: result.draft.category, note: result.draft.note, occurredAt: result.draft.occurredAt }}
              missing={result.missing}
              submitLabel="入账"
              onCancel={() => setManual(false)}
              onSubmit={(v) => {
                const e = actions.addExpense({ ...v, tripId: trip.id, source: kind, confidence: 1, status: "confirmed", evidence: { kind, text, thumbnail: image?.thumb } });
                setRecorded(e);
                setManual(false);
              }}
            />
          )}
          {result.decision === "reject" && <p className="text-sm text-ink-600">{result.reason}。可以换一张支付截图，或直接用文字描述这笔消费。</p>}
        </Section>
      )}

      {!result && !busy && <ImportPanel trip={trip} expenses={expenses} />}

      {recent.length > 0 && !result && !busy && (
        <Section title="最近录入" className="lg:hidden">
          <div className="space-y-2">
            {recent.map((e) => (
              <ExpenseCard key={e.id} trip={trip} e={e} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
