/**
 * 核账评测用的账本（第二版，2026-11-13 按第一轮评测的复查结果重做）。
 *
 * 每本账 = 普通的背景账目 + 人为埋进去的问题（truth）+ 看着可疑其实没问题的账目（decoys）。
 * 全部是构造的，不是真实用户的账本。埋了什么都记在 truth 里，评分只看模型报的账目 id 对不对得上。
 * 账目 id 按时间顺序编成 e01、e02……，不带任何提示。
 *
 * truth.kind：
 *  - rule      规则检查（check_integrity、默认参数的 find_duplicates）能直接命中的
 *  - evidence  账目字段和它自己的原话证据矛盾，规则检查看不出来
 *  - judgment  要靠判断：金额相近的疑似重复、隔天的重复、没有凭证的离群金额、没有凭证的币种记错
 * truth.fix    有依据能确定的修改；truth.noFix = 没有依据、不该给具体修改值的（给了要记一笔）。两者都没有的不评修改建议。
 *
 * 第一版的问题和这一版的对应做法（编号是复查报告里的）：
 *  - gen-01 备注按天取，一本账里不重名；要重名的（重复类埋点、往返、两天同一家早餐）都登记在 truth / decoys 里。
 *  - gen-02 「已确认规则」的文字带日期和金额，只指向一笔账。
 *  - gen-03 来源和置信度不分背景、问题、干扰项，一律按来源在同一个区间里随机取，副本的来源也随机。
 *  - gen-04 金额按人头算（每人单价 × 参与人数），两个人的消费就是两个人的量。
 *  - gen-05 时间带随机偏移；金额只保证同一天内不撞，跨天自然会撞；另有「同名同额但确实是两笔」的干扰项。
 *  - gen-06 正常账目的原话里也有「只有 X 和 Y」「不用 A」「差不多」「先垫」这些字眼，只看字面分不出好坏；
 *           往返、垫付、分两辆车这类干扰项，备注不写答案，区别在原话里。
 *  - gen-07 截图账目的证据文本只放备注或一句附言（产品里存的就是这个），金额、币种的矛盾都放在文字 / 语音原话里。
 *  - gen-09 「只有两个人…」按分类换动词。gen-10 约数比原数更整，入账前查重。gen-11 人多的行程不拿交通费当重复埋点。
 *  - gen-12 住宿 = 每间每晚单价 × 晚数 × 间数。gen-14 两人账目、每本账的住宿都登记成干扰项，干扰项带 kind。
 *  - gen-15 出发前预订铺到 7 本账，写法各不相同。
 *
 * 这一版新加的问题类型：participantsVsEvidence:missing（原话说大家一起，账上只记了两个人）、treatVsEvidence:notTreat（账上标了请客，
 * 原话却是先垫着回头平摊）、splitVsEvidence（原话说算两份，账上均摊）、dupLate（第二天上午原样补记了一次）、currencyNoEvidence（没有原话的币种记错）。
 *
 * 依赖的结算口径（lib/settle.ts）：请客 = 全额记在付款人自己头上；没标请客而付款人不在参与人里 = 替别人垫付，本身是合法记法。
 * 所以「付款人不在参与人里」只有在原话说了大家一起时才埋成问题（payerNotIn），原话说是垫付的登记成干扰项（advance）。
 * 日期出界只埋在吃饭和打车上（不会和出发前预订混），没有凭证的离群金额只埋在早餐和小吃饮品上（乘十以后一眼离谱）。
 */
import { createHash } from "node:crypto";
import type { Category, Expense, LedgerSnapshot, Member, Source, Trip } from "../lib/types";

export type Fix =
  | { action: "delete"; anyOf: string[] }
  | { action: "update"; id: string; amount?: number; payerId?: string; participantIds?: string[]; treat?: boolean };
export type TruthKind = "rule" | "evidence" | "judgment";
export type Truth = { key: string; ids: string[]; kind: TruthKind; type: string; note: string; fix?: Fix; noFix?: boolean };

/* 干扰项的类型：汇总时按类型算被报率 */
export const DECOY_KINDS = ["lodging", "twoPerson", "approx", "shuttle", "twoCars", "sameName", "treat", "advance", "rule", "shares", "pretrip", "cnyOrder"] as const;
export type DecoyKind = (typeof DECOY_KINDS)[number];
export const DECOY_LABEL: Record<DecoyKind, string> = {
  lodging: "住宿（金额最大）",
  twoPerson: "两人账目（原话说了只有两个人）",
  approx: "原话带「差不多」但和账面一致",
  shuttle: "往返同价（规则会配成重复）",
  twoCars: "分两辆车各付一笔（规则会配成重复）",
  sameName: "同名但确实是两笔",
  treat: "已标请客",
  advance: "替别人垫付（规则会报付款人不在参与人里）",
  rule: "用户确认过的规则",
  shares: "按份数分摊",
  pretrip: "出发前预订（规则会报日期出界）",
  cnyOrder: "外币行程里的人民币订单",
};
export type Decoy = { ids: string[]; kind: DecoyKind; note: string; rule?: string };
export type ReconcileCase = { id: string; title: string; size: "small" | "medium" | "large"; snap: LedgerSnapshot; truth: Truth[]; decoys: Decoy[] };

/* ---------- 小工具（时间一律按 UTC 算，结果不随机器时区变） ---------- */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n: number) => String(n).padStart(2, "0");
function addDays(date: string, d: number): string {
  return new Date(new Date(date + "T00:00:00Z").getTime() + d * 86400000).toISOString().slice(0, 10);
}
function addMin(iso: string, m: number): string {
  return new Date(new Date(iso + "Z").getTime() + m * 60000).toISOString().slice(0, 19);
}
const dayOf = (e: Expense) => e.occurredAt.slice(0, 10);

/* ---------- 背景账目的模板 ---------- */
type SlotKey = "breakfast" | "go" | "ticket" | "lunch" | "snack" | "back" | "dinner" | "fun" | "late";
/** min / max 是每人的价格区间（当地币种）；打车这类按车算的另用 theme.car。 */
type Slot = { key: SlotKey; time: string; category: Category; min: number; max: number; notes: string[] };
type Pair = { note: string; a: string; b: string; min: number; max: number };
type Item = { note: string; category: Category; min: number; max: number; step?: number };
type Theme = {
  currency: string;
  rate?: number;
  step: number;
  /** 一辆车的车费区间 */
  car: [number, number];
  /** 住宿：每间每晚（人民币订单） */
  lodging: { note: string; min: number; max: number };
  slots: Slot[];
  /** 往返同价的两笔（每人票价） */
  pairs: Pair[];
  /** 人多时分两辆车 */
  cars: string[];
  /** 一天里、几天里会反复出现的小额消费（每人） */
  generic: Item[];
  /** 外币行程里在国内平台下的人民币订单（每人，人民币） */
  cny: Item[];
};

const S = (key: SlotKey, time: string, category: Category, min: number, max: number, ...notes: string[]): Slot => ({ key, time, category, min, max, notes });
const CAR = /打车|网约车|出租车|Grab|Bolt|突突车/;
const DRINK = /奶茶|咖啡|酸梅汤|汁|冰沙|泰奶|椰青|冰饮|果茶|矿泉水|饮料/;

