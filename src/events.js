/**
 * 领域事件工厂。
 *
 * 事件只追加、不可原地改写；业务更正通过后继事件表达。
 * 每个事件沿用基础信封（event_id / event_type / aggregate_type /
 * aggregate_id / occurred_at / version / summary），业务字段放在 payload。
 */

let seq = 0;

/** 生成进程内唯一事件标识（重启后靠时间戳+序号+随机后缀避免撞号）。 */
export function newEventId(now = new Date()) {
  seq = (seq + 1) % 100000;
  const rand = Math.random().toString(36).slice(2, 8);
  const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `evt-${stamp}-${String(seq).padStart(5, "0")}-${rand}`;
}

export function makeEvent(eventType, aggregateType, aggregateId, payload, summary, opts = {}) {
  const occurredAt = opts.occurredAt ?? new Date().toISOString();
  return {
    event_id: opts.eventId ?? newEventId(new Date(occurredAt)),
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version: opts.version ?? 1,
    summary,
    payload: payload ?? {},
  };
}

/* ---------------- 报名与资格 ---------------- */

export const entryAccepted = (entryId, p, o) =>
  makeEvent("ENTRY_ACCEPTED", "candidate_entry", entryId,
    {
      candidate_id: p.candidateId,
      name: p.name ?? null,
      groups: p.groups,
      primary_group: p.primaryGroup,
    },
    p.summary ?? `候选人 ${p.candidateId} 报名通过，申报组别：${p.groups.join("、")}`, o);

export const materialSubmitted = (entryId, p, o) =>
  makeEvent("MATERIAL_SUBMITTED", "material_pack", entryId,
    {
      entry_id: entryId,
      candidate_id: p.candidateId,
      material_version: p.materialVersion,
      title: p.title ?? `材料版本 ${p.materialVersion}`,
      submitted_at: p.submittedAt ?? null,
    },
    p.summary ?? `候选人 ${p.candidateId} 提交材料版本 ${p.materialVersion}`, o);

export const interestDeclared = (entryId, p, o) =>
  makeEvent("INTEREST_DECLARED", "interest_record", `${entryId}/interest/${p.interestId}`,
    {
      entry_id: entryId,
      candidate_id: p.candidateId,
      interest_id: p.interestId,
      judge_id: p.judgeId,
      declared_at: p.declaredAt ?? null,
      reason: p.reason ?? "",
    },
    p.summary ?? `候选人 ${p.candidateId} 已申报与评委 ${p.judgeId} 的利益关系 ${p.interestId}`, o);

export const qualificationConcluded = (entryId, p, o) =>
  makeEvent("QUALIFICATION_CONCLUDED", "qualification_record", entryId,
    {
      entry_id: entryId,
      candidate_id: p.candidateId,
      group: p.group,
      conclusion: p.conclusion,            // "ELIGIBLE" | "INELIGIBLE"
      basis_material_version: p.basisMaterialVersion,
      concluded_by: p.concludedBy,
      approved_by: p.approvedBy,
      reused_from_group: p.reusedFromGroup ?? null,
    },
    p.summary ?? `组别 ${p.group} 资格结论：${p.conclusion}（依据材料版本 ${p.basisMaterialVersion}）`, o);

/* ---------------- 评委受派、冻结与迟到关系 ---------------- */

export const assignmentFrozen = (assignmentId, p, o) =>
  makeEvent("ASSIGNMENT_FROZEN", "judging_assignment", assignmentId,
    {
      assignment_id: assignmentId,
      group: p.group,
      judge_id: p.judgeId,
      judge_org: p.judgeOrg,
      frozen_interest_ids: p.frozenInterestIds,
      frozen_at: p.frozenAt,
    },
    p.summary ?? `评委 ${p.judgeId} 受派组别 ${p.group}，冻结当时已申报利益关系 ${p.frozenInterestIds.length} 条`, o);

export const lateInterestReceived = (entryId, p, o) =>
  makeEvent("LATE_INTEREST_RECEIVED", "interest_record", `${entryId}/interest/${p.interestId}`,
    {
      entry_id: entryId,
      candidate_id: p.candidateId,
      interest_id: p.interestId,
      judge_id: p.judgeId,
      received_at: p.receivedAt ?? null,
      reason: p.reason ?? "",
    },
    p.summary ?? `收到候选人 ${p.candidateId} 与评委 ${p.judgeId} 的迟到利益关系 ${p.interestId}`, o);

