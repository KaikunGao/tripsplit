import { z } from "zod";
import { ready } from "../db";
import { AuditEntrySchema, ExpenseSchema, TripSchema, type AuditEntry, type Expense, type Trip } from "../types";

/**
 * 云同步（服务端）。没有账号体系：分享码就是凭证，拿到邀请链接的人即可读写这次旅行。
 * 所有表都以分享码为作用域：不同用户的示例旅行（id 都是 t_demo、账目 id 都是 e_01…）互不干扰。
 * 合并规则：
 *  - 账目按 updatedAt 最后写入胜（LWW）；删除是墓碑，墓碑之后的修改不会复活它。
 *  - 旅行文档整体 LWW（谁后推谁赢），但 id 固定为首次分享时的 id。
 *  - 审计记录按 id 去重、只增不删。
 */
export const PushSchema = z.object({
  trip: TripSchema.optional(),
  expenses: z.array(ExpenseSchema),
  deletedIds: z.array(z.string()).default([]),
  audit: z.array(AuditEntrySchema).default([]),
});
export type Push = z.infer<typeof PushSchema>;
export type Pull = { trip: Trip; expenses: Expense[]; audit: AuditEntry[]; version: number; serverTime: string };

export function newShareCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

/** 开启分享：永远生成新分享码（同一设备重复点"开启"由客户端用已有 shareCode 拦住）。 */
export async function createShare(trip: Trip, expenses: Expense[], audit: AuditEntry[]): Promise<string> {
  const d = await ready();
  if (!d) throw new Error("NO_DB");
  const code = newShareCode();
  const t = { ...trip, shareCode: code };
  const now = new Date().toISOString();
  await d.batch(
    [
      { sql: "INSERT INTO shares (code, trip_id, data, version, updated_at) VALUES (?,?,?,1,?)", args: [code, t.id, JSON.stringify(t), now] },
      ...expenses.filter((e) => e.tripId === t.id).map((e) => ({ sql: "INSERT INTO share_expenses (code, id, data, updated_at, deleted) VALUES (?,?,?,?,0)", args: [code, e.id, JSON.stringify(e), e.updatedAt] })),
      ...audit.filter((a) => a.tripId === t.id).map((a) => ({ sql: "INSERT OR IGNORE INTO share_audit (code, id, at, data) VALUES (?,?,?,?)", args: [code, a.id, a.at, JSON.stringify(a)] })),
    ],
    "write",
  );
  return code;
}

async function shareByCode(code: string) {
  const d = await ready();
  if (!d) throw new Error("NO_DB");
  const r = await d.execute({ sql: "SELECT trip_id, data, version FROM shares WHERE code = ?", args: [code] });
  if (!r.rows[0]) return null;
  return { d, tripId: String(r.rows[0].trip_id), trip: JSON.parse(String(r.rows[0].data)) as Trip, version: Number(r.rows[0].version) };
}

export async function pull(code: string): Promise<Pull | null> {
  const t = await shareByCode(code);
  if (!t) return null;
  const es = await t.d.execute({ sql: "SELECT data FROM share_expenses WHERE code = ? AND deleted = 0", args: [code] });
  const au = await t.d.execute({ sql: "SELECT data FROM share_audit WHERE code = ? ORDER BY at DESC LIMIT 500", args: [code] });
  return {
    trip: { ...t.trip, id: t.tripId, shareCode: code },
    expenses: es.rows.map((r) => JSON.parse(String(r.data)) as Expense),
    audit: au.rows.map((r) => JSON.parse(String(r.data)) as AuditEntry),
    version: t.version,
    serverTime: new Date().toISOString(),
  };
}

export async function push(code: string, body: Push): Promise<Pull | null> {
  const t = await shareByCode(code);
  if (!t) return null;
  const now = new Date().toISOString();
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  if (body.trip) {
    const merged = { ...body.trip, id: t.tripId, shareCode: code };
    stmts.push({ sql: "UPDATE shares SET data = ?, updated_at = ?, version = version + 1 WHERE code = ?", args: [JSON.stringify(merged), now, code] });
  }
  for (const e of body.expenses) {
    if (e.tripId !== t.tripId) continue;
    // 新行直接插；已有行只有更新时间更新才覆盖；墓碑不复活
    stmts.push({
      sql: "INSERT INTO share_expenses (code, id, data, updated_at, deleted) VALUES (?,?,?,?,0) ON CONFLICT(code, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE excluded.updated_at > share_expenses.updated_at AND share_expenses.deleted = 0",
      args: [code, e.id, JSON.stringify(e), e.updatedAt],
    });
  }
  for (const id of body.deletedIds) stmts.push({ sql: "UPDATE share_expenses SET deleted = 1, updated_at = ? WHERE code = ? AND id = ?", args: [now, code, id] });
  for (const a of body.audit) if (a.tripId === t.tripId) stmts.push({ sql: "INSERT OR IGNORE INTO share_audit (code, id, at, data) VALUES (?,?,?,?)", args: [code, a.id, a.at, JSON.stringify(a)] });
  if (stmts.length) await t.d.batch(stmts, "write");
  return pull(code);
}
