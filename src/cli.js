#!/usr/bin/env node
/**
 * 复核服务命令入口。
 *
 *   node src/cli.js demo
 *
 * 端到端演示三个验收场景：
 *   1. 迟到利益关系 → 评分暂停（原记录保留）→ 替补评委接管；
 *   2. 两个组别按各自截止时间独立排序、各自双签裁决、同时公布；
 *   3. 公布后申诉指向具体材料版本，双签重新评分 → 追加更正 → 最终序列变化。
 * 另含：服务重启后按原截止时间继续、请求重复/同编号异内容识别、
 * 从一项分数反查其有效或被排除的原因。
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStore } from "./store.js";
import { ReviewError, ReviewService } from "./review.js";

const LINE = "─".repeat(72);

function section(title) {
  console.log(`\n${LINE}\n${title}\n${LINE}`);
}

function show(label, value) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

async function run() {
  const storePath = join(tmpdir(), `review-demo-${Date.now()}.jsonl`);
  let clock = new Date("2026-09-20T09:00:00+08:00");
  const tick = (minutes = 1) => { clock = new Date(clock.getTime() + minutes * 60_000); };
  const store = new EventStore(storePath);
  await store.load();
  let svc = new ReviewService(store, { now: () => clock.toISOString() });

  section("零、幂等：完全相同的重复请求与同编号异内容");
  await svc.acceptEntry({ entryId: "E-C002", candidateId: "C002", name: "林某", groups: ["A"] }, "REQ-001");
  const dup = await svc.acceptEntry({ entryId: "E-C002", candidateId: "C002", name: "林某", groups: ["A"] }, "REQ-001");
  show("重复提交 REQ-001（应 duplicate=true，事件总数不增加）", { duplicate: dup.duplicate, eventIds: dup.events.map((e) => e.event_id) });
  try {
    await svc.acceptEntry({ entryId: "E-OTHER", candidateId: "C999", groups: ["A"] }, "REQ-001");
  } catch (err) {
    if (err instanceof ReviewError) show("同编号异内容（应被拒绝）", err.message);
    else throw err;
  }

  section("一、报名（含跨组兼报）、材料版本、时间线与利益关系");
  tick(5);
  await svc.acceptEntry({ entryId: "E-C001", candidateId: "C001", name: "苏某", groups: ["A", "B"], primaryGroup: "A" });
  await svc.acceptEntry({ entryId: "E-C003", candidateId: "C003", name: "何某", groups: ["B"] });
  tick(3);
  await svc.submitMaterial({ entryId: "E-C001", materialVersion: 1, title: "代表作品初版" });
  await svc.submitMaterial({ entryId: "E-C002", materialVersion: 1 });
  await svc.submitMaterial({ entryId: "E-C003", materialVersion: 1 });
  // 截止时间在恢复后仍以这里登记的为准。
  await svc.setTimeline({ group: "A", recusalDeadline: "2026-09-25T18:00:00+08:00", appealDeadline: "2026-09-30T18:00:00+08:00" });
  await svc.setTimeline({ group: "B", recusalDeadline: "2026-09-25T18:00:00+08:00", appealDeadline: "2026-09-30T18:00:00+08:00" });

  section("二、评委受派冻结利益关系，初评评分");
  tick(10);
  // J1 受派时没有任何已申报关系 → 冻结清单为空。
  await svc.assignJudge({ assignmentId: "ASG-J1-A", group: "A", judgeId: "J1", judgeOrg: "甲通讯社" });
  await svc.assignJudge({ assignmentId: "ASG-J2-A", group: "A", judgeId: "J2", judgeOrg: "丁周刊" });
  await svc.assignJudge({ assignmentId: "ASG-J3-B", group: "B", judgeId: "J3", judgeOrg: "戊网媒" });
  tick(20);
  await svc.submitScore({ scoreId: "S-J1-C001", assignmentId: "ASG-J1-A", entryId: "E-C001", group: "A", judgeId: "J1", value: 80, basedOnMaterialVersion: 1 });
  await svc.submitScore({ scoreId: "S-J1-C002", assignmentId: "ASG-J1-A", entryId: "E-C002", group: "A", judgeId: "J1", value: 88, basedOnMaterialVersion: 1 });
  await svc.submitScore({ scoreId: "S-J2-C001", assignmentId: "ASG-J2-A", entryId: "E-C001", group: "A", judgeId: "J2", value: 85, basedOnMaterialVersion: 1 });
  await svc.submitScore({ scoreId: "S-J2-C002", assignmentId: "ASG-J2-A", entryId: "E-C002", group: "A", judgeId: "J2", value: 82, basedOnMaterialVersion: 1 });
  await svc.submitScore({ scoreId: "S-J3-C001", assignmentId: "ASG-J3-B", entryId: "E-C001", group: "B", judgeId: "J3", value: 90, basedOnMaterialVersion: 1 });
  await svc.submitScore({ scoreId: "S-J3-C003", assignmentId: "ASG-J3-B", entryId: "E-C003", group: "B", judgeId: "J3", value: 84, basedOnMaterialVersion: 1 });
  // 资格：A 组下结论，B 组复用同一结论。
  await svc.concludeQualification({ entryId: "E-C001", group: "A", conclusion: "ELIGIBLE", basisMaterialVersion: 1, concludedBy: "资格审查员-Q1", approvedBy: "资格批准人-Q2" });
  await svc.concludeQualification({ entryId: "E-C001", group: "B", conclusion: "ELIGIBLE", basisMaterialVersion: 1, concludedBy: "资格审查员-Q1", approvedBy: "资格批准人-Q2", reusedFromGroup: "A" });
  await svc.concludeQualification({ entryId: "E-C002", group: "A", conclusion: "ELIGIBLE", basisMaterialVersion: 1, concludedBy: "Q1", approvedBy: "Q2" });
  await svc.concludeQualification({ entryId: "E-C003", group: "B", conclusion: "ELIGIBLE", basisMaterialVersion: 1, concludedBy: "Q1", approvedBy: "Q2" });

  section("三、迟到利益关系：暂停受影响评分，不删除原记录");
  tick(60);
  await svc.receiveLateInterest({
    entryId: "E-C001", interestId: "INT-LATE-01", judgeId: "J1",
    reason: "初评后收到新材料：候选人 C001 与评委 J1 曾在同机构共同任职",
  });
  show("S-J1-C001 反查（应为 SUSPENDED、不计入排名、原事件仍在）", svc.explainScore("S-J1-C001"));
  show("S-J1-C002 反查（不受影响，仍 ACTIVE）", svc.explainScore("S-J1-C002"));

  section("四、服务重启：重放事件日志后按原截止时间继续");
  const store2 = new EventStore(storePath);
  await store2.load();
  svc = new ReviewService(store2, { now: () => clock.toISOString() });
  show("重启后 A 组截止时间不变", svc.getTimeline("A"));
  show("重启后暂停状态仍在", svc.explainScore("S-J1-C001").effectiveStatus);

  section("五、回避确认与不同机构批准替补，原评委看不到替补意见");
  tick(30);
  await svc.confirmRecusal({ assignmentId: "ASG-J1-A", reason: `迟到关系 INT-LATE-01 成立，评委 J1 对 C001 回避`, declaredAt: clock.toISOString() });
  await svc.approveSubstitute({
    substituteAssignmentId: "ASG-S1-A", originalAssignmentId: "ASG-J1-A",
    substituteJudgeId: "S1", substituteOrg: "乙晚报",
    approverOrg: "丙评审委员会", approverId: "ADMIN-1",
    note: "替补内部意见：建议关注候选人选题独立性（对原评委 J1 不可见）",
  });
  tick(15);
  await svc.submitScore({ scoreId: "S-S1-C001", assignmentId: "ASG-S1-A", entryId: "E-C001", group: "A", judgeId: "S1", value: 76, basedOnMaterialVersion: 1 });
  show("原评委 J1 查看替补意见（应为 null）", svc.substituteView("ASG-S1-A", "J1"));
  show("秘书处查看替补意见（可见）", svc.substituteView("ASG-S1-A", "SEC-01"));
  try {
    await svc.submitScore({ scoreId: "S-X", assignmentId: "ASG-J3-B", entryId: "E-C001", group: "A", judgeId: "J3", value: 50, basedOnMaterialVersion: 1 });
  } catch (err) {
    if (err instanceof ReviewError) show("跨组评分被拒（评分严格隔离）", err.message);
    else throw err;
  }

  section("六、两个组别独立排序、双角色签署、同时裁决公布");
  show("A 组排名", svc.computeRanking("A"));
  show("B 组排名（与 A 组独立，资格结论复用）", svc.computeRanking("B"));
  const decisionA = "DEC-A-001";
  const decisionB = "DEC-B-001";
  await svc.signDecision({ decisionId: decisionA, group: "A", signerId: "LEAD-A", signerRole: "评审组长" });
  await svc.signDecision({ decisionId: decisionB, group: "B", signerId: "LEAD-B", signerRole: "评审组长" });
  await svc.signDecision({ decisionId: decisionA, group: "A", signerId: "AUD-1", signerRole: "监审委员" });
  await svc.signDecision({ decisionId: decisionB, group: "B", signerId: "AUD-2", signerRole: "监审委员" });
  await svc.finalizeDecision({ decisionId: decisionA, group: "A" });
  await svc.finalizeDecision({ decisionId: decisionB, group: "B" });
  show("A 组当前公布序列", svc.currentPublishedRanking("A"));
  show("B 组当前公布序列", svc.currentPublishedRanking("B"));
  try {
    await svc.signDecision({ decisionId: decisionA, group: "A", signerId: "X", signerRole: "第三角色" });
  } catch (err) {
    if (err instanceof ReviewError) show("公布后再签署被拒（只能追加更正）", err.message);
    else throw err;
  }

  section("七、申诉指向具体材料版本 → 双签重新评分 → 追加更正公布");
  tick(40);
  await svc.submitMaterial({ entryId: "E-C001", materialVersion: 2, title: "代表作品补充版" });
  await svc.confirmIncident({ incidentId: "INC-01", group: "A", entryId: "E-C001", kind: "材料启封程序", detail: "v2 材料在监督下标封启封" });
  tick(10);
  await svc.fileAppeal({
    appealId: "APL-001", entryId: "E-C001", group: "A",
    targetKind: "MATERIAL_VERSION", materialVersion: 2,
    reason: "v2 补充材料足以反映作品完整面貌，替补评分 76 明显偏低",
    filedAt: clock.toISOString(),
  });
  await svc.proposeRescore({ appealId: "APL-001", oldScoreIds: ["S-S1-C001"], proposedValues: [91], materialVersion: 2, proposedBy: "LEAD-A", reason: "复核 v2 后调整为 91" });
  await svc.addRescoreSignature({ appealId: "APL-001", signerId: "LEAD-A", signerRole: "评审组长" });
  try {
    await svc.addRescoreSignature({ appealId: "APL-001", signerId: "LEAD-A", signerRole: "监审委员" });
  } catch (err) {
    if (err instanceof ReviewError) show("同一人换角色重复签署被拒", err.message);
    else throw err;
  }
  await svc.addRescoreSignature({ appealId: "APL-001", signerId: "AUD-1", signerRole: "监审委员" });
  show("原替补评分 S-S1-C001 反查（应为 REPLACED）", svc.explainScore("S-S1-C001"));
  await svc.proposeCorrection({ group: "A", reason: "申诉 APL-001 重新评分后名次变化，追加更正", appealId: "APL-001", proposedBy: "LEAD-A" });
  await svc.addCorrectionSignature({ group: "A", correctionRound: 1, signerId: "LEAD-A", signerRole: "评审组长" });
  await svc.addCorrectionSignature({ group: "A", correctionRound: 1, signerId: "AUD-1", signerRole: "监审委员" });
  show("A 组裁决视图（原公布保留 + 一次追加更正）", svc.getDecisionView("A"));
  show("A 组最终序列（更正后）", svc.currentPublishedRanking("A"));
  show("B 组不受 A 组申诉影响", svc.currentPublishedRanking("B"));

  section("完成");
  console.log(`事件日志（只追加）：${storePath}`);
  console.log(`事件总数：${store2.events.length}`);
}

run().catch((err) => {
  console.error("演示失败：", err);
  process.exitCode = 1;
});
