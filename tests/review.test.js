import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStore } from "../src/store.js";
import { ReviewError, ReviewService } from "../src/review.js";
import { validateEvent } from "../src/validator.js";

/** 构造一个内存（可选落盘）服务，时钟可手动推进。 */
function makeHarness({ file = null, start = "2026-09-20T09:00:00+08:00" } = {}) {
  const store = new EventStore(file);
  let clock = new Date(start);
  const svc = new ReviewService(store, { now: () => new Date(clock).toISOString() });
  return {
    store,
    svc,
    tick: (minutes) => { clock = new Date(clock.getTime() + minutes * 60_000); return new Date(clock).toISOString(); },
    setClock: (iso) => { clock = new Date(iso); },
    clock: () => new Date(clock).toISOString(),
  };
}

async function seedBase(h, { groups = ["A", "B"], entryId = "E1", candidateId = "C1", qualify = true } = {}) {
  const { svc } = h;
  await svc.acceptEntry({ entryId, candidateId, name: "候选人", groups, primaryGroup: groups[0] });
  await svc.submitMaterial({ entryId, materialVersion: 1 });
  await svc.setTimeline({ group: "A", recusalDeadline: "2026-09-25T18:00:00+08:00", appealDeadline: "2026-09-30T18:00:00+08:00" });
  await svc.setTimeline({ group: "B", recusalDeadline: "2026-09-25T18:00:00+08:00", appealDeadline: "2026-09-30T18:00:00+08:00" });
  if (qualify) {
    for (const g of groups) {
      await svc.concludeQualification({
        entryId, group: g, conclusion: "ELIGIBLE", basisMaterialVersion: 1,
        concludedBy: "Q1", approvedBy: "Q2", ...(g !== groups[0] ? { reusedFromGroup: groups[0] } : {}),
      });
    }
  }
}

async function rejects(promise, messageIncludes) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ReviewError, `应为 ReviewError，实际 ${err?.constructor?.name}`);
    if (messageIncludes) assert.ok(err.message.includes(messageIncludes), `错误信息应包含「${messageIncludes}」，实际：${err.message}`);
    return true;
  });
}

/* ============ 材料版本与资格结论 ============ */

test("材料按版本保存，版本不可覆盖；资格结论可跨组复用", async () => {
  const h = makeHarness();
  await seedBase(h);
  await rejects(h.svc.submitMaterial({ entryId: "E1", materialVersion: 1 }), "版本已存在");
  await h.svc.submitMaterial({ entryId: "E1", materialVersion: 2 });

  const qB = h.svc.qualificationOf("E1", "B");
  assert.equal(qB.conclusion, "ELIGIBLE");
  assert.equal(qB.reused_from_group, "A");

  // 结论或依据不一致时不能冒用复用。
  await rejects(h.svc.concludeQualification({
    entryId: "E1", group: "B", conclusion: "INELIGIBLE", basisMaterialVersion: 1,
    concludedBy: "Q1", approvedBy: "Q2", reusedFromGroup: "A",
  }), "不一致");
});

