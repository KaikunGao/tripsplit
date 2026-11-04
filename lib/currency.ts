/** 常用币种：代码、中文名、符号。第一项 CNY 是默认本币。 */
export const CURRENCIES: { code: string; name: string; symbol: string }[] = [
  { code: "CNY", name: "人民币", symbol: "¥" },
  { code: "JPY", name: "日元", symbol: "¥" },
  { code: "USD", name: "美元", symbol: "$" },
  { code: "EUR", name: "欧元", symbol: "€" },
  { code: "GBP", name: "英镑", symbol: "£" },
  { code: "HKD", name: "港币", symbol: "HK$" },
  { code: "KRW", name: "韩元", symbol: "₩" },
  { code: "THB", name: "泰铢", symbol: "฿" },
  { code: "TWD", name: "新台币", symbol: "NT$" },
  { code: "SGD", name: "新加坡元", symbol: "S$" },
  { code: "MYR", name: "马来西亚林吉特", symbol: "RM" },
  { code: "AUD", name: "澳元", symbol: "A$" },
  { code: "CAD", name: "加元", symbol: "C$" },
];

export const currencyName = (code: string) => CURRENCIES.find((c) => c.code === code)?.name ?? code;

/** 向 /api/rate 取某日汇率（1 from = ? to）；取不到返回 null，由用户手填。 */
export async function fetchRate(from: string, to: string, date: string): Promise<{ rate: number; date: string; source: string } | null> {
  if (from === to) return { rate: 1, date, source: "same" };
  try {
    const r = await fetch(`/api/rate?from=${from}&to=${to}&date=${date}`);
    const j = await r.json();
    return j.ok ? { rate: j.rate, date: j.date, source: j.source } : null;
  } catch {
    return null;
  }
}
