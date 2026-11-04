import { NextResponse } from "next/server";
import { record } from "@/lib/telemetry";

/**
 * 服务端语音识别：把录音转发到 Whisper 兼容接口（OpenAI / Groq 都是同一协议）。
 *  STT_API_KEY   必填，没有则 GET 返回 enabled:false，前端退回浏览器 Web Speech
 *  STT_BASE_URL  默认 https://api.openai.com/v1；Groq 用 https://api.groq.com/openai/v1
 *  STT_MODEL     默认 whisper-1；Groq 用 whisper-large-v3-turbo
 */
export const maxDuration = 60;

const enabled = () => !!process.env.STT_API_KEY;

export async function GET() {
  return NextResponse.json({ enabled: enabled(), model: process.env.STT_MODEL ?? "whisper-1" });
}

export async function POST(req: Request) {
  if (!enabled()) return NextResponse.json({ ok: false, error: "服务端未配置 STT_API_KEY" }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ ok: false, error: "没有收到音频" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ ok: false, error: "音频太大（>20MB）" }, { status: 413 });
  const t0 = Date.now();
  try {
    const fd = new FormData();
    const ext = file.type.includes("mp4") || file.type.includes("m4a") ? "m4a" : file.type.includes("ogg") ? "ogg" : file.type.includes("wav") ? "wav" : "webm";
    fd.append("file", file, `audio.${ext}`);
    fd.append("model", process.env.STT_MODEL ?? "whisper-1");
    fd.append("language", "zh");
    fd.append("response_format", "json");
    fd.append("prompt", "旅行记账：火锅、打车、门票、酒店、AA、请客、小明、小华、阿强、小林。");
    const base = (process.env.STT_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const r = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${process.env.STT_API_KEY}` }, body: fd });
    if (!r.ok) throw new Error(`语音服务 ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { text: string };
    void record({ route: "transcribe", model: process.env.STT_MODEL ?? "whisper-1", ok: true, ms: Date.now() - t0, input: Math.round(file.size / 1024), output: j.text.length, meta: { kb: Math.round(file.size / 1024) } });
    return NextResponse.json({ ok: true, text: j.text.trim() });
  } catch (e) {
    const message = e instanceof Error ? e.message : "识别失败";
    void record({ route: "transcribe", model: process.env.STT_MODEL ?? "whisper-1", ok: false, ms: Date.now() - t0, input: 0, output: 0, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
