# TripSplit 旅游分账 Agent

多人自由行 AA 记账助手。核心四件事：**多模态录入**（文字 / 支付截图 / 语音）、**历史账目检索与报告**（结构化条件 + 语义检索，带证据引用与修改预览）、**核账 Agent**（只读工具链路，建议需用户确认）、**最少转账结算**。

在此之上：多人云同步、分摊规则（份数 / 比例 / 指定金额 / 请客）、多币种汇率、预算与趋势、还款跟踪与锁账、分享图片 / Excel / PDF 导出、截图批量与账单导入、服务端语音识别与离线队列、Agent 记忆（规则 / 习惯）、评测集与运营后台。

- 产品文档：[docs/PRD.md](docs/PRD.md)（用户动线、页面交互、业务规则、异常处理、验收标准）
- 应用内说明：`/about`；运营后台：`/admin`
- 线上地址：https://tripsplit-jet.vercel.app

## 运行

```bash
npm install
cp .env.example .env.local   # 至少填 ANTHROPIC_API_KEY；其余可选项见文件注释
npm run dev                  # http://localhost:3000
```

首次打开会载入两趟示例旅行，首页有导览卡直达：
- 成都四日游：刚玩完还没核账，内含故意埋的重复录入 / 参与人错误 / 金额异常，预算因此显示超支；核账页直接带一份 Agent 的真实核账结果，逐条确认后预算和结算跟着变。
- 大阪京都五日：已核账、已全部结清并锁账，日元按当日汇率折算，含请客 / 按份 / 按比例 / 指定金额四种分摊、已转记录和消费报告。

示例旅行的核账 / 查询 / 报告结果是 `npm run demo:snapshot` 对示例数据真实调模型跑出来后存下的快照（`lib/demo-results.json`）；改了 `lib/seed.ts` 要重跑。账本被改动后快照不再展示，以现场结果为准。

```bash
npm test        # 纯函数单测：分摊规则/结算/还款、录入决策、检索
npm run demo:snapshot   # 重新生成示例旅行的 AI 结果快照（真实调模型）
npm run eval    # 录入解析评测集（eval/cases.json，20 例，真实调模型），结果写 eval/results/ 与数据库
npm run build
```

## 可选服务

| 功能 | 需要 | 没配时 |
|---|---|---|
| 云同步 / 邀请链接、遥测入库、评测历史 | `TRIPSPLIT_DB_URL`（本地默认 `file:./data/tripsplit.db`；线上用 Turso + `TRIPSPLIT_DB_TOKEN`） | 本机模式；后台只显示进程内存里的最近调用 |
| 服务端语音识别（Safari / 微信可用，离线排队） | `STT_API_KEY`（OpenAI 或 Groq 的 Whisper 接口，见 `.env.example`） | 退回浏览器 Web Speech（Chrome 系） |
| 汇率 | 无（frankfurter.dev 免费接口，欧洲央行参考汇率） | 取不到时手填 |
| `/admin` 访问控制 | `ADMIN_TOKEN` | 任何人可看（线上务必设置） |

## 部署到 Cloudflare(国内不翻墙能打开)

线上一直在 Vercel(tripsplit-jet.vercel.app),但 `*.vercel.app` 在大陆被 DNS 污染,国内面试官点不开。2026-11-10 另加了一套 Cloudflare 部署:
OpenNext 把 Next.js 构建成一个 Worker(`wrangler.jsonc`),再用一个只含 `_worker.js` 的 Cloudflare Pages 项目(`cf-pages/`)把 `tripsplit-app.pages.dev` 的请求经 Service Binding 转给它。
多这一层是因为 `*.workers.dev` 同样被污染,而 `*.pages.dev` 国内 29 个节点 21 个能开。

为此 `lib/db.ts` 改成异步:本地 `file:` 库仍走 Node 客户端,远端 Turso 走 `@libsql/client/web`;在 Workers 上把 `libsql://` 换成 `https://`,因为 Workers 不允许跨请求复用 WebSocket。调用方统一 `await ready()`。

一次性准备(本机):

```bash
npx wrangler login
```

```bash
for k in ANTHROPIC_API_KEY STT_API_KEY TRIPSPLIT_DB_URL TRIPSPLIT_DB_TOKEN ADMIN_TOKEN; do npx wrangler secret put $k; done
```

```bash
npx wrangler pages project create tripsplit-app --production-branch main --force
```

之后每次发布:

```bash
npm run cf:deploy
```