test("不合格资格结论使该组评分排除，但不影响另一组", async () => {
  const h = makeHarness();
  await h.svc.acceptEntry({ entryId: "E1", candidateId: "C1", groups: ["A", "B"], primaryGroup: "A" });
  await h.svc.submitMaterial({ entryId: "E1", materialVersion: 1 });
  await h.svc.setTimeline({ group: "A", recusalDeadline: "2026-09-25T18:00:00+08:00", appealDeadline: "2026-09-30T18:00:00+08:00" });
  await h.svc.setTimeline({ group: "B", recusalDeadline: "2026-09-25T18:00:00+08:00", appealDeadline: "2026-09-30T18:00:00+08:00" });
  await h.svc.concludeQualification({ entryId: "E1", group: "A", conclusion: "ELIGIBLE", basisMaterialVersion: 1, concludedBy: "Q1", approvedBy: "Q2" });
  await h.svc.concludeQualification({ entryId: "E1", group: "B", conclusion: "INELIGIBLE", basisMaterialVersion: 1, concludedBy: "Q1", approvedBy: "Q2" });
  await h.svc.assignJudge({ assignmentId: "G1", group: "A", judgeId: "J1", judgeOrg: "甲社" });
  await h.svc.assignJudge({ assignmentId: "G2", group: "B", judgeId: "J2", judgeOrg: "乙社" });
  await h.svc.submitScore({ scoreId: "S1", assignmentId: "G1", entryId: "E1", group: "A", judgeId: "J1", value: 90, basedOnMaterialVersion: 1 });
  await h.svc.submitScore({ scoreId: "S2", assignmentId: "G2", entryId: "E1", group: "B", judgeId: "J2", value: 90, basedOnMaterialVersion: 1 });

  assert.equal(h.svc.computeRanking("A").length, 1);
  assert.equal(h.svc.computeRanking("B").length, 0);
  assert.equal(h.svc.explainScore("S2").countedInRanking, false);
  assert.equal(h.svc.explainScore("S2").effectiveStatus, "EXCLUDED");
});

/* ============ 冻结、迟到关系、暂停 ============ */

test("受派时只冻结当时已申报关系；迟到关系暂停受影响评分且保留原记录", async () => {
  const h = makeHarness();
  await seedBase(h, { groups: ["A"] });
  await h.svc.declareInterest({ entryId: "E1", interestId: "I-OLD", judgeId: "J9", reason: "旧关系（与本次评委无关）" });
  await h.svc.assignJudge({ assignmentId: "G1", group: "A", judgeId: "J1", judgeOrg: "甲社" });

  const frozen = h.store.events.find((e) => e.event_type === "ASSIGNMENT_FROZEN");
  assert.deepEqual(frozen.payload.frozen_interest_ids, []);

  await h.svc.submitScore({ scoreId: "S1", assignmentId: "G1", entryId: "E1", group: "A", judgeId: "J1", value: 80, basedOnMaterialVersion: 1 });
  assert.equal(h.svc.explainScore("S1").countedInRanking, true);

  h.tick(30);
  await h.svc.receiveLateInterest({ entryId: "E1", interestId: "I-LATE", judgeId: "J1", reason: "初评后发现共同任职" });

  const explanation = h.svc.explainScore("S1");
  assert.equal(explanation.effectiveStatus, "SUSPENDED");
  assert.equal(explanation.countedInRanking, false);
  assert.ok(explanation.reasons[0].includes("I-LATE"));
  // 原 SCORE_SUBMITTED 仍在事件流中，SCORE_SUSPENDED 是追加记录。
  const types = h.store.events.map((e) => e.event_type);
  assert.ok(types.includes("SCORE_SUBMITTED"));
  assert.ok(types.includes("SCORE_SUSPENDED"));
  assert.equal(h.svc.computeRanking("A").length, 0);

  // 迟到关系后原评委不能再对该候选人评分。
  await rejects(h.svc.submitScore({ scoreId: "S2", assignmentId: "G1", entryId: "E1", group: "A", judgeId: "J1", value: 70, basedOnMaterialVersion: 1 }), "评分通道已关闭");
});

