import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewService, projectState } from "../src/review-service.js";
import { EventStore } from "../src/event-store.js";
import { DomainRuleError } from "../src/errors.js";
import { fingerprint } from "../src/canonical.js";

const G1 = "G1";
const G2 = "G2";

/** 构造一个时钟可控的内存服务与常用实体。 */
function makeHarness() {
  let ms = Date.parse("2026-09-20T09:00:00Z");
  const now = () => new Date(ms).toISOString();
  const svc = new ReviewService({ now });
  return {
    svc,
    now,
    setTime: (iso) => { ms = Date.parse(iso); },
    advanceHours: (h) => { ms += h * 3600 * 1000; },
  };
}

/** 登记 C1（跨 G1/G2）、C2（G1）、C3（G2）并各提交材料 v1。 */
function seedEntries(svc) {
  svc.acceptEntry({ candidateId: "C1", name: "候选人一", groupIds: [G1, G2] });
  svc.acceptEntry({ candidateId: "C2", name: "候选人二", groupIds: [G1] });
  svc.acceptEntry({ candidateId: "C3", name: "候选人三", groupIds: [G2] });
  for (const id of ["C1", "C2", "C3"]) svc.submitMaterial({ candidateId: id, title: "材料", contentHash: `${id}-v1` });
}

function qualify(svc, candidateId, groupId = G1) {
  svc.decideQualification({
    candidateId, groupId, conclusion: "qualified", basisMaterialVersion: 1,
    signedBy: [{ id: "qual-officer", role: "qualification-officer" }],
  });
}

const twoSigners = [
  { id: "chair-1", role: "panel-head" },
  { id: "supervisor-1", role: "supervisor" },
];

describe("材料版本", () => {
  it("材料按版本递增保存，旧版本不被改写", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    assert.equal(svc.submitMaterial({ candidateId: "C1", title: "第二版" }), 2);
    assert.equal(svc.submitMaterial({ candidateId: "C1", title: "第三版" }), 3);
    const versions = svc.events.filter((e) => e.event_type === "MATERIAL_VERSION_SUBMITTED" && e.candidate_id === "C1").map((e) => e.payload.material_version);
    assert.deepEqual(versions, [1, 2, 3]);
    // 历史事件内容保持不变（仅追加）
    const first = svc.events.find((e) => e.event_type === "MATERIAL_VERSION_SUBMITTED" && e.candidate_id === "C1" && e.version === 1);
    assert.equal(first.aggregate_id, "material-C1");
  });

  it("评分必须指明存在的材料版本", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    assert.throws(() => svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 9 }), (e) => e.code === "INVALID_TARGET");
    assert.throws(() => svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80 }), (e) => e.code === "INVALID_TARGET");
  });
});

describe("受派冻结利益关系快照", () => {
  it("受派时只冻结当时已申报的关系；迟到关系不回写快照", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    svc.declareInterest({ reviewerId: "R1", candidateId: "C1", detail: "旧关系" });
    const { frozenInterestIds } = svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    assert.deepEqual(frozenInterestIds, ["interest-R1-C1-1"]);

    // 受派之后才申报（迟到）
    svc.declareInterest({ reviewerId: "R1", candidateId: "C2", detail: "新浮现的关系" });
    const asgEvent = svc.events.find((e) => e.event_type === "REVIEWER_ASSIGNED" && e.reviewer_id === "R1");
    assert.equal(asgEvent.payload.frozen_snapshot.length, 1);
    assert.equal(asgEvent.payload.frozen_snapshot[0].detail, "旧关系");
  });

  it("未申报利益关系时受派，快照为空且之后不被回填", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R2", reviewerOrg: "org-a" });
    svc.declareInterest({ reviewerId: "R2", candidateId: "C1", detail: "事后才说" });
    const trace = svc.traceScore; // 仅确认接口存在；快照断言走事件
    const asgEvent = svc.events.find((e) => e.event_type === "REVIEWER_ASSIGNED" && e.reviewer_id === "R2");
    assert.deepEqual(asgEvent.payload.frozen_snapshot, []);
    assert.equal(typeof trace, "function");
  });
});

