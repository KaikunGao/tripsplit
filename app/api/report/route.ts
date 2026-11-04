import { NextResponse } from "next/server";
import { record } from "@/lib/telemetry";
import { friendlyError } from "@/lib/claude";
import { report } from "@/lib/report";
import { LedgerSnapshotSchema } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const parsed = LedgerSnapshotSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  const t0 = Date.now();
  try {
    const r = await report(parsed.data);
    void record({ route: "report", ok: true, ms: Date.now() - t0, input: r.usage?.input ?? 0, output: r.usage?.output ?? 0, meta: { expenses: parsed.data.expenses.length } });
    return NextResponse.json(r);
  } catch (err) {
    const { message, status } = friendlyError(err);
    void record({ route: "report", ok: false, ms: Date.now() - t0, input: 0, output: 0, error: message });
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
