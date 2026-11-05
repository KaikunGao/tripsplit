import { computeBalances, memberName, settle } from "./settle";
import type { AuditEntry, Expense, Trip } from "./types";
import type { State } from "./store";

export const DEMO_TRIP_ID = "t_demo";
export const DEMO_DONE_TRIP_ID = "t_demo_jp";

/**
 * 示例数据：两趟旅行，合起来把产品走一遍。
 *
 * 1. 成都四日游 —— 刚玩完、还没核账。预算因为错账显示超支，故意埋了几处异常给核账 Agent 找：
 *  - e_03/e_dup2：同一顿火锅记了两次
 *  - e_nopay：付款人不在参与人里（也没标请客）
 *  - e_empty：参与人为空
 *  - e_big：金额疑似多打一个零
 *  - e_pending：录入时字段不全，待补全
 *    另有请客（e_11）、按份分摊（e_12）、截图凭证、修改记录、Agent 记忆。
 * 2. 大阪京都五日 —— 已核账、已全部结清并锁账。日元按当日汇率折算，
 *    含按份 / 按比例 / 指定金额 / 请客四种分摊、预算、已转记录。
 *
 * 成都必须保持在 trips[0]：单测与评测集（eval/cases.json）都按它的成员和账目写的。
 */
export function SEED(): State {
  const cd = chengdu();
  const jp = japan();
  return {
    trips: [cd.trip, jp.trip],
    expenses: [...cd.expenses, ...jp.expenses],
    audit: [...cd.audit, ...jp.audit],
    prefs: { habits: ["住宿一般由小明先垫付", "阿强常抢着买单，他付了钱但没说「请客」时仍按 AA 算"], lastReconcile: {} },
  };
}

type Extra = Partial<Expense>;

function maker(tripId: string) {
  return (id: string, amount: number, payerId: string, participantIds: string[], category: Expense["category"], note: string, occurredAt: string, extra: Extra = {}): Expense => ({
    id,
    tripId,
    amount,
    currency: "CNY",
    payerId,
    participantIds,
    category,
    note,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    source: "manual",
    confidence: 1,
    status: "confirmed",
    ...extra,
  });
}

function auditor(tripId: string) {
  let n = 0;
  return (at: string, origin: AuditEntry["origin"], action: AuditEntry["action"], summary: string, expenseId?: string): AuditEntry => ({ id: `a_${tripId}_${++n}`, tripId, at, action, origin, summary, expenseId });
}