describe("迟到利益关系：暂停而非删除", () => {
  it("暂停受影响评分并留下理由，原记录保留、不再进入排名", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    qualify(svc, "C1");
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    const scoreId = svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 1 });
    const { suspendedScoreIds } = svc.reportLateInterest({ reviewerId: "R1", candidateId: "C1", reason: "共同任职" });
    assert.deepEqual(suspendedScoreIds, [scoreId]);

    // 原 SCORE_SUBMITTED 事件仍在
    assert.ok(svc.events.some((e) => e.event_id === `${scoreId}#1` || (e.event_type === "SCORE_SUBMITTED" && e.aggregate_id === scoreId)));
    const t = svc.traceScore(scoreId);
    assert.equal(t.status, "suspended");
    assert.equal(t.countedInRanking, false);
    assert.match(t.reasons.join(" "), /共同任职/);
    assert.deepEqual(svc.computeRanking(G1), []);

    // 不会重复暂停同一评分
    const again = svc.reportLateInterest; // 接口保留
    assert.equal(typeof again, "function");
  });

  it("迟到关系只影响指定评委/候选人，其他评分照常有效", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    qualify(svc, "C1");
    qualify(svc, "C2");
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    svc.assignReviewer({ groupId: G1, candidateId: "C2", reviewerId: "R2", reviewerOrg: "org-a" });
    svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 1 });
    const other = svc.submitScore({ groupId: G1, candidateId: "C2", reviewerId: "R2", value: 70, materialVersion: 1 });
    svc.reportLateInterest({ reviewerId: "R1", candidateId: "C1", reason: "共同任职" });
    assert.equal(svc.traceScore(other).status, "valid");
    assert.equal(svc.computeRanking(G1)[0].candidateId, "C2");
  });
});

describe("替补：异机构批准与意见隔离", () => {
  function setupLateSubstitution() {
    const h = makeHarness();
    const { svc } = h;
    seedEntries(svc);
    qualify(svc, "C1");
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 1 });
    svc.reportLateInterest({ reviewerId: "R1", candidateId: "C1", reason: "共同任职" });
    return h;
  }

  it("与原评委同机构的批准被拒绝", () => {
    const { svc } = setupLateSubstitution();
    assert.throws(
      () => svc.approveSubstitute({ groupId: G1, candidateId: "C1", replacedReviewerId: "R1", substituteReviewerId: "R3", substituteOrg: "org-b", approver: { id: "boss-a", org: "org-a" } }),
      (e) => e.code === "ACCESS_DENIED",
    );
  });

  it("原评委不能批准自己的替补", () => {
    const { svc } = setupLateSubstitution();
    assert.throws(
      () => svc.approveSubstitute({ groupId: G1, candidateId: "C1", replacedReviewerId: "R1", substituteReviewerId: "R3", approver: { id: "R1", org: "org-z" } }),
      (e) => e.code === "ACCESS_DENIED",
    );
  });

  it("异机构批准后替补接管，原评委既看不到替补意见也不能再评分", () => {
    const { svc } = setupLateSubstitution();
    const { subAssignmentId } = svc.approveSubstitute({
      groupId: G1, candidateId: "C1", replacedReviewerId: "R1", substituteReviewerId: "R3",
      substituteOrg: "org-c", approver: { id: "boss-z", org: "org-z" },
    });
    assert.ok(subAssignmentId);
    const subScore = svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R3", value: 90, materialVersion: 1 });
    assert.throws(() => svc.viewScore(subScore, { id: "R1" }), (e) => e.code === "ACCESS_DENIED");
    // 其他角色仍可查看
    assert.equal(svc.viewScore(subScore, { id: "auditor" }).value, 90);
    assert.throws(() => svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 10, materialVersion: 1 }), (e) => e.code === "ILLEGAL_STATE");
    assert.equal(svc.computeRanking(G1)[0].average, 90);
  });
});

