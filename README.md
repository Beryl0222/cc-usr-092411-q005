# 记者选拔回避与复核

联合选拔进入初评后，秘书处需要回答两个此前无法回答的问题：评委交出的某一分数在出现新材料后**是否还应进入排名**，以及候选人跨组兼报时**哪些资格结论可以共用**。本仓库在已有的报名、回避、评分、事件确认与终局决定事件约定之上，建立了可恢复、可反查的**复核服务**。

## 领域原则

- **仅追加事件**：事实一经接收，其标识、发生时间与版本不被原地改写；更正只产生后继事件（`DECISION_CORRECTED`、`SCORE_SUSPENDED` 等）。
- **纯函数投影**：当前状态完全由事件流重放得到（`projectState`），崩溃后从 JSONL 日志恢复，截止时间等一并还原。
- **最小知情**：替补意见对原评委隔离；调用方只读取完成职责所需字段。

## 业务规则到实现的对应

| 规则 | 实现 |
| --- | --- |
| 候选材料按版本保存 | `submitMaterial` → `MATERIAL_VERSION_SUBMITTED`（版本递增，旧版保留）；评分/申诉必须指明版本 |
| 受派时冻结当时已申报利益关系 | `assignReviewer` → `REVIEWER_ASSIGNED.payload.frozen_snapshot`；迟到关系不回写快照 |
| 迟到关系只暂停受影响评分、留理由、不删记录 | `reportLateInterest` → `LATE_INTEREST_RECEIVED` + `SCORE_SUSPENDED`；原 `SCORE_SUBMITTED` 保留 |
| 替补由不同机构批准，原评委不可见替补意见 | `approveSubstitute` 校验批准机构 ≠ 原评委机构且批准人 ≠ 原评委；`viewScore` 对被接替者拒绝 |
| 各组独立排序、评分严格隔离 | `computeRanking(groupId)` 只统计本组评分；其他组评分不会串入 |
| 资格结论可跨组复用 | `effectiveQualification(candidateId, groupId)` 返回结论及 `reusedFromGroup` |
| 申诉须指向材料版本或程序事件 | `fileAppeal` 仅接受 `target:{kind:"material",version}` 或 `{kind:"incident",incidentId}` |
| 重评与终局裁决须两名不同角色签署 | `signRescore`、`finalizeDecision`、`correctDecision` 均强制两人两角色 |
| 公布后只能追加更正 | 公布后普通评分通道关闭；更正只能经申诉走 `DECISION_CORRECTED`，原裁决/公布保留 |
| 识别完全相同重复请求与同编号异内容 | 内容规范化指纹：无编号但完全相同 → `DUPLICATE_REQUEST`；同号同内容幂等；同号异内容 → `CONFLICTING_REQUEST` 并追加 `REQUEST_REJECTED` |
| 恢复后按原截止时间继续 | `scheduleDeadline` → `DEADLINE_SCHEDULED` 持久化；重放后回避确认/申诉仍按原截止时间判定 |
| 从分数反查为何有效或被排除 | `traceScore(scoreId)`：状态、受派快照、资格依据（含跨组复用）、完整事件与理由链 |

分数的有效性状态：`valid`（进入排名）、`suspended`（迟到关系暂停）、`superseded`（申诉重评替代）。资格不达标时分数仍被接收与保留，但投影在排名阶段排除，并在 `traceScore` 中说明原因——这正是“能反查它为何被排除”的前提。

## 目录

- `contracts/domain.schema.json`：领域事件信封、事件类型与聚合类型（含复核新增事件）。
- `src/domain.ts`：对应的 TypeScript 类型。
- `src/validator.js`：基础事件信封校验。
- `src/event-store.js`：事务式仅追加事件存储（缓冲 → commit 落盘 / rollback；`recover` 重放）。
- `src/review-service.js`：复核领域服务与纯函数事件投影。
- `src/errors.js` / `src/canonical.js`：错误码与规范化指纹工具。
- `src/demo.js`：验收命令入口。
- `tests/`：信封约定测试与复核规则测试。

## 本地检查

```bash
npm test        # node --test，全部规则测试
npm run build   # 语法检查
npm run demo    # 端到端验收演示（事件写入 data/demo-event-log.jsonl，已被 git 忽略）
```

## 验收演示内容

`npm run demo` 用可控时钟和两次“崩溃—恢复”串起完整流程：

1. 初评当日安排两组截止时间、跨组兼报报名、材料 v1，随后退出；
2. 从事件日志恢复，按原截止时间继续分派评委与回避确认，并演示幂等/冲突请求识别；
3. 秘书处收到“评委与候选人曾共同任职”的迟到材料 → 暂停原分数（留理由、不删记录）→ 同机构批准被拒、异机构批准替补接管，原评委看不到替补意见；
4. 深度调查组 / 时政组独立排序、各自双人异角色签署、**同时终局裁决**并公布；
5. 申诉期内再次恢复，申诉指向具体材料版本 → 两名不同角色重评签署 → 公布决定**仅追加更正**后的最终序列（另一组不受影响）；
6. 输出每个关键分数的反查链：为何有效、为何因迟到关系暂停、为何被重评替代。