export const scoreSuspended = (scoreId, p, o) =>
  makeEvent("SCORE_SUSPENDED", "score_sheet", scoreId,
    {
      score_id: scoreId,
      assignment_id: p.assignmentId,
      entry_id: p.entryId,
      candidate_id: p.candidateId,
      group: p.group,
      judge_id: p.judgeId,
      value: p.value,
      interest_id: p.interestId,
      reason: p.reason,
      suspended_at: p.suspendedAt ?? null,
    },
    p.summary ?? `评委 ${p.judgeId} 对候选人 ${p.candidateId} 的评分因迟到关系 ${p.interestId} 暂停（原记录保留）`, o);

export const recusalDeclared = (assignmentId, p, o) =>
  makeEvent("RECUSAL_DECLARED", "judging_assignment", assignmentId,
    {
      assignment_id: assignmentId,
      group: p.group,
      judge_id: p.judgeId,
      reason: p.reason,
      declared_at: p.declaredAt ?? null,
    },
    p.summary ?? `评委 ${p.judgeId} 在组别 ${p.group} 回避：${p.reason}`, o);

export const substituteApproved = (subId, p, o) =>
  makeEvent("SUBSTITUTE_APPROVED", "judging_assignment", subId,
    {
      substitute_assignment_id: subId,
      group: p.group,
      original_assignment_id: p.originalAssignmentId,
      original_judge_id: p.originalJudgeId,
      substitute_judge_id: p.substituteJudgeId,
      substitute_org: p.substituteOrg,
      approver_org: p.approverOrg,
      approver_id: p.approverId,
      note_visible_to_original: false,
      note: p.note ?? null,
      approved_at: p.approvedAt ?? null,
    },
    p.summary ?? `${p.approverOrg} 批准评委 ${p.substituteJudgeId} 替补 ${p.originalJudgeId}（组别 ${p.group}）`, o);

/* ---------------- 评分 ---------------- */

export const scoreSubmitted = (scoreId, p, o) =>
  makeEvent("SCORE_SUBMITTED", "score_sheet", scoreId,
    {
      score_id: scoreId,
      assignment_id: p.assignmentId,
      substitute_assignment_id: p.substituteAssignmentId ?? null,
      entry_id: p.entryId,
      candidate_id: p.candidateId,
      group: p.group,
      judge_id: p.judgeId,
      value: p.value,
      based_on_material_version: p.basedOnMaterialVersion,
      rescore_appeal_id: p.rescoreAppealId ?? null,
      submitted_at: p.submittedAt ?? null,
    },
    p.summary ?? `评委 ${p.judgeId} 提交组别 ${p.group} 对候选人 ${p.candidateId} 的评分 ${p.value}`, o);

/* ---------------- 程序事件与时间线 ---------------- */

export const incidentConfirmed = (incidentId, p, o) =>
  makeEvent("INCIDENT_CONFIRMED", "incident_record", incidentId,
    {
      incident_id: incidentId,
      group: p.group,
      entry_id: p.entryId ?? null,
      kind: p.kind,
      confirmed_at: p.confirmedAt ?? null,
      detail: p.detail ?? "",
    },
    p.summary ?? `确认程序事件 ${incidentId}（${p.kind}）`, o);

export const timelineSet = (group, p, o) =>
  makeEvent("TIMELINE_SET", "group_timeline", `timeline/${group}`,
    {
      group,
      recusal_deadline: p.recusalDeadline,
      appeal_deadline: p.appealDeadline,
    },
    p.summary ?? `组别 ${group} 设置截止时间：回避确认 ${p.recusalDeadline}，申诉 ${p.appealDeadline}`, o);

/* ---------------- 申诉、重新评分、裁决、更正 ---------------- */

export const appealFiled = (appealId, p, o) =>
  makeEvent("APPEAL_FILED", "appeal_case", appealId,
    {
      appeal_id: appealId,
      entry_id: p.entryId,
      candidate_id: p.candidateId,
      group: p.group,
      target_kind: p.targetKind,            // "MATERIAL_VERSION" | "INCIDENT"
      material_version: p.materialVersion ?? null,
      incident_id: p.incidentId ?? null,
      reason: p.reason,
      filed_at: p.filedAt ?? null,
    },
    p.summary ?? `候选人 ${p.candidateId} 就${p.targetKind === "MATERIAL_VERSION"
      ? `材料版本 ${p.materialVersion}` : `程序事件 ${p.incidentId}`}提出申诉 ${appealId}`, o);

