import { NextResponse } from "next/server";
import { z } from "zod";
import { createShare } from "@/lib/sync/server";
import { AuditEntrySchema, ExpenseSchema, TripSchema } from "@/lib/types";

const Body = z.object({ trip: TripSchema, expenses: z.array(ExpenseSchema), audit: z.array(AuditEntrySchema).default([]) });

/** 开启云同步：把本机这次旅行上传，返回分享码。 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  try {
    const code = await createShare(parsed.data.trip, parsed.data.expenses, parsed.data.audit);
    return NextResponse.json({ ok: true, shareCode: code });
  } catch (e) {
    if (e instanceof Error && e.message === "NO_DB") return NextResponse.json({ ok: false, error: "服务端未配置数据库（TRIPSPLIT_DB_URL），云同步不可用" }, { status: 503 });
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "同步失败" }, { status: 500 });
  }
}
