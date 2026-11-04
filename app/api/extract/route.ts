import { NextResponse } from "next/server";
import { friendlyError } from "@/lib/claude";
import { extract } from "@/lib/extract/extract";
import { ExtractRequestSchema } from "@/lib/extract/schema";
import { record } from "@/lib/telemetry";

export const maxDuration = 60;

export async function POST(req: Request) {
  const parsed = ExtractRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  if (parsed.data.kind === "image" && !parsed.data.image) return NextResponse.json({ ok: false, error: "缺少图片" }, { status: 400 });
  if (parsed.data.kind !== "image" && !parsed.data.text?.trim()) return NextResponse.json({ ok: false, error: "内容为空" }, { status: 400 });
  const t0 = Date.now();
  try {
    const r = await extract(parsed.data);
    void record({ route: "extract", ok: true, ms: Date.now() - t0, input: r.usage?.input ?? 0, output: r.usage?.output ?? 0, meta: { kind: parsed.data.kind, decision: r.decision } });
    return NextResponse.json(r);
  } catch (err) {
    const { message, status } = friendlyError(err);
    void record({ route: "extract", ok: false, ms: Date.now() - t0, input: 0, output: 0, error: message });
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
