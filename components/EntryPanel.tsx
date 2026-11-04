"use client";
import { useEffect, useRef, useState } from "react";
import { ExpenseCard } from "@/components/ExpenseCard";
import { ExpenseForm } from "@/components/ExpenseForm";
import { Badge, ConfidenceBar, Section, Spinner } from "@/components/ui";
import type { ExtractResponse } from "@/lib/extract/schema";
import { localIso } from "@/lib/format";
import { compressImage } from "@/lib/image-client";
import { actions } from "@/lib/store";
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
  const speechOk = typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  useEffect(() => () => recRef.current?.stop(), []);

  async function onFile(f: File | undefined) {
    if (!f) return;
    const big = await compressImage(f, 1280, 0.85);
    const small = await compressImage(f, 360, 0.7);
    setImage({ base64: big.base64, dataUrl: big.dataUrl, thumb: small.dataUrl });
    setResult(null);
    setRecorded(null);
  }

  function toggleVoice() {
    if (listening) return recRef.current?.stop();
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec: Recognition = new Ctor();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = false;
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
      setErr(e.error === "not-allowed" ? "麦克风权限被拒绝" : `语音识别出错：${e.error}`);
    };
    recRef.current = rec;
    setErr("");
    setListening(true);
    rec.start();
  }

  async function run(extra?: { supplement: string; previous: unknown }) {
    setBusy(true);
    setErr("");
    setRecorded(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trip, kind, text: text || undefined, image: kind === "image" && image ? { media_type: "image/jpeg", data: image.base64 } : undefined, ...extra }),
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

  const recent = [...expenses].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);

  return (
    <div className="space-y-4">
      <Section title="记一笔">
        <div className="mb-3 flex gap-2">
          {(["text", "image", "voice"] as Kind[]).map((k) => (
            <button key={k} className={`btn ${kind === k ? "btn-primary" : "btn-ghost"}`} onClick={() => (setKind(k), setResult(null), setRecorded(null))}>
              {{ text: "文字", image: "支付截图", voice: "语音" }[k]}
            </button>
          ))}
        </div>

        {kind === "image" && (
          <div className="mb-3">
            <input type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
            {image && <img src={image.dataUrl} alt="截图" className="mt-2 max-h-56 rounded-xl border border-ink-100" />}
          </div>
        )}

        <textarea
          className="input min-h-20"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={{ text: "例：阿强付的火锅 412，大家 AA", image: "可选：补充说明，如“我付的，四个人”", voice: speechOk ? "点“开始说话”，或直接输入转写文字" : "当前浏览器不支持语音识别，请改用 Chrome / Safari，或直接输入文字" }[kind]}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {kind === "voice" && (
            <button className={`btn ${listening ? "btn-danger" : "btn-ghost"}`} disabled={!speechOk} onClick={toggleVoice}>
              {listening ? "● 停止" : "🎙 开始说话"}
            </button>
          )}
          <button className="btn btn-primary" disabled={busy || (kind === "image" ? !image : !text.trim())} onClick={() => run()}>
            {busy ? <Spinner /> : null} 解析并入账
          </button>
          <button className="btn btn-ghost" onClick={reset}>
            清空
          </button>
        </div>
        {err && <p className="mt-2 text-sm text-danger-700">{err}</p>}
      </Section>

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
                <button className="btn btn-ghost" onClick={reset}>
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
              initial={{ amount: result.draft.amount, payerId: result.draft.payerId, participantIds: result.draft.participantIds, category: result.draft.category, note: result.draft.note, occurredAt: result.draft.occurredAt }}
              missing={result.missing}
              submitLabel="入账"
              onCancel={() => setManual(false)}
              onSubmit={(v) => {
                const e = actions.addExpense({ ...v, tripId: trip.id, currency: trip.currency, source: kind, confidence: 1, status: "confirmed", evidence: { kind, text, thumbnail: image?.thumb } });
                setRecorded(e);
                setManual(false);
              }}
            />
          )}
          {result.decision === "reject" && <p className="text-sm text-ink-600">{result.reason}。可以换一张支付截图，或直接用文字描述这笔消费。</p>}
        </Section>
      )}

      {recent.length > 0 && !result && (
        <Section title="最近录入">
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
