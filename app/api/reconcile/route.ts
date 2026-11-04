import { NextResponse } from "next/server";
import { reconcile } from "@/lib/agent/run";
import { friendlyError } from "@/lib/claude";
import { LedgerSnapshotSchema } from "@/lib/types";

export const maxDuration = 120;

export async function POST(req: Request) {
  const parsed = LedgerSnapshotSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  try {
    return NextResponse.json(await reconcile(parsed.data));
  } catch (err) {
    const { message, status } = friendlyError(err);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
