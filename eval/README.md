# 录入解析评测（eval/）

- `cases.json`：评测集 v2，100 例（2026-11-10）。`t01–t20` 是 2026-11-04 的 v1 原集，原样保留（另存 `cases-v1-20.json`）；`c21–c100` 为 2026-11-10 构造。每例有 `tags` 标注考察维度，`expected` 为人工标注（participants 用成员名，null 表示不评该字段）。
- `scripts/eval.ts`：`npm run eval [caseId] [-- --cases <file>] [-- --label <说明>]`，`TRIPSPLIT_MODEL` / `TRIPSPLIT_EFFORT` 切模型与 effort。结果写 `eval/results/<时间>[-label].json`（含 `summary.byTag` 按维度通过率与 `failures`），配置数据库时同时写 `evals` 表，`/admin` 可看历史。
- `results/` 不入库（.gitignore）。本次各轮结果与口径见 `../docs/评测-2026-11-10.md`。

## 口径与边界

- 线上遥测（`runs` 表）只存录入方式和决策、不存原文，且截至 2026-11-10 没有一条 `extract` 调用，所以 80 例新用例**全部是构造的**，按旅行记账的表达方式分层（中文数字、需计算金额、多金额候选、付款人缺失 / 别称 / 非成员 / 多人付、参与人全员 / 子集 / 排除 / 缺失、请客、个人消费、外币、分类边界、非消费、语音转写噪声、一句两笔、押金、时间）。
- 决策分布 74 auto / 18 ask / 8 reject，89 文字 / 11 语音转写。
- 标注原则：参与人、付款人必须有文字依据，没有就 ask，不按「4 张票 = 4 个人」推断（v1 的 t04 口径）；c41 原按全员标 auto，与此冲突，在 before 跑完后改为 ask，前后对比统一按新标重算。