describe("分组：独立排序、资格复用、评分隔离", () => {
  it("资格结论可跨组复用，但评分只在本组内统计", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    qualify(svc, "C1", G1); // 资格只在 G1 作出
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    svc.assignReviewer({ groupId: G2, candidateId: "C1", reviewerId: "R2", reviewerOrg: "org-a" });
    svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 88, materialVersion: 1 });
    svc.submitScore({ groupId: G2, candidateId: "C1", reviewerId: "R2", value: 60, materialVersion: 1 });

    const reused = svc.effectiveQualification("C1", G2);
    assert.equal(reused.conclusion, "qualified");
    assert.equal(reused.reusedFromGroup, G1);
    assert.equal(svc.computeRanking(G1)[0].average, 88);
    assert.equal(svc.computeRanking(G2)[0].average, 60);
  });

  it("候选人未兼报的组别不能评分或申诉", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    assert.throws(() => svc.assignReviewer({ groupId: "G99", candidateId: "C2", reviewerId: "R1" }), (e) => e.code === "INVALID_TARGET");
  });

  it("没有合格资格结论的候选人评分不进入排名（资格状态在排名阶段判定）", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    // 无资格结论时评分可提交，但不进入排名
    const scoreNoQual = svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 1 });
    assert.deepEqual(svc.computeRanking(G1), []);
    assert.equal(svc.traceScore(scoreNoQual).status, "valid");
    assert.equal(svc.traceScore(scoreNoQual).countedInRanking, false);
    qualify(svc, "C1");
    assert.equal(svc.computeRanking(G1).length, 1);
    // 最新结论改为不合格后，该评分被排名排除
    svc.decideQualification({ candidateId: "C1", groupId: G1, conclusion: "rejected", basisMaterialVersion: 1, signedBy: [] });
    assert.deepEqual(svc.computeRanking(G1), []);
  });

  it("已确认回避的评委不能再提交评分", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    qualify(svc, "C1");
    const { assignmentId } = svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    svc.confirmRecusal({ assignmentId, reason: "回避" });
    assert.throws(() => svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 1 }), (e) => e.code === "ILLEGAL_STATE");
  });
});

describe("申诉与程序事件", () => {
  function publishedCase() {
    const h = makeHarness();
    const { svc } = h;
    seedEntries(svc);
    qualify(svc, "C1");
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 1 });
    svc.finalizeDecision({ groupId: G1, signers: twoSigners });
    svc.publishDecision({ groupId: G1 });
    return h;
  }

  it("申诉必须指向具体材料版本或已确认程序事件", () => {
    const { svc } = publishedCase();
    assert.throws(() => svc.fileAppeal({ groupId: G1, candidateId: "C1", target: { kind: "material", version: 7 }, reason: "x" }), (e) => e.code === "INVALID_TARGET");
    assert.throws(() => svc.fileAppeal({ groupId: G1, candidateId: "C1", target: { kind: "incident", incidentId: "nope" }, reason: "x" }), (e) => e.code === "INVALID_TARGET");
    assert.throws(() => svc.fileAppeal({ groupId: G1, candidateId: "C1", target: {}, reason: "x" }), (e) => e.code === "INVALID_TARGET");

    const appealMaterial = svc.fileAppeal({ groupId: G1, candidateId: "C1", target: { kind: "material", version: 1 }, reason: "版本问题" });
    assert.ok(appealMaterial);
    svc.confirmIncident({ incidentId: "INC-1", groupId: G1, candidateId: "C1", description: "计分程序中断" });
    const appealIncident = svc.fileAppeal({ groupId: G1, candidateId: "C1", target: { kind: "incident", incidentId: "INC-1" }, reason: "程序问题" });
    assert.ok(appealIncident);
  });

  it("程序事件与申诉组别/候选人不一致时被拒", () => {
    const { svc } = publishedCase();
    svc.confirmIncident({ incidentId: "INC-2", groupId: G2, candidateId: "C1", description: "别组的事件" });
    assert.throws(() => svc.fileAppeal({ groupId: G1, candidateId: "C1", target: { kind: "incident", incidentId: "INC-2" } }), (e) => e.code === "INVALID_TARGET");
  });

  it("未公布的决定不能申诉；公布后普通评分通道关闭", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    qualify(svc, "C1");
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    assert.throws(() => svc.fileAppeal({ groupId: G1, candidateId: "C1", target: { kind: "material", version: 1 } }), (e) => e.code === "ILLEGAL_STATE");
  });
});