const THEMES: Record<string, Theme> = {
  重庆: {
    currency: "CNY", step: 1, car: [14, 58],
    lodging: { note: "解放碑民宿", min: 180, max: 330 },
    slots: [
      S("breakfast", "08:20", "餐饮", 8, 16, "小面+豌杂面", "酸辣粉+抄手", "豆浆油条", "锅盔+冰粉", "糯米团+豆奶", "包子稀饭", "油茶+麻圆"),
      S("go", "09:30", "交通", 2, 7, "轻轨 2 号线去洪崖洞", "打车去磁器口", "公交去长江索道", "地铁去三峡博物馆", "网约车去南山", "公交去鹅岭", "打车去白公馆"),
      S("ticket", "10:40", "门票", 20, 55, "洪崖洞观景台", "磁器口手工体验", "长江索道往返", "三峡博物馆讲解", "南山一棵树观景台", "鹅岭二厂展览", "白公馆讲解"),
      S("lunch", "12:40", "餐饮", 45, 100, "九宫格火锅", "磁器口江湖菜", "万州烤鱼", "串串香", "酸菜鱼", "毛血旺家常菜", "来凤鱼"),
      S("snack", "15:20", "餐饮", 9, 22, "解放碑奶茶", "冰汤圆", "酸梅汤+凉糕", "观音桥咖啡", "山城冰粉", "烤苕皮", "老酸奶"),
      S("back", "17:10", "交通", 2, 7, "打车回民宿", "轻轨回解放碑", "网约车去南滨路", "公交回民宿", "打车去观音桥", "地铁回民宿", "网约车回民宿"),
      S("dinner", "19:10", "餐饮", 55, 120, "纸包鱼", "洞子老火锅", "歌乐山辣子鸡", "鲜锅兔", "南山泉水鸡", "美蛙鱼头", "烧烤+啤酒"),
      S("fun", "21:30", "娱乐", 35, 95, "两江夜游船票", "九街小酒馆", "KTV", "剧本杀", "脱口秀门票", "桌游吧", "Livehouse"),
      S("late", "23:10", "餐饮", 14, 38, "夜宵 小龙虾", "夜宵 烤串", "夜宵 酸辣粉", "夜宵 砂锅粥", "夜宵 炒饭", "夜宵 小面", "夜宵 冒菜"),
    ],
    pairs: [{ note: "景区摆渡车", a: "上山", b: "下山", min: 10, max: 20 }, { note: "景区观光车", a: "进去", b: "出来", min: 8, max: 18 }],
    cars: ["网约车去千厮门大桥"],
    generic: [{ note: "轻轨车票", category: "交通", min: 2, max: 6 }, { note: "便利店矿泉水", category: "餐饮", min: 2, max: 4 }],
    cny: [],
  },
  厦门: {
    currency: "CNY", step: 1, car: [12, 52],
    lodging: { note: "曾厝垵民宿", min: 220, max: 390 },
    slots: [
      S("breakfast", "08:10", "餐饮", 8, 17, "沙茶面", "花生汤+油条", "面线糊", "肠粉", "海蛎煎+豆浆", "同安封肉粥", "芋包"),
      S("go", "09:20", "交通", 2, 6, "打车去轮渡码头", "公交去厦大", "地铁去集美", "网约车去植物园", "打车去环岛路", "公交去中山路", "打车去沙坡尾"),
      S("ticket", "10:30", "门票", 25, 60, "鼓浪屿船票", "胡里山炮台", "集美鳌园", "植物园门票", "环岛路观光塔", "老厦门故事博物馆", "沙坡尾手作体验"),
      S("lunch", "12:30", "餐饮", 45, 105, "曾厝垵海鲜大排档", "姜母鸭", "土笋冻+海鲜面", "闽南菜馆", "沙茶火锅", "酱油水杂鱼", "同安煎蟹"),
      S("snack", "15:10", "餐饮", 8, 22, "厦大门口奶茶", "四果汤", "芒果冰", "猫咖啡", "椰子冻", "麻糍+烧仙草", "杨桃汁"),
      S("back", "17:00", "交通", 2, 6, "打车回民宿", "公交回曾厝垵", "环岛路共享单车", "地铁回民宿", "网约车去白城沙滩", "公交回民宿", "打车回曾厝垵"),
      S("dinner", "19:00", "餐饮", 55, 120, "中山路海鲜酒楼", "八市烧烤", "潮汕牛肉火锅", "佛跳墙小馆", "闽南古早味餐厅", "沙坡尾西餐", "蒸汽海鲜"),
      S("fun", "21:20", "娱乐", 30, 95, "环岛路夜骑", "沙坡尾酒吧", "电影票", "KTV", "海边帆船体验", "密室逃脱", "音乐现场"),
      S("late", "23:00", "餐饮", 12, 35, "夜宵 烧烤", "夜宵 炒米粉", "夜宵 沙茶面", "夜宵 海鲜粥", "夜宵 花生汤", "夜宵 炸物", "夜宵 卤味"),
    ],
    pairs: [{ note: "景区摆渡车", a: "上山", b: "下山", min: 10, max: 20 }, { note: "园区电瓶车", a: "进园", b: "出园", min: 8, max: 15 }],
    cars: ["网约车去五缘湾"],
    generic: [{ note: "公交车费", category: "交通", min: 2, max: 4 }, { note: "便利店矿泉水", category: "餐饮", min: 2, max: 4 }],
    cny: [],
  },
  西安: {
    currency: "CNY", step: 1, car: [13, 60],
    lodging: { note: "钟楼附近酒店", min: 240, max: 420 },
    slots: [
      S("breakfast", "08:15", "餐饮", 7, 15, "胡辣汤+油饼", "肉夹馍+冰峰", "甑糕+豆浆", "菜盒子+稀饭", "凉皮+肉夹馍", "豆腐脑+油条", "锅盔辣子"),
      S("go", "09:25", "交通", 2, 7, "游 5 路去兵马俑", "网约车去城墙南门", "地铁去小寨", "地铁去大雁塔", "大巴去华清宫", "公交去碑林", "打车去大唐芙蓉园"),
      S("ticket", "10:35", "门票", 35, 120, "兵马俑门票", "城墙门票", "陕历博讲解", "大雁塔登塔", "华清宫门票", "碑林博物馆", "大唐芙蓉园"),
      S("lunch", "12:35", "餐饮", 40, 100, "回民街泡馍+烤肉", "葫芦鸡", "老孙家泡馍", "陕菜馆", "水盆羊肉+凉菜", "西安饭庄", "袁家村小吃拼桌"),
      S("snack", "15:05", "餐饮", 8, 22, "永兴坊酸梅汤", "柿子饼+镜糕", "钟楼奶茶", "小寨咖啡", "冰峰+凉糕", "石榴汁", "玫瑰镜糕"),
      S("back", "17:05", "交通", 2, 7, "地铁回酒店", "打车回钟楼", "公交回酒店", "网约车回酒店", "公交回钟楼", "地铁去不夜城", "打车去永兴坊"),
      S("dinner", "19:05", "餐饮", 50, 118, "长安大排档", "烤肉+涮牛肚", "铜锅涮肉", "大唐不夜城餐厅", "洒金桥烤肉", "新疆菜馆", "德发长饺子宴"),
      S("fun", "21:15", "娱乐", 35, 105, "皮影戏演出票", "德福巷酒吧", "电影票", "KTV", "不夜城汉服体验", "剧本杀", "相声门票"),
      S("late", "23:05", "餐饮", 12, 35, "夜宵 烤肉", "夜宵 砂锅", "夜宵 麻辣烫", "夜宵 炒面", "夜宵 馄饨", "夜宵 米线", "夜宵 肉夹馍"),
    ],
    pairs: [{ note: "景区摆渡车", a: "上山", b: "下山", min: 10, max: 20 }, { note: "景区电瓶车", a: "去程", b: "回程", min: 5, max: 15 }],
    cars: ["网约车去曲江池"],
    generic: [{ note: "地铁车票", category: "交通", min: 2, max: 6 }, { note: "便利店矿泉水", category: "餐饮", min: 2, max: 4 }],
    cny: [],
  },
  青岛: {
    currency: "CNY", step: 1, car: [13, 55],
    lodging: { note: "栈桥海景民宿", min: 260, max: 460 },
    slots: [
      S("breakfast", "08:25", "餐饮", 8, 16, "馄饨+火烧", "甜沫+油条", "豆腐脑+锅贴", "虾仁馄饨", "海菜包子+豆浆", "煎饼果子", "小笼包"),
      S("go", "09:35", "交通", 2, 7, "地铁去五四广场", "大巴去崂山", "公交去八大关", "网约车去啤酒博物馆", "地铁去海底世界", "打车去极地海洋世界", "公交去信号山"),
      S("ticket", "10:45", "门票", 25, 95, "奥帆中心帆船", "崂山门票", "八大关花石楼", "啤酒博物馆", "海底世界", "极地海洋世界", "信号山公园"),
      S("lunch", "12:45", "餐饮", 45, 110, "海鲜家常菜", "啤酒屋+蛤蜊", "鲅鱼水饺馆", "海胆蒸蛋+海鲜", "烧烤+扎啤", "鲁菜馆", "海肠捞饭"),
      S("snack", "15:15", "餐饮", 9, 23, "大学路咖啡", "台东奶茶", "栈桥冰淇淋", "酸奶+糖球", "烤鱿鱼", "果茶", "崂山绿茶冰饮"),
      S("back", "17:15", "交通", 2, 7, "地铁回民宿", "打车回栈桥", "公交回民宿", "网约车回民宿", "地铁去台东夜市", "打车去登州路", "公交回栈桥"),
      S("dinner", "19:15", "餐饮", 55, 122, "台东夜市海鲜", "登州路啤酒街", "铁板海鲜", "海鲜火锅", "韩式烤肉", "海鲜大咖", "烧烤"),
      S("fun", "21:25", "娱乐", 35, 98, "五四广场灯光秀游船", "大学路小酒馆", "电影票", "KTV", "桌游", "密室逃脱", "脱口秀"),
      S("late", "23:15", "餐饮", 12, 34, "夜宵 烧烤", "夜宵 海鲜面", "夜宵 炒蛤蜊", "夜宵 麻辣烫", "夜宵 炸串", "夜宵 海鲜粥", "夜宵 锅贴"),
    ],
    pairs: [{ note: "景区观光车", a: "上山", b: "下山", min: 10, max: 20 }, { note: "景区摆渡车", a: "进去", b: "出来", min: 8, max: 15 }],
    cars: ["网约车去石老人"],
    generic: [{ note: "地铁车票", category: "交通", min: 2, max: 6 }, { note: "便利店矿泉水", category: "餐饮", min: 2, max: 4 }],
    cny: [],
  },
  大阪: {
    currency: "JPY", rate: 0.048, step: 10, car: [1300, 3600],
    lodging: { note: "难波民宿", min: 420, max: 760 },
    slots: [
      S("breakfast", "08:20", "餐饮", 380, 900, "便利店早餐", "喫茶店早餐", "松屋早餐", "面包店", "饭团+咖啡", "吉野家早餐", "立食荞麦面"),
      S("go", "09:30", "交通", 180, 700, "地铁去大阪城", "JR 去京都", "京阪电车去伏见", "近铁去奈良", "地铁去大阪港", "阪急去京都", "地铁去新世界"),
      S("ticket", "10:40", "门票", 500, 2400, "大阪城天守阁", "清水寺", "伏见稻荷周边体验", "奈良东大寺", "海游馆", "金阁寺", "通天阁"),
      S("lunch", "12:40", "餐饮", 950, 2300, "一兰拉面", "道顿堀大阪烧", "京都汤豆腐", "回转寿司", "烧肉午市", "鳗鱼饭", "天妇罗定食"),
      S("snack", "15:20", "餐饮", 300, 780, "抹茶冰淇淋", "章鱼烧", "难波咖啡", "和果子+抹茶", "可丽饼", "珍珠奶茶", "鲷鱼烧"),
      S("back", "17:10", "交通", 180, 700, "地铁回民宿", "JR 回大阪", "出租车回民宿", "近铁回难波", "地铁去心斋桥", "阪急回梅田", "巴士回难波"),
      S("dinner", "19:10", "餐饮", 2200, 5200, "烧肉", "居酒屋", "蟹道乐", "寿司", "串炸", "寿喜烧", "河豚料理"),
      S("fun", "21:30", "娱乐", 700, 2300, "梅田蓝天大厦展望台", "居酒屋二次会", "卡拉 OK", "游戏厅", "摩天轮", "温泉钱汤", "心斋桥酒吧"),
      S("late", "23:10", "餐饮", 300, 850, "便利店夜宵", "深夜拉面", "便利店关东煮", "深夜牛丼", "便利店饭团", "深夜乌冬", "便利店甜品"),
    ],
    pairs: [{ note: "缆车", a: "上山", b: "下山", min: 500, max: 900 }, { note: "观光巴士", a: "去程", b: "回程", min: 200, max: 320 }],
    cars: ["出租车去车站"],
    generic: [{ note: "ICOCA 充值", category: "交通", min: 400, max: 1000, step: 1000 }, { note: "自动贩卖机饮料", category: "餐饮", min: 130, max: 180 }],
    cny: [{ note: "环球影城门票", category: "门票", min: 420, max: 520 }, { note: "和服体验", category: "娱乐", min: 150, max: 260 }],
  },
  曼谷: {
    currency: "THB", rate: 0.2, step: 5, car: [80, 340],
    lodging: { note: "素坤逸酒店", min: 280, max: 520 },
    slots: [
      S("breakfast", "08:20", "餐饮", 40, 110, "酒店旁早餐", "粿条", "泰式粥", "面包+咖啡", "芒果糯米饭", "便利店早餐", "猪脚饭"),
      S("go", "09:30", "交通", 20, 60, "Grab 去大皇宫", "BTS 去暹罗", "渡船去郑王庙", "MRT 去卧佛寺", "突突车去吉姆汤普森之家", "Bolt 去水上市场", "Grab 去恰图恰"),
      S("ticket", "10:40", "门票", 100, 500, "大皇宫门票", "暹罗海洋世界", "郑王庙", "卧佛寺", "吉姆汤普森之家", "水上市场船票", "曼谷艺术文化中心特展"),
      S("lunch", "12:40", "餐饮", 140, 420, "冬阴功+咖喱蟹", "泰式船面+炸物", "泰北菜", "海鲜烧烤", "建兴酒家", "泰式火锅", "商场美食广场"),
      S("snack", "15:20", "餐饮", 35, 100, "泰奶", "椰子冰淇淋", "芒果冰沙", "暹罗咖啡", "香蕉煎饼", "鲜榨橙汁", "椰青"),
      S("back", "17:10", "交通", 20, 60, "Grab 回酒店", "BTS 回酒店", "渡船返程", "MRT 回酒店", "突突车回酒店", "Bolt 回酒店", "Grab 去夜市"),
      S("dinner", "19:10", "餐饮", 220, 650, "夜市海鲜", "米其林路边摊", "泰式烧烤", "屋顶餐厅", "唐人街海鲜", "河景餐厅", "泰式火锅 MK"),
      S("fun", "21:30", "娱乐", 180, 560, "泰式按摩", "人妖秀门票", "考山路酒吧", "泰拳比赛门票", "夜游湄南河", "KTV", "SPA"),
      S("late", "23:10", "餐饮", 35, 110, "7-11 夜宵", "夜宵 粿条", "7-11 饮料", "夜宵 烤串", "7-11 零食", "夜宵 芒果糯米饭", "夜宵 炒粉"),
    ],
    pairs: [{ note: "湄南河渡船", a: "过河", b: "回来", min: 20, max: 40 }, { note: "水上巴士", a: "去程", b: "回程", min: 30, max: 60 }],
    cars: ["Grab 去暹罗广场"],
    generic: [{ note: "BTS 车票", category: "交通", min: 25, max: 60 }, { note: "7-11 矿泉水", category: "餐饮", min: 10, max: 20 }],
    cny: [{ note: "大象营半日游", category: "门票", min: 260, max: 420 }, { note: "湄南河游船晚餐", category: "餐饮", min: 180, max: 320 }],
  },
};

