"use client";
import { money } from "./format";
import { homeAmount, memberName, type Transfer } from "./settle";
import type { Expense, Settlement, Trip } from "./types";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 账本导出为 CSV（带 BOM，Excel 直接打开中文不乱码）。 */
export function exportLedgerCsv(trip: Trip, expenses: Expense[]) {
  const head = ["日期", "时间", "事项", "分类", "金额", "币种", "汇率", `本币金额(${trip.currency})`, "付款人", "参与人", "分摊方式", "请客", "状态", "来源", "置信度", "原始证据"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [...expenses]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .map((e) => [
      e.occurredAt.slice(0, 10),
      e.occurredAt.slice(11, 16),
      e.note,
      e.category,
      e.amount,
      e.currency,
      e.rate ?? "",
      homeAmount(e),
      memberName(trip.members, e.payerId),
      e.participantIds.map((id) => memberName(trip.members, id)).join("、"),
      { equal: "均摊", shares: "按份数", percent: "按比例", exact: "指定金额" }[e.split?.mode ?? (e.shares ? "shares" : "equal")],
      e.treat ? "是" : "",
      e.status === "pending" ? "待补全" : "已入账",
      { manual: "手动", text: "文字", image: "截图", voice: "语音", agent: "核账" }[e.source],
      e.confidence,
      e.evidence?.text ?? "",
    ]);
  const csv = "﻿" + [head, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${trip.name}-账本.csv`);
}

/** 结算方案生成一张图片卡片（PNG），可保存或直接系统分享到群里。 */
export async function shareSettlementCard(trip: Trip, transfers: Transfer[], paid: Settlement[], total: number): Promise<"shared" | "downloaded"> {
  const W = 720;
  const lineH = 64;
  const rows = transfers.length + paid.length;
  const H = 200 + Math.max(1, rows) * lineH + 90;
  const c = document.createElement("canvas");
  c.width = W * 2;
  c.height = H * 2;
  const g = c.getContext("2d")!;
  g.scale(2, 2);
  // 背景
  g.fillStyle = "#f5f5f9";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#ffffff";
  roundRect(g, 24, 24, W - 48, H - 48, 24);
  g.fill();
  // 标题
  g.fillStyle = "#4338ca";
  roundRect(g, 48, 52, 36, 36, 10);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 20px system-ui, -apple-system, 'PingFang SC', sans-serif";
  g.fillText("T", 59, 78);
  g.fillStyle = "#1a1a2e";
  g.font = "bold 26px system-ui, -apple-system, 'PingFang SC', sans-serif";
  g.fillText(`${trip.name} · 结算方案`, 100, 80);
  g.fillStyle = "#6b6b85";
  g.font = "15px system-ui, -apple-system, 'PingFang SC', sans-serif";
  g.fillText(`${trip.startDate ?? ""} ~ ${trip.endDate ?? ""} · 合计 ${money(total, trip.currency)} · ${trip.members.length} 人`, 100, 106);
  // 转账行
  let y = 160;
  const draw = (from: string, to: string, amt: number, done: boolean) => {
    g.fillStyle = done ? "#f0f0f5" : "#eef2ff";
    roundRect(g, 48, y - 36, W - 96, 52, 14);
    g.fill();
    g.fillStyle = done ? "#8b8ba3" : "#1a1a2e";
    g.font = "600 18px system-ui, -apple-system, 'PingFang SC', sans-serif";
    g.fillText(`${from}  →  ${to}`, 68, y - 4);
    g.textAlign = "right";
    g.fillText(`${money(amt, trip.currency)}${done ? "  已转 ✓" : ""}`, W - 68, y - 4);
    g.textAlign = "left";
    y += lineH;
  };
  for (const t of transfers) draw(memberName(trip.members, t.from), memberName(trip.members, t.to), t.amount, false);
  for (const p of paid) draw(memberName(trip.members, p.from), memberName(trip.members, p.to), p.amount, true);
  if (rows === 0) {
    g.fillStyle = "#15803d";
    g.font = "600 18px system-ui, -apple-system, 'PingFang SC', sans-serif";
    g.fillText("已经平了，不需要转账 ✓", 68, y - 4);
    y += lineH;
  }
  g.fillStyle = "#8b8ba3";
  g.font = "13px system-ui, -apple-system, 'PingFang SC', sans-serif";
  g.fillText("由 TripSplit 旅游分账助手生成 · 最少转账方案", 48, H - 44);

  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
  const file = new File([blob], `${trip.name}-结算.png`, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: `${trip.name} 结算方案` });
      return "shared";
    } catch {
      /* 用户取消分享则落到下载 */
    }
  }
  download(blob, file.name);
  return "downloaded";
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** 消费报告导出 PDF：生成一页打印友好的 HTML，在新窗口打开并调用打印（另存为 PDF）。 */
export function printReport(
  trip: Trip,
  expenses: Expense[],
  agg: { total: number; count: number; byCategory: Record<string, number>; byDay: Record<string, number>; byPayer: Record<string, number>; balances: { name: string; paid: number; owed: number; net: number }[]; transfers: { from: string; to: string; amount: number }[]; perHead: number },
  narrative: { title: string; highlights: string[]; narrative: string } | null,
) {
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const table = (title: string, rows: [string, number][]) =>
    `<h3>${title}</h3><table>${rows
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${money(v, trip.currency)}</td></tr>`)
      .join("")}</table>`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(trip.name)} 消费报告</title>
<style>
body{font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:#1a1a2e;margin:40px;max-width:800px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:2px solid #4338ca;padding-bottom:4px}h3{font-size:13px;color:#6b6b85;margin:14px 0 6px}
p,li{font-size:13px;line-height:1.6}.muted{color:#6b6b85;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{padding:5px 6px;border-bottom:1px solid #e2e2ea;text-align:left}td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}.kpi{display:flex;gap:24px;margin:12px 0}.kpi div{background:#f5f5f9;border-radius:10px;padding:10px 14px}.kpi b{display:block;font-size:20px}
@media print{body{margin:16mm}}
</style></head><body>
<h1>${esc(narrative?.title ?? trip.name + " 消费报告")}</h1>
<p class="muted">${esc(trip.startDate ?? "")} ~ ${esc(trip.endDate ?? "")} · ${trip.members.map((m) => esc(m.name)).join("、")} · 生成于 ${new Date().toLocaleString("zh-CN")}</p>
<div class="kpi"><div><span class="muted">总支出</span><b>${money(agg.total, trip.currency)}</b></div><div><span class="muted">笔数</span><b>${agg.count}</b></div><div><span class="muted">人均</span><b>${money(agg.perHead, trip.currency)}</b></div></div>
${narrative ? `<h2>小结</h2><ul>${narrative.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul><p>${esc(narrative.narrative)}</p>` : ""}
<h2>统计</h2><div class="grid">${table("按分类", Object.entries(agg.byCategory))}${table("按天", Object.entries(agg.byDay))}${table("谁垫付", Object.entries(agg.byPayer))}</div>
<h2>每人收支</h2><table><tr><th>成员</th><th class="r">已垫付</th><th class="r">应分摊</th><th class="r">净额</th></tr>${agg.balances.map((b) => `<tr><td>${esc(b.name)}</td><td class="r">${money(b.paid, trip.currency)}</td><td class="r">${money(b.owed, trip.currency)}</td><td class="r">${b.net > 0 ? "+" : ""}${money(b.net, trip.currency)}</td></tr>`).join("")}</table>
<h2>最少转账方案</h2>${agg.transfers.length ? `<table>${agg.transfers.map((t) => `<tr><td>${esc(t.from)} → ${esc(t.to)}</td><td class="r">${money(t.amount, trip.currency)}</td></tr>`).join("")}</table>` : "<p>已经平了，不需要转账。</p>"}
<h2>账目明细（${expenses.length} 笔）</h2><table><tr><th>日期</th><th>事项</th><th>分类</th><th>付款人</th><th>参与人</th><th class="r">金额</th></tr>${[...expenses]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .map((e) => `<tr><td>${e.occurredAt.slice(5, 16).replace("T", " ")}</td><td>${esc(e.note)}${e.treat ? " <span class='muted'>(请客)</span>" : ""}${e.status === "pending" ? " <span class='muted'>(待补全)</span>" : ""}</td><td>${e.category}</td><td>${esc(memberName(trip.members, e.payerId))}</td><td>${e.participantIds.map((id) => esc(memberName(trip.members, id))).join("、")}</td><td class="r">${money(e.amount, e.currency)}${e.currency !== trip.currency ? ` <span class="muted">≈${money(homeAmount(e), trip.currency)}</span>` : ""}</td></tr>`)
    .join("")}</table>
<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>
</body></html>`;
  const w = window.open("", "_blank");
  if (!w) return alert("浏览器拦截了新窗口，请允许弹窗后重试");
  w.document.write(html);
  w.document.close();
}
