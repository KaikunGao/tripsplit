import { NextResponse } from "next/server";
import { friendlyError } from "@/lib/claude";
import { extract } from "@/lib/extract/extract";
import { ExtractRequestSchema } from "@/lib/extract/schema";

export const maxDuration = 60;

export async function POST(req: Request) {
  const parsed = ExtractRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  if (parsed.data.kind === "image" && !parsed.data.image) return NextResponse.json({ ok: false, error: "缺少图片" }, { status: 400 });
  if (parsed.data.kind !== "image" && !parsed.data.text?.trim()) return NextResponse.json({ ok: false, error: "内容为空" }, { status: 400 });
  try {
    return NextResponse.json(await extract(parsed.data));
  } catch (err) {
    const { message, status } = friendlyError(err);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