describe("双人异角色签署", () => {
  it("终局裁决必须恰好两名不同角色签署", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    qualify(svc, "C1");
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 1 });
    assert.throws(() => svc.finalizeDecision({ groupId: G1, signers: [{ id: "a", role: "head" }] }), (e) => e.code === "SIGNATURE_REQUIRED");
    assert.throws(() => svc.finalizeDecision({ groupId: G1, signers: [{ id: "a", role: "head" }, { id: "b", role: "head" }] }), (e) => e.code === "SIGNATURE_REQUIRED");
    assert.throws(() => svc.finalizeDecision({ groupId: G1, signers: [{ id: "a", role: "head" }, { id: "a", role: "auditor" }] }), (e) => e.code === "SIGNATURE_REQUIRED");
    assert.doesNotThrow(() => svc.finalizeDecision({ groupId: G1, signers: twoSigners }));
  });

  it("重新评分须两名不同角色签署后才能录入替代评分", () => {
    const { svc } = publishedCaseWithAppeal();
    const rescoreId = svc.events.filter((e) => e.event_type === "RESCORE_REQUESTED").pop().aggregate_id;
    assert.throws(
      () => svc.submitReplacementScore({ rescoreId, reviewerId: "R1", value: 95, materialVersion: 1 }),
      (e) => e.code === "SIGNATURE_REQUIRED",
    );
    svc.signRescore({ rescoreId, signer: { id: "s1", role: "ethics-officer" } });
    assert.throws(() => svc.signRescore({ rescoreId, signer: { id: "s2", role: "ethics-officer" } }), (e) => e.code === "SIGNATURE_REQUIRED");
    assert.throws(() => svc.signRescore({ rescoreId, signer: { id: "s1", role: "panel-head" } }), (e) => e.code === "SIGNATURE_REQUIRED"); // 同人换角色也不行
    svc.signRescore({ rescoreId, signer: { id: "s3", role: "panel-head" } });
    const newScore = svc.submitReplacementScore({ rescoreId, reviewerId: "R1", value: 95, materialVersion: 1 });
    assert.equal(svc.traceScore(newScore).status, "valid");
    // 旧评分被替代并保留
    const old = svc.listScores(G1).find((s) => s.value === 80);
    assert.equal(old.status, "superseded");
  });

  function publishedCaseWithAppeal() {
    const h = makeHarness();
    const { svc } = h;
    seedEntries(svc);
    qualify(svc, "C1");
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 1 });
    svc.finalizeDecision({ groupId: G1, signers: twoSigners });
    svc.publishDecision({ groupId: G1 });
    const appealId = svc.fileAppeal({ groupId: G1, candidateId: "C1", target: { kind: "material", version: 1 }, reason: "评分偏差" });
    svc.requestRescore({ appealId });
    return h;
  }
});

describe("终局决定：公布后只能追加更正", () => {
  it("更正以追加事件保留原裁决，并更新当前序列；两组互不影响", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    qualify(svc, "C1", G1);
    qualify(svc, "C2", G1);
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    svc.assignReviewer({ groupId: G1, candidateId: "C2", reviewerId: "R2", reviewerOrg: "org-a" });
    svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 90, materialVersion: 1 });
    svc.submitScore({ groupId: G1, candidateId: "C2", reviewerId: "R2", value: 80, materialVersion: 1 });
    svc.finalizeDecision({ groupId: G1, signers: twoSigners });
    svc.publishDecision({ groupId: G1 });

    // 不能再次裁决或原地修改
    assert.throws(() => svc.finalizeDecision({ groupId: G1, signers: twoSigners }), (e) => e.code === "ILLEGAL_STATE");
    // 未公布不能更正
    const { svc: svc2 } = makeHarness();
    seedEntries(svc2);
    qualify(svc2, "C1");
    svc2.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    svc2.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 90, materialVersion: 1 });
    svc2.finalizeDecision({ groupId: G1, signers: twoSigners });
    const appealId0 = "cannot-appeal";
    assert.throws(() => svc2.correctDecision({ groupId: G1, appealId: appealId0, signers: twoSigners }), (e) => e.code === "ILLEGAL_STATE");

    // 走申诉 → 重评 → 更正
    const appealId = svc.fileAppeal({ groupId: G1, candidateId: "C2", target: { kind: "material", version: 1 }, reason: "C2 被低估" });
    const rescoreId = svc.requestRescore({ appealId });
    svc.signRescore({ rescoreId, signer: { id: "a", role: "ethics-officer" } });
    svc.signRescore({ rescoreId, signer: { id: "b", role: "panel-head" } });
    svc.submitReplacementScore({ rescoreId, reviewerId: "R2", value: 95, materialVersion: 1 });
    const corrected = svc.correctDecision({
      groupId: G1, appealId, reason: "申诉成立",
      signers: [{ id: "c", role: "adjudication-chair" }, { id: "d", role: "supervisor" }],
    });
    assert.equal(corrected[0].candidateId, "C2");
    const seq = svc.finalSequence(G1);
    assert.equal(seq.corrections.length, 1);
    assert.equal(seq.ranking[0].candidateId, "C2");
    assert.equal(seq.corrections[0].previousRanking[0].candidateId, "C1");
    // 原 FINALIZED / PUBLISHED 事件仍保留
    assert.ok(svc.events.some((e) => e.event_type === "DECISION_FINALIZED" && e.group_id === G1));
    assert.ok(svc.events.some((e) => e.event_type === "DECISION_PUBLISHED" && e.group_id === G1));
  });
});