/* 置信度区间（×100），按来源分。背景、问题、干扰项用的是同一套，见 gen-03。低于 0.75 会被 check_integrity 报低置信度，所以下限都在它之上。 */
const CONF = { text: [85, 95], image: [90, 97], voice: [78, 90] } as const;

/* ---------- 原话的写法 ---------- */
/**
 * 一笔账的原话是怎么说的。payer / amount / unit 不填就照账面说；填了就是「原话和账面不一样」，埋证据矛盾用。
 * 背景、干扰项、问题走的是同一套句式，区别只在说的内容和账面对不对得上。
 */
type Said = {
  mode: "plain" | "pad" | "approx" | "treat" | "advance" | "noAmount";
  tpl: number;
  who: "none" | "all" | "two";
  whoTpl: number;
  pair?: [string, string];
  payer?: string;
  amount?: number;
  unit?: string;
  /** 原话里怎么称呼这笔消费，默认就是备注 */
  label?: string;
  shares?: boolean;
  noA?: boolean;
  tail?: string;
};
type Meta = { day: number; slot?: SlotKey; per?: number; car?: boolean; said?: Said };

type Opt = { id: string; title: string; size: ReconcileCase["size"]; theme: keyof typeof THEMES; trip: string; start: string; days: number; count: number; members: string[]; seed: number };
type Pred = (e: Expense, m: Meta) => boolean;

/* ---------- 账本构造器 ---------- */
class Builder {
  readonly trip: Trip;
  readonly theme: Theme;
  private ex: Expense[] = [];
  private bg: Expense[] = [];
  private truth: Truth[] = [];
  private decoys: Decoy[] = [];
  private meta = new Map<string, Meta>();
  private taken = new Set<string>();
  private lodge!: Expense;
  private busyDays = new Set<number>();
  private n = 0;
  private r: () => number;

  constructor(private opt: Opt) {
    this.theme = THEMES[opt.theme];
    this.r = rng(opt.seed);
    const members: Member[] = opt.members.map((name, i) => ({ id: `m${i + 1}`, name }));
    this.trip = { id: opt.id, name: opt.trip, currency: "CNY", members, startDate: opt.start, endDate: addDays(opt.start, opt.days - 1), createdAt: opt.start + "T08:00:00.000Z", selfMemberId: members[0].id };
    this.background();
  }

  /* ----- 随机数和取值 ----- */
  private get all() { return this.trip.members.map((m) => m.id); }
  private name(id: string) { return this.trip.members.find((m) => m.id === id)?.name ?? id; }
  private int(lo: number, hi: number) { return lo + Math.floor(this.r() * (hi - lo + 1)); }
  private chance(p: number) { return this.r() < p; }
  private one<T>(xs: T[]): T { return xs[Math.floor(this.r() * xs.length)]; }
  private shuffle<T>(xs: T[]): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  private others(id: string) { return this.all.filter((x) => x !== id); }
  private round(x: number, step = this.theme.step) { return Math.max(step, Math.round(x / step) * step); }
  private date(day: number) { return addDays(this.opt.start, day); }
  private m(e: Expense): Meta { return this.meta.get(e.id)!; }
  /** 同一天里这个金额还没人用（跨天允许自然撞数）。 */
  private free(date: string, amount: number, ...except: Expense[]) { return !this.ex.some((e) => !except.includes(e) && dayOf(e) === date && e.amount === amount); }
  private bump(date: string, amount: number, ...except: Expense[]) {
    while (!this.free(date, amount, ...except)) amount += this.theme.step;
    return amount;
  }
  /** 时间不和别的账目落在同一分钟。 */
  private clear(iso: string) {
    while (this.ex.some((e) => e.occurredAt === iso)) iso = addMin(iso, 1);
    return iso;
  }
  private time(date: string, hhmm: string, lo: number, hi: number) { return this.clear(addMin(`${date}T${hhmm}:00`, this.int(lo, hi))); }
  /** 在 iso 之后 lo–hi 分钟，不跨过当天。 */
  private after(iso: string, lo: number, hi: number) {
    const left = Math.floor((new Date(iso.slice(0, 10) + "T23:57:00Z").getTime() - new Date(iso + "Z").getTime()) / 60000);
    hi = Math.max(1, Math.min(hi, left));
    return this.clear(addMin(iso, this.int(Math.min(lo, hi), hi)));
  }
  private conf(source: Source) {
    if (source === "manual" || source === "agent") return 1;
    const [lo, hi] = CONF[source];
    return this.int(lo, hi) / 100;
  }
  private source(): Source { const x = this.r(); return x < 0.38 ? "manual" : x < 0.66 ? "text" : x < 0.86 ? "voice" : "image"; }
  private spoken(): "text" | "voice" { return this.chance(0.58) ? "text" : "voice"; }
  /** 不是「差不多」的说法里，「先垫着回头平摊」和直说各占多少：和背景账目同一个比例。 */
  private padOrPlain(): "pad" | "plain" { return this.chance(0.23) ? "pad" : "plain"; }

  private mk(p: Pick<Expense, "amount" | "payerId" | "category" | "note" | "occurredAt"> & Partial<Expense>, meta: Meta): Expense {
    const e: Expense = { tripId: this.trip.id, currency: this.theme.currency, rate: this.theme.rate, createdAt: p.occurredAt, updatedAt: p.occurredAt, source: "manual", confidence: 1, status: "confirmed", ...p, id: `t${++this.n}`, participantIds: [...(p.participantIds ?? this.all)] };
    this.meta.set(e.id, meta);
    this.ex.push(e);
    return e;
  }

