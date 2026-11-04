import type { Expense, Trip } from "./types";
import type { State } from "./store";

/**
 * 示例旅行：成都四日游，四个成员。故意埋了几处异常给核账 Agent 找：
 *  - e_dup1/e_dup2：同一顿火锅记了两次
 *  - e_nopay：付款人不在参与人里（阿强请客但自己没吃？不合理）
 *  - e_empty：参与人为空
 *  - e_big：金额疑似多打一个零
 *  - e_pending：录入时字段不全，待补全
 */
export function SEED(): State {
  const tripId = "t_demo";
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
  };
  const all = Object.values(m);
  const base = (
    id: string,
    amount: number,
    payerId: string,
    participantIds: string[],
    category: Expense["category"],
    note: string,
    occurredAt: string,
    extra: Partial<Expense> = {},
  ): Expense => ({
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
  const expenses: Expense[] = [
    base("e_01", 1280, m.ming, all, "住宿", "锦江区民宿 2 晚（10/1-10/3）", "2025-10-01T15:00:00"),
    base("e_02", 196, m.hua, all, "交通", "双流机场→市区 滴滴", "2025-10-01T13:20:00"),
    base("e_03", 412, m.qiang, all, "餐饮", "春熙路 小龙坎火锅", "2025-10-01T19:30:00", { source: "image", evidence: { kind: "image", text: "支付宝支付成功 ¥412.00 小龙坎火锅（春熙路店）" } }),
    base("e_dup2", 412, m.qiang, all, "餐饮", "小龙坎 火锅", "2025-10-01T19:42:00", { source: "text", confidence: 0.82, evidence: { kind: "text", text: "阿强付了火锅 412" } }),
    base("e_04", 80, m.lin, all, "门票", "武侯祠门票 4 张", "2025-10-02T09:10:00"),
    base("e_05", 52, m.ming, [m.ming, m.hua], "餐饮", "锦里 三大炮+糖油果子", "2025-10-02T11:00:00"),
    base("e_06", 240, m.hua, all, "门票", "大熊猫基地门票", "2025-10-02T14:00:00"),
    base("e_nopay", 168, m.qiang, [m.ming, m.hua, m.lin], "餐饮", "宽窄巷子 钟水饺", "2025-10-02T18:30:00", { source: "voice", confidence: 0.74, evidence: { kind: "voice", text: "阿强付的钟水饺一百六十八，我和小华小林吃的" } }),
    base("e_big", 3500, m.lin, all, "交通", "青城山包车一日", "2025-10-03T08:00:00", { source: "text", confidence: 0.7, evidence: { kind: "text", text: "小林包车 350" } }),
    base("e_07", 120, m.ming, all, "门票", "青城山门票", "2025-10-03T10:00:00"),
    base("e_empty", 98, m.hua, [], "餐饮", "青城山 山脚农家菜", "2025-10-03T12:30:00", { confidence: 0.6 }),
    base("e_08", 600, m.ming, [m.ming], "购物", "伴手礼（自己买的）", "2025-10-03T17:00:00"),
    base("e_09", 318, m.lin, all, "餐饮", "太古里 日料 (10/3 晚)", "2025-10-03T19:30:00"),
    base("e_10", 64, m.qiang, all, "交通", "去机场 地铁+打车", "2025-10-04T09:00:00"),
    base("e_pending", 0, m.hua, all, "餐饮", "机场早餐", "2025-10-04T07:30:00", { status: "pending", confidence: 0.4, source: "voice", evidence: { kind: "voice", text: "小华买的机场早餐" } }),
  ];
  return { trips: [trip], expenses, audit: [], prefs: { habits: [], lastReconcile: {} } };
}
