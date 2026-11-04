import { NextResponse } from "next/server";
import { friendlyError } from "@/lib/claude";
import { report } from "@/lib/report";
import { LedgerSnapshotSchema } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const parsed = LedgerSnapshotSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  try {
    return NextResponse.json(await report(parsed.data));
  } catch (err) {
    const { message, status } = friendlyError(err);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
