import { NextResponse } from "next/server";
import { PushSchema, pull, push } from "@/lib/sync/server";

type Ctx = { params: Promise<{ code: string }> };

function fail(e: unknown) {
  if (e instanceof Error && e.message === "NO_DB") return NextResponse.json({ ok: false, error: "服务端未配置数据库，云同步不可用" }, { status: 503 });
  return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "同步失败" }, { status: 500 });
}

/** 拉取：返回这次旅行的全量当前状态。 */
export async function GET(_req: Request, ctx: Ctx) {
  const { code } = await ctx.params;
  try {
    const r = await pull(code);
    if (!r) return NextResponse.json({ ok: false, error: "邀请码无效或旅行已删除" }, { status: 404 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return fail(e);
  }
}

/** 推送本机变更并返回合并后的全量状态。 */
export async function POST(req: Request, ctx: Ctx) {
  const { code } = await ctx.params;
  const parsed = PushSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  try {
    const r = await push(code, parsed.data);
    if (!r) return NextResponse.json({ ok: false, error: "邀请码无效或旅行已删除" }, { status: 404 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return fail(e);
  }
}
