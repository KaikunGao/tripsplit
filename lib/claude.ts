import Anthropic from "@anthropic-ai/sdk";

// DECISION: 模型与 effort 走环境变量，方便 eval 时对比，不改代码。
export const MODEL = process.env.TRIPSPLIT_MODEL ?? "claude-opus-5-5";
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
  return { message: err instanceof Error ? err.message : "未知错误", status: 500 };
}