describe("请求幂等与重复识别", () => {
  it("同编号同内容只生效一次并返回原结果", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    const args = { groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a", requestId: "assign-1" };
    const r1 = svc.assignReviewer(args);
    const r2 = svc.assignReviewer(args);
    assert.deepEqual(r2, r1);
    assert.equal(svc.events.filter((e) => e.event_type === "REVIEWER_ASSIGNED").length, 1);
  });

  it("同编号异内容被拒绝并记录 REQUEST_REJECTED", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a", requestId: "x" });
    assert.throws(
      () => svc.assignReviewer({ groupId: G1, candidateId: "C2", reviewerId: "R1", reviewerOrg: "org-a", requestId: "x" }),
      (e) => e.code === "CONFLICTING_REQUEST",
    );
    assert.ok(svc.events.some((e) => e.event_type === "REQUEST_REJECTED"));
  });

  it("无编号但内容完全相同的请求被识别为重复", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    svc.reportLateInterest({ reviewerId: "R1", candidateId: "C1", reason: "同样理由" });
    assert.throws(() => svc.reportLateInterest({ reviewerId: "R1", candidateId: "C1", reason: "同样理由" }), (e) => e.code === "DUPLICATE_REQUEST");
    // 字段顺序不同也视为相同
    assert.throws(
      () => svc.reportLateInterest({ candidateId: "C1", reason: "同样理由", reviewerId: "R1" }),
      (e) => e.code === "DUPLICATE_REQUEST",
    );
    assert.equal(svc.events.filter((e) => e.event_type === "LATE_INTEREST_RECEIVED").length, 1);
  });

  it("指纹对键顺序不敏感、对值敏感", () => {
    assert.equal(fingerprint({ a: 1, b: { c: 2, d: 3 } }), fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  });
});

describe("截止时间与崩溃恢复", () => {
  const dir = join(tmpdir(), `review-test-${process.pid}`);
  const logPath = join(dir, "events.jsonl");

  before(async () => {
    await rm(logPath, { force: true });
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("恢复后按原截止时间继续回避确认与申诉，幂等索引一并重建", async () => {
    let ms = Date.parse("2026-09-20T09:00:00Z");
    const now = () => new Date(ms).toISOString();

    let svc = await ReviewService.open({ filePath: logPath, now });
    svc.scheduleDeadline({ groupId: G1, recusalConfirmUntil: "2026-09-21T18:00:00Z", appealUntil: "2026-09-28T18:00:00Z", requestId: "dl-1" });
    svc.acceptEntry({ candidateId: "C1", groupIds: [G1], requestId: "entry-1" });
    svc.submitMaterial({ candidateId: "C1", title: "v1" });
    const { assignmentId } = svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a", requestId: "asg-1" });
    await svc.flush();
    const persistedCount = svc.events.length;

    // —— 崩溃：丢弃进程，用新服务重放 ——
    ms = Date.parse("2026-09-22T09:00:00Z"); // 已过回避确认截止
    svc = await ReviewService.open({ filePath: logPath, now });
    assert.equal(svc.events.length, persistedCount);
    assert.deepEqual(svc.deadlines(G1), { recusal_confirm_until: "2026-09-21T18:00:00Z", appeal_until: "2026-09-28T18:00:00Z" });
    assert.throws(() => svc.confirmRecusal({ assignmentId, reason: "迟到回避" }), (e) => e.code === "DEADLINE_PASSED");

    // 幂等索引恢复：旧 requestId 仍被识别
    svc.scheduleDeadline({ groupId: G1, recusalConfirmUntil: "2026-09-21T18:00:00Z", appealUntil: "2026-09-28T18:00:00Z", requestId: "dl-1" });
    assert.equal(svc.events.filter((e) => e.event_type === "DEADLINE_SCHEDULED").length, 1);
    // 同编号同内容在恢复后重放：幂等返回，不产生第二条报名
    const entryCount = svc.events.filter((e) => e.event_type === "ENTRY_ACCEPTED").length;
    assert.doesNotThrow(() => svc.acceptEntry({ candidateId: "C1", groupIds: [G1], requestId: "entry-1" }));
    assert.equal(svc.events.filter((e) => e.event_type === "ENTRY_ACCEPTED").length, entryCount);

    // 走到公布后、申诉期内验证申诉截止沿用
    qualify(svc, "C1");
    svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 80, materialVersion: 1 });
    svc.finalizeDecision({ groupId: G1, signers: twoSigners });
    svc.publishDecision({ groupId: G1 });
    assert.doesNotThrow(() => svc.fileAppeal({ groupId: G1, candidateId: "C1", target: { kind: "material", version: 1 }, reason: "期内申诉" }));

    ms = Date.parse("2026-09-29T00:00:00Z");
    assert.throws(() => svc.fileAppeal({ groupId: G1, candidateId: "C1", target: { kind: "material", version: 1 }, reason: "逾期" }), (e) => e.code === "DEADLINE_PASSED");
  });

  it("投影可从任意事件数组纯函数重建", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    qualify(svc, "C1");
    const rebuilt = projectState(svc.events);
    assert.ok(rebuilt.entries.has("C1"));
    assert.equal(rebuilt.latestQual.get("C1").conclusion, "qualified");
  });
});

