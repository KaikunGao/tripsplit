import { NextResponse } from "next/server";
import { friendlyError } from "@/lib/claude";
import { ImportRequestSchema, importDrafts } from "@/lib/import/import";
import { record } from "@/lib/telemetry";

export const maxDuration = 120;

export async function POST(req: Request) {
  const parsed = ImportRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  if (!parsed.data.rows?.length && !parsed.data.text?.trim()) return NextResponse.json({ ok: false, error: "没有可导入的内容" }, { status: 400 });
  const t0 = Date.now();
  try {
    const r = await importDrafts(parsed.data);
    void record({ route: "import", ok: true, ms: Date.now() - t0, input: r.usage.input, output: r.usage.output, meta: { rows: parsed.data.rows?.length ?? 0, drafts: r.drafts.length } });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    const { message, status } = friendlyError(err);
    void record({ route: "import", ok: false, ms: Date.now() - t0, input: 0, output: 0, error: message });
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
