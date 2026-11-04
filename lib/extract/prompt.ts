import type Anthropic from "@anthropic-ai/sdk";
import type { Trip } from "../types";
import { CATEGORIES } from "../types";
import { todayLocal } from "../format";
import type { ExtractRequest } from "./schema";

export function systemPrompt(trip: Trip, habits: string[] = []): string {
  const self = trip.members.find((m) => m.id === trip.selfMemberId)?.name;
  return [
    "你是多人旅行 AA 记账助手的录入解析器。输入是一段文字、一张支付截图或一段语音转写，任务是抽取一笔消费的结构化字段。",
    "",
    `旅行：${trip.name}（${trip.startDate ?? "?"} 至 ${trip.endDate ?? "?"}，默认币种 ${trip.currency}）`,
    `成员名单（payer 与 participants 只能用这些名字）：${trip.members.map((m) => m.name).join("、")}`,
    self ? `当前使用者是「${self}」，"我/我付的/我的支付宝"指的就是${self}。` : "",
    `分类只能是：${CATEGORIES.join("/")}`,
    "",
    "规则：",
    "- 置信度要诚实：字段是输入里明确写出的给 0.9+；靠推断（如截图没写谁付、默认当前使用者）给 0.6-0.8；完全猜的给 0.5 以下或填 null。",
    "- 支付截图：读取实付金额、商户、支付时间。截图本身不说明付款人，除非有明确线索，否则 payer 取当前使用者且置信度 ≤ 0.75。",
    "- 参与人没提到时：不要臆测，participants 留空并在 questions 里问「这笔有谁参与分摊？」。说了'大家/我们/AA/所有人'则列出全部成员。",
    "- 金额看不清或有多个候选（如原价/实付）时取实付；仍不确定则 amount 为 null 并追问。",
    "- 用户补充回答（supplement）优先级最高，用它修正上一轮结果。",
    "- 不是消费（聊天、风景照、非支付截图）时 is_expense=false 并说明原因。",
    "- 请客：出现'请客/我请/X 请大家'时 treat=true，participants 列出被请的人、不含付款人；普通 AA 时 treat=false 且付款人通常也在参与人里。",
    `- 币种：出现外币（日元/円/¥JPY、美元/$、欧元/€、泰铢/฿、港币、韩元、新台币等）时 currency 填 ISO 代码（JPY/USD/EUR/THB/HKD/KRW/TWD），金额保持原币；没提币种按 ${trip.currency}。`,
    habits.length ? `\n已知的个人习惯（用于推断付款人/参与人，但置信度仍按证据给）：\n${habits.map((h) => "- " + h).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function userContent(req: ExtractRequest): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (req.kind === "image" && req.image) {
    blocks.push({ type: "image", source: { type: "base64", media_type: req.image.media_type, data: req.image.data } });
  }
  const lines: string[] = [];
  lines.push(`录入方式：${{ text: "文字", image: "支付截图", voice: "语音转写" }[req.kind]}`);
  lines.push(`今天：${todayLocal()}`);
  if (req.text?.trim()) lines.push(`${req.kind === "image" ? "用户附言" : "内容"}：${req.text.trim()}`);
  if (req.previous) lines.push(`上一轮抽取结果：${JSON.stringify(req.previous)}`);
  if (req.supplement?.trim()) lines.push(`用户补充回答：${req.supplement.trim()}`);
  blocks.push({ type: "text", text: lines.join("\n") });
  return blocks;
}