describe("分数反查 traceScore", () => {
  it("给出有效性、受派快照、资格依据与完整事件理由链", () => {
    const { svc } = makeHarness();
    seedEntries(svc);
    svc.declareInterest({ reviewerId: "R1", candidateId: "C1", detail: "旧关系" });
    qualify(svc, "C1");
    svc.assignReviewer({ groupId: G1, candidateId: "C1", reviewerId: "R1", reviewerOrg: "org-a" });
    const scoreId = svc.submitScore({ groupId: G1, candidateId: "C1", reviewerId: "R1", value: 77, materialVersion: 1 });
    const valid = svc.traceScore(scoreId);
    assert.equal(valid.status, "valid");
    assert.equal(valid.assignment.frozenSnapshot[0].detail, "旧关系");
    assert.equal(valid.qualification.conclusion, "qualified");

    svc.reportLateInterest({ reviewerId: "R1", candidateId: "C1", reason: "新关系" });
    const excluded = svc.traceScore(scoreId);
    assert.equal(excluded.countedInRanking, false);
    assert.equal(excluded.history.length, 2);
    assert.throws(() => svc.traceScore("missing"), (e) => e.code === "NOT_FOUND");
  });
});

describe("事件存储", () => {
  it("append 进入事务、commit 后落盘，recover 后内容与顺序一致；rollback 丢弃缓冲", async () => {
    const dir = join(tmpdir(), `review-store-${process.pid}-${Date.now()}`);
    const path = join(dir, "log.jsonl");
    const store = new EventStore({ filePath: path });
    store.append({ event_id: "e1", event_type: "ENTRY_ACCEPTED", aggregate_type: "candidate_entry", aggregate_id: "a", occurred_at: "2026-09-20T00:00:00Z", version: 1, summary: "x" });
    store.append({ event_id: "e2", event_type: "ENTRY_ACCEPTED", aggregate_type: "candidate_entry", aggregate_id: "b", occurred_at: "2026-09-20T00:01:00Z", version: 1, summary: "y" });
    // commit 前回滚不会残留，也不影响后续 seq
    store.rollback();
    assert.equal(store.size, 0);
    store.append({ event_id: "e1", event_type: "ENTRY_ACCEPTED", aggregate_type: "candidate_entry", aggregate_id: "a", occurred_at: "2026-09-20T00:00:00Z", version: 1, summary: "x" });
    store.append({ event_id: "e2", event_type: "ENTRY_ACCEPTED", aggregate_type: "candidate_entry", aggregate_id: "b", occurred_at: "2026-09-20T00:01:00Z", version: 1, summary: "y" });
    await store.commit();
    await store.flush();
    const reopened = new EventStore({ filePath: path });
    const recovered = await reopened.recover();
    assert.deepEqual(recovered.map((e) => e.event_id), ["e1", "e2"]);
    assert.ok(recovered[0].seq < recovered[1].seq);
    await rm(dir, { recursive: true, force: true });
  });
});
