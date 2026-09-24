import { DomainRuleError, CONFLICTING_REQUEST, DUPLICATE_REQUEST, ACCESS_DENIED, DEADLINE_PASSED, INVALID_TARGET, SIGNATURE_REQUIRED, ILLEGAL_STATE, NOT_FOUND } from "./errors.js";
import { EventStore } from "./event-store.js";
import { validateEvent } from "./validator.js";
import { fingerprint as fpOf, isAfter, nowIso } from "./canonical.js";

/**
 * 复核服务。
 *
 * 不变量：
 * - 所有业务事实都是仅追加事件；本投影可随时从事件流完整重建（崩溃恢复）。
 * - 材料按版本保存；评委受派时冻结当时已申报利益关系，迟到关系不修改快照。
 * - 迟到关系只暂停受影响评分并记录理由，原评分不删除。
 * - 替补须由不同机构批准；原评委不可见替补意见。
 * - 各组独立排序、评分严格隔离；资格结论可跨组复用。
 * - 申诉必须指向具体材料版本或已确认程序事件；重评与终局裁决须两名不同角色签署。
 * - 决定公布后只能以 DECISION_CORRECTED 追加更正。
 */
export class ReviewService {
  #store;
  #state;
  #clock;
  #ctx = null; // { requestId, fp } 当前命令的幂等上下文

  constructor({ store = new EventStore(), now = nowIso } = {}) {
    this.#store = store;
    this.#clock = now;
    this.#state = projectState(store.all());
  }

  /** 从持久化日志打开服务：重放后截止时间等状态按原记录继续。 */
  static async open({ filePath, now } = {}) {
    const store = new EventStore({ filePath });
    await store.recover();
    return new ReviewService({ store, now });
  }

  get events() {
    return this.#store.all();
  }

  /** 等待全部事件落盘（仅文件存储有实际效果）。 */
  flush() {
    return this.#store.flush();
  }

  // ---------- 报名与材料版本 ----------

