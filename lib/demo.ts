import snapshot from "./demo-results.json";
import type { ReconcileResult } from "./agent/run";
import type { aggregate } from "./report";
import type { SearchResult } from "./search/answer";
import { DEMO_DONE_TRIP_ID, DEMO_TRIP_ID } from "./seed";
import { fingerprint } from "./store";
import type { Expense, Trip } from "./types";

/**
 * 示例账本的 AI 结果快照：scripts/demo-snapshot.ts 对示例数据真实跑一遍核账 / 检索 / 报告后存下来的输出。
 * 示例旅行的核账页、查询页首次打开时直接展示它，访客不用先等 30 秒；
 * 账本一旦被改动（指纹对不上）就不再展示，避免结论和账目不一致。
 */
export type DemoReport = { aggregate: ReturnType<typeof aggregate>; narrative: { title: string; highlights: string[]; narrative: string } | null };
export type DemoResults = {
  fingerprint: string;
  reconcile?: ReconcileResult;
  search?: { query: string; result: SearchResult };
  report?: DemoReport;
};

const TRIPS = (snapshot as unknown as { trips: Record<string, DemoResults> }).trips;

export const isDemoTrip = (id: string) => id === DEMO_TRIP_ID || id === DEMO_DONE_TRIP_ID;

export function demoResults(trip: Trip, expenses: Expense[]): DemoResults | null {
  const d = TRIPS[trip.id];
  return d && d.fingerprint === fingerprint(expenses) ? d : null;
}

/** 查询页的示例问题：要和这趟旅行的账目对得上。 */
export const DEMO_QUESTIONS: Record<string, string[]> = {
  [DEMO_TRIP_ID]: ["第一天晚上那顿火锅是谁付的？", "小林付的超过 300 的账", "10月2号的门票花了多少", "把钟水饺那笔的参与人改成大家", "这趟餐饮一共花了多少，谁付得最多"],
  [DEMO_DONE_TRIP_ID]: ["这趟餐饮一共花了多少，谁付得最多", "环球影城那天一共花了多少", "阿强付的超过两万日元的账", "哪几笔不是所有人都参与的？", "小华请客的是哪一顿"],
};
