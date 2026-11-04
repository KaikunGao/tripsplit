import { NextResponse } from "next/server";
import { friendlyError } from "@/lib/claude";
import { SearchRequestSchema, search } from "@/lib/search/answer";

export const maxDuration = 60;

export async function POST(req: Request) {
  const parsed = SearchRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  try {
    const { query, ...snap } = parsed.data;
    return NextResponse.json(await search(snap, query));
  } catch (err) {
    const { message, status } = friendlyError(err);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