  /* ----- 原话 ----- */
  private unit(e: Expense, kind: "text" | "voice") {
    if (e.currency === "JPY") return " 日元";
    if (e.currency === "THB") return " 泰铢";
    if (this.theme.currency !== "CNY") return " 人民币";
    return kind === "voice" ? " 块" : "";
  }
  private verb(e: Expense) { return e.category === "餐饮" ? (DRINK.test(e.note) && !e.note.includes("+") ? "喝" : "吃") : e.category === "交通" ? "坐" : e.category === "住宿" ? "住" : "去"; }
  private list(ids: string[]) {
    const ns = ids.map((id) => this.name(id));
    return ns.length <= 2 ? ns.join("和") : `${ns.slice(0, -1).join("、")}和${ns[ns.length - 1]}`;
  }
  private words(e: Expense, kind: "text" | "voice", s: Said): string {
    const n = this.all.length;
    const P = this.name(s.payer ?? e.payerId);
    const N = s.label ?? e.note;
    const A = s.amount ?? e.amount;
    const U = s.unit ?? this.unit(e, kind);
    const v = this.verb(e);
    // 「买的」只用在买得着的东西上（票、卡、饮料零食）；饭馆、打车、住宿、另起称呼的不这么说
    const buyable = !s.label && (/票|卡|券|零食|早餐|夜宵/.test(e.note) || DRINK.test(e.note));
    let t: string;
    if (s.mode === "treat") t = `${P}请大家的${N} ${A}${U}${s.noA ? "，不用 A" : ""}`;
    else if (s.mode === "pad") t = s.tpl % 2 === 0 && !s.label ? `${P}先垫的${N} ${A}${U}，回头大家平摊` : `${N} ${A}${U}，${P}先垫着，回头 ${n} 个人 A`;
    else if (s.mode === "approx") t = s.tpl % 2 === 0 ? `${P}付的${N}差不多 ${A}${U}` : `${N}是${P}付的，差不多 ${A}${U}`;
    else if (s.mode === "advance") t = `${P}帮${this.list(e.participantIds)}垫付的${N} ${A}${U}，${P}没${v}`;
    else if (s.mode === "noAmount") t = buyable && s.tpl % 3 === 0 ? `${P}买的${N}` : s.tpl % 2 === 0 ? `${N}是${P}付的，多少钱没记` : `${P}付的${N}，金额回头补`;
    else t = [`${P}付了${N} ${A}${U}`, `${N} ${A}${U}，${P}付的`, `${P}买的${N} ${A}${U}`][s.tpl % (buyable ? 3 : 2)];
    if (s.who === "all") t += s.whoTpl % 2 === 0 ? "，大家一起" : `，${n} 个人`;
    // 「只有两个人…」的动词跟着分类走：餐饮吃 / 喝，交通坐，门票和娱乐去（gen-09）
    if (s.who === "two" && s.pair) t += `，只有${this.name(s.pair[0])}和${this.name(s.pair[1])}${s.whoTpl % 2 === 0 ? "" : `两个人${v}`}`;
    if (s.shares) t += `，${this.name(e.payerId)}算两份，其他人一人一份`;
    return t + (s.tail ?? "");
  }
  /**
   * 定下一笔账的来源、置信度和原话。
   * 截图账目的证据文本：产品里存的是用户附言，没写附言就是备注本身（components/EntryPanel.tsx、ImportPanel.tsx），
   * 不会有「支付成功 346 元」这种带金额的文字，所以这里只放备注或一句附言（gen-07）。
   */
  private speak(e: Expense, source: Source, over?: Partial<Said>, imageText?: string): Said | undefined {
    const m = this.m(e);
    e.source = source;
    e.confidence = this.conf(source);
    m.said = undefined;
    if (source === "image") {
      const x = imageText ? 0 : this.r();
      const full = e.participantIds.length === this.all.length;
      e.evidence = { kind: "image", text: imageText ?? (x < 0.7 ? e.note : x < 0.85 || !full ? `${this.name(e.payerId)}付的` : `${this.name(e.payerId)}付的，大家一起`) };
      return undefined;
    }
    if (source !== "text" && source !== "voice") { e.evidence = undefined; return undefined; }
    let mode = over?.mode;
    if (!mode) {
      const x = this.r();
      mode = source === "voice" ? (x < 0.16 ? "approx" : x < 0.34 ? "pad" : "plain") : x < 0.04 ? "approx" : x < 0.28 ? "pad" : "plain";
      // 十几二十块的小额不会有人说「差不多」
      if (mode === "approx" && e.amount < 30 * this.theme.step) mode = "plain";
    }
    const s: Said = { tpl: this.int(0, 5), who: "none", whoTpl: this.int(0, 1), ...over, mode };
    if (!over && (mode === "plain" || mode === "approx") && this.chance(0.3)) s.who = "all";
    m.said = s;
    e.evidence = { kind: source, text: this.words(e, source, s) };
    return s;
  }
  /** 改完账面或说法以后，把原话重写一遍。 */
  private resay(e: Expense, patch?: Partial<Said>) {
    const s = this.m(e).said;
    if (!s || !e.evidence || (e.evidence.kind !== "text" && e.evidence.kind !== "voice")) throw new Error(`${this.opt.id}: ${e.id} 没有原话可改`);
    Object.assign(s, patch);
    e.evidence = { kind: e.evidence.kind, text: this.words(e, e.evidence.kind, s) };
  }

