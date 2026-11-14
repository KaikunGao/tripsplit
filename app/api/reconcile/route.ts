import { NextResponse } from "next/server";
import { record } from "@/lib/telemetry";
import { runReconcile } from "@/lib/agent/pipeline";
import { RECONCILE_MODE, RECONCILE_MODEL, friendlyError } from "@/lib/claude";
import { LedgerSnapshotSchema } from "@/lib/types";

export const maxDuration = 120;

export async function POST(req: Request) {
  const parsed = LedgerSnapshotSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  const t0 = Date.now();
  try {
    const r = await runReconcile(parsed.data);
    void record({ route: "reconcile", model: RECONCILE_MODEL, ok: true, ms: Date.now() - t0, input: r.usage?.input ?? 0, output: r.usage?.output ?? 0, usageDetail: r.usageDetail, meta: { mode: RECONCILE_MODE, expenses: parsed.data.expenses.length, findings: r.findings.length, turns: r.usage.turns } });
    return NextResponse.json(r);
  } catch (err) {
    const { message, status } = friendlyError(err);
    void record({ route: "reconcile", model: RECONCILE_MODEL, ok: false, ms: Date.now() - t0, input: 0, output: 0, error: message, meta: { mode: RECONCILE_MODE } });
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