test("迟到关系只暂停对应评委与候选人的评分，其他评分不受影响", async () => {
  const h = makeHarness();
  await seedBase(h, { groups: ["A"], entryId: "E1", candidateId: "C1" });
  await h.svc.acceptEntry({ entryId: "E2", candidateId: "C2", groups: ["A"] });
  await h.svc.submitMaterial({ entryId: "E2", materialVersion: 1 });
  await h.svc.concludeQualification({ entryId: "E2", group: "A", conclusion: "ELIGIBLE", basisMaterialVersion: 1, concludedBy: "Q1", approvedBy: "Q2" });
  await h.svc.assignJudge({ assignmentId: "G1", group: "A", judgeId: "J1", judgeOrg: "甲社" });
  await h.svc.submitScore({ scoreId: "S-E1", assignmentId: "G1", entryId: "E1", group: "A", judgeId: "J1", value: 80, basedOnMaterialVersion: 1 });
  await h.svc.submitScore({ scoreId: "S-E2", assignmentId: "G1", entryId: "E2", group: "A", judgeId: "J1", value: 88, basedOnMaterialVersion: 1 });

  await h.svc.receiveLateInterest({ entryId: "E1", interestId: "I1", judgeId: "J1", reason: "仅与 C1 相关" });
  assert.equal(h.svc.explainScore("S-E1").effectiveStatus, "SUSPENDED");
  assert.equal(h.svc.explainScore("S-E2").effectiveStatus, "ACTIVE");
  assert.deepEqual(h.svc.computeRanking("A").map((r) => r.entryId), ["E2"]);
});

/* ============ 回避与替补 ============ */

test("替补由不同机构批准；原评委看不到替补意见", async () => {
  const h = makeHarness();
  await seedBase(h, { groups: ["A"] });
  await h.svc.assignJudge({ assignmentId: "G1", group: "A", judgeId: "J1", judgeOrg: "甲社" });
  await h.svc.submitScore({ scoreId: "S1", assignmentId: "G1", entryId: "E1", group: "A", judgeId: "J1", value: 80, basedOnMaterialVersion: 1 });
  await h.svc.receiveLateInterest({ entryId: "E1", interestId: "I1", judgeId: "J1", reason: "共同任职" });
  await h.svc.confirmRecusal({ assignmentId: "G1", reason: "回避" });

  // 原机构不能批准。
  await rejects(h.svc.approveSubstitute({
    substituteAssignmentId: "G2", originalAssignmentId: "G1",
    substituteJudgeId: "S1", substituteOrg: "乙社", approverOrg: "甲社", approverId: "A1",
  }), "不同于原评委所属机构");

  await h.svc.approveSubstitute({
    substituteAssignmentId: "G2", originalAssignmentId: "G1",
    substituteJudgeId: "S1", substituteOrg: "乙社", approverOrg: "丙委员会", approverId: "A1",
    note: "内部意见",
  });
  assert.equal(h.svc.substituteView("G2", "J1"), null);
  assert.equal(h.svc.substituteView("G2", "SEC")?.note, "内部意见");

  // 替补接管评分。
  await h.svc.submitScore({ scoreId: "S2", assignmentId: "G2", entryId: "E1", group: "A", judgeId: "S1", value: 76, basedOnMaterialVersion: 1 });
  const ranking = h.svc.computeRanking("A");
  assert.equal(ranking[0].averageScore, 76);
});

