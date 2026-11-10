import type { Client } from "@libsql/client";

/**
 * 数据库（libsql）：云同步、遥测、评测结果都放这里。
 *  - 本地开发：TRIPSPLIT_DB_URL=file:./data/tripsplit.db（默认，自动建表，走 Node 客户端）
 *  - 线上：TRIPSPLIT_DB_URL=libsql://xxx.turso.io + TRIPSPLIT_DB_TOKEN（走 web 客户端，Vercel / Cloudflare 通用）
 *  - 设为 "off"，或 Vercel / Cloudflare 上未配置时返回 null，功能自动退回本机模式。
 *
 * 2026-11-10 为部署到 Cloudflare Workers 改成异步：Workers 上不能静态引入 Node 版客户端，
 * 也不能跨请求复用 WebSocket，所以远端一律用 HTTP（https://）。
 */
const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

let _db: Promise<Client | null> | undefined;

async function connect(): Promise<Client | null> {
  const url = process.env.TRIPSPLIT_DB_URL ?? (process.env.VERCEL || onWorkers ? "off" : "file:./data/tripsplit.db");
  if (url === "off") return null;
  try {
    let c: Client;
    if (url.startsWith("file:")) {
      // 本地文件库：先把目录建出来，libsql 不会自动创建
      const [{ mkdirSync }, { dirname }, { createClient }] = await Promise.all([import("node:fs"), import("node:path"), import("@libsql/client")]);
      mkdirSync(dirname(url.slice(5)), { recursive: true });
      c = createClient({ url });
    } else {
      const { createClient } = await import("@libsql/client/web");
      c = createClient({ url: onWorkers ? url.replace(/^libsql:/, "https:") : url, authToken: process.env.TRIPSPLIT_DB_TOKEN });
    }
    await migrate(c);
    return c;
  } catch (e) {
    console.warn("db init failed", e);
    return null;
  }
}

/** 拿到已建好表的客户端；不可用时为 null。同一进程只连一次。 */
export function ready(): Promise<Client | null> {
  if (_db === undefined) _db = connect();
  return _db;
}

/** 与 ready() 相同，保留旧名字。 */
export const db = ready;
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