  acceptEntry({ candidateId, name, groupIds, requestId } = {}) {
    return this.#command(requestId, { op: "acceptEntry", candidateId, name, groupIds }, () => {
      if (this.#state.entries.has(candidateId)) throw new DomainRuleError(ILLEGAL_STATE, `候选人 ${candidateId} 已登记`);
      if (!Array.isArray(groupIds) || groupIds.length === 0) throw new DomainRuleError(INVALID_TARGET, "至少填报一个组别");
      this.#emit("ENTRY_ACCEPTED", "candidate_entry", candidateId, {
        candidate_id: candidateId, group_id: groupIds[0],
        summary: `候选人 ${name ?? candidateId} 报名进入初评`,
        payload: { name, group_ids: [...new Set(groupIds)] },
      });
      for (const groupId of [...new Set(groupIds)]) this.#ensureRound(groupId);
    });
  }

  submitMaterial({ candidateId, title, contentHash, requestId } = {}) {
    return this.#command(requestId, { op: "submitMaterial", candidateId, title, contentHash }, () => {
      this.#assertEntry(candidateId);
      const version = (this.#state.materialSeq.get(candidateId) ?? 0) + 1;
      this.#emit("MATERIAL_VERSION_SUBMITTED", "candidate_entry", `material-${candidateId}`, {
        candidate_id: candidateId, material_version: version,
        summary: `候选人 ${candidateId} 提交第 ${version} 版材料`,
        payload: { material_version: version, title, content_hash: contentHash },
      });
      return version;
    });
  }

  // ---------- 利益关系与受派（冻结快照） ----------

  declareInterest({ reviewerId, candidateId, detail, requestId } = {}) {
    return this.#command(requestId, { op: "declareInterest", reviewerId, candidateId, detail }, () => {
      this.#assertEntry(candidateId);
      const id = `interest-${reviewerId}-${candidateId}-${this.#state.interestSeq + 1}`;
      this.#emit("INTEREST_DECLARED", "judging_assignment", id, {
        reviewer_id: reviewerId, candidate_id: candidateId,
        summary: `评委 ${reviewerId} 申报与候选人 ${candidateId} 的利益关系`,
        payload: { detail: detail ?? "" },
      });
      return id;
    });
  }

  assignReviewer({ groupId, candidateId, reviewerId, reviewerOrg, requestId } = {}) {
    return this.#command(requestId, { op: "assignReviewer", groupId, candidateId, reviewerId, reviewerOrg }, () => {
      this.#assertEntry(candidateId);
      this.#assertInGroup(candidateId, groupId);
      const key = assignmentKey(groupId, candidateId, reviewerId);
      if (this.#state.assignmentIndex.has(key)) throw new DomainRuleError(ILLEGAL_STATE, "该评委已受派于此候选人/组别");
      const assignmentId = `asg-${groupId}-${candidateId}-${reviewerId}`;
      // 冻结：仅包含受派时刻之前已申报的利益关系；事后到达的关系不会回写此快照。
      const frozen = this.#state.interestsByReviewer.get(reviewerId)?.filter((i) => i.candidateId === candidateId) ?? [];
      this.#emit("REVIEWER_ASSIGNED", "judging_assignment", assignmentId, {
        group_id: groupId, candidate_id: candidateId, reviewer_id: reviewerId,
        summary: `评委 ${reviewerId} 受派 ${groupId} 组，冻结 ${frozen.length} 条已申报利益关系`,
        payload: { reviewer_org: reviewerOrg ?? null, frozen_interest_ids: frozen.map((i) => i.interestId), frozen_snapshot: frozen.map((i) => ({ interest_id: i.interestId, detail: i.detail, declared_at: i.declaredAt })) },
      });
      return { assignmentId, frozenInterestIds: frozen.map((i) => i.interestId) };
    });
  }

  /** 回避确认：须在本组回避确认截止时间之前。 */
  confirmRecusal({ assignmentId, reason, requestId } = {}) {
    return this.#command(requestId, { op: "confirmRecusal", assignmentId, reason }, () => {
      const asg = this.#assertAssignment(assignmentId);
      this.#assertBeforeDeadline(asg.groupId, "recusal_confirm_until", "回避确认");
      this.#emit("RECUSAL_DECLARED", "judging_assignment", assignmentId, {
        group_id: asg.groupId, candidate_id: asg.candidateId, reviewer_id: asg.reviewerId,
        summary: `评委 ${asg.reviewerId} 在 ${asg.groupId} 组确认回避`,
        payload: { reason: reason ?? "" },
      });
    });
  }

  // ---------- 资格结论（可跨组复用） ----------

  decideQualification({ candidateId, groupId, conclusion, basisMaterialVersion, signedBy, requestId } = {}) {
    return this.#command(requestId, { op: "decideQualification", candidateId, groupId, conclusion, basisMaterialVersion, signedBy }, () => {
      this.#assertEntry(candidateId);
      if (!["qualified", "rejected"].includes(conclusion)) throw new DomainRuleError(INVALID_TARGET, "结论必须是 qualified 或 rejected");
      this.#assertMaterial(candidateId, basisMaterialVersion);
      const id = `qual-${candidateId}`;
      this.#emit("QUALIFICATION_DECIDED", "candidate_entry", id, {
        candidate_id: candidateId, group_id: groupId ?? null, material_version: basisMaterialVersion,
        summary: `候选人 ${candidateId} 资格结论：${conclusion === "qualified" ? "合格" : "不合格"}`,
        payload: { conclusion, decided_in_group: groupId ?? null, signed_by: signedBy ?? [] },
      });
    });
  }

  /** 资格结论查询：在 groupId 使用时，若结论来自其他组别则标注复用。 */
  effectiveQualification(candidateId, groupId) {
    const qual = this.#state.latestQual.get(candidateId);
    if (!qual) return null;
    return {
      candidateId,
      conclusion: qual.conclusion,
      qualId: qual.qualId,
      decidedInGroup: qual.groupId,
      reusedFromGroup: qual.groupId && groupId && qual.groupId !== groupId ? qual.groupId : null,
      basisMaterialVersion: qual.basisMaterialVersion,
    };
  }

  // ---------- 评分 ----------

  submitScore({ groupId, candidateId, reviewerId, value, materialVersion, requestId } = {}) {
    return this.#command(requestId, { op: "submitScore", groupId, candidateId, reviewerId, value, materialVersion }, () => {
      const asg = this.#assertActiveAssignment(groupId, candidateId, reviewerId);
      this.#assertMaterial(candidateId, materialVersion);
      if (typeof value !== "number" || !Number.isFinite(value)) throw new DomainRuleError(INVALID_TARGET, "评分必须是数值");
      const decision = this.#state.finalByGroup.get(groupId);
      if (decision?.published) throw new DomainRuleError(ILLEGAL_STATE, `${groupId} 组决定已公布，普通评分通道关闭，只能经申诉重评追加`);
      // 注意：资格结论不影响评分的“接收”。是否进入排名由投影按当时资格结论判定，
      // 这样才能从一项分数反查它为何有效或因资格等原因被排除。
      const scoreId = `score-${groupId}-${candidateId}-${reviewerId}-${this.#state.scoreSeq + 1}`;
      this.#emit("SCORE_SUBMITTED", "score_sheet", scoreId, {
        group_id: groupId, candidate_id: candidateId, reviewer_id: reviewerId, material_version: materialVersion,
        summary: `评委 ${reviewerId} 为 ${candidateId}（${groupId} 组）提交评分 ${value}`,
        payload: { value, assignment_id: asg.assignmentId },
      });
      return scoreId;
    });
  }

  // ---------- 迟到关系：暂停受影响评分（不删除） ----------

  /**
   * 秘书处收到新材料（评委受派后才浮现的利益关系）。
   * 仅暂停该评委对该候选人的评分并写明理由，原记录保留；随后可批准替补接管。
   */
  reportLateInterest({ reviewerId, candidateId, reason, groupIds, requestId } = {}) {
    return this.#command(requestId, { op: "reportLateInterest", reviewerId, candidateId, reason, groupIds }, () => {
      this.#assertEntry(candidateId);
      const id = `late-${reviewerId}-${candidateId}-${this.#state.lateSeq + 1}`;
      this.#emit("LATE_INTEREST_RECEIVED", "candidate_entry", id, {
        reviewer_id: reviewerId, candidate_id: candidateId, reason,
        summary: `收到评委 ${reviewerId} 与候选人 ${candidateId} 的迟到利益关系材料`,
        payload: { detail: reason ?? "" },
      });
      const groups = groupIds ?? [...new Set([...this.#state.scores.values()].filter((s) => s.reviewerId === reviewerId && s.candidateId === candidateId).map((s) => s.groupId))];
      const suspended = [];
      for (const score of this.#state.scores.values()) {
        if (score.reviewerId !== reviewerId || score.candidateId !== candidateId) continue;
        if (!groups.includes(score.groupId)) continue;
        if (score.status !== "valid") continue;
        this.#emit("SCORE_SUSPENDED", "score_sheet", score.scoreId, {
          group_id: score.groupId, candidate_id: candidateId, reviewer_id: reviewerId,
          summary: `因迟到利益关系暂停评分 ${score.scoreId}（原记录保留，不删除）`,
          reason,
          payload: { late_interest_id: id, value: score.value },
        });
        suspended.push(score.scoreId);
      }
      return { lateInterestId: id, suspendedScoreIds: suspended };
    });
  }

  // ---------- 替补：异机构批准，原评委隔离 ----------

  approveSubstitute({ groupId, candidateId, replacedReviewerId, substituteReviewerId, substituteOrg, approver, requestId } = {}) {
    return this.#command(requestId, { op: "approveSubstitute", groupId, candidateId, replacedReviewerId, substituteReviewerId, substituteOrg, approver }, () => {
      this.#assertEntry(candidateId);
      const oldKey = assignmentKey(groupId, candidateId, replacedReviewerId);
      const oldAsg = this.#state.assignmentIndex.get(oldKey);
      if (!oldAsg) throw new DomainRuleError(NOT_FOUND, "原评委受派记录不存在");
      const oldRecord = this.#state.assignments.get(oldAsg);
      if (oldRecord.superseded) throw new DomainRuleError(ILLEGAL_STATE, "该评委已被替补接管");
      if (!approver?.id || !approver.org) throw new DomainRuleError(INVALID_TARGET, "批准人必须包含身份与机构");
      if (approver.org === oldRecord.reviewerOrg) throw new DomainRuleError(ACCESS_DENIED, "替补人选必须由不同机构批准");
      if (approver.id === replacedReviewerId) throw new DomainRuleError(ACCESS_DENIED, "原评委不得参与批准自己的替补");
      const subKey = assignmentKey(groupId, candidateId, substituteReviewerId);
      if (this.#state.assignmentIndex.has(subKey)) throw new DomainRuleError(ILLEGAL_STATE, "替补评委已受派");

      const subAssignmentId = `asg-${groupId}-${candidateId}-${substituteReviewerId}`;
      const frozen = this.#state.interestsByReviewer.get(substituteReviewerId)?.filter((i) => i.candidateId === candidateId) ?? [];
      this.#emit("REVIEWER_ASSIGNED", "judging_assignment", subAssignmentId, {
        group_id: groupId, candidate_id: candidateId, reviewer_id: substituteReviewerId,
        summary: `替补评委 ${substituteReviewerId} 受派，冻结 ${frozen.length} 条已申报利益关系`,
        payload: { reviewer_org: substituteOrg ?? null, frozen_interest_ids: frozen.map((i) => i.interestId), frozen_snapshot: frozen.map((i) => ({ interest_id: i.interestId, detail: i.detail, declared_at: i.declaredAt })) },
      });
      const substituteId = `sub-${groupId}-${candidateId}-${this.#state.substituteSeq + 1}`;
      this.#emit("SUBSTITUTE_APPROVED", "judging_assignment", substituteId, {
        group_id: groupId, candidate_id: candidateId, reviewer_id: substituteReviewerId,
        summary: `${approver.org} 的 ${approver.id} 批准 ${substituteReviewerId} 接替 ${replacedReviewerId}`,
        payload: {
          substitute_id: substituteId,
          replaced_reviewer_id: replacedReviewerId,
          substitute_reviewer_id: substituteReviewerId,
          substitute_assignment_id: subAssignmentId,
          replaced_assignment_id: oldAsg,
          approver: { id: approver.id, org: approver.org },
        },
      });
      return { substituteId, subAssignmentId };
    });
  }

  /** 读取评分视图：原评委不得查看接替自己的替补意见/评分。 */
  viewScore(scoreId, actor) {
    const score = this.#state.scores.get(scoreId);
    if (!score) throw new DomainRuleError(NOT_FOUND, `评分 ${scoreId} 不存在`);
    for (const sub of this.#state.substitutes.values()) {
      if (sub.substituteReviewerId === score.reviewerId && sub.candidateId === score.candidateId && sub.groupId === score.groupId && actor?.id === sub.replacedReviewerId) {
        throw new DomainRuleError(ACCESS_DENIED, "原评委不可见替补意见");
      }
    }
    return structuredClone(score);
  }

  // ---------- 程序事件与申诉 ----------

  confirmIncident({ incidentId, groupId, candidateId, description, requestId } = {}) {
    return this.#command(requestId, { op: "confirmIncident", incidentId, groupId, candidateId, description }, () => {
      this.#emit("INCIDENT_CONFIRMED", "appeal_case", `incident-${incidentId}`, {
        group_id: groupId ?? null, candidate_id: candidateId ?? null,
        summary: `确认程序事件：${description ?? incidentId}`,
        payload: { incident_id: incidentId, description: description ?? "" },
      });
      return incidentId;
    });
  }

  /** 申诉必须指向具体材料版本或已确认的程序事件，且在申诉截止时间之前。 */
  fileAppeal({ groupId, candidateId, target, reason, requestId } = {}) {
    return this.#command(requestId, { op: "fileAppeal", groupId, candidateId, target, reason }, () => {
      this.#assertEntry(candidateId);
      this.#assertInGroup(candidateId, groupId);
      const decision = this.#state.finalByGroup.get(groupId);
      if (!decision?.published) throw new DomainRuleError(ILLEGAL_STATE, "只能对已公布的决定提出申诉");
      this.#assertBeforeDeadline(groupId, "appeal_until", "申诉");
      if (!target || !["material", "incident"].includes(target.kind)) throw new DomainRuleError(INVALID_TARGET, "申诉必须指向材料版本(material)或程序事件(incident)");
      if (target.kind === "material") {
        this.#assertMaterial(candidateId, target.version);
      } else {
        const incident = this.#state.incidents.get(target.incidentId);
        if (!incident) throw new DomainRuleError(INVALID_TARGET, "申诉指向的程序事件不存在或未确认");
        if (incident.candidateId && incident.candidateId !== candidateId) throw new DomainRuleError(INVALID_TARGET, "程序事件与申诉候选人不一致");
        if (incident.groupId && incident.groupId !== groupId) throw new DomainRuleError(INVALID_TARGET, "程序事件与申诉组别不一致");
      }
      const appealId = `appeal-${groupId}-${candidateId}-${this.#state.appealSeq + 1}`;
      this.#emit("APPEAL_FILED", "appeal_case", appealId, {
        group_id: groupId, candidate_id: candidateId,
        material_version: target.kind === "material" ? target.version : undefined,
        incident_id: target.kind === "incident" ? target.incidentId : undefined,
        summary: `候选人 ${candidateId} 就 ${groupId} 组公布决定提出申诉（指向${target.kind === "material" ? `材料第 ${target.version} 版` : `程序事件 ${target.incidentId}`}）`,
        reason,
        payload: { target_kind: target.kind, target_version: target.version ?? null, target_incident: target.incidentId ?? null },
      });
      return appealId;
    });
  }

  requestRescore({ appealId, requestId } = {}) {
    return this.#command(requestId, { op: "requestRescore", appealId }, () => {
      const appeal = this.#assertAppeal(appealId);
      const rescoreId = `rescore-${appeal.groupId}-${appeal.candidateId}-${this.#state.rescoreSeq + 1}`;
      this.#emit("RESCORE_REQUESTED", "appeal_case", rescoreId, {
        group_id: appeal.groupId, candidate_id: appeal.candidateId,
        material_version: appeal.targetVersion ?? undefined, incident_id: appeal.targetIncident ?? undefined,
        summary: `就申诉 ${appealId} 启动重新评分`,
        payload: { appeal_id: appealId },
      });
      return rescoreId;
    });
  }

  /** 重新评分签署：必须累计两名不同角色（同一角色重复签署无效）。 */
  signRescore({ rescoreId, signer, requestId } = {}) {
    return this.#command(requestId, { op: "signRescore", rescoreId, signer }, () => {
      const rescore = this.#state.rescoring.get(rescoreId);
      if (!rescore) throw new DomainRuleError(NOT_FOUND, `重新评分案 ${rescoreId} 不存在`);
      if (rescore.signers.length >= 2) throw new DomainRuleError(SIGNATURE_REQUIRED, "重新评分案已集齐两名签署人");
      if (!signer?.id || !signer?.role) throw new DomainRuleError(INVALID_TARGET, "签署人必须包含身份与角色");
      if (rescore.signers.some((s) => s.id === signer.id)) throw new DomainRuleError(SIGNATURE_REQUIRED, "同一签署人不得重复签署");
      if (rescore.signers.some((s) => s.role === signer.role)) throw new DomainRuleError(SIGNATURE_REQUIRED, "两名签署人必须是不同角色");
      this.#emit("RESCORE_SIGNED", "appeal_case", rescoreId, {
        group_id: rescore.groupId, candidate_id: rescore.candidateId,
        summary: `${signer.role} ${signer.id} 签署重新评分案 ${rescoreId}`,
        payload: { signer: { id: signer.id, role: signer.role } },
      });
      return { completed: rescore.signers.length + 1 >= 2 };
    });
  }

  /** 重评完成后提交替代评分；被替代的旧评分标记 superseded（保留记录与申诉链路）。 */
  submitReplacementScore({ rescoreId, reviewerId, value, materialVersion, supersedesScoreIds, requestId } = {}) {
    return this.#command(requestId, { op: "submitReplacementScore", rescoreId, reviewerId, value, materialVersion, supersedesScoreIds }, () => {
      const rescore = this.#state.rescoring.get(rescoreId);
      if (!rescore) throw new DomainRuleError(NOT_FOUND, `重新评分案 ${rescoreId} 不存在`);
      if (rescore.signers.length < 2) throw new DomainRuleError(SIGNATURE_REQUIRED, "重新评分须经两名不同角色签署后方可录入");
      const { groupId, candidateId, appealId } = rescore;
      const asg = this.#assertActiveAssignment(groupId, candidateId, reviewerId);
      this.#assertMaterial(candidateId, materialVersion);
      const oldIds = supersedesScoreIds ?? [...this.#state.scores.values()]
        .filter((s) => s.groupId === groupId && s.candidateId === candidateId && s.status === "valid").map((s) => s.scoreId);
      const scoreId = `score-${groupId}-${candidateId}-${reviewerId}-${this.#state.scoreSeq + 1}`;
      this.#emit("SCORE_SUBMITTED", "score_sheet", scoreId, {
        group_id: groupId, candidate_id: candidateId, reviewer_id: reviewerId, material_version: materialVersion,
        summary: `重评后评委 ${reviewerId} 提交替代评分 ${value}`,
        payload: { value, assignment_id: asg.assignmentId, rescore_id: rescoreId, appeal_id: appealId, supersedes: oldIds },
      });
      for (const oldId of oldIds) {
        const old = this.#state.scores.get(oldId);
        if (!old) throw new DomainRuleError(NOT_FOUND, `被替代评分 ${oldId} 不存在`);
        if (old.groupId !== groupId || old.candidateId !== candidateId) throw new DomainRuleError(INVALID_TARGET, "只能替代同组同候选人的评分");
        if (old.status === "superseded") continue;
        this.#emit("SCORE_SUSPENDED", "score_sheet", oldId, {
          group_id: groupId, candidate_id: candidateId, reviewer_id: old.reviewerId,
          summary: `申诉 ${appealId} 重评后，旧评分 ${oldId} 被替代（记录保留）`,
          reason: `申诉重评替代：${appealId}`,
          payload: { superseded_by: scoreId, rescore_id: rescoreId, appeal_id: appealId },
        });
      }
      return scoreId;
    });
  }

  // ---------- 终局裁决与更正 ----------

  /** 终局裁决：两名不同角色签署；各组独立。 */
  finalizeDecision({ groupId, signers, requestId } = {}) {
    return this.#command(requestId, { op: "finalizeDecision", groupId, signers }, () => {
      assertTwoRoles(signers);
      const existing = this.#state.finalByGroup.get(groupId);
      if (existing) throw new DomainRuleError(ILLEGAL_STATE, `${groupId} 组已有终局裁决`);
      const ranking = this.computeRanking(groupId);
      if (ranking.length === 0) throw new DomainRuleError(ILLEGAL_STATE, `${groupId} 组没有可排名的有效评分`);
      this.#emit("DECISION_FINALIZED", "review_round", `decision-${groupId}`, {
        group_id: groupId,
        summary: `${groupId} 组完成终局裁决：${ranking.map((r, i) => `#${i + 1} ${r.candidateId}`).join("、")}`,
        payload: { ranking, signers: signers.map((s) => ({ id: s.id, role: s.role })), score_trace: this.scoreTraceSummary(groupId) },
      });
      return ranking;
    });
  }

  publishDecision({ groupId, requestId } = {}) {
    return this.#command(requestId, { op: "publishDecision", groupId }, () => {
      const decision = this.#state.finalByGroup.get(groupId);
      if (!decision) throw new DomainRuleError(ILLEGAL_STATE, `${groupId} 组尚无终局裁决`);
      if (decision.published) throw new DomainRuleError(ILLEGAL_STATE, `${groupId} 组决定已公布`);
      this.#emit("DECISION_PUBLISHED", "review_round", `decision-${groupId}`, {
        group_id: groupId,
        summary: `${groupId} 组终局决定公布`,
        payload: {},
      });
    });
  }

  /** 公布后只能追加更正：两名不同角色签署，原裁决与公布记录均保留。 */
  correctDecision({ groupId, appealId, reason, signers, ranking, requestId } = {}) {
    return this.#command(requestId, { op: "correctDecision", groupId, appealId, reason, signers, ranking }, () => {
      assertTwoRoles(signers);
      const decision = this.#state.finalByGroup.get(groupId);
      if (!decision?.published) throw new DomainRuleError(ILLEGAL_STATE, "只能对已公布的决定追加更正");
      const appeal = this.#assertAppeal(appealId);
      if (appeal.groupId !== groupId) throw new DomainRuleError(INVALID_TARGET, "申诉与更正组别不一致");
      const newRanking = ranking ?? this.computeRanking(groupId);
      this.#emit("DECISION_CORRECTED", "review_round", `decision-${groupId}`, {
        group_id: groupId,
        summary: `${groupId} 组依申诉 ${appealId} 追加更正：${newRanking.map((r, i) => `#${i + 1} ${r.candidateId}`).join("、")}`,
        reason,
        payload: {
          appeal_id: appealId,
          new_ranking: newRanking,
          signers: signers.map((s) => ({ id: s.id, role: s.role })),
          supersedes_ranking: this.finalSequence(groupId).ranking,
          score_trace: this.scoreTraceSummary(groupId),
        },
      });
      return newRanking;
    });
  }

  /** 公布后决定的当前有效序列（含更正链）。 */
  finalSequence(groupId) {
    const d = this.#state.finalByGroup.get(groupId);
    if (!d) return null;
    const current = d.corrections.length > 0 ? d.corrections[d.corrections.length - 1].newRanking : d.ranking;
    return {
      groupId,
      ranking: current,
      finalizedAt: d.finalizedAt,
      publishedAt: d.publishedAt ?? null,
      corrections: d.corrections.map((c) => ({ at: c.at, appealId: c.appealId, reason: c.reason, previousRanking: c.previousRanking, newRanking: c.newRanking, signers: c.signers })),
    };
  }

  // ---------- 截止时间（持久化、恢复后按原时间继续） ----------

  scheduleDeadline({ groupId, recusalConfirmUntil, appealUntil, requestId } = {}) {
    return this.#command(requestId, { op: "scheduleDeadline", groupId, recusalConfirmUntil, appealUntil }, () => {
      this.#ensureRound(groupId);
      this.#emit("DEADLINE_SCHEDULED", "review_round", `round-${groupId}`, {
        group_id: groupId,
        summary: `安排 ${groupId} 组截止时间：回避确认 ${recusalConfirmUntil ?? "（未设）"}，申诉 ${appealUntil ?? "（未设）"}`,
        payload: { deadlines: { recusal_confirm_until: recusalConfirmUntil ?? null, appeal_until: appealUntil ?? null } },
      });
    });
  }

  deadlines(groupId) {
    return this.#state.rounds.get(groupId)?.deadlines ?? null;
  }

  // ---------- 查询：排名与分数反查 ----------

  /** 各组独立排序：仅统计本组 status=valid 的评分；资格结论可来自其他组别。 */
  computeRanking(groupId) {
    const buckets = new Map();
    for (const s of this.#state.scores.values()) {
      if (s.groupId !== groupId || s.status !== "valid") continue;
      const qual = this.effectiveQualification(s.candidateId, groupId);
      if (!qual || qual.conclusion !== "qualified") continue;
      if (!buckets.has(s.candidateId)) buckets.set(s.candidateId, { candidateId: s.candidateId, total: 0, count: 0 });
      const b = buckets.get(s.candidateId);
      b.total += s.value;
      b.count += 1;
    }
    return [...buckets.values()]
      .map((b) => ({ candidateId: b.candidateId, average: Number((b.total / b.count).toFixed(4)), scoreCount: b.count }))
      .sort((a, b) => b.average - a.average || a.candidateId.localeCompare(b.candidateId));
  }

  /** 从一项分数反查它为何有效或被排除。 */
  traceScore(scoreId) {
    const s = this.#state.scores.get(scoreId);
    if (!s) throw new DomainRuleError(NOT_FOUND, `评分 ${scoreId} 不存在`);
    const asg = this.#state.assignments.get(s.assignmentId);
    const qual = this.effectiveQualification(s.candidateId, s.groupId);
    const qualifies = qual?.conclusion === "qualified";
    const excludedByQualification = !qualifies;
    const statusText = s.status !== "valid"
      ? (s.status === "suspended" ? "EXCLUDED_SUSPENDED（暂停，不进入排名）" : "EXCLUDED_SUPERSEDED（被重评替代，不进入排名）")
      : excludedByQualification
        ? "EXCLUDED_QUALIFICATION（评分本身有效，但候选人不具合格资格，不进入排名）"
        : "VALID（进入排名）";
    const reasons = s.history.map((h) => h.explain);
    if (s.status === "valid" && excludedByQualification) {
      reasons.push(qual ? `候选人当前资格结论为 ${qual.conclusion}（依据材料 v${qual.basisMaterialVersion}），评分虽有效但被排名排除` : "候选人尚无资格结论，评分暂不能进入排名");
    }
    return {
      scoreId,
      groupId: s.groupId,
      candidateId: s.candidateId,
      reviewerId: s.reviewerId,
      value: s.value,
      materialVersion: s.materialVersion,
      status: s.status,
      statusText,
      countedInRanking: s.status === "valid" && qualifies,
      excludedByQualification,
      assignment: asg ? {
        assignmentId: asg.assignmentId,
        assignedAt: asg.assignedAt,
        reviewerOrg: asg.reviewerOrg,
        frozenSnapshot: asg.frozenSnapshot,
        snapshotNote: "快照为受派时刻已申报利益关系；迟到关系不会改写此快照",
      } : null,
      qualification: qual,
      history: s.history.map((h) => ({ ...h })),
      reasons,
    };
  }

  scoreTraceSummary(groupId) {
    return [...this.#state.scores.values()].filter((s) => s.groupId === groupId).map((s) => ({
      scoreId: s.scoreId, candidateId: s.candidateId, reviewerId: s.reviewerId, value: s.value, status: s.status,
    }));
  }

  listScores(groupId) {
    return [...this.#state.scores.values()].filter((s) => !groupId || s.groupId === groupId).map((s) => structuredClone(s));
  }

  // ---------- 内部 ----------

  /**
   * 事务式命令：
   * - 带 request_id：编号前置判定——同号同内容幂等返回，同号异内容拒绝（即使业务状态已变）；
   * - 无 request_id：先执行业务校验，成功后再判定“内容完全相同的重复”，
   *   避免把“因当前状态本就不允许的操作”误判为重复；
   * - 命令失败或命中重复时回滚缓冲与投影，已提交历史不受影响。
   */
  #command(requestId, intent, run) {
    const fp = fpOf(intent);
    if (requestId) {
      const seen = this.#state.requests.get(requestId);
      if (seen) {
        if (seen.fp === fp) {
          this.#audit("REQUEST_DEDUPLICATED", requestId, { request_id: requestId, fingerprint: fp, original_event_ids: seen.eventIds, note: "同编号同内容：识别为重复请求，不重复生效" });
          return seen.result;
        }
        this.#audit("REQUEST_REJECTED", requestId, { request_id: requestId, fingerprint: fp, existing_fingerprint: seen.fp, note: "同编号异内容：拒绝" });
        throw new DomainRuleError(CONFLICTING_REQUEST, `请求编号 ${requestId} 曾用于不同内容，已拒绝`, { existingFingerprint: seen.fp });
      }
    }

    // 无 request_id：在执行业务逻辑前记录该内容指纹是否此前已出现。
    // 不能在 run() 之后再查指纹表——本命令刚发出的事件也会被投影写入该表。
    const priorMatch = !requestId ? this.#state.fingerprints.get(fp) ?? null : null;

    this.#ctx = { requestId: requestId ?? null, fp, eventIds: [] };
    let result;
    try {
      result = run();
    } catch (err) {
      this.#abort();
      this.#ctx = null;
      throw err;
    }

    // 无编号请求：业务校验通过后，若内容此前已出现则判为重复并回滚
    if (priorMatch) {
      const first = priorMatch;
      this.#abort();
      this.#ctx = null;
      this.#audit("REQUEST_DEDUPLICATED", `fp-${fp.slice(0, 12)}`, { fingerprint: fp, original_request_id: first.requestId ?? null, original_event_ids: first.eventIds, note: "无编号但内容完全相同：识别为重复请求" });
      throw new DomainRuleError(DUPLICATE_REQUEST, "完全相同的重复请求已被识别", { originalEventIds: first.eventIds });
    }

    const eventIds = this.#ctx.eventIds;
    this.#store.commit();
    this.#ctx = null;
    this.#state.registerRequest({ requestId: requestId ?? null, fp, eventIds, result });
    return result;
  }

  /** 回滚当前命令产生的缓冲事件，并从已提交历史重建投影。 */
  #abort() {
    this.#store.rollback();
    this.#state = projectState(this.#store.all());
  }

  #audit(type, aggregateId, payload) {
    const version = this.#state.nextAggregateVersion(aggregateId);
    const event = {
      event_id: `${aggregateId}#${version}`,
      event_type: type,
      aggregate_type: "request_record",
      aggregate_id: aggregateId,
      occurred_at: this.#clock(),
      version,
      summary: payload.note,
      payload,
    };
    const stored = this.#store.commitDirect(event);
    applyEvent(this.#state, stored);
    return stored;
  }

  #ensureRound(groupId) {
    if (!this.#state.rounds.has(groupId)) this.#state.rounds.set(groupId, { groupId, deadlines: {} });
  }

  #assertBeforeDeadline(groupId, field, label) {
    const deadline = this.#state.rounds.get(groupId)?.deadlines?.[field];
    if (deadline && isAfter(this.#clock(), deadline)) {
      throw new DomainRuleError(DEADLINE_PASSED, `${label}截止时间 ${deadline} 已过（当前 ${this.#clock()}）`, { deadline, now: this.#clock() });
    }
  }

  #assertEntry(candidateId) {
    if (!this.#state.entries.has(candidateId)) throw new DomainRuleError(NOT_FOUND, `候选人 ${candidateId} 未登记报名`);
    return this.#state.entries.get(candidateId);
  }

  #assertInGroup(candidateId, groupId) {
    const entry = this.#assertEntry(candidateId);
    if (!entry.groupIds.includes(groupId)) throw new DomainRuleError(INVALID_TARGET, `候选人 ${candidateId} 未兼报 ${groupId} 组`);
  }

  #assertMaterial(candidateId, version) {
    if (!Number.isInteger(version) || version < 1) throw new DomainRuleError(INVALID_TARGET, "必须指明具体材料版本");
    const m = this.#state.materials.get(materialKey(candidateId, version));
    if (!m) throw new DomainRuleError(INVALID_TARGET, `候选人 ${candidateId} 的第 ${version} 版材料不存在`);
    return m;
  }

  #assertAssignment(assignmentId) {
    const asg = this.#state.assignments.get(assignmentId);
    if (!asg) throw new DomainRuleError(NOT_FOUND, `受派记录 ${assignmentId} 不存在`);
    return asg;
  }

  #assertActiveAssignment(groupId, candidateId, reviewerId) {
    const id = this.#state.assignmentIndex.get(assignmentKey(groupId, candidateId, reviewerId));
    if (!id) throw new DomainRuleError(ILLEGAL_STATE, `评委 ${reviewerId} 未受派于 ${groupId}/${candidateId}`);
    const asg = this.#state.assignments.get(id);
    if (asg.superseded) throw new DomainRuleError(ILLEGAL_STATE, `评委 ${reviewerId} 已被替补接管，不得再提交评分`);
    if (asg.recused) throw new DomainRuleError(ILLEGAL_STATE, `评委 ${reviewerId} 已确认回避`);
    return asg;
  }

  #assertAppeal(appealId) {
    const appeal = this.#state.appeals.get(appealId);
    if (!appeal) throw new DomainRuleError(NOT_FOUND, `申诉 ${appealId} 不存在`);
    return appeal;
  }

  #emit(type, aggregateType, aggregateId, { group_id, candidate_id, reviewer_id, material_version, incident_id, reason, summary, payload = {} }) {
    const event = this.#buildEvent(type, aggregateType, aggregateId, {
      group_id, candidate_id, reviewer_id,
      material_version, incident_id, reason, summary, payload, stamp: true,
    });
    return this.#append(event);
  }

  #buildEvent(type, aggregateType, aggregateId, { group_id, candidate_id, reviewer_id, material_version, incident_id, reason, summary, payload, stamp }) {
    const version = this.#state.nextAggregateVersion(aggregateId);
    const event = {
      event_id: `${aggregateId}#${version}`,
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.#clock(),
      version,
      summary,
      ...(group_id !== undefined ? { group_id } : {}),
      ...(candidate_id !== undefined ? { candidate_id } : {}),
      ...(reviewer_id !== undefined ? { reviewer_id } : {}),
      ...(material_version !== undefined ? { material_version } : {}),
      ...(incident_id !== undefined ? { incident_id } : {}),
      ...(reason !== undefined ? { reason } : {}),
      payload,
    };
    if (stamp && this.#ctx) {
      if (this.#ctx.requestId) event.request_id = this.#ctx.requestId;
      event.request_fp = this.#ctx.fp;
    }
    const errors = validateEvent(event);
    if (errors.length) throw new DomainRuleError(ILLEGAL_STATE, `事件校验失败：${errors.join("；")}`);
    return event;
  }

  #append(event) {
    const stored = this.#store.append(event);
    applyEvent(this.#state, stored);
    if (this.#ctx) this.#ctx.eventIds.push(stored.event_id);
    return stored;
  }
}

