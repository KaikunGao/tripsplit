/**
 * 支付宝 / 微信账单 CSV 解析（纯函数，浏览器与 Node 都能跑）。
 * 两家导出格式都是"若干行说明 + 一行表头 + 明细"，表头里有「交易时间」和「金额」。
 * 支付宝 CSV 是 GBK 编码，调用方先用 TextDecoder("gbk") 解码再传进来。
 */
export type BillRow = {
  time: string; // ISO 本地时间 YYYY-MM-DDTHH:mm:ss
  merchant: string;
  item: string;
  amount: number;
  method: string;
  source: "alipay" | "wechat" | "generic";
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normTime(s: string): string | null {
  const m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h = "12", mi = "00", se = "00"] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:${se}`;
}

export function parseBillCsv(text: string): { rows: BillRow[]; source: BillRow["source"]; skipped: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const headerIdx = lines.findIndex((l) => /交易时间/.test(l) && /金额/.test(l));
  if (headerIdx < 0) return { rows: [], source: "generic", skipped: lines.length };
  const header = parseCsvLine(lines[headerIdx]);
  const source: BillRow["source"] = header.some((h) => /商品说明/.test(h)) ? "alipay" : header.some((h) => /^商品$/.test(h) || /交易类型/.test(h)) ? "wechat" : "generic";
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const iTime = col(/交易时间/);
  const iAmt = col(/金额/);
  const iDir = col(/收\/支/);
  const iPeer = col(/交易对方/);
  const iItem = col(/商品说明|^商品$|商品名称|摘要/);
  const iMethod = col(/付款方式|支付方式/);
  const iStatus = col(/交易状态|当前状态/);
  const rows: BillRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(headerIdx + 1)) {
    const c = parseCsvLine(line);
    if (c.length < header.length - 2) {
      skipped++;
      continue;
    }
    const dir = iDir >= 0 ? c[iDir] : "支出";
    if (dir && !/支出/.test(dir)) {
      skipped++;
      continue;
    }
    const status = iStatus >= 0 ? c[iStatus] : "";
    if (/退款|关闭|失败|已撤销/.test(status)) {
      skipped++;
      continue;
    }
    const time = normTime(c[iTime] ?? "");
    const amount = Number(String(c[iAmt] ?? "").replace(/[¥￥,\s]/g, ""));
    if (!time || !Number.isFinite(amount) || amount <= 0) {
      skipped++;
      continue;
    }
    rows.push({ time, merchant: iPeer >= 0 ? c[iPeer] : "", item: iItem >= 0 ? c[iItem] : "", amount: Math.round(amount * 100) / 100, method: iMethod >= 0 ? c[iMethod] : "", source });
  }
  return { rows, source, skipped };
}
