import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODEL, client } from "./claude";
import { computeBalances, homeAmount, memberName, settle } from "./settle";
import type { LedgerSnapshot } from "./types";

/** 确定性聚合，模型只负责把数字写成人话；数字永远以聚合结果为准。 */
export function aggregate(snap: LedgerSnapshot) {
  const { trip, expenses } = snap;
  const confirmed = expenses.filter((e) => e.status === "confirmed");
  const total = r2(confirmed.reduce((a, e) => a + homeAmount(e), 0));
  const byCategory: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  const byPayer: Record<string, number> = {};
  for (const e of confirmed) {
    byCategory[e.category] = r2((byCategory[e.category] ?? 0) + homeAmount(e));
    const d = e.occurredAt.slice(0, 10);
    byDay[d] = r2((byDay[d] ?? 0) + homeAmount(e));
    const p = memberName(trip.members, e.payerId);
    byPayer[p] = r2((byPayer[p] ?? 0) + homeAmount(e));
  }
  const balances = computeBalances(trip, expenses).map((b) => ({ ...b, name: memberName(trip.members, b.memberId) }));
  const transfers = settle(balances).map((t) => ({ from: memberName(trip.members, t.from), to: memberName(trip.members, t.to), amount: t.amount }));
  /* 已经转完的钱单独列出：净额里已扣掉它们，不说明的话模型会把"净额为 0 但垫付不等"当成异常 */
  const paid = (trip.settlements ?? []).map((t) => ({ from: memberName(trip.members, t.from), to: memberName(trip.members, t.to), amount: t.amount }));
  const top = [...confirmed].sort((a, b) => homeAmount(b) - homeAmount(a)).slice(0, 3).map((e) => ({ note: e.note, amount: homeAmount(e), category: e.category }));
  return { total, count: confirmed.length, pending: expenses.length - confirmed.length, byCategory, byDay, byPayer, balances, transfers, paid, settled: paid.length > 0 && transfers.length === 0, top, perHead: trip.members.length ? r2(total / trip.members.length) : 0 };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

const NarrativeSchema = z.object({
  title: z.string(),
  highlights: z.array(z.string()).describe("3-5 条要点，每条一句话，含具体数字"),
  narrative: z.string().describe("150 字以内的旅行消费小结，口语化"),
});

export async function report(snap: LedgerSnapshot) {
  const agg = aggregate(snap);
  const res = await client().messages.parse({
    model: MODEL,
    max_tokens: 1500,
    system: "你根据给定的聚合数据写一份旅行消费报告。所有数字必须来自给定数据，不得自行计算或改动；不要提及结算转账以外的建议。transfers 是还没转的钱，paid 是已经转完的，balances 的 net 已扣除 paid；settled=true 表示这趟已全部结清。",
    messages: [{ role: "user", content: `旅行：${snap.trip.name}\n聚合数据：${JSON.stringify(agg)}` }],
    output_config: { effort: "low", format: zodOutputFormat(NarrativeSchema) },
  });
  return { ok: true as const, aggregate: agg, narrative: res.parsed_output, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
}
