# TripSplit 旅游分账 Agent

多人自由行 AA 记账助手。四件事：**多模态录入**（文字 / 支付截图 / 语音）、**历史账目检索与报告**（结构化条件 + 语义检索，带证据引用与修改预览）、**核账 Agent**（只读工具链路，建议需用户确认）、**最少转账结算**。

- 产品文档：[docs/PRD.md](docs/PRD.md)（用户动线、页面交互、业务规则、异常处理、验收标准）
- 应用内说明：`/about`

## 运行

```bash
npm install
cp .env.example .env.local   # 填入 ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

首次打开会载入示例旅行（成都四日游，内含故意埋的重复录入 / 参与人错误 / 金额异常，用于演示核账）。

```bash
npm test        # 纯函数单测：分摊/结算、录入决策、检索
npm run build
```

## 架构

```
浏览器（localStorage 持有全部账本）
  ├─ 录入   ──POST /api/extract───►  messages.parse + zod 结构化输出（每字段置信度）→ 决策 auto / ask / reject
  ├─ 查询   ──POST /api/search────►  ① 模糊描述→结构化条件  ② 条件过滤 + TF-IDF 语义排序  ③ 基于候选作答（引用 id、修改建议）
  │          ──POST /api/report────►  确定性聚合 → 模型写叙述
  ├─ 核账   ──POST /api/reconcile─►  手写 agent loop：Planning → 只读工具调用 → tool_result 回传 → submit_findings(strict)
  └─ 结算     本地计算：权重分摊、贪心最少转账
```

服务端只收账本快照、只返回建议，没有写接口。核账 Agent 的工具全是快照上的纯函数，技术上无法改账；所有修改都经"字段级预览 → 用户确认 → 客户端写入 → 审计记录"。

| 目录 | 内容 |
|---|---|
| `lib/types.ts` | 数据模型（zod） |
| `lib/settle.ts` | 分摊与最少转账 |
| `lib/store.ts` | localStorage 存储 + 审计 |
| `lib/extract/` | 多模态录入：提示词、输出 schema、置信度决策 |
| `lib/search/` | 检索（分词、TF-IDF、条件过滤）与回答生成 |
| `lib/agent/` | 核账 Agent 工具集与循环 |
| `lib/report.ts` | 聚合 + 叙述 |
| `components/` | 五个面板与通用组件 |

模型默认 `claude-opus-5-5`，可用 `TRIPSPLIT_MODEL` / `TRIPSPLIT_EFFORT` 覆盖。语音录入使用浏览器 Web Speech API 在本地转写，不上传音频。