本地在 Workers 运行时里预览:`npm run cf:preview`,环境变量放 `.dev.vars`(已忽略;不填数据库时写 `TRIPSPLIT_DB_URL=off`)。`STT_BASE_URL`、`STT_MODEL` 这类非密钥配置在 `wrangler.jsonc` 的 `vars` 里。Vercel 部署照旧,两边同时在线。
`cf:*` 脚本通过 `scripts/cf-build.mjs` 构建:它在构建期间把 `.env.local` 挪开(OpenNext 会把所有 `.env*` 的值直接写进 Worker 包里,不挪开就等于把本地密钥上传了),构建完再放回;同时设 `CF_BUILD=1`:这个构建关掉 `cacheComponents` 和 `partialPrefetching`(Next 的 Cache Components 在 workerd 里会让页面挂死),Vercel 构建仍然开着。

## 架构

```
浏览器（localStorage 持有全部账本；开启云同步后与服务端 LWW 合并）
  ├─ 录入   ──POST /api/extract───►  messages.parse + zod 结构化输出（每字段置信度、请客、币种）→ auto / ask / reject
  │          ──POST /api/import────►  账单 CSV 明细分类 / 订单文本抽取 → 草稿列表（本地查重）→ 用户勾选入账
  │          ──POST /api/transcribe►  Whisper 兼容接口（可选）；离线录音进 IndexedDB 队列
  ├─ 查询   ──POST /api/search────►  ① 模糊描述→结构化条件  ② 条件过滤 + TF-IDF 语义排序  ③ 基于候选作答（引用 id、修改建议）
  │          ──POST /api/report────►  确定性聚合 → 模型写叙述 → 可导出 PDF（打印）
  ├─ 核账   ──POST /api/reconcile─►  手写 agent loop：Planning → 只读工具 → submit_findings(strict)；带入本次规则 + 长期习惯
  ├─ 结算     本地：分摊规则、外币折算、贪心最少转账、已转记录、全部结清后锁账、图片卡片分享
  ├─ 同步   ──/api/sync/share, /api/sync/[code]──► libsql：账目按 updatedAt 最后写入胜，删除为墓碑，审计只增
  └─ 后台   /admin：按路由的次数 / 成功率 / p50 p90 / token / 成本；评测历史
```

服务端 AI 接口只收账本快照、只返回建议，没有写接口。核账 Agent 的工具全是快照上的纯函数，技术上无法改账；所有修改都经"字段级预览 → 用户确认 → 客户端写入 → 审计记录"。云同步是唯一的服务端写路径，且只搬运用户已经确认的账目。

| 目录 | 内容 |
|---|---|
| `lib/types.ts` | 数据模型（zod）：分摊规则、币种汇率、预算、已转记录、规则与习惯 |
| `lib/settle.ts` | 分摊（均摊 / 份数 / 比例 / 指定额 / 请客）、折算、最少转账、还款后的剩余方案 |
| `lib/store.ts` | localStorage 存储 + 审计 + 锁定守卫 + 远端写入口 |
| `lib/sync/` | 云同步：服务端合并（server.ts）与客户端轮询 / 防抖推送（client.ts） |
| `lib/extract/` | 多模态录入：提示词、输出 schema、置信度决策 |
| `lib/import/` | 支付宝 / 微信账单 CSV 解析，账单与订单文本的模型整理 |
| `lib/search/` | 检索（分词、TF-IDF、条件过滤）与回答生成 |
| `lib/agent/` | 核账 Agent 工具集与循环 |
| `lib/report.ts` `lib/export.ts` | 聚合 + 叙述；CSV / 图片卡片 / 打印 PDF |
| `lib/voice.ts` | 录音、服务端转写、离线队列 |
| `lib/db.ts` `lib/telemetry.ts` | libsql 连接与建表；模型调用遥测与成本估算 |
| `eval/` `scripts/eval.ts` | 录入解析评测集与评测脚本 |
| `components/` | 面板与通用组件 |

录入解析默认 `claude-sonnet-5-5`（2026-11-10 的 100 例评测里与 opus 同准、成本 19%，见 `docs/评测-2026-11-10.md`），核账 / 检索 / 报告 / 导入默认 `claude-opus-5-5`；`TRIPSPLIT_MODEL` 一次覆盖全部，`TRIPSPLIT_EXTRACT_MODEL` 只覆盖录入，`TRIPSPLIT_EFFORT` 调 effort。