  /* ----- 背景账目 ----- */
  /**
   * 住宿一笔 + 每天从九个时段里随机抽几个。金额 = 每人单价 × 参与人数；时间在时段上下 20 分钟内随机；
   * 备注按天取，七天以内不重名。两个人参加的（原话里说明了）、原话带「差不多」的，登记成干扰项。
   */
  private background() {
    const { opt, theme } = this;
    const n = this.all.length;
    const nights = Math.max(1, opt.days - 1);
    const rooms = Math.ceil(n / 2);
    const perNight = Math.round((theme.lodging.min + this.r() * (theme.lodging.max - theme.lodging.min)) / 10) * 10;
    const lodge = this.mk({ amount: perNight * nights * rooms, currency: "CNY", rate: undefined, payerId: this.one(this.all), category: "住宿", note: `${theme.lodging.note} ${nights} 晚 ${rooms} 间`, occurredAt: this.time(opt.start, "15:00", -35, 45) }, { day: 0 });
    // 外币行程里住宿是人民币订单，原话里说了「人民币」；不然单看账面和币种记错分不开
    this.speak(lodge, theme.currency === "CNY" ? this.source() : this.spoken(), { mode: this.padOrPlain() });
    this.lodge = lodge;
    this.bg.push(lodge);

    const want = Math.min(opt.count - 1, opt.days * theme.slots.length);
    const perDay = Array.from({ length: opt.days }, () => Math.floor(want / opt.days));
    for (const d of this.shuffle(perDay.map((_, d) => d)).slice(0, want % opt.days)) perDay[d]++;
    const picks: { day: number; slot: Slot }[] = [];
    for (let d = 0; d < opt.days; d++) {
      const chosen = this.shuffle(theme.slots).slice(0, perDay[d]);
      // 一天至少有一顿正餐
      if (chosen.length >= 2 && !chosen.some((s) => s.key === "lunch" || s.key === "dinner")) {
        const meal: SlotKey = this.chance(0.5) ? "lunch" : "dinner";
        chosen[0] = theme.slots.find((s) => s.key === meal)!;
      }
      for (const slot of theme.slots) if (chosen.includes(slot)) picks.push({ day: d, slot });
    }
    // 大约每十一笔里有一笔只有两个人参加（小账本一笔，大账本四五笔）；打车按车算钱，不拿来当两人账目
    const two = new Set(n >= 3 ? this.shuffle(picks.filter((p) => !CAR.test(p.slot.notes[p.day % p.slot.notes.length]))).slice(0, Math.max(1, Math.round(picks.length * 0.09))) : []);
    for (const p of picks) this.slotExpense(p.day, p.slot, two.has(p));
    this.bg.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
  private slotExpense(day: number, slot: Slot, two: boolean) {
    const { theme } = this;
    const n = this.all.length;
    const base = slot.notes[day % slot.notes.length];
    const car = CAR.test(base);
    const payer = this.one(this.all);
    const per = slot.min + this.r() * (slot.max - slot.min);
    const date = this.date(day);
    // 五个人以上一辆车坐不下：背景里记成一笔「两辆车」的合计
    const raw = car ? (theme.car[0] + this.r() * (theme.car[1] - theme.car[0])) * (n >= 5 ? 2 : 1) : per * (two ? 2 : n);
    const e = this.mk({ amount: this.bump(date, this.round(raw)), payerId: payer, category: slot.category, note: car && n >= 5 ? `${base}（两辆车）` : base, occurredAt: this.time(date, slot.time, -20, 20) }, { day, slot: slot.key, per, car });
    this.bg.push(e);
    if (two) {
      const other = this.one(this.others(payer));
      e.participantIds = [payer, other];
      this.speak(e, this.spoken(), { mode: "plain", who: "two", pair: [payer, other] });
      this.d([e], "twoPerson", "参与人只有两个，原话里说了只有这两个人");
      return;
    }
    const s = this.speak(e, this.source());
    if (s?.mode === "approx") {
      // 说「差不多」的时候报的是个整数，账面记的也就是这个数
      const unit = 10 * theme.step;
      let amount = Math.max(unit, Math.round(e.amount / unit) * unit);
      while (!this.free(date, amount, e)) amount += unit;
      e.amount = amount;
      this.resay(e);
      this.d([e], "approx", "原话说的是「差不多」，但账面金额和原话一致，没有更准的数可对");
    }
  }

  /* ----- 挑一笔背景账目来改 ----- */
  /** 还没被动过、全员参与、不是住宿的背景账目。每笔最多被动一次。 */
  private pool(pred?: Pred) {
    const n = this.all.length;
    return this.bg.filter((e) => !this.taken.has(e.id) && e.category !== "住宿" && e.participantIds.length === n && (!pred || pred(e, this.m(e))));
  }
  private pick(what: string, pred?: Pred): Expense {
    const pool = this.pool(pred);
    if (!pool.length) throw new Error(`${this.opt.id}: ${what} 找不到可用的背景账目`);
    const e = this.one(pool);
    this.taken.add(e.id);
    return e;
  }
  /** 挑一笔带文字 / 语音原话的；没有现成的，就把一笔别的来源的改成文字或语音录入（来源、置信度仍在同一套区间里取）。 */
  private pickSpoken(what: string, pred?: Pred): Expense {
    const spoken = this.pool((e, m) => !!m.said && (!pred || pred(e, m)));
    if (spoken.length) { const e = this.one(spoken); this.taken.add(e.id); return e; }
    const e = this.pick(what, pred);
    this.speak(e, this.spoken(), { mode: "plain" });
    return e;
  }
  /** 挑一笔手动录入、没有任何原话的；没有现成的，就把一笔别的来源的改成手动录入。 */
  private pickManual(what: string, pred?: Pred): Expense {
    const manual = this.pool((e, m) => e.source === "manual" && (!pred || pred(e, m)));
    if (manual.length) { const e = this.one(manual); this.taken.add(e.id); return e; }
    const e = this.pick(what, pred);
    this.speak(e, "manual");
    return e;
  }
  /** 照着一笔账再记一笔（重复类埋点用）。来源随机，原话照副本自己的账面说。 */
  private copy(o: Expense, at: string, over?: Partial<Expense>, said?: Partial<Said>, source?: Source): Expense {
    const c = this.mk({ ...o, occurredAt: at, createdAt: at, updatedAt: at, evidence: undefined, ...over }, { ...this.m(o), said: undefined });
    // 人民币订单出现在外币行程里时，原话里要有「人民币」
    this.speak(c, source ?? (c.currency === "CNY" && this.theme.currency !== "CNY" ? this.spoken() : this.source()), { mode: this.padOrPlain(), ...said });
    this.taken.add(c.id);
    return c;
  }
  /** 另加一笔不在时段表里的账目（往返、分车、反复出现的小额消费等）。 */
  private extra(p: Pick<Expense, "amount" | "payerId" | "category" | "note" | "occurredAt"> & Partial<Expense>, day: number, source: Source, said?: Partial<Said>, imageText?: string): Expense {
    const e = this.mk(p, { day });
    this.speak(e, source, { mode: said?.tail ? "plain" : this.padOrPlain(), ...(said?.label && said.tpl === undefined ? { tpl: this.int(0, 1) } : {}), ...said }, imageText);
    this.taken.add(e.id);
    return e;
  }
  private t(key: string, items: Expense[], kind: TruthKind, type: string, note: string, fix?: Fix, noFix?: boolean) {
    this.truth.push({ key, ids: items.map((e) => e.id), kind, type, note, ...(fix ? { fix } : {}), ...(noFix ? { noFix: true } : {}) });
    for (const e of items) this.taken.add(e.id);
  }
  private d(items: Expense[], kind: DecoyKind, note: string, rule?: string) {
    this.decoys.push({ ids: items.map((e) => e.id), kind, note, ...(rule ? { rule } : {}) });
    for (const e of items) this.taken.add(e.id);
  }

  /* ===== 埋问题：规则能直接命中的 ===== */
  /** 同一笔记了两次：金额相同，相隔 3–100 分钟（在查重的 120 分钟窗口内）。 */
  dupExact() {
    // 五个人以上的行程不拿交通费埋重复：同价两辆车说得通（gen-11）
    const o = this.pick("dupExact", (e) => !(this.all.length >= 5 && e.category === "交通"));
    const c = this.copy(o, this.after(o.occurredAt, 3, 100));
    this.t("dupExact", [o, c], "rule", "duplicate", `同一笔「${o.note}」记了两次，金额相同，时间相隔不到两小时`, { action: "delete", anyOf: [o.id, c.id] });
  }
  /** 参与人为空。withEvidence：原话里说了是大家一起，能确定该补成全员。 */
  emptyParticipants(withEvidence: boolean) {
    if (!withEvidence) {
      const o = this.pickManual("emptyParticipants");
      o.participantIds = [];
      this.t("emptyParticipants", [o], "rule", "participants", `「${o.note}」参与人为空，没有原话可对`);
      return;
    }
    const o = this.pickSpoken("emptyParticipants");
    this.resay(o, { mode: "plain", who: "all" });
    o.participantIds = [];
    this.t("emptyParticipants", [o], "rule", "participants", `「${o.note}」参与人为空，原话说的是大家一起`, { action: "update", id: o.id, participantIds: this.all });
  }
  /** 付款人不在参与人里、也没标请客，而原话说的是大家一起（不是替别人垫付）。 */
  payerNotIn() {
    const o = this.pickSpoken("payerNotIn");
    this.resay(o, { mode: "plain", who: "all" });
    o.participantIds = this.others(o.payerId);
    this.t("payerNotIn", [o], "rule", "payer", `「${o.note}」付款人不在参与人里，也没标请客；原话说的是大家一起，不是替别人垫付`, { action: "update", id: o.id, participantIds: this.all });
  }
  /** 金额没记，待补全。没有任何地方能查到金额，不该给具体数。 */
  pending() {
    const o = this.pickSpoken("pending");
    o.amount = 0;
    o.status = "pending";
    o.confidence = this.int(30, 60) / 100;
    this.resay(o, { mode: "noAmount", who: "none" });
    this.t("pending", [o], "rule", "pending", `「${o.note}」金额没记，待补全`, undefined, true);
  }
  /** 月份敲错，日期落在行程之外。只挑吃饭和打车：这两样不会提前一两个月订，不会和「出发前预订」混。 */
  outOfRange() {
    const o = this.pick("outOfRange", (e, m) => e.category === "餐饮" || !!m.car);
    const d = dayOf(o);
    const month = Number(d.slice(5, 7));
    const wrong = this.shuffle([-2, -1, 1, 2])
      .map((s) => `${d.slice(0, 5)}${pad(month + s)}${d.slice(7)}`)
      .find((x) => !Number.isNaN(new Date(x + "T00:00:00Z").getTime()) && new Date(x + "T00:00:00Z").toISOString().slice(0, 10) === x);
    if (!wrong) throw new Error(`${this.opt.id}: outOfRange 找不到合法的错月份`);
    o.occurredAt = this.clear(wrong + o.occurredAt.slice(10));
    o.createdAt = o.occurredAt;
    o.updatedAt = o.occurredAt;
    this.t("outOfRange", [o], "rule", "date", `「${o.note}」日期落在行程之外（月份敲错）`);
  }
  /** 付款人不是这趟旅行的成员，手动录入、没有原话，没法知道该是谁。 */
  nonMember() {
    const o = this.pickManual("nonMember");
    o.payerId = `m${this.all.length + 1}`;
    this.t("nonMember", [o], "rule", "payer", `「${o.note}」付款人不是这趟旅行的成员，也没有原话可查`, undefined, true);
  }

  /* ===== 埋问题：账面和自己的原话矛盾 ===== */
  /** 金额和原话对不上：多打一个零、少打一个零，或前两位数字敲反。 */
  amountVsEvidence(mode: "x10" | "div10" | "swap") {
    const step = this.theme.step;
    const wrongOf = (a: number) => (mode === "x10" ? a * 10 : mode === "div10" ? a / 10 : Number(String(a)[1] + String(a)[0] + String(a).slice(2)));
    // 少打一个零：原数先凑成整十，这样记错的数也落在步长上（不然整本账里只有它带小数）
    const realOf = (e: Expense) => (mode === "div10" ? Math.round(e.amount / (10 * step)) * 10 * step : e.amount);
    const o = this.pickSpoken(`amountVsEvidence:${mode}`, (e) => {
      const real = realOf(e);
      const s = String(real);
      if (mode === "div10" && real < 200 * step) return false;
      if (mode === "swap" && (s.length < 3 || s[0] === s[1] || s[1] === "0")) return false;
      return (real === e.amount || this.free(dayOf(e), real, e)) && this.free(dayOf(e), wrongOf(real), e);
    });
    const real = realOf(o);
    o.amount = wrongOf(real);
    this.resay(o, { amount: real });
    this.t(`amountVsEvidence:${mode}`, [o], "evidence", "amount_outlier", `「${o.note}」记成 ${o.amount}，原话说的是 ${real}`, { action: "update", id: o.id, amount: real });
  }
  /** 外币行程里把外币金额按人民币记了（原话里说的是外币）。修改建议里改不了币种（只能把金额改成折算值，原币信息就丢了），所以不评修改。 */
  currencyMistake() {
    const { theme } = this;
    if (theme.currency === "CNY" || !theme.rate) throw new Error("currencyMistake 只能用在外币行程里");
    const o = this.pickSpoken("currencyMistake", (e) => e.category === "餐饮" && e.amount >= 300 * theme.step);
    const unit = this.unit(o, "text");
    o.currency = "CNY";
    o.rate = undefined;
    this.resay(o, { unit });
    this.t("currencyMistake", [o], "evidence", "amount_outlier", `「${o.note}」原话是 ${o.amount}${unit}，却按人民币记了，多算约 ${Math.round(1 / theme.rate)} 倍`);
  }
  /** 原话说只有两个人参与，账上记的是全员。金额是两个人的量。 */
  participantsVsEvidence() {
    const o = this.pickSpoken("participantsVsEvidence", (_, m) => !m.car && m.per !== undefined);
    const other = this.one(this.others(o.payerId));
    o.amount = this.bump(dayOf(o), this.round(this.m(o).per! * 2), o);
    this.resay(o, { mode: "plain", who: "two", pair: [o.payerId, other] });
    this.t("participantsVsEvidence", [o], "evidence", "participants", `「${o.note}」原话说只有两个人参与，账上记的是全员`, { action: "update", id: o.id, participantIds: [o.payerId, other] });
  }
  /** 反过来：原话说大家一起，账上只记了两个人。 */
  participantsMissing() {
    const o = this.pickSpoken("participantsVsEvidence:missing", (e, m) => !m.car && e.category !== "交通");
    this.resay(o, { mode: "plain", who: "all" });
    o.participantIds = [o.payerId, this.one(this.others(o.payerId))];
    this.t("participantsVsEvidence:missing", [o], "evidence", "participants", `「${o.note}」原话说的是大家一起，账上只记了两个人`, { action: "update", id: o.id, participantIds: this.all });
  }
  /** 原话里付钱的是另一个人。 */
  payerVsEvidence() {
    const o = this.pickSpoken("payerVsEvidence");
    const real = this.one(this.others(o.payerId));
    this.resay(o, { payer: real });
    this.t("payerVsEvidence", [o], "evidence", "payer", `「${o.note}」原话是${this.name(real)}付的，账上记成了${this.name(o.payerId)}`, { action: "update", id: o.id, payerId: real });
  }
  /** 原话是请客，账上却按全员均摊。 */
  treatVsEvidence(noA: boolean) {
    const o = this.pickSpoken("treatVsEvidence", (e) => e.category === "餐饮" || e.category === "娱乐");
    this.resay(o, { mode: "treat", who: "none", noA });
    this.t("treatVsEvidence", [o], "evidence", "other", `「${o.note}」原话是${this.name(o.payerId)}请客，账上却按全员均摊`, { action: "update", id: o.id, treat: true });
  }
  /** 反过来：账上标了请客，原话却是先垫着、回头平摊。要把请客去掉，参与人也要补上付款人。 */
  treatNot() {
    const o = this.pickSpoken("treatVsEvidence:notTreat", (e) => e.category === "餐饮" || e.category === "娱乐");
    this.resay(o, { mode: "pad", tpl: 1, who: "none" });
    o.treat = true;
    o.participantIds = this.others(o.payerId);
    this.t("treatVsEvidence:notTreat", [o], "evidence", "other", `「${o.note}」账上标了请客，原话却是${this.name(o.payerId)}先垫着、回头 ${this.all.length} 个人平摊`, { action: "update", id: o.id, treat: false, participantIds: this.all });
  }
  /** 原话说付款人算两份，账上是均摊。修改建议里改不了分摊规则，所以不评修改。 */
  splitVsEvidence() {
    const o = this.pickSpoken("splitVsEvidence", (e) => e.category === "餐饮" || e.category === "娱乐");
    this.resay(o, { mode: "plain", who: "none", shares: true });
    this.t("splitVsEvidence", [o], "evidence", "other", `「${o.note}」原话说${this.name(o.payerId)}算两份，账上却是均摊`);
  }

  /* ===== 埋问题：要靠判断 ===== */
  /** 同一笔记了两次，第二次是凭印象记的约数。约数比原数更整（398 记成 400，140 记成 150），入账前查过当天没人用这个数（gen-10）。 */
  dupNear(sayApprox: boolean) {
    const step = this.theme.step;
    const approxOf = (a: number) => { const r = Math.round(a / (10 * step)) * 10 * step; return r !== a ? r : Math.round(a / (50 * step)) * 50 * step; };
    const o = this.pick("dupNear", (e) => e.amount >= 100 * step && e.amount % (50 * step) !== 0 && this.free(dayOf(e), approxOf(e.amount)));
    const approx = approxOf(o.amount);
    const c = this.copy(o, this.after(o.occurredAt, 8, 75), { amount: approx }, { mode: sayApprox ? "approx" : "plain" }, this.spoken());
    // 原话里说了「差不多」的，该删的是约数那条；没说的，删哪条都算对
    this.t("dupNear", [o, c], "judgment", "duplicate", `同一笔「${o.note}」记了两次，第二次是凭印象记的约数（${o.amount} 和 ${approx}）`, { action: "delete", anyOf: sayApprox ? [c.id] : [o.id, c.id] });
  }
  /** 住宿在入住和退房时各记了一次，金额相同，隔了几天。 */
  dupFar() {
    const o = this.lodge;
    const c = this.copy(o, this.time(this.trip.endDate!, "11:00", -35, 40));
    this.t("dupFar", [o, c], "judgment", "duplicate", `住宿「${o.note}」在入住和退房时各记了一次，金额相同`, { action: "delete", anyOf: [o.id, c.id] });
  }
  /** 正餐、门票、娱乐这种一次性的消费，第二天上午又原样记了一次（补记时忘了已经记过）。隔天，查重规则配不上。 */
  dupLate() {
    const o = this.pick("dupLate", (e, m) => ["lunch", "dinner", "ticket", "fun"].includes(m.slot ?? "") && m.day < this.opt.days - 1 && this.free(addDays(dayOf(e), 1), e.amount));
    const c = this.copy(o, this.time(addDays(dayOf(o), 1), "09:10", -65, 65));
    this.t("dupLate", [o, c], "judgment", "duplicate", `「${o.note}」第二天上午又原样记了一次，金额相同`, { action: "delete", anyOf: [o.id, c.id] });
  }
  /** 早餐、小吃饮品多打了一个零，手动录入、没有凭证：看得出离谱，但不知道该是多少。（夜宵不埋：烧烤海鲜乘十也可能说得通。） */
  outlierNoEvidence() {
    const o = this.pickManual("outlierNoEvidence", (e, m) => ["breakfast", "snack"].includes(m.slot ?? "") && this.free(dayOf(e), e.amount * 10, e));
    o.amount *= 10;
    this.t("outlierNoEvidence", [o], "judgment", "amount_outlier", `「${o.note}」金额 ${o.amount}，是同类早餐、小吃饮品的十倍左右，没有凭证`, undefined, true);
  }
  /** 外币行程里，一笔当地消费的币种记成了人民币，手动录入、没有原话。 */
  currencyNoEvidence() {
    const { theme } = this;
    if (theme.currency === "CNY" || !theme.rate) throw new Error("currencyNoEvidence 只能用在外币行程里");
    const o = this.pickManual("currencyNoEvidence", (e, m) => !m.car && e.category !== "交通" && e.amount >= 300 * theme.step);
    o.currency = "CNY";
    o.rate = undefined;
    this.t("currencyNoEvidence", [o], "judgment", "amount_outlier", `「${o.note}」是当地消费，币种却记成了人民币（其余当地消费都是${theme.currency === "JPY" ? "日元" : "泰铢"}），多算约 ${Math.round(1 / theme.rate)} 倍`);
  }

  /* ===== 干扰项：看着可疑，其实没问题 ===== */
  /** 往返两笔同价、相隔一个多小时，查重规则会配成一对。两笔备注相同，哪笔是去、哪笔是回只在原话里（gen-06）。 */
  shuttle(k: number) {
    const p = this.theme.pairs[k];
    const slotAt = (date: string, key: SlotKey) => `${date}T${this.theme.slots.find((s) => s.key === key)!.time}:00`;
    // 放在午饭后、下午茶前的空档，去和回之间不夹别的账目；第一天下午是入住时间，也避开
    for (const day of this.shuffle(Array.from({ length: this.opt.days }, (_, d) => d).filter((d) => !this.busyDays.has(d) && (d > 0 || this.opt.days === 1)))) {
      const date = this.date(day);
      const up = this.clear(addMin(slotAt(date, "lunch"), this.int(23, 38)));
      const room = Math.floor((new Date(addMin(slotAt(date, "snack"), -22) + "Z").getTime() - new Date(up + "Z").getTime()) / 60000);
      const down = this.after(up, 62, Math.min(92, room));
      if (this.ex.some((e) => e.occurredAt > up && e.occurredAt < down)) continue;
      this.busyDays.add(day);
      const fare = this.bump(date, this.round((p.min + this.r() * (p.max - p.min)) * this.all.length));
      const payer = this.one(this.all);
      const a = this.extra({ amount: fare, payerId: payer, category: "交通", note: p.note, occurredAt: up }, day, this.spoken(), { label: `${p.a}的${p.note}` });
      const b = this.extra({ amount: fare, payerId: payer, category: "交通", note: p.note, occurredAt: down }, day, this.spoken(), { label: `${p.b}的${p.note}` });
      this.d([a, b], "shuttle", `${p.a}和${p.b}各一笔，金额相同、相隔不到两小时，会被查重规则配成一对，但不是重复`);
      return;
    }
    throw new Error(`${this.opt.id}: shuttle 找不到午饭后有空档的一天`);
  }
  /** 人多分两辆车，两个人各付一笔同价的车费，时间挨着。 */
  twoCars() {
    const { theme } = this;
    const day = this.int(0, this.opt.days - 1);
    const date = this.date(day);
    const fare = this.bump(date, this.round(theme.car[0] + this.r() * (theme.car[1] - theme.car[0])));
    const [p1, p2] = this.shuffle(this.all);
    const t1 = this.time(date, "11:30", -20, 25);
    const a = this.extra({ amount: fare, payerId: p1, category: "交通", note: theme.cars[0], occurredAt: t1 }, day, this.spoken(), { tpl: 0, tail: "，分两辆车，这是第一辆" });
    const b = this.extra({ amount: fare, payerId: p2, category: "交通", note: theme.cars[0], occurredAt: this.after(t1, 1, 4) }, day, this.spoken(), { mode: "plain", tpl: 1, label: "第二辆车" });
    this.d([a, b], "twoCars", "人多分两辆车，各付一笔，金额相同、时间挨着，会被查重规则配成一对，但不是重复");
  }
  /** 已标请客，参与人不含付款人，原话是请客。 */
  treatOk(noA: boolean) {
    const o = this.pickSpoken("treatOk", (e) => e.category === "餐饮" || e.category === "娱乐");
    o.treat = true;
    o.participantIds = this.others(o.payerId);
    this.resay(o, { mode: "treat", who: "none", noA });
    this.d([o], "treat", "已标请客，参与人里没有付款人是对的，和原话一致");
  }
  /** 替别人垫付：付款人自己没参加，不在参与人里，也不是请客。规则会报「付款人不在参与人内」。 */
  advance() {
    const o = this.pickSpoken("advance", (e, m) => !m.car && m.per !== undefined && (e.category === "餐饮" || e.category === "门票" || e.category === "娱乐"));
    const rest = this.others(o.payerId);
    const some = this.shuffle(rest).slice(0, 2);
    const who = rest.length > 2 && this.chance(0.5) ? rest.filter((id) => some.includes(id)) : rest;
    o.participantIds = who;
    o.amount = this.bump(dayOf(o), this.round(this.m(o).per! * who.length), o);
    this.resay(o, { mode: "advance", who: "none" });
    this.d([o], "advance", "付款人替别人垫付、自己没参加，不在参与人里是对的，原话里说了");
  }
  /** 参与人只有两个，没有原话，但用户确认过规则。规则文字带日期和金额，只对得上这一笔（gen-02）。 */
  ruleCovered() {
    const o = this.pickManual("ruleCovered", (e, m) => m.per !== undefined && e.category !== "交通");
    const other = this.one(this.others(o.payerId));
    o.participantIds = [o.payerId, other];
    o.amount = this.bump(dayOf(o), this.round(this.m(o).per! * 2), o);
    const [, mo, d] = dayOf(o).split("-").map(Number);
    const unit = this.theme.currency === "JPY" ? " 日元" : this.theme.currency === "THB" ? " 泰铢" : "";
    const rule = `${mo} 月 ${d} 日${o.category === "餐饮" ? "那顿" : "的"}${o.note}（${o.amount}${unit}）只有${this.name(o.payerId)}和${this.name(other)}参加，参与人不用补全`;
    (this.trip.rules ??= []).push(rule);
    this.d([o], "rule", "参与人只有两个，用户已经确认过这条规则", rule);
  }
  /** 按份数分摊，和原话一致。 */
  sharesSplit() {
    const o = this.pickSpoken("sharesSplit", (e) => e.category === "餐饮" || e.category === "娱乐");
    o.split = { mode: "shares", values: Object.fromEntries(this.all.map((id) => [id, id === o.payerId ? 2 : 1])) };
    this.resay(o, { mode: "plain", who: "none", shares: true });
    this.d([o], "shares", "按份数分摊，和原话一致");
  }
  /** 两天去了同一家、点了同样的东西，同名同价（比如同一家早餐）。按给的时段顺序找，找到两天都有的就用。 */
  sameSlot(...keys: SlotKey[]) {
    for (const key of keys) {
      const of = (d: number) => this.pool((e, m) => m.slot === key && m.day === d && !m.car)[0];
      for (let da = 0; da < this.opt.days; da++)
        for (let db = da + 1; db < this.opt.days; db++) {
          const a = of(da);
          const b = of(db);
          if (!a || !b || !this.free(dayOf(b), a.amount, b)) continue;
          const old = b.note;
          b.note = a.note;
          b.amount = a.amount;
          if (b.evidence?.kind === "image" && b.evidence.text === old) b.evidence = { kind: "image", text: b.note };
          if (this.m(b).said) this.resay(b);
          this.d([a, b], "sameName", `两天各有一笔「${a.note}」，同价，是两次消费，不是重复`);
          return;
        }
    }
    // 小账本里可能没有哪个时段两天都排了：退一步，隔天各加一笔同价的小额消费
    this.sameGeneric(0, false, true);
  }
  /**
   * 反复出现的小额消费（车票、矿泉水、充值）。sameDay：同一天上午、傍晚各一笔，隔了四个多小时；否则隔天各一笔。
   * equal：两笔同价；否则差一点。都不在查重窗口里。
   */
  sameGeneric(k: number, sameDay: boolean, equal: boolean) {
    const it = this.theme.generic[k];
    const step = it.step ?? this.theme.step;
    const da = this.int(0, this.opt.days - (sameDay ? 1 : 2));
    const db = sameDay ? da : this.int(da + 1, this.opt.days - 1);
    let amount = this.round((it.min + this.r() * (it.max - it.min)) * this.all.length, step);
    while (!this.free(this.date(da), amount) || (equal && !sameDay && !this.free(this.date(db), amount))) amount += step;
    const a = this.extra({ amount, payerId: this.one(this.all), category: it.category, note: it.note, occurredAt: sameDay ? this.time(this.date(da), "11:20", -12, 15) : this.time(this.date(da), "18:20", -15, 20) }, da, this.source());
    let second = equal ? amount : amount + step * this.int(1, 3);
    if (!equal) while (!this.free(this.date(db), second)) second += step;
    const b = this.extra({ amount: second, payerId: this.one(this.all), category: it.category, note: it.note, occurredAt: sameDay ? this.time(this.date(db), "16:25", -15, 15) : this.time(this.date(db), "18:20", -15, 20) }, db, this.source());
    this.d([a, b], "sameName", `「${it.note}」${sameDay ? "同一天上午、傍晚各一笔" : "隔天各一笔"}，${equal ? "同价" : "金额接近"}，是两次消费，不是重复`);
  }
  /** 出发前订的（机票、车票、流量卡），日期在行程之外是正常的。每本账写法不一样（gen-15）。 */
  preTrip(p: { note: string; category: Category; min: number; max: number; before: number; source: Source; said?: Partial<Said>; imageText?: string }) {
    const date = addDays(this.opt.start, -p.before);
    const e = this.extra({ amount: this.round((p.min + this.r() * (p.max - p.min)) * this.all.length, 1), currency: "CNY", rate: undefined, payerId: this.one(this.all), category: p.category, note: p.note, occurredAt: this.time(date, "21:00", -50, 60) }, -p.before, p.source, p.said, p.imageText);
    this.d([e], "pretrip", "出发前订的，日期在行程之外是正常的");
  }
  /** 外币行程里，在国内平台下的人民币订单：币种是人民币没错，原话里说了。 */
  cnyOrder(k: number) {
    const it = this.theme.cny[k];
    const day = this.int(0, this.opt.days - 1);
    const date = this.date(day);
    const e = this.extra({ amount: this.bump(date, this.round((it.min + this.r() * (it.max - it.min)) * this.all.length, 1)), currency: "CNY", rate: undefined, payerId: this.one(this.all), category: it.category, note: it.note, occurredAt: this.time(date, "07:40", -15, 15) }, day, this.spoken(), { label: `携程上订的${it.note}` });
    this.d([e], "cnyOrder", "国内平台下的人民币订单，币种是人民币没错，原话里说了");
  }

  /** 收尾：住宿登记成干扰项（除非它已经是埋点），按时间排序，id 重编成 e01…，truth / decoys 跟着换。 */
  done(): ReconcileCase {
    if (!this.truth.some((t) => t.ids.includes(this.lodge.id))) this.d([this.lodge], "lodging", "住宿是整本账里金额最大的一笔，人民币订单，本身没问题");
    this.ex.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    const map = new Map(this.ex.map((e, i) => [e.id, `e${pad(i + 1)}`]));
    const re = (id: string) => map.get(id) ?? id;
    for (const e of this.ex) e.id = re(e.id);
    const truth = this.truth.map((t) => ({ ...t, ids: t.ids.map(re), ...(t.fix ? { fix: t.fix.action === "delete" ? { ...t.fix, anyOf: t.fix.anyOf.map(re) } : { ...t.fix, id: re(t.fix.id) } } : {}) }));
    const decoys = this.decoys.map((d) => ({ ...d, ids: d.ids.map(re) }));
    return { id: this.opt.id, title: this.opt.title, size: this.opt.size, snap: { trip: this.trip, expenses: this.ex }, truth, decoys };
  }
}

/* ---------- 12 本账 ---------- */
function build(opt: Opt, f: (b: Builder) => void): ReconcileCase {
  const b = new Builder({ ...opt, seed: opt.seed + SALT * 7919 });
  f(b);
  return b.done();
}
/** 换一套随机种子用的偏移。评测用的账本是 0；别的值只在探针里用，确认生成器不是只在默认种子下碰巧能过自检。 */
let SALT = 0;

/**
 * 每个来源的每个置信度取值，至少落在一笔普通背景账目上：这样没有哪个 source + confidence 取值只出现在问题或干扰项里。
 * 取值本来就是从同一个区间随机抽的，这一步只是把「某个取值碰巧没被背景抽到」的情况补上（从同来源、取值有富余的背景账目里挪一笔）。
 */
function coverConfidence(cases: ReconcileCase[]) {
  const special = new Set<Expense>();
  for (const c of cases) {
    const ids = new Set([...c.truth.flatMap((t) => t.ids), ...c.decoys.flatMap((d) => d.ids)]);
    for (const e of c.snap.expenses) if (ids.has(e.id)) special.add(e);
  }
  for (const source of ["text", "image", "voice"] as const) {
    const plain = cases.flatMap((c) => c.snap.expenses).filter((e) => e.source === source && !special.has(e));
    const count = new Map<number, number>();
    for (const e of plain) count.set(e.confidence, (count.get(e.confidence) ?? 0) + 1);
    for (let v = CONF[source][0]; v <= CONF[source][1]; v++) {
      const conf = v / 100;
      if (count.get(conf)) continue;
      const donor = plain.find((e) => (count.get(e.confidence) ?? 0) >= 2);
      if (!donor) throw new Error(`来源 ${source} 的普通背景账目太少，铺不满置信度取值`);
      count.set(donor.confidence, count.get(donor.confidence)! - 1);
      donor.confidence = conf;
      count.set(conf, 1);
    }
  }
}

export function reconcileCases(salt = 0): ReconcileCase[] {
  SALT = salt;
  /* 每本账里先埋挑得最严的（只能落在早餐小吃上的、对金额有要求的），再埋随便哪笔都行的；干扰项在后。 */
  const cases = [
    build({ id: "c01", title: "重庆三日 · 小 · 重复 + 空参与人 + 多打一个零", size: "small", theme: "重庆", trip: "重庆三日", start: "2026-04-03", days: 3, count: 10, members: ["小安", "阿哲", "圆圆", "大鹏"], seed: 101 }, (b) => {
      b.amountVsEvidence("x10"); b.dupExact(); b.emptyParticipants(true);
      b.treatOk(false); b.shuttle(0);
    }),
    build({ id: "c02", title: "厦门三日 · 小 · 付款人不在参与人 + 待补全 + 参与人与原话不符", size: "small", theme: "厦门", trip: "厦门三日", start: "2026-05-01", days: 3, count: 9, members: ["婷婷", "大伟", "小雨"], seed: 202 }, (b) => {
      b.participantsVsEvidence(); b.payerNotIn(); b.pending();
      b.advance(); b.preTrip({ note: "厦门往返机票 3 张", category: "交通", min: 700, max: 1100, before: 9, source: "image" });
    }),
    build({ id: "c03", title: "大阪四日 · 小 · 币种记错 + 约数重复 + 日期出界", size: "small", theme: "大阪", trip: "大阪京都四日", start: "2026-03-20", days: 4, count: 12, members: ["老周", "小陈", "阿杰", "琳琳", "思思"], seed: 303 }, (b) => {
      b.currencyMistake(); b.dupNear(true); b.outOfRange();
      b.treatOk(true); b.sharesSplit();
    }),
    build({ id: "c04", title: "西安三日 · 小 · 干净账本", size: "small", theme: "西安", trip: "西安三日", start: "2026-06-12", days: 3, count: 10, members: ["浩然", "佳怡", "子轩", "欣妍"], seed: 404 }, (b) => {
      b.sameSlot("breakfast", "snack", "late", "back"); b.shuttle(0); b.treatOk(false); b.ruleCovered();
    }),
    build({ id: "c05", title: "青岛四日 · 中 · 六处问题", size: "medium", theme: "青岛", trip: "青岛四日", start: "2026-07-17", days: 4, count: 22, members: ["小安", "婷婷", "阿杰", "欣妍"], seed: 505 }, (b) => {
      b.amountVsEvidence("div10"); b.treatVsEvidence(true); b.payerVsEvidence(); b.dupFar(); b.dupExact(); b.emptyParticipants(false);
      b.shuttle(0); b.ruleCovered(); b.sameGeneric(0, true, true);
      b.preTrip({ note: "青岛往返高铁票", category: "交通", min: 380, max: 620, before: 15, source: "text", said: { tpl: 2 } });
    }),
    build({ id: "c06", title: "曼谷五日 · 中 · 七处问题", size: "medium", theme: "曼谷", trip: "曼谷五日", start: "2026-02-10", days: 5, count: 24, members: ["阿凯", "小敏", "大刘", "晓彤", "文文", "小宇"], seed: 606 }, (b) => {
      b.outlierNoEvidence(); b.currencyNoEvidence(); b.participantsVsEvidence(); b.participantsMissing(); b.dupExact(); b.nonMember(); b.pending();
      b.treatOk(true); b.sharesSplit(); b.twoCars(); b.cnyOrder(0);
      b.preTrip({ note: "曼谷往返机票 6 张", category: "交通", min: 1600, max: 2400, before: 21, source: "text", said: { tpl: 1 } });
    }),
    build({ id: "c07", title: "重庆四日 · 中 · 六处问题", size: "medium", theme: "重庆", trip: "重庆四日", start: "2026-09-25", days: 4, count: 20, members: ["老周", "圆圆", "子轩", "小雨", "大伟"], seed: 707 }, (b) => {
      b.amountVsEvidence("swap"); b.dupNear(false); b.dupLate(); b.splitVsEvidence(); b.payerNotIn(); b.outOfRange();
      b.shuttle(0); b.shuttle(1); b.twoCars(); b.treatOk(false); b.advance();
    }),
    build({ id: "c08", title: "西安五日 · 中 · 六处问题", size: "medium", theme: "西安", trip: "西安五日", start: "2026-10-01", days: 5, count: 27, members: ["浩然", "琳琳", "阿哲"], seed: 808 }, (b) => {
      b.outlierNoEvidence(); b.sameSlot("breakfast", "snack", "late");
      b.treatVsEvidence(false); b.treatNot(); b.dupExact(); b.dupExact(); b.emptyParticipants(true);
      b.ruleCovered(); b.treatOk(true);
      b.preTrip({ note: "高铁票 去程", category: "交通", min: 180, max: 330, before: 6, source: "image", imageText: "提前订的，三个人的票" });
    }),
    build({ id: "c09", title: "大阪七日 · 大 · 十处问题", size: "large", theme: "大阪", trip: "大阪京都七日", start: "2026-04-25", days: 7, count: 52, members: ["小安", "大鹏", "思思", "文文", "阿凯"], seed: 909 }, (b) => {
      b.currencyNoEvidence(); b.currencyMistake(); b.amountVsEvidence("x10"); b.dupNear(true); b.dupLate();
      b.participantsVsEvidence(); b.payerVsEvidence(); b.dupExact(); b.pending(); b.outOfRange();
      b.shuttle(0); b.shuttle(1); b.twoCars(); b.treatOk(false); b.treatOk(true); b.sharesSplit(); b.cnyOrder(0); b.sameGeneric(0, false, true);
      b.preTrip({ note: "境外流量卡 5 张", category: "其他", min: 25, max: 45, before: 4, source: "voice" });
    }),
    build({ id: "c10", title: "重庆七日 · 大 · 十二处问题", size: "large", theme: "重庆", trip: "重庆七日", start: "2026-08-08", days: 7, count: 56, members: ["阿凯", "小敏", "大刘", "晓彤", "文文", "小宇"], seed: 1010 }, (b) => {
      b.outlierNoEvidence(); b.amountVsEvidence("swap"); b.treatVsEvidence(true); b.treatNot(); b.participantsMissing(); b.payerVsEvidence();
      b.dupFar(); b.dupExact(); b.dupExact(); b.emptyParticipants(false); b.payerNotIn(); b.nonMember();
      b.shuttle(0); b.shuttle(1); b.twoCars(); b.ruleCovered(); b.ruleCovered(); b.treatOk(false); b.sharesSplit(); b.advance(); b.sameGeneric(1, true, false);
    }),
    build({ id: "c11", title: "厦门七日 · 大 · 干净账本", size: "large", theme: "厦门", trip: "厦门泉州七日", start: "2026-01-24", days: 7, count: 50, members: ["婷婷", "子轩", "佳怡", "大伟"], seed: 1111 }, (b) => {
      b.sameSlot("breakfast", "snack", "late"); b.shuttle(0); b.shuttle(1); b.treatOk(true); b.treatOk(false); b.ruleCovered(); b.sharesSplit(); b.advance(); b.sameGeneric(1, false, true);
      b.preTrip({ note: "厦门往返机票 4 张", category: "交通", min: 800, max: 1300, before: 12, source: "text", said: { mode: "pad", tpl: 1 } });
    }),
    build({ id: "c12", title: "青岛三日 · 中 · 只埋规则查不出来的六处", size: "medium", theme: "青岛", trip: "青岛三日", start: "2026-05-29", days: 3, count: 19, members: ["圆圆", "阿哲", "晓彤", "小宇"], seed: 1212 }, (b) => {
      b.outlierNoEvidence(); b.amountVsEvidence("div10"); b.dupNear(true); b.splitVsEvidence(); b.participantsVsEvidence(); b.payerVsEvidence();
      b.shuttle(1); b.treatOk(true); b.sameGeneric(0, true, false);
      b.preTrip({ note: "往返高铁票 4 张", category: "交通", min: 380, max: 620, before: 20, source: "manual" });
    }),
  ];
  coverConfidence(cases);
  return cases;
}

/** 账本内容的指纹：写进每个结果文件，汇总时用来确认结果和当前账本是同一版。 */
export function casesHash(cases: ReconcileCase[] = reconcileCases()): string {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex").slice(0, 12);
}
