"use client";

/**
 * 语音录入的两条路：
 *  1. 服务端识别：MediaRecorder 录音 → POST /api/transcribe（Whisper 兼容）。Safari/微信内置浏览器也能用。
 *  2. 浏览器识别：Web Speech API（仅 Chrome 系），不上传音频。
 * 离线时录音进 IndexedDB 队列，恢复联网后由 EntryPanel 逐条处理。
 */

let sttEnabled: boolean | null = null;
export async function serverSttEnabled(): Promise<boolean> {
  if (sttEnabled != null) return sttEnabled;
  try {
    const r = await fetch("/api/transcribe", { cache: "no-store" });
    sttEnabled = (await r.json()).enabled === true;
  } catch {
    sttEnabled = false;
  }
  return sttEnabled;
}

export function pickMime(): string {
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return cands.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
  }
  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const r = this.rec;
      if (!r) return resolve(new Blob());
      r.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: r.mimeType || "audio/webm" }));
      };
      r.stop();
    });
  }
}

export async function transcribe(blob: Blob): Promise<string> {
  const fd = new FormData();
  fd.append("audio", blob, "audio.webm");
  const r = await fetch("/api/transcribe", { method: "POST", body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? "识别失败");
  return j.text as string;
}

/* ---------- 离线队列（IndexedDB） ---------- */
const DB = "tripsplit-voice";
const STORE = "queue";
export type QueuedVoice = { id: number; tripId: string; blob: Blob; at: string };

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function enqueueVoice(tripId: string, blob: Blob): Promise<void> {
  const d = await open();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add({ tripId, blob, at: new Date().toISOString() });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export async function listQueued(tripId: string): Promise<QueuedVoice[]> {
  try {
    const d = await open();
    return await new Promise((res, rej) => {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => res((req.result as QueuedVoice[]).filter((q) => q.tripId === tripId));
      req.onerror = () => rej(req.error);
    });
  } catch {
    return [];
  }
}
export async function dequeueVoice(id: number): Promise<void> {
  const d = await open();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
