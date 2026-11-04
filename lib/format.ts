export const money = (n: number, currency = "CNY") =>
  (currency === "CNY" ? "¥" : currency + " ") + n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const day = (iso: string) => iso.slice(0, 10);
export const hhmm = (iso: string) => iso.slice(11, 16);
export const weekday = (iso: string) => ["日", "一", "二", "三", "四", "五", "六"][new Date(iso).getDay()];

/** 本地时间的 ISO（无时区后缀），与录入模型的 occurred_at 格式一致。 */
export function localIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

/** 本地日期 YYYY-MM-DD（服务端与浏览器都用本地时区，避免 UTC 跨日）。 */
export const todayLocal = () => localIso().slice(0, 10);

/** 审计时间展示：本地 MM-DD HH:mm */
export const localStamp = (iso: string) => localIso(new Date(iso)).slice(5, 16).replace("T", " ");