/** 截图凭证的缩略图：一张示意的支付成功页（内联 SVG，不依赖图片文件）。 */
function receipt(merchant: string, amount: string, time: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="300" viewBox="0 0 360 300" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif"><rect width="360" height="300" fill="#f5f5f9"/><rect x="16" y="16" width="328" height="268" rx="16" fill="#fff"/><circle cx="180" cy="66" r="22" fill="#16a34a"/><path d="m170 66 7 7 13-14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><text x="180" y="112" text-anchor="middle" font-size="14" fill="#6b7280">支付成功</text><text x="180" y="156" text-anchor="middle" font-size="34" font-weight="700" fill="#111827">${amount}</text><line x1="40" y1="182" x2="320" y2="182" stroke="#e5e7eb"/><text x="40" y="212" font-size="13" fill="#9ca3af">收款方</text><text x="320" y="212" text-anchor="end" font-size="13" fill="#374151">${merchant}</text><text x="40" y="242" font-size="13" fill="#9ca3af">支付时间</text><text x="320" y="242" text-anchor="end" font-size="13" fill="#374151">${time}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function chengdu() {
  const tripId = DEMO_TRIP_ID;
  const m = { ming: "m_ming", hua: "m_hua", qiang: "m_qiang", lin: "m_lin" };
  const trip: Trip = {
    id: tripId,
    name: "成都四日游（示例）",
    currency: "CNY",
    members: [
      { id: m.ming, name: "小明" },
      { id: m.hua, name: "小华" },
      { id: m.qiang, name: "阿强" },
      { id: m.lin, name: "小林" },
    ],
    startDate: "2025-10-01",
    endDate: "2025-10-04",
    createdAt: "2025-09-28T10:00:00.000Z",
    selfMemberId: m.ming,
    budget: { total: 5000, byCategory: { 住宿: 1400, 餐饮: 1200, 交通: 800, 门票: 500 } },
    rules: ["锦里小吃只有小明和小华吃，参与人不用补全", "伴手礼是小明自己买的，只算他一个人"],
  };
  const all = Object.values(m);
  const base = maker(tripId);
  const expenses: Expense[] = [
    base("e_01", 1280, m.ming, all, "住宿", "锦江区民宿 2 晚（10/1-10/3）", "2025-10-01T15:00:00"),
    base("e_02", 196, m.hua, all, "交通", "双流机场→市区 滴滴", "2025-10-01T13:20:00"),
    base("e_03", 412, m.qiang, all, "餐饮", "春熙路 小龙坎火锅", "2025-10-01T19:30:00", { source: "image", evidence: { kind: "image", text: "支付宝支付成功 ¥412.00 小龙坎火锅（春熙路店）", thumbnail: receipt("小龙坎火锅（春熙路店）", "¥412.00", "2025-10-01 19:30") } }),
    base("e_dup2", 412, m.qiang, all, "餐饮", "小龙坎 火锅", "2025-10-01T19:42:00", { source: "text", confidence: 0.82, evidence: { kind: "text", text: "阿强付了火锅 412" } }),
    base("e_04", 80, m.lin, all, "门票", "武侯祠门票 4 张", "2025-10-02T09:10:00"),
    base("e_05", 52, m.ming, [m.ming, m.hua], "餐饮", "锦里 三大炮+糖油果子", "2025-10-02T11:00:00"),
    base("e_06", 240, m.hua, all, "门票", "大熊猫基地门票", "2025-10-02T14:00:00"),
    base("e_11", 68, m.hua, [m.ming, m.qiang, m.lin], "餐饮", "熊猫基地门口 奶茶 3 杯", "2025-10-02T15:40:00", { treat: true, source: "text", confidence: 0.93, evidence: { kind: "text", text: "小华请大家喝奶茶 68" } }),
    base("e_nopay", 168, m.qiang, [m.ming, m.hua, m.lin], "餐饮", "宽窄巷子 钟水饺", "2025-10-02T18:30:00", { source: "voice", confidence: 0.74, evidence: { kind: "voice", text: "阿强付的钟水饺一百六十八，我和小华小林吃的" } }),
    base("e_big", 3500, m.lin, all, "交通", "青城山包车一日", "2025-10-03T08:00:00", { source: "text", confidence: 0.7, evidence: { kind: "text", text: "小林包车 350" } }),
    base("e_07", 120, m.ming, all, "门票", "青城山门票", "2025-10-03T10:00:00"),
    base("e_empty", 98, m.hua, [], "餐饮", "青城山 山脚农家菜", "2025-10-03T12:30:00", { confidence: 0.6 }),
    base("e_08", 600, m.ming, [m.ming], "购物", "伴手礼（自己买的）", "2025-10-03T17:00:00"),
    base("e_09", 318, m.lin, all, "餐饮", "太古里 日料 (10/3 晚)", "2025-10-03T19:30:00"),
    base("e_12", 260, m.qiang, all, "娱乐", "九眼桥 小酒馆", "2025-10-03T21:40:00", { split: { mode: "shares", values: { [m.qiang]: 2, [m.ming]: 1, [m.hua]: 1, [m.lin]: 1 } }, source: "voice", confidence: 0.88, evidence: { kind: "voice", text: "阿强付的酒钱两百六，他喝了两份，其他人一人一份" } }),
    base("e_10", 64, m.qiang, all, "交通", "去机场 地铁+打车", "2025-10-04T09:00:00"),
    base("e_pending", 0, m.hua, all, "餐饮", "机场早餐", "2025-10-04T07:30:00", { status: "pending", confidence: 0.4, source: "voice", evidence: { kind: "voice", text: "小华买的机场早餐" } }),
  ];
  const log = auditor(tripId);
  /* 新的在前，和 store 里 prepend 的顺序一致 */
  const audit: AuditEntry[] = [
    log("2025-10-04T07:32:00", "user", "create", "新增 机场早餐（语音，金额没听清，存为待补全）", "e_pending"),
    log("2025-10-03T21:43:00", "user", "update", "修改 九眼桥 小酒馆：分摊 均摊 → 按份（阿强 2 份）", "e_12"),
    log("2025-10-02T22:10:00", "search-confirmed", "update", "修改 锦里 三大炮+糖油果子：参与人 小明、小华、阿强、小林 → 小明、小华", "e_05"),
    log("2025-10-02T14:06:00", "user", "update", "修改 大熊猫基地门票：金额 ¥220 → ¥240", "e_06"),
    log("2025-10-01T19:31:00", "user", "create", "新增 春熙路 小龙坎火锅 ¥412（截图）", "e_03"),
    log("2025-10-01T15:02:00", "user", "create", "新增 锦江区民宿 2 晚（10/1-10/3） ¥1280", "e_01"),
  ];
  return { trip, expenses, audit };
}