// ---------- 纯函数投影 ----------

export function projectState(events) {
  const state = freshState();
  for (const event of events) applyEvent(state, event);
  return state;
}

function freshState() {
  return {
    entries: new Map(),
    materials: new Map(),
    materialSeq: new Map(),
    interests: new Map(),
    interestsByReviewer: new Map(),
    interestSeq: 0,
    assignments: new Map(),
    assignmentIndex: new Map(),
    qualifications: new Map(),
    latestQual: new Map(),
    scores: new Map(),
    scoreSeq: 0,
    lateInterests: new Map(),
    lateSeq: 0,
    substitutes: new Map(),
    substituteSeq: 0,
    incidents: new Map(),
    appeals: new Map(),
    appealSeq: 0,
    rescoring: new Map(),
    rescoreSeq: 0,
    rounds: new Map(),
    finalByGroup: new Map(),
    requests: new Map(),
    fingerprints: new Map(),
    aggVersions: new Map(),
    registerRequest({ requestId, fp, eventIds, result }) {
      // 事务缓冲阶段 applyEvent 可能已建过占位条目；提交后以带返回值的正式记录覆盖。
      if (requestId) this.requests.set(requestId, { fp, eventIds, result });
      if (!this.fingerprints.has(fp)) this.fingerprints.set(fp, { requestId, eventIds });
    },
    nextAggregateVersion(aggregateId) {
      const v = (this.aggVersions.get(aggregateId) ?? 0) + 1;
      this.aggVersions.set(aggregateId, v);
      return v;
    },
  };
}

