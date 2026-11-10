import Anthropic from "@anthropic-ai/sdk";

// DECISION: 模型与 effort 走环境变量，方便 eval 时对比，不改代码。
// 核账 Agent、检索、报告、导入默认 opus（没做过同样的评测）；TRIPSPLIT_MODEL 一次覆盖全部路径。
export const MODEL = process.env.TRIPSPLIT_MODEL ?? "claude-opus-5-5";
// 录入解析默认 sonnet：2026-11-10 的 100 例评测里 sonnet 97 / opus 96 / haiku 88 通过，
// sonnet 单条成本是 opus 的 19%、耗时少约四成（docs/评测-2026-11-10.md）。TRIPSPLIT_EXTRACT_MODEL 只覆盖这一路径。
export const EXTRACT_MODEL = process.env.TRIPSPLIT_EXTRACT_MODEL ?? process.env.TRIPSPLIT_MODEL ?? "claude-sonnet-5-5";
export type Effort = "low" | "medium" | "high";
export const EFFORT = (process.env.TRIPSPLIT_EFFORT ?? "medium") as Effort;

let _client: Anthropic | null = null;
export function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

/** 把 SDK 错误映射成用户可读文案（不泄露内部细节）。 */
export function friendlyError(err: unknown): { message: string; status: number } {
  if (err instanceof Anthropic.AuthenticationError) return { message: "服务端未配置有效的 ANTHROPIC_API_KEY", status: 500 };
  if (err instanceof Anthropic.RateLimitError) return { message: "请求太频繁，请稍后再试", status: 429 };
  if (err instanceof Anthropic.BadRequestError) return { message: "请求内容无法处理：" + err.message, status: 400 };
  if (err instanceof Anthropic.APIConnectionError) return { message: "无法连接模型服务，请检查网络", status: 502 };
  if (err instanceof Anthropic.APIError) return { message: `模型服务错误 (${err.status})`, status: 502 };
  // SDK 在构造客户端时找不到任何凭证会抛普通 Error（不是 APIError）。
  if (err instanceof Error && /authentication method/i.test(err.message)) return { message: "服务端未配置 ANTHROPIC_API_KEY", status: 500 };
  return { message: err instanceof Error ? err.message : "未知错误", status: 500 };
}
