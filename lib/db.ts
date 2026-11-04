import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 数据库（libsql）：云同步、遥测、评测结果都放这里。
 *  - 本地开发：TRIPSPLIT_DB_URL=file:./data/tripsplit.db（默认，自动建表）
 *  - 线上：TRIPSPLIT_DB_URL=libsql://xxx.turso.io + TRIPSPLIT_DB_TOKEN
 *  - 设为 "off" 或 Vercel 上未配置时返回 null，功能自动退回本机模式。
 */
let _db: Client | null | undefined;
let _ready: Promise<void> | null = null;

export function db(): Client | null {
  if (_db !== undefined) return _db;
  const url = process.env.TRIPSPLIT_DB_URL ?? (process.env.VERCEL ? "off" : "file:./data/tripsplit.db");
  if (url === "off") return (_db = null);
  try {
    // 本地文件库：先把目录建出来，libsql 不会自动创建
    if (url.startsWith("file:")) mkdirSync(dirname(url.slice(5)), { recursive: true });
    _db = createClient({ url, authToken: process.env.TRIPSPLIT_DB_TOKEN });
    _ready = migrate(_db);
    return _db;
  } catch (e) {
    console.warn("db init failed", e);
    return (_db = null);
  }
}

/** 等建表完成（路由里 await 一下即可）。 */
export async function ready(): Promise<Client | null> {
  const d = db();
  if (_ready) await _ready;
  return d;
}

async function migrate(c: Client) {
  await c.batch(
    [
      `CREATE TABLE IF NOT EXISTS shares (
        code TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL,
        data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS share_expenses (
        code TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (code, id)
      )`,
      `CREATE TABLE IF NOT EXISTS share_audit (
        code TEXT NOT NULL,
        id TEXT NOT NULL,
        at TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (code, id)
      )`,
      `CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        route TEXT NOT NULL,
        model TEXT NOT NULL,
        ok INTEGER NOT NULL,
        ms INTEGER NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        error TEXT,
        meta TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS evals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        model TEXT NOT NULL,
        cases INTEGER NOT NULL,
        decision_acc REAL NOT NULL,
        amount_acc REAL NOT NULL,
        payer_acc REAL NOT NULL,
        participants_acc REAL NOT NULL,
        category_acc REAL NOT NULL,
        cost_usd REAL NOT NULL,
        detail TEXT
      )`,
    ],
    "write",
  );
}