function japan() {
  const tripId = DEMO_DONE_TRIP_ID;
  const m = { ming: "j_ming", hua: "j_hua", qiang: "j_qiang", lin: "j_lin", yi: "j_yi" };
  const base = maker(tripId);
  const all = Object.values(m);
  /* 日元兑人民币，按消费当日汇率记（周末沿用周五） */
  const RATE: Record<string, number> = { "07-12": 0.0487, "07-13": 0.0487, "07-14": 0.0486, "07-15": 0.0483, "07-16": 0.0484 };
  const jpy = (id: string, amount: number, payerId: string, participantIds: string[], category: Expense["category"], note: string, occurredAt: string, extra: Extra = {}) =>
    base(id, amount, payerId, participantIds, category, note, occurredAt, { currency: "JPY", rate: RATE[occurredAt.slice(5, 10)], ...extra });

  const expenses: Expense[] = [
    jpy("j_01", 4850, m.hua, all, "交通", "关西机场→难波 南海电铁 5 张", "2025-07-12T14:20:00", { source: "image", confidence: 0.96, evidence: { kind: "image", text: "南海電鉄 なんば 970円×5 合計 4,850円", thumbnail: receipt("南海電鉄 関西空港駅", "JPY 4,850", "2025-07-12 14:20") } }),
    base("j_02", 3150, m.ming, all, "住宿", "心斋桥民宿 3 晚", "2025-07-12T15:30:00"),
    jpy("j_03", 28600, m.qiang, all, "餐饮", "道顿堀 蟹道乐", "2025-07-12T19:10:00", { source: "image", confidence: 0.95, evidence: { kind: "image", text: "かに道楽 道頓堀本店 合計 ¥28,600 クレジット", thumbnail: receipt("かに道楽 道頓堀本店", "JPY 28,600", "2025-07-12 19:10") } }),
    jpy("j_04", 2140, m.yi, [m.yi, m.hua, m.lin], "餐饮", "便利店夜宵", "2025-07-12T21:30:00", { source: "voice", confidence: 0.9, evidence: { kind: "voice", text: "佳怡付的便利店两千一百四十日元，她和小华小林三个人吃的" } }),
    jpy("j_05", 18000, m.lin, all, "交通", "大阪周游卡 2 日券 ×5", "2025-07-13T09:00:00", { source: "text", confidence: 0.94, evidence: { kind: "text", text: "小林买了五张周游卡 一共 18000 日元" } }),
    jpy("j_06", 9800, m.ming, all, "餐饮", "黑门市场 海鲜", "2025-07-13T12:40:00", { split: { mode: "shares", values: { [m.qiang]: 2, [m.ming]: 1, [m.hua]: 1, [m.lin]: 1, [m.yi]: 1 } }, source: "text", confidence: 0.91, evidence: { kind: "text", text: "我付的黑门市场 9800 日元，阿强吃了两份" } }),
    jpy("j_07", 3000, m.hua, all, "门票", "大阪城天守阁 ×5", "2025-07-13T15:30:00"),
    jpy("j_08", 21500, m.yi, all, "餐饮", "难波 烧肉", "2025-07-13T19:30:00", { split: { mode: "exact", values: { [m.hua]: 2000 } }, source: "voice", confidence: 0.87, evidence: { kind: "voice", text: "佳怡付的烧肉两万一千五，小华来得晚只吃了两千，其他人平分" } }),
    base("j_09", 2790, m.ming, all, "门票", "环球影城门票 ×5（提前订）", "2025-07-14T08:30:00", { source: "image", confidence: 0.97, evidence: { kind: "image", text: "订单已支付 ¥2,790.00 日本大阪环球影城 1 日门票 ×5", thumbnail: receipt("大阪环球影城 1 日门票 ×5", "¥2,790.00", "2025-07-14 08:30") } }),
    jpy("j_10", 8900, m.lin, all, "餐饮", "影城里的午饭", "2025-07-14T12:30:00", { source: "voice", confidence: 0.89, evidence: { kind: "voice", text: "小林付的午饭八千九日元 大家一起" } }),
    jpy("j_11", 23600, m.qiang, [m.qiang, m.yi], "娱乐", "环球影城 快速通行证 ×2", "2025-07-14T14:00:00"),
    jpy("j_12", 16800, m.hua, [m.ming, m.qiang, m.lin, m.yi], "餐饮", "梅田 居酒屋（小华生日请客）", "2025-07-14T20:00:00", { treat: true, source: "text", confidence: 0.92, evidence: { kind: "text", text: "小华生日请大家居酒屋 16800 日元" } }),
    jpy("j_13", 2050, m.lin, all, "交通", "阪急 大阪→京都 ×5", "2025-07-15T09:20:00", { source: "text", confidence: 0.9, evidence: { kind: "text", text: "小林付的阪急车票 2050" } }),
    base("j_14", 1380, m.ming, all, "住宿", "京都町屋 1 晚", "2025-07-15T10:30:00", { split: { mode: "percent", values: { [m.yi]: 30, [m.ming]: 17.5, [m.hua]: 17.5, [m.qiang]: 17.5, [m.lin]: 17.5 } } }),
    jpy("j_15", 13200, m.yi, [m.yi, m.hua, m.lin], "娱乐", "和服租赁 ×3", "2025-07-15T11:30:00"),
    jpy("j_16", 2500, m.qiang, all, "门票", "清水寺 ×5", "2025-07-15T13:00:00"),
    jpy("j_17", 42000, m.qiang, all, "餐饮", "祇园 怀石料理", "2025-07-15T18:30:00", { source: "image", confidence: 0.95, evidence: { kind: "image", text: "祇園 御食事代 5名様 ¥42,000", thumbnail: receipt("祇園 懐石", "JPY 42,000", "2025-07-15 18:30") } }),
    jpy("j_18", 4600, m.hua, all, "餐饮", "伏见稻荷 早餐+抹茶", "2025-07-16T09:00:00"),
    jpy("j_19", 9000, m.yi, all, "交通", "Haruka 京都→关西机场 ×5", "2025-07-16T11:00:00"),
  ];

  const members = [
    { id: m.ming, name: "小明" },
    { id: m.hua, name: "小华" },
    { id: m.qiang, name: "阿强" },
    { id: m.lin, name: "小林" },
    { id: m.yi, name: "佳怡" },
  ];
  const draft: Trip = {
    id: tripId,
    name: "大阪京都五日（示例）",
    currency: "CNY",
    members,
    startDate: "2025-07-12",
    endDate: "2025-07-16",
    createdAt: "2025-07-05T20:00:00.000Z",
    selfMemberId: m.ming,
    budget: { total: 22000, byCategory: { 住宿: 5000, 餐饮: 7500, 交通: 2000, 门票: 3500, 娱乐: 2000 } },
    rules: ["梅田居酒屋是小华生日请客，不用分摊", "快速通行证只有阿强和佳怡买了"],
  };
  /* 结算方案直接由账目算出，再逐笔标成已转，保证"全部结清"和账目永远对得上 */
  const PAID_AT = ["2025-07-17T10:12:00", "2025-07-17T12:40:00", "2025-07-17T21:05:00", "2025-07-18T09:30:00"];
  const settlements = settle(computeBalances(draft, expenses, [])).map((t, i) => ({ ...t, paidAt: PAID_AT[Math.min(i, PAID_AT.length - 1)] }));
  const trip: Trip = { ...draft, settlements, locked: true };

  const log = auditor(tripId);
  const name = (id: string) => memberName(members, id);
  const audit: AuditEntry[] = [
    log("2025-07-18T09:32:00", "user", "settle", "全部结清，账本已锁定"),
    ...[...settlements].reverse().map((s) => log(s.paidAt, "user", "settle", `标记已转：${name(s.from)} → ${name(s.to)} ¥${s.amount}`)),
    log("2025-07-16T21:41:00", "agent-confirmed", "delete", "删除 道顿堀 蟹道乐 JPY 28600（和截图那笔重复）"),
    log("2025-07-16T21:40:00", "agent-confirmed", "update", "修改 环球影城 快速通行证 ×2：参与人 小明、小华、阿强、小林、佳怡 → 阿强、佳怡", "j_11"),
    log("2025-07-16T21:40:00", "agent-confirmed", "update", "修改 阪急 大阪→京都 ×5：金额 JPY 20500 → JPY 2050", "j_13"),
    log("2025-07-15T22:05:00", "search-confirmed", "update", "修改 和服租赁 ×3：参与人 小明、小华、阿强、小林、佳怡 → 小华、小林、佳怡", "j_15"),
    log("2025-07-14T20:30:00", "user", "update", "修改 梅田 居酒屋（小华生日请客）：请客 否 → 是", "j_12"),
    log("2025-07-13T19:36:00", "user", "update", "修改 难波 烧肉：分摊 均摊 → 指定金额（小华 JPY 2000）", "j_08"),
    log("2025-07-12T15:32:00", "user", "create", "新增 心斋桥民宿 3 晚 ¥3150", "j_02"),
  ];
  return { trip, expenses, audit };
}