export const rescoreProposed = (appealId, p, o) =>
  makeEvent("RESCORE_PROPOSED", "appeal_case", appealId,
    {
      appeal_id: appealId,
      group: p.group,
      entry_id: p.entryId,
      old_score_ids: p.oldScoreIds,
      proposed_values: p.proposedValues,
      material_version: p.materialVersion,
      proposed_by: p.proposedBy,
      reason: p.reason ?? "",
    },
    p.summary ?? `申诉 ${appealId} 提出重新评分，待第二角色签署`, o);

export const rescoreSignatureAdded = (appealId, p, o) =>
  makeEvent("RESCORE_SIGNATURE_ADDED", "appeal_case", appealId,
    {
      appeal_id: appealId,
      signer_id: p.signerId,
      signer_role: p.signerRole,
      signed_at: p.signedAt ?? null,
    },
    p.summary ?? `重新评分签署：${p.signerRole} ${p.signerId}`, o);

export const rescoreCompleted = (appealId, p, newScoreIds, o) =>
  makeEvent("RESCORE_COMPLETED", "appeal_case", appealId,
    {
      appeal_id: appealId,
      group: p.group,
      entry_id: p.entryId,
      new_score_ids: newScoreIds,
      material_version: p.materialVersion,
      completed_at: p.completedAt ?? null,
    },
    p.summary ?? `申诉 ${appealId} 重新评分完成，旧评分被替代`, o);

export const decisionSignatureAdded = (decisionId, p, o) =>
  makeEvent("DECISION_SIGNATURE_ADDED", "group_decision", decisionId,
    {
      decision_id: decisionId,
      group: p.group,
      round: p.round,
      signer_id: p.signerId,
      signer_role: p.signerRole,
      ranking: p.ranking,
      signed_at: p.signedAt ?? null,
    },
    p.summary ?? `裁决签署：组别 ${p.group} 第 ${p.round} 轮，${p.signerRole} ${p.signerId}`, o);

export const decisionFinalized = (decisionId, p, ranking, o) =>
  makeEvent("DECISION_FINALIZED", "group_decision", decisionId,
    {
      decision_id: decisionId,
      group: p.group,
      round: p.round,
      ranking,
      published_at: p.publishedAt ?? null,
    },
    p.summary ?? `组别 ${p.group} 第 ${p.round} 轮裁决公布`, o);

export const decisionCorrectionProposed = (decisionId, p, o) =>
  makeEvent("DECISION_CORRECTION_PROPOSED", "group_decision", decisionId,
    {
      decision_id: decisionId,
      group: p.group,
      correction_round: p.correctionRound,
      reason: p.reason,
      appeal_id: p.appealId ?? null,
      proposed_by: p.proposedBy,
      proposed_ranking: p.proposedRanking,
      proposed_at: p.proposedAt ?? null,
    },
    p.summary ?? `组别 ${p.group} 裁决更正提案（第 ${p.correctionRound} 次）：${p.reason}`, o);

export const correctionSignatureAdded = (decisionId, p, o) =>
  makeEvent("CORRECTION_SIGNATURE_ADDED", "group_decision", decisionId,
    {
      decision_id: decisionId,
      group: p.group,
      correction_round: p.correctionRound,
      signer_id: p.signerId,
      signer_role: p.signerRole,
      signed_at: p.signedAt ?? null,
    },
    p.summary ?? `更正签署：第 ${p.correctionRound} 次，${p.signerRole} ${p.signerId}`, o);

export const correctionPublished = (decisionId, p, ranking, o) =>
  makeEvent("CORRECTION_PUBLISHED", "group_decision", decisionId,
    {
      decision_id: decisionId,
      group: p.group,
      correction_round: p.correctionRound,
      ranking,
      appeal_id: p.appealId ?? null,
      published_at: p.publishedAt ?? null,
    },
    p.summary ?? `组别 ${p.group} 第 ${p.correctionRound} 次裁决更正公布（追加，不改写原公布）`, o);

/* ---------------- 请求幂等 ---------------- */

export const requestSeen = (requestKey, p, o) =>
  makeEvent("REQUEST_SEEN", "request_log", `request/${requestKey}`,
    {
      request_key: requestKey,
      request_no: p.requestNo,
      body_hash: p.bodyHash,
      duplicate_of: p.duplicateOf ?? null,
      conflict_with: p.conflictWith ?? null,
      command: p.command,
      produced_event_ids: p.producedEventIds ?? [],
      seen_at: p.seenAt ?? null,
    },
    p.summary ?? `请求 ${p.requestNo} 已登记（${p.command}）`, o);