test("超过回避截止时间不能确认回避；恢复后仍按原截止时间", async () => {
  const file = join(tmpdir(), `review-deadline-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const h = makeHarness({ file });
  await seedBase(h, { groups: ["A"] });
  await h.svc.assignJudge({ assignmentId: "G1", group: "A", judgeId: "J1", judgeOrg: "甲社" });

  // 重启：从文件重放。
  const store2 = new EventStore(file);
  await store2.load();
  const svc2 = new ReviewService(store2);
  assert.equal(svc2.getTimeline("A").recusalDeadline, "2026-09-25T18:00:00+08:00");
  await rejects(svc2.confirmRecusal({
    assignmentId: "G1", reason: "迟到的回避", declaredAt: "2026-09-26T09:00:00+08:00",
  }), "截止时间");
});

/* ============ 评分隔离 ============ */

test("评分严格按组隔离：受派组别与评分组别不符即拒绝", async () => {
  const h = makeHarness();
  await seedBase(h, { groups: ["A", "B"] });
  await h.svc.assignJudge({ assignmentId: "G1", group: "A", judgeId: "J1", judgeOrg: "甲社" });
  await rejects(h.svc.submitScore({
    scoreId: "S1", assignmentId: "G1", entryId: "E1", group: "B", judgeId: "J1", value: 90, basedOnMaterialVersion: 1,
  }), "跨组");
});

/* ============ 申诉与重新评分双签 ============ */

test("申诉必须指向具体材料版本或程序事件；重新评分需两名不同角色签署", async () => {
  const h = makeHarness();
  await seedBase(h, { groups: ["A"] });
  await h.svc.assignJudge({ assignmentId: "G1", group: "A", judgeId: "J1", judgeOrg: "甲社" });
  await h.svc.submitScore({ scoreId: "S1", assignmentId: "G1", entryId: "E1", group: "A", judgeId: "J1", value: 70, basedOnMaterialVersion: 1 });

  await rejects(h.svc.fileAppeal({
    appealId: "AP1", entryId: "E1", group: "A", targetKind: "MATERIAL_VERSION", reason: "不服",
  }), "materialVersion");
  await rejects(h.svc.fileAppeal({
    appealId: "AP1", entryId: "E1", group: "A", targetKind: "MATERIAL_VERSION", materialVersion: 9, reason: "不服",
  }), "材料版本不存在");
  await rejects(h.svc.fileAppeal({
    appealId: "AP1", entryId: "E1", group: "A", targetKind: "INCIDENT", incidentId: "NOPE", reason: "不服",
  }), "程序事件不存在");

  await h.svc.confirmIncident({ incidentId: "INC1", group: "A", entryId: "E1", kind: "启封", detail: "监督启封" });
  await h.svc.fileAppeal({ appealId: "AP1", entryId: "E1", group: "A", targetKind: "INCIDENT", incidentId: "INC1", reason: "程序异议" });
  await rejects(h.svc.proposeRescore({ appealId: "AP1", oldScoreIds: [], proposedValues: [], materialVersion: 1, proposedBy: "X" }), "被替代的原评分");
  await h.svc.proposeRescore({ appealId: "AP1", oldScoreIds: ["S1"], proposedValues: [91], materialVersion: 1, proposedBy: "LEAD" });

  await h.svc.addRescoreSignature({ appealId: "AP1", signerId: "LEAD", signerRole: "评审组长" });
  // 未达两签时旧评分仍有效。
  assert.equal(h.svc.explainScore("S1").effectiveStatus, "ACTIVE");
  // 同一人不能换角色签第二次。
  await rejects(h.svc.addRescoreSignature({ appealId: "AP1", signerId: "LEAD", signerRole: "监审委员" }), "同一签署人");
  // 同角色不能重复签。
  await rejects(h.svc.addRescoreSignature({ appealId: "AP1", signerId: "LEAD2", signerRole: "评审组长" }), "角色不同");

  await h.svc.addRescoreSignature({ appealId: "AP1", signerId: "AUD", signerRole: "监审委员" });
  assert.equal(h.svc.explainScore("S1").effectiveStatus, "REPLACED");
  const newId = h.svc.explainScore("S1").eventTrail.length; // trail 含提交与重评事件
  assert.ok(newId >= 2);
  assert.equal(h.svc.computeRanking("A")[0].averageScore, 91);
});

test("超过申诉截止时间不能提出申诉", async () => {
  const h = makeHarness();
  await seedBase(h, { groups: ["A"] });
  await rejects(h.svc.fileAppeal({
    appealId: "AP1", entryId: "E1", group: "A",
    targetKind: "MATERIAL_VERSION", materialVersion: 1, reason: "逾期",
    filedAt: "2026-10-01T09:00:00+08:00",
  }), "申诉截止时间");
});

/* ============ 裁决双签与追加更正 ============ */

test("裁决需两名不同角色签署；公布后只能追加更正，最终序列随之变化", async () => {
  const h = makeHarness();
  await seedBase(h, { groups: ["A"] });
  await h.svc.assignJudge({ assignmentId: "G1", group: "A", judgeId: "J1", judgeOrg: "甲社" });
  await h.svc.submitScore({ scoreId: "S1", assignmentId: "G1", entryId: "E1", group: "A", judgeId: "J1", value: 70, basedOnMaterialVersion: 1 });

  await rejects(h.svc.finalizeDecision({ decisionId: "D1", group: "A" }), "两名不同角色");
  await h.svc.signDecision({ decisionId: "D1", group: "A", signerId: "LEAD", signerRole: "评审组长" });
  await rejects(h.svc.signDecision({ decisionId: "D1", group: "A", signerId: "LEAD", signerRole: "监审委员" }), "同一签署人");
  await h.svc.signDecision({ decisionId: "D1", group: "A", signerId: "AUD", signerRole: "监审委员" });
  await h.svc.finalizeDecision({ decisionId: "D1", group: "A" });
  assert.equal(h.svc.currentPublishedRanking("A").source, "DECISION");

  // 未公布的决定谈不上更正。（这里已公布，直接验证更正流程）
  await rejects(h.svc.addCorrectionSignature({ group: "A", correctionRound: 9, signerId: "X", signerRole: "评审组长" }), "更正提案不存在");

  // 申诉 → 重评 → 追加更正。
  await h.svc.submitMaterial({ entryId: "E1", materialVersion: 2 });
  await h.svc.fileAppeal({ appealId: "AP1", entryId: "E1", group: "A", targetKind: "MATERIAL_VERSION", materialVersion: 2, reason: "新材料" });
  await h.svc.proposeRescore({ appealId: "AP1", oldScoreIds: ["S1"], proposedValues: [95], materialVersion: 2, proposedBy: "LEAD" });
  await h.svc.addRescoreSignature({ appealId: "AP1", signerId: "LEAD", signerRole: "评审组长" });
  await h.svc.addRescoreSignature({ appealId: "AP1", signerId: "AUD", signerRole: "监审委员" });

  await rejects(h.svc.proposeCorrection({ group: "A", reason: "无依据", appealId: "NO-SUCH", proposedBy: "LEAD" }), "申诉不存在");
  await h.svc.proposeCorrection({ group: "A", reason: "AP1 改分", appealId: "AP1", proposedBy: "LEAD" });
  await h.svc.addCorrectionSignature({ group: "A", correctionRound: 1, signerId: "LEAD", signerRole: "评审组长" });
  await h.svc.addCorrectionSignature({ group: "A", correctionRound: 1, signerId: "AUD", signerRole: "监审委员" });

  const published = h.svc.currentPublishedRanking("A");
  assert.equal(published.source, "CORRECTION#1");
  assert.equal(published.ranking[0].averageScore, 95);
  // 原公布与更正都作为事件保留。
  const correctionEvents = h.store.events.filter((e) => e.event_type === "CORRECTION_PUBLISHED");
  const finalizedEvents = h.store.events.filter((e) => e.event_type === "DECISION_FINALIZED");
  assert.equal(correctionEvents.length, 1);
  assert.equal(finalizedEvents.length, 1);
});

test("两组同时裁决互不干扰：A 组申诉更正不改变 B 组序列", async () => {
  const h = makeHarness();
  await seedBase(h, { groups: ["A", "B"] });
  await h.svc.assignJudge({ assignmentId: "GA", group: "A", judgeId: "JA", judgeOrg: "甲社" });
  await h.svc.assignJudge({ assignmentId: "GB", group: "B", judgeId: "JB", judgeOrg: "乙社" });
  await h.svc.submitScore({ scoreId: "SA", assignmentId: "GA", entryId: "E1", group: "A", judgeId: "JA", value: 70, basedOnMaterialVersion: 1 });
  await h.svc.submitScore({ scoreId: "SB", assignmentId: "GB", entryId: "E1", group: "B", judgeId: "JB", value: 72, basedOnMaterialVersion: 1 });

  for (const [decisionId, group, lead, aud] of [
    ["DA", "A", "LA", "AA"],
    ["DB", "B", "LB", "AB"],
  ]) {
    await h.svc.signDecision({ decisionId, group, signerId: lead, signerRole: "评审组长" });
    await h.svc.signDecision({ decisionId, group, signerId: aud, signerRole: "监审委员" });
    await h.svc.finalizeDecision({ decisionId, group });
  }
  assert.equal(h.svc.currentPublishedRanking("B").ranking[0].averageScore, 72);

  await h.svc.submitMaterial({ entryId: "E1", materialVersion: 2 });
  await h.svc.fileAppeal({ appealId: "AP1", entryId: "E1", group: "A", targetKind: "MATERIAL_VERSION", materialVersion: 2, reason: "x" });
  await h.svc.proposeRescore({ appealId: "AP1", oldScoreIds: ["SA"], proposedValues: [99], materialVersion: 2, proposedBy: "LA" });
  await h.svc.addRescoreSignature({ appealId: "AP1", signerId: "LA", signerRole: "评审组长" });
  await h.svc.addRescoreSignature({ appealId: "AP1", signerId: "AA", signerRole: "监审委员" });
  await h.svc.proposeCorrection({ group: "A", reason: "改", appealId: "AP1", proposedBy: "LA" });
  await h.svc.addCorrectionSignature({ group: "A", correctionRound: 1, signerId: "LA", signerRole: "评审组长" });
  await h.svc.addCorrectionSignature({ group: "A", correctionRound: 1, signerId: "AA", signerRole: "监审委员" });

  assert.equal(h.svc.currentPublishedRanking("A").ranking[0].averageScore, 99);
  assert.equal(h.svc.currentPublishedRanking("B").ranking[0].averageScore, 72);
});

/* ============ 幂等 ============ */

test("完全相同的重复请求返回原结果；同编号异内容被拒绝", async () => {
  const h = makeHarness();
  const body = { entryId: "E1", candidateId: "C1", groups: ["A"] };
  const r1 = await h.svc.acceptEntry(body, "REQ-1");
  const r2 = await h.svc.acceptEntry(JSON.parse(JSON.stringify(body)), "REQ-1");
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.deepEqual(r1.events.map((e) => e.event_id), r2.events.map((e) => e.event_id));
  const countAfterDup = h.store.events.length;

  await rejects(h.svc.acceptEntry({ entryId: "E2", candidateId: "C2", groups: ["A"] }, "REQ-1"), "请求编号冲突");
  assert.equal(h.store.events.length, countAfterDup);
});

/* ============ 恢复 ============ */

test("恢复后重放事件日志，暂停/裁决/请求登记全部保留", async () => {
  const file = join(tmpdir(), `review-restore-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const h = makeHarness({ file });
  await seedBase(h, { groups: ["A"] });
  await h.svc.assignJudge({ assignmentId: "G1", group: "A", judgeId: "J1", judgeOrg: "甲社" });
  await h.svc.submitScore({ scoreId: "S1", assignmentId: "G1", entryId: "E1", group: "A", judgeId: "J1", value: 80, basedOnMaterialVersion: 1 }, "REQ-SCORE");
  await h.svc.receiveLateInterest({ entryId: "E1", interestId: "I1", judgeId: "J1", reason: "共同任职" });

  const store2 = new EventStore(file);
  await store2.load();
  const svc2 = new ReviewService(store2);
  assert.equal(svc2.explainScore("S1").effectiveStatus, "SUSPENDED");
  assert.ok(svc2.getRequestStatus("REQ-SCORE"));
  // 重复请求在恢复后仍被识别。
  const dup = await svc2.submitScore({ scoreId: "S1", assignmentId: "G1", entryId: "E1", group: "A", judgeId: "J1", value: 80, basedOnMaterialVersion: 1 }, "REQ-SCORE");
  assert.equal(dup.duplicate, true);
});

/* ============ 信封兼容 ============ */

test("服务产生的事件仍满足基础信封校验", async () => {
  const h = makeHarness();
  await seedBase(h, { groups: ["A"] });
  for (const event of h.store.events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_type} 缺少信封字段`);
  }
});
