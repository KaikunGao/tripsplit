import Link from "next/link";

export const metadata = { title: "产品说明 · TripSplit" };

const ROWS: [string, string, string][] = [
  ["创建旅行", "名称、成员、日期；第一位成员为管账人", "本机 localStorage"],
  ["消费录入", "文字 / 支付截图 / 语音统一抽取金额、付款人、参与人；按置信度与字段完整性决定自动入账或追问", "POST /api/extract"],
  ["账本管理", "按天分组、按人筛选、编辑/删除、待补全标记、修改记录（审计）", "本机"],
  ["查询", "模糊描述 → 结构化条件 + 语义检索 → 带证据引用的回答与修改预览；一键生成消费报告", "POST /api/search · /api/report"],
  ["核账", "只读核账：代码跑完规则体检、查重、分类统计、结算预览，模型逐项核对后给出结构化结论；修改建议逐条确认", "POST /api/reconcile"],
  ["结算", "每人已付/应摊/净额（外币按汇率折算），贪心最少转账；标记已转、催款文案、全部结清后锁账；图片卡片分享", "本机"],
  ["批量导入", "多张截图逐张识别；支付宝/微信账单 CSV 与订单文本由模型整理成草稿；本地查重后勾选入账", "POST /api/import"],
  ["云同步", "开启后生成邀请链接，同行者各自手机记账；账目按最后写入胜合并，删除为墓碑", "/api/sync（libsql）"],
  ["核账记忆", "忽略建议时的理由记为本次规则或长期习惯，回灌录入解析与核账；账本有改动时结算前提示先核账", "本机 + 随快照上送"],
  ["可观测", "每次模型调用的耗时、token、成本入库；评测集 npm run eval；/admin 查看", "libsql"],
];

export default function About() {
  return (
    <article className="prose-sm max-w-none space-y-6">
      <div>
        <h1 className="text-2xl font-bold">TripSplit 旅游分账助手</h1>
        <p className="mt-2 text-ink-600">
          面向多人自由行的 AA 记账助手。针对消费记录分散、垫付关系复杂、参与人易记错、结算核对繁琐四个痛点，用多模态录入降低记录成本，用检索 + 核账降低核对成本，并把 AI 限定在“只读账目、提出建议、用户确认修改”的边界内。
        </p>
      </div>

      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-paper text-left text-xs text-ink-400">
            <tr>
              <th className="px-4 py-2 font-medium">环节</th>
              <th className="px-4 py-2 font-medium">做什么</th>
              <th className="px-4 py-2 font-medium">数据流</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([a, b, c]) => (
              <tr key={a} className="border-t border-ink-100 align-top">
                <td className="px-4 py-2 font-medium">{a}</td>
                <td className="px-4 py-2 text-ink-600">{b}</td>
                <td className="mono px-4 py-2 text-ink-400">{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card p-5">
        <h2 className="font-semibold">安全边界</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-600">
          <li>账本只存在你的浏览器里；三个 AI 接口只接收账本快照，服务端没有任何持久化或写接口。</li>
          <li>核账用到的全部检查都是对快照的纯函数，模型在技术上无法改账，只能提交建议。</li>
          <li>每条建议附带证据引用与字段级修改预览，确认后才写入，并记入修改记录（来源标记为“核账建议·已确认”）。</li>
          <li>报告里的数字来自确定性聚合，模型只负责措辞。</li>
        </ul>
      </section>

      <p className="text-sm text-ink-400">
        完整 PRD（用户动线、页面交互、业务规则、异常处理、验收标准）见仓库 <span className="mono">docs/PRD.md</span>。{" "}
        <Link href="/" className="underline">
          返回首页
        </Link>
      </p>
    </article>
  );
}