function applyEvent(state, e) {
  state.aggVersions.set(e.aggregate_id, Math.max(state.aggVersions.get(e.aggregate_id) ?? 0, e.version));
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "ENTRY_ACCEPTED": {
      state.entries.set(e.candidate_id, { candidateId: e.candidate_id, name: p.name ?? null, groupIds: [...new Set(p.group_ids ?? [e.group_id])], enteredAt: e.occurred_at });
      if (!state.rounds.has(e.group_id)) state.rounds.set(e.group_id, { groupId: e.group_id, deadlines: {} });
      break;
    }
    case "MATERIAL_VERSION_SUBMITTED": {
      const version = p.material_version;
      state.materials.set(materialKey(e.candidate_id, version), { candidateId: e.candidate_id, version, title: p.title ?? null, contentHash: p.content_hash ?? null, submittedAt: e.occurred_at });
      state.materialSeq.set(e.candidate_id, Math.max(state.materialSeq.get(e.candidate_id) ?? 0, version));
      break;
    }
    case "INTEREST_DECLARED": {
      state.interestSeq += 1;
      const rec = { interestId: e.aggregate_id, reviewerId: e.reviewer_id, candidateId: e.candidate_id, detail: p.detail ?? "", declaredAt: e.occurred_at };
      state.interests.set(rec.interestId, rec);
      if (!state.interestsByReviewer.has(e.reviewer_id)) state.interestsByReviewer.set(e.reviewer_id, []);
      state.interestsByReviewer.get(e.reviewer_id).push(rec);
      break;
    }
    case "REVIEWER_ASSIGNED": {
      state.assignments.set(e.aggregate_id, {
        assignmentId: e.aggregate_id, groupId: e.group_id, candidateId: e.candidate_id, reviewerId: e.reviewer_id,
        reviewerOrg: p.reviewer_org ?? null, frozenInterestIds: p.frozen_interest_ids ?? [], frozenSnapshot: p.frozen_snapshot ?? [],
        assignedAt: e.occurred_at, superseded: false, recused: false,
      });
      state.assignmentIndex.set(assignmentKey(e.group_id, e.candidate_id, e.reviewer_id), e.aggregate_id);
      break;
    }
    case "RECUSAL_DECLARED": {
      const asg = state.assignments.get(e.aggregate_id);
      if (asg) asg.recused = true;
      break;
    }
    case "QUALIFICATION_DECIDED": {
      const rec = { qualId: e.aggregate_id, candidateId: e.candidate_id, groupId: e.group_id ?? p.decided_in_group ?? null, conclusion: p.conclusion, basisMaterialVersion: e.material_version ?? p.basis_material_version, signedBy: p.signed_by ?? [], at: e.occurred_at };
      state.qualifications.set(rec.qualId, rec);
      state.latestQual.set(e.candidate_id, rec);
      break;
    }
    case "SCORE_SUBMITTED": {
      state.scoreSeq += 1;
      state.scores.set(e.aggregate_id, {
        scoreId: e.aggregate_id, groupId: e.group_id, candidateId: e.candidate_id, reviewerId: e.reviewer_id,
        value: p.value, materialVersion: e.material_version, assignmentId: p.assignment_id ?? null,
        rescoreId: p.rescore_id ?? null, appealId: p.appeal_id ?? null,
        status: "valid", submittedAt: e.occurred_at, history: [{ event: "SCORE_SUBMITTED", eventId: e.event_id, at: e.occurred_at, explain: `评分 ${p.value} 由评委 ${e.reviewer_id} 依受派记录提交，当时为有效评分` }],
      });
      break;
    }
    case "LATE_INTEREST_RECEIVED": {
      state.lateSeq += 1;
      state.lateInterests.set(e.aggregate_id, { lateInterestId: e.aggregate_id, reviewerId: e.reviewer_id, candidateId: e.candidate_id, reason: e.reason ?? p.detail ?? "", receivedAt: e.occurred_at });
      break;
    }
    case "SCORE_SUSPENDED": {
      const s = state.scores.get(e.aggregate_id);
      if (!s) break;
      if (p.superseded_by) {
        s.status = "superseded";
        s.history.push({ event: "SCORE_SUPERSEDED", eventId: e.event_id, at: e.occurred_at, rescoreId: p.rescore_id ?? null, appealId: p.appeal_id ?? null, supersededBy: p.superseded_by, explain: `申诉 ${p.appeal_id} 重评后被新评分 ${p.superseded_by} 替代；原记录保留，不进入排名` });
      } else {
        s.status = "suspended";
        s.history.push({ event: "SCORE_SUSPENDED", eventId: e.event_id, at: e.occurred_at, lateInterestId: p.late_interest_id, reason: e.reason ?? "", explain: `受迟到利益关系 ${p.late_interest_id} 影响暂停：${e.reason ?? ""}；原记录保留，不删除，不进入排名` });
      }
      break;
    }
    case "SUBSTITUTE_APPROVED": {
      state.substituteSeq += 1;
      const rec = {
        substituteId: e.aggregate_id, groupId: e.group_id, candidateId: e.candidate_id,
        replacedReviewerId: p.replaced_reviewer_id, substituteReviewerId: p.substitute_reviewer_id,
        substituteAssignmentId: p.substitute_assignment_id, replacedAssignmentId: p.replaced_assignment_id,
        approver: p.approver, approvedAt: e.occurred_at,
      };
      state.substitutes.set(rec.substituteId, rec);
      const old = state.assignments.get(rec.replacedAssignmentId);
      if (old) old.superseded = true;
      break;
    }
    case "INCIDENT_CONFIRMED": {
      state.incidents.set(p.incident_id, { incidentId: p.incident_id, groupId: e.group_id, candidateId: e.candidate_id, description: p.description ?? "", confirmedAt: e.occurred_at });
      break;
    }
    case "APPEAL_FILED": {
      state.appealSeq += 1;
      state.appeals.set(e.aggregate_id, {
        appealId: e.aggregate_id, groupId: e.group_id, candidateId: e.candidate_id,
        targetKind: p.target_kind, targetVersion: p.target_version, targetIncident: p.target_incident,
        reason: e.reason ?? "", filedAt: e.occurred_at,
      });
      break;
    }
    case "RESCORE_REQUESTED": {
      state.rescoreSeq += 1;
      state.rescoring.set(e.aggregate_id, { rescoreId: e.aggregate_id, groupId: e.group_id, candidateId: e.candidate_id, appealId: p.appeal_id, signers: [], requestedAt: e.occurred_at });
      break;
    }
    case "RESCORE_SIGNED": {
      const r = state.rescoring.get(e.aggregate_id);
      if (r && !r.signers.some((x) => x.id === p.signer.id)) r.signers.push({ id: p.signer.id, role: p.signer.role, at: e.occurred_at });
      break;
    }
    case "DECISION_FINALIZED": {
      state.finalByGroup.set(e.group_id, { groupId: e.group_id, ranking: p.ranking, signers: p.signers, scoreTrace: p.score_trace ?? [], finalizedAt: e.occurred_at, published: false, publishedAt: null, corrections: [] });
      break;
    }
    case "DECISION_PUBLISHED": {
      const d = state.finalByGroup.get(e.group_id);
      if (d) {
        d.published = true;
        d.publishedAt = e.occurred_at;
      }
      break;
    }
    case "DECISION_CORRECTED": {
      const d = state.finalByGroup.get(e.group_id);
      if (d) d.corrections.push({ at: e.occurred_at, appealId: p.appeal_id, reason: e.reason ?? "", previousRanking: p.supersedes_ranking, newRanking: p.new_ranking, signers: p.signers });
      break;
    }
    case "DEADLINE_SCHEDULED": {
      if (!state.rounds.has(e.group_id)) state.rounds.set(e.group_id, { groupId: e.group_id, deadlines: {} });
      state.rounds.get(e.group_id).deadlines = { ...state.rounds.get(e.group_id).deadlines, ...p.deadlines };
      break;
    }
    case "REQUEST_REJECTED":
    case "REQUEST_DEDUPLICATED":
      break; // 审计记录，不进入业务索引
    default:
      break;
  }

  // 幂等索引从业务事件重建（崩溃恢复后仍然认得旧请求）
  if (e.request_fp && !["REQUEST_REJECTED", "REQUEST_DEDUPLICATED"].includes(e.event_type)) {
    if (!state.fingerprints.has(e.request_fp)) state.fingerprints.set(e.request_fp, { requestId: e.request_id ?? null, eventIds: [] });
    state.fingerprints.get(e.request_fp).eventIds.push(e.event_id);
    if (e.request_id) {
      if (!state.requests.has(e.request_id)) state.requests.set(e.request_id, { fp: e.request_fp, eventIds: [], result: undefined });
      state.requests.get(e.request_id).eventIds.push(e.event_id);
    }
  }
}

function assertTwoRoles(signers) {
  if (!Array.isArray(signers) || signers.length !== 2) throw new DomainRuleError(SIGNATURE_REQUIRED, "必须恰好两名签署人");
  const [a, b] = signers;
  if (!a?.id || !a.role || !b?.id || !b.role) throw new DomainRuleError(SIGNATURE_REQUIRED, "签署人必须包含身份与角色");
  if (a.id === b.id) throw new DomainRuleError(SIGNATURE_REQUIRED, "两名签署人必须是不同人员");
  if (a.role === b.role) throw new DomainRuleError(SIGNATURE_REQUIRED, "两名签署人必须是不同角色");
}

function assignmentKey(groupId, candidateId, reviewerId) {
  return `${groupId}|${candidateId}|${reviewerId}`;
}

function materialKey(candidateId, version) {
  return `${candidateId}|${version}`;
}
