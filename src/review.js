/**
 * 记者选拔复核服务。
 *
 * 设计要点：
 * - 事件溯源：状态完全由追加事件重放得到，重启后按原截止时间继续运行。
 * - 材料按版本保存；评委受派时冻结当时已申报利益关系。
 * - 迟到利益关系只暂停受影响评分（保留原记录与理由），不删除任何事件。
 * - 替补由不同于原评委所属机构的机构批准；替补意见对原评委不可见。
 * - 各组独立排序；资格结论可跨组复用，评分严格按组隔离。
 * - 申诉必须指向具体材料版本或程序事件；重新评分与最终裁决均需两名不同角色签署。
 * - 公布后的决定只能追加更正；同编号请求识别重复与异内容冲突。
 */
import { createHash } from "node:crypto";

import * as E from "./events.js";

export class ReviewError extends Error {}

const iso = (v) => new Date(v).getTime();

export function hashBody(body) {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export class ReviewService {
  /**
   * @param {import("./store.js").EventStore} store
   * @param {{ now?: () => string }} [opts]
   */
  constructor(store, opts = {}) {
    this.store = store;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.#rebuild();
  }

  /* ============================== 状态与重放 ============================== */

  #blankState() {
    return {
      entries: new Map(),          // entryId -> {candidateId,name,groups:Set,primaryGroup}
      materials: new Map(),        // entryId -> Map(version -> payload)
      materialOrder: new Map(),    // entryId -> version[]
      interests: new Map(),        // `${entryId}|${interestId}` -> payload+kind
      qualifications: new Map(),   // entryId -> Map(group -> conclusion payload)
      assignments: new Map(),      // assignmentId -> state
      substitutes: new Map(),      // subId -> payload
      scores: new Map(),           // scoreId -> state
      incidents: new Map(),        // incidentId -> payload
      timelines: new Map(),        // group -> {recusalDeadline, appealDeadline}
      appeals: new Map(),          // appealId -> state
      decisions: new Map(),        // group -> state
      requests: new Map(),         // requestNo -> {bodyHash, command, producedEventIds}
    };
  }

  #rebuild() {
    this.s = this.#blankState();
    for (const event of this.store.events) this.#fold(event);
  }

  #fold(event) {
    const s = this.s;
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "ENTRY_ACCEPTED":
        s.entries.set(p.entry_id ?? event.aggregate_id, {
          entryId: p.entry_id ?? event.aggregate_id,
          candidateId: p.candidate_id,
          name: p.name,
          groups: new Set(p.groups),
          primaryGroup: p.primary_group,
        });
        break;

      case "MATERIAL_SUBMITTED": {
        const byEntry = s.materials.get(p.entry_id) ?? new Map();
        byEntry.set(p.material_version, { ...p });
        s.materials.set(p.entry_id, byEntry);
        const order = s.materialOrder.get(p.entry_id) ?? [];
        if (!order.includes(p.material_version)) order.push(p.material_version);
        s.materialOrder.set(p.entry_id, order);
        break;
      }

      case "INTEREST_DECLARED":
      case "LATE_INTEREST_RECEIVED": {
        const kind = event.event_type === "INTEREST_DECLARED" ? "DECLARED" : "LATE";
        s.interests.set(`${p.entry_id}|${p.interest_id}`, { ...p, kind });
        break;
      }

      case "QUALIFICATION_CONCLUDED": {
        const byEntry = s.qualifications.get(p.entry_id) ?? new Map();
        byEntry.set(p.group, { ...p });
        s.qualifications.set(p.entry_id, byEntry);
        break;
      }

      case "ASSIGNMENT_FROZEN":
        s.assignments.set(p.assignment_id, {
          assignmentId: p.assignment_id,
          group: p.group,
          judgeId: p.judge_id,
          judgeOrg: p.judge_org,
          frozenInterestIds: [...p.frozen_interest_ids],
          frozenAt: p.frozen_at,
          status: "ACTIVE",
          recusalReason: null,
          recusedAt: null,
        });
        break;

      case "RECUSAL_DECLARED": {
        const a = s.assignments.get(p.assignment_id);
        if (a) {
          a.status = "RECUSED";
          a.recusalReason = p.reason;
          a.recusedAt = p.declared_at;
        }
        break;
      }

      case "SUBSTITUTE_APPROVED":
        s.substitutes.set(p.substitute_assignment_id, { ...p });
        s.assignments.set(p.substitute_assignment_id, {
          assignmentId: p.substitute_assignment_id,
          group: p.group,
          judgeId: p.substitute_judge_id,
          judgeOrg: p.substitute_org,
          frozenInterestIds: [],
          frozenAt: p.approved_at,
          status: "ACTIVE",
          recusalReason: null,
          recusedAt: null,
          substitute: { originalAssignmentId: p.original_assignment_id, approverOrg: p.approver_org },
        });
        break;

      case "SCORE_SUBMITTED":
        s.scores.set(p.score_id, {
          scoreId: p.score_id,
          assignmentId: p.assignment_id,
          substituteAssignmentId: p.substitute_assignment_id,
          entryId: p.entry_id,
          candidateId: p.candidate_id,
          group: p.group,
          judgeId: p.judge_id,
          value: p.value,
          materialVersion: p.based_on_material_version,
          rescoreAppealId: p.rescore_appeal_id,
          status: "ACTIVE",
          suspension: null,
          replacedBy: null,
          replacedByAppeal: null,
          submittedAt: p.submitted_at,
        });
        break;

      case "SCORE_SUSPENDED": {
        const sc = s.scores.get(p.score_id);
        if (sc) {
          sc.status = "SUSPENDED";
          sc.suspension = { interestId: p.interest_id, reason: p.reason, suspendedAt: p.suspended_at };
        }
        break;
      }

      case "INCIDENT_CONFIRMED":
        s.incidents.set(p.incident_id, { ...p });
        break;

      case "TIMELINE_SET":
        s.timelines.set(p.group, { recusalDeadline: p.recusal_deadline, appealDeadline: p.appeal_deadline });
        break;

      case "APPEAL_FILED":
        s.appeals.set(p.appeal_id, {
          appealId: p.appeal_id,
          entryId: p.entry_id,
          candidateId: p.candidate_id,
          group: p.group,
          targetKind: p.target_kind,
          materialVersion: p.material_version,
          incidentId: p.incident_id,
          reason: p.reason,
          filedAt: p.filed_at,
          rescore: null,
        });
        break;

      case "RESCORE_PROPOSED": {
        const a = s.appeals.get(p.appeal_id);
        if (a) {
          a.rescore = {
            proposedValues: p.proposed_values,
            oldScoreIds: [...p.old_score_ids],
            materialVersion: p.material_version,
            proposedBy: p.proposed_by,
            reason: p.reason,
            signers: new Map(), // role -> {signerId, signedAt}
            completed: false,
            newScoreIds: [],
          };
        }
        break;
      }

      case "RESCORE_SIGNATURE_ADDED": {
        const a = s.appeals.get(p.appeal_id);
        if (a?.rescore) a.rescore.signers.set(p.signer_role, { signerId: p.signer_id, signedAt: p.signed_at });
        break;
      }

      case "RESCORE_COMPLETED": {
        const a = s.appeals.get(p.appeal_id);
        if (!a?.rescore) break;
        a.rescore.completed = true;
        a.rescore.newScoreIds = [...p.new_score_ids];
        for (const oldId of a.rescore.oldScoreIds) {
          const old = s.scores.get(oldId);
          if (old) {
            old.status = "REPLACED";
            old.replacedBy = [...p.new_score_ids];
            old.replacedByAppeal = p.appeal_id;
          }
        }
        break;
      }

      case "DECISION_SIGNATURE_ADDED": {
        const d = this.#decisionFor(p.group, p.decision_id);
        d.signers.push({ signerId: p.signer_id, signerRole: p.signer_role, ranking: p.ranking, signedAt: p.signed_at });
        break;
      }

      case "DECISION_FINALIZED": {
        const d = this.#decisionFor(p.group, p.decision_id);
        d.finalized = true;
        d.publishedAt = p.published_at;
        d.ranking = p.ranking;
        break;
      }

      case "DECISION_CORRECTION_PROPOSED": {
        const d = s.decisions.get(p.group);
        if (!d) break;
        d.corrections.push({
          round: p.correction_round,
          reason: p.reason,
          appealId: p.appeal_id,
          proposedBy: p.proposed_by,
          proposedRanking: p.proposed_ranking,
          proposedAt: p.proposed_at,
          signers: [],
          published: false,
          ranking: null,
          publishedAt: null,
        });
        break;
      }

      case "CORRECTION_SIGNATURE_ADDED": {
        const d = s.decisions.get(p.group);
        const c = d?.corrections.find((x) => x.round === p.correction_round);
        if (c) c.signers.push({ signerId: p.signer_id, signerRole: p.signer_role, signedAt: p.signed_at });
        break;
      }

      case "CORRECTION_PUBLISHED": {
        const d = s.decisions.get(p.group);
        const c = d?.corrections.find((x) => x.round === p.correction_round);
        if (c) {
          c.published = true;
          c.ranking = p.ranking;
          c.publishedAt = p.published_at;
        }
        break;
      }

      case "REQUEST_SEEN":
        s.requests.set(p.request_no, {
          requestNo: p.request_no,
          bodyHash: p.body_hash,
          command: p.command,
          duplicateOf: p.duplicate_of,
          conflictWith: p.conflict_with,
          producedEventIds: [...p.produced_event_ids],
          seenAt: p.seen_at,
        });
        break;
    }
  }

  #decisionFor(group, decisionId) {
    let d = this.s.decisions.get(group);
    if (!d) {
      d = { decisionId, group, signers: [], finalized: false, ranking: null, publishedAt: null, corrections: [] };
      this.s.decisions.set(group, d);
    }
    d.decisionId = decisionId;
    return d;
  }

  /* ============================== 提交与幂等 ============================== */

  /**
   * 执行一个命令并原子追加事件。
   * requestNo 非空时：完全相同的重复请求直接回放原结果；同编号异内容拒绝。
   */
  async #commit(requestNo, command, build) {
    if (requestNo != null) {
      const seen = this.s.requests.get(requestNo);
      const bodyHash = hashBody(command.body);
      if (seen) {
        if (seen.bodyHash === bodyHash) {
          return { duplicate: true, requestNo, events: seen.producedEventIds.map((id) => this.store.events.find((e) => e.event_id === id)).filter(Boolean) };
        }
        throw new ReviewError(`请求编号冲突：${requestNo} 已用于不同内容（原命令 ${seen.command}）`);
      }
      const events = build(bodyHash);
      const log = E.requestSeen(requestNo, {
        requestNo,
        bodyHash,
        command: command.name,
        producedEventIds: events.map((e) => e.event_id),
        seenAt: this.now(),
        summary: `登记请求 ${requestNo}（${command.name}）`,
      }, { occurredAt: this.now() });
      await this.store.append([...events, log]);
      for (const event of [...events, log]) this.#fold(event);
      return { duplicate: false, requestNo, events };
    }
    const events = build(null);
    await this.store.append(events);
    // 追加成功后才把事件折入内存状态：构建器本身无副作用，校验失败不留痕迹。
    for (const event of events) this.#fold(event);
    return { duplicate: false, requestNo: null, events };
  }

  /* ============================== 命令：报名/材料/关系 ============================== */

  async acceptEntry(p, requestNo = null) {
    return this.#commit(requestNo, { name: "acceptEntry", body: p }, () => {
      if (!p.entryId || !p.candidateId || !Array.isArray(p.groups) || p.groups.length === 0) {
        throw new ReviewError("报名缺少 entryId/candidateId/groups");
      }
      if (this.s.entries.has(p.entryId)) throw new ReviewError(`报名已存在：${p.entryId}`);
      const primaryGroup = p.primaryGroup ?? p.groups[0];
      if (!p.groups.includes(primaryGroup)) throw new ReviewError("主组别必须在申报组别内");
      return [E.entryAccepted(p.entryId, { ...p, primaryGroup }, { occurredAt: this.now() })];
    });
  }

  async submitMaterial(p, requestNo = null) {
    return this.#commit(requestNo, { name: "submitMaterial", body: p }, () => {
      const entry = this.#requireEntry(p.entryId);
      if (!Number.isInteger(p.materialVersion) || p.materialVersion < 1) throw new ReviewError("材料版本必须为正整数");
      const versions = this.s.materialOrder.get(p.entryId) ?? [];
      if (versions.includes(p.materialVersion)) throw new ReviewError(`材料版本已存在：${p.materialVersion}（版本不可覆盖）`);
      return [E.materialSubmitted(p.entryId, { ...p, candidateId: entry.candidateId }, { occurredAt: this.now() })];
    });
  }

  async declareInterest(p, requestNo = null) {
    return this.#commit(requestNo, { name: "declareInterest", body: p }, () => {
      const entry = this.#requireEntry(p.entryId);
      const key = `${p.entryId}|${p.interestId}`;
      if (this.s.interests.has(key)) throw new ReviewError(`利益关系已申报：${p.interestId}`);
      return [E.interestDeclared(p.entryId, { ...p, candidateId: entry.candidateId }, { occurredAt: this.now() })];
    });
  }

  /* ============================== 命令：资格结论（可跨组复用） ============================== */

  async concludeQualification(p, requestNo = null) {
    return this.#commit(requestNo, { name: "concludeQualification", body: p }, () => {
      const entry = this.#requireEntry(p.entryId);
      if (!entry.groups.has(p.group)) throw new ReviewError(`候选人未申报组别 ${p.group}`);
      if (!["ELIGIBLE", "INELIGIBLE"].includes(p.conclusion)) throw new ReviewError("资格结论必须为 ELIGIBLE 或 INELIGIBLE");
      this.#requireMaterial(p.entryId, p.basisMaterialVersion);
      if (!p.concludedBy || !p.approvedBy) throw new ReviewError("资格结论需要结论人与批准人");

      // 跨组兼报复用：结论内容与依据一致时允许直接复用另一组的资格结论。
      let reusedFromGroup = null;
      if (p.reusedFromGroup) {
        if (p.reusedFromGroup === p.group) throw new ReviewError("复用来源不能是本组别");
        const source = (this.s.qualifications.get(p.entryId) ?? new Map()).get(p.reusedFromGroup);
        if (!source) throw new ReviewError(`组别 ${p.reusedFromGroup} 尚无资格结论可复用`);
        if (source.conclusion !== p.conclusion || source.basis_material_version !== p.basisMaterialVersion) {
          throw new ReviewError("复用的资格结论或依据材料版本不一致，不能共用");
        }
        reusedFromGroup = p.reusedFromGroup;
      }
      return [E.qualificationConcluded(p.entryId, { ...p, candidateId: entry.candidateId, reusedFromGroup }, { occurredAt: this.now() })];
    });
  }

  /* ============================== 命令：受派冻结/迟到关系/回避/替补 ============================== */

  async assignJudge(p, requestNo = null) {
    return this.#commit(requestNo, { name: "assignJudge", body: p }, () => {
      if (this.s.assignments.has(p.assignmentId)) throw new ReviewError(`评委受派已存在：${p.assignmentId}`);
      const frozenAt = p.frozenAt ?? this.now();
      // 冻结时点：仅收录当时已申报（DECLARED）且不晚于冻结时间的利益关系。
      const frozenInterestIds = [];
      for (const [key, rel] of this.s.interests) {
        if (rel.kind !== "DECLARED" || rel.judge_id !== p.judgeId) continue;
        if (rel.entry_id && !this.#entryInGroup(rel.entry_id, p.group)) continue;
        const declaredAt = rel.declared_at ?? rel.received_at;
        if (declaredAt && iso(declaredAt) > iso(frozenAt)) continue;
        frozenInterestIds.push(rel.interest_id);
      }
      return [E.assignmentFrozen(p.assignmentId, {
        group: p.group, judgeId: p.judgeId, judgeOrg: p.judgeOrg,
        frozenInterestIds, frozenAt,
      }, { occurredAt: this.now() })];
    });
  }

  async receiveLateInterest(p, requestNo = null) {
    return this.#commit(requestNo, { name: "receiveLateInterest", body: p }, () => {
      const entry = this.#requireEntry(p.entryId);
      const key = `${p.entryId}|${p.interestId}`;
      if (this.s.interests.has(key)) throw new ReviewError(`利益关系已存在：${p.interestId}`);
      const receivedAt = p.receivedAt ?? this.now();

      const events = [E.lateInterestReceived(p.entryId, { ...p, candidateId: entry.candidateId, receivedAt }, { occurredAt: this.now() })];

      // 只暂停受影响的、仍有效的评分；原 SCORE_SUBMITTED 记录保留不删。
      const affected = [...this.s.scores.values()].filter(
        (sc) => sc.entryId === p.entryId && sc.judgeId === p.judgeId && sc.status === "ACTIVE",
      );
      for (const sc of affected) {
        events.push(E.scoreSuspended(sc.scoreId, {
          assignmentId: sc.assignmentId,
          entryId: sc.entryId,
          candidateId: sc.candidateId,
          group: sc.group,
          judgeId: sc.judgeId,
          value: sc.value,
          interestId: p.interestId,
          reason: p.reason || `迟到利益关系 ${p.interestId}：初评后收到，暂停该评委相关评分`,
          suspendedAt: receivedAt,
        }, { occurredAt: this.now() }));
      }
      return events;
    });
  }

  async confirmRecusal(p, requestNo = null) {
    return this.#commit(requestNo, { name: "confirmRecusal", body: p }, () => {
      const a = this.s.assignments.get(p.assignmentId);
      if (!a) throw new ReviewError(`评委受派不存在：${p.assignmentId}`);
      if (a.status === "RECUSED") throw new ReviewError("该受派已回避");
      const timeline = this.s.timelines.get(a.group);
      const at = p.declaredAt ?? this.now();
      if (timeline?.recusalDeadline && iso(at) > iso(timeline.recusalDeadline)) {
        throw new ReviewError(`已超过组别 ${a.group} 回避确认截止时间 ${timeline.recusalDeadline}`);
      }
      return [E.recusalDeclared(p.assignmentId, {
        assignmentId: p.assignmentId, group: a.group, judgeId: a.judgeId,
        reason: p.reason, declaredAt: at,
      }, { occurredAt: this.now() })];
    });
  }

  async approveSubstitute(p, requestNo = null) {
    return this.#commit(requestNo, { name: "approveSubstitute", body: p }, () => {
      const original = this.s.assignments.get(p.originalAssignmentId);
      if (!original) throw new ReviewError(`原评委受派不存在：${p.originalAssignmentId}`);
      if (original.status !== "RECUSED") throw new ReviewError("原评委尚未回避，不能批准替补");
      if (this.s.assignments.has(p.substituteAssignmentId)) throw new ReviewError("替补受派已存在");
      if (p.substituteJudgeId === original.judgeId) throw new ReviewError("替补评委不能与原评委为同一人");
      // 替补人选必须由不同机构批准（批准方既不是原评委机构，也不是替补本人机构）。
      if (!p.approverOrg || p.approverOrg === original.judgeOrg) {
        throw new ReviewError("替补须由不同于原评委所属机构的机构批准");
      }
      if (p.approverOrg === p.substituteOrg) throw new ReviewError("批准机构不能与替补评委所属机构相同");
      return [E.substituteApproved(p.substituteAssignmentId, {
        ...p, group: original.group, originalJudgeId: original.judgeId,
        approvedAt: p.approvedAt ?? this.now(),
      }, { occurredAt: this.now() })];
    });
  }

  /** 替补意见对原评委不可见：原评委查询时返回 null。 */
  substituteView(subId, viewerId) {
    const sub = this.s.substitutes.get(subId);
    if (!sub) return null;
    if (viewerId === sub.original_judge_id) return null;
    return {
      substituteAssignmentId: sub.substitute_assignment_id,
      group: sub.group,
      substituteJudgeId: sub.substitute_judge_id,
      substituteOrg: sub.substitute_org,
      approverOrg: sub.approver_org,
      approvedAt: sub.approved_at,
      note: sub.note,
    };
  }

  /* ============================== 命令：评分（按组隔离） ============================== */

  async submitScore(p, requestNo = null) {
    return this.#commit(requestNo, { name: "submitScore", body: p }, () => {
      const entry = this.#requireEntry(p.entryId);
      if (!entry.groups.has(p.group)) throw new ReviewError(`候选人未申报组别 ${p.group}`);
      const a = this.s.assignments.get(p.assignmentId);
      if (!a) throw new ReviewError(`评委受派不存在：${p.assignmentId}`);
      if (a.group !== p.group) throw new ReviewError(`评分跨组：受派属于组别 ${a.group}，不能给组别 ${p.group} 评分`);
      if (a.status === "RECUSED") throw new ReviewError("该评委已回避，不能提交评分");
      if (p.judgeId !== a.judgeId) throw new ReviewError("评分评委与受派评委不一致");
      this.#requireMaterial(p.entryId, p.basedOnMaterialVersion);
      // 迟到关系到达后，原评委不得再就该候选人评分。
      const blocked = [...this.s.interests.values()].find(
        (r) => r.kind === "LATE" && r.entry_id === p.entryId && r.judge_id === p.judgeId,
      );
      if (blocked) throw new ReviewError(`存在迟到利益关系 ${blocked.interest_id}，该评委对此候选人的评分通道已关闭`);
      if (typeof p.value !== "number") throw new ReviewError("评分必须为数值");
      if (this.s.scores.has(p.scoreId)) throw new ReviewError(`评分已存在：${p.scoreId}`);
      return [E.scoreSubmitted(p.scoreId, {
        ...p, candidateId: entry.candidateId,
        substituteAssignmentId: a.substitute ? a.assignmentId : null,
        submittedAt: p.submittedAt ?? this.now(),
      }, { occurredAt: this.now() })];
    });
  }

  /* ============================== 命令：程序事件与时间线 ============================== */

  async confirmIncident(p, requestNo = null) {
    return this.#commit(requestNo, { name: "confirmIncident", body: p }, () => {
      if (this.s.incidents.has(p.incidentId)) throw new ReviewError(`程序事件已确认：${p.incidentId}`);
      if (p.entryId) this.#requireEntry(p.entryId);
      return [E.incidentConfirmed(p.incidentId, { ...p, confirmedAt: p.confirmedAt ?? this.now() }, { occurredAt: this.now() })];
    });
  }

  async setTimeline(p, requestNo = null) {
    return this.#commit(requestNo, { name: "setTimeline", body: p }, () => {
      if (!p.group || !p.recusalDeadline || !p.appealDeadline) throw new ReviewError("时间线缺少组别或截止时间");
      if (iso(p.appealDeadline) < iso(p.recusalDeadline)) throw new ReviewError("申诉截止时间不应早于回避确认截止时间");
      return [E.timelineSet(p.group, p, { occurredAt: this.now() })];
    });
  }

  /* ============================== 命令：申诉/重新评分（双角色签署） ============================== */

  async fileAppeal(p, requestNo = null) {
    return this.#commit(requestNo, { name: "fileAppeal", body: p }, () => {
      const entry = this.#requireEntry(p.entryId);
      if (!entry.groups.has(p.group)) throw new ReviewError(`候选人未申报组别 ${p.group}`);
      if (this.s.appeals.has(p.appealId)) throw new ReviewError(`申诉已存在：${p.appealId}`);
      if (!["MATERIAL_VERSION", "INCIDENT"].includes(p.targetKind)) throw new ReviewError("申诉必须指向具体材料版本或程序事件");
      if (p.targetKind === "MATERIAL_VERSION") {
        if (p.materialVersion == null) throw new ReviewError("材料版本申诉必须给出 materialVersion");
        this.#requireMaterial(p.entryId, p.materialVersion);
      } else {
        const inc = this.s.incidents.get(p.incidentId);
        if (!inc) throw new ReviewError(`程序事件不存在：${p.incidentId}`);
        if (inc.group && inc.group !== p.group) throw new ReviewError("程序事件不属于申诉组别");
        if (inc.entry_id && inc.entry_id !== p.entryId) throw new ReviewError("程序事件与申诉候选人不一致");
      }
      const timeline = this.s.timelines.get(p.group);
      const at = p.filedAt ?? this.now();
      if (timeline?.appealDeadline && iso(at) > iso(timeline.appealDeadline)) {
        throw new ReviewError(`已超过组别 ${p.group} 申诉截止时间 ${timeline.appealDeadline}`);
      }
      return [E.appealFiled(p.appealId, { ...p, candidateId: entry.candidateId, filedAt: at }, { occurredAt: this.now() })];
    });
  }

  async proposeRescore(p, requestNo = null) {
    return this.#commit(requestNo, { name: "proposeRescore", body: p }, () => {
      const appeal = this.#requireAppeal(p.appealId);
      if (appeal.rescore) throw new ReviewError("该申诉已有重新评分提案");
      if (!Array.isArray(p.oldScoreIds) || p.oldScoreIds.length === 0) throw new ReviewError("重新评分必须指明被替代的原评分");
      for (const scoreId of p.oldScoreIds) {
        const sc = this.s.scores.get(scoreId);
        if (!sc) throw new ReviewError(`评分不存在：${scoreId}`);
        if (sc.group !== appeal.group || sc.entryId !== appeal.entryId) {
          throw new ReviewError(`评分 ${scoreId} 不属于申诉组别/候选人，评分按组隔离`);
        }
        if (sc.status !== "ACTIVE") throw new ReviewError(`评分 ${scoreId} 当前状态 ${sc.status}，不能重新评分`);
      }
      if (!Array.isArray(p.proposedValues) || p.proposedValues.length !== p.oldScoreIds.length) {
        throw new ReviewError("提议分值数量必须与原评分一一对应");
      }
      if (p.proposedValues.some((v) => typeof v !== "number")) throw new ReviewError("提议分值必须全部为数值");
      this.#requireMaterial(appeal.entryId, p.materialVersion);
      return [E.rescoreProposed(p.appealId, {
        appealId: p.appealId,
        group: appeal.group,
        entryId: appeal.entryId,
        oldScoreIds: p.oldScoreIds,
        proposedValues: p.proposedValues,
        materialVersion: p.materialVersion,
        proposedBy: p.proposedBy,
        reason: p.reason ?? "",
      }, { occurredAt: this.now() })];
    });
  }

  /**
   * 重新评分签署。第二名不同角色签署即完成：原评分置为 REPLACED，
   * 产生新的 SCORE_SUBMITTED（带 rescore_appeal_id），仅影响申诉所在组。
   */
  async addRescoreSignature(p, requestNo = null) {
    return this.#commit(requestNo, { name: "addRescoreSignature", body: p }, () => {
      const appeal = this.#requireAppeal(p.appealId);
      if (!appeal.rescore || appeal.rescore.completed) throw new ReviewError("没有待签署的重新评分提案");
      const signers = appeal.rescore.signers;
      this.#assertFreshSigner(signers, p.signerId, p.signerRole);

      const events = [E.rescoreSignatureAdded(p.appealId, {
        appealId: p.appealId, signerId: p.signerId, signerRole: p.signerRole, signedAt: this.now(),
      }, { occurredAt: this.now() })];

      if (signers.size === 1) {
        // 本次签署后满足两名不同角色 → 完成重评。
        const newScoreIds = [];
        const newScoreEvents = [];
        appeal.rescore.oldScoreIds.forEach((oldId, i) => {
          const old = this.s.scores.get(oldId);
          const newValue = appeal.rescore.proposedValues[i];
          const newId = `${p.appealId}/rescore/${i + 1}`;
          newScoreIds.push(newId);
          newScoreEvents.push(E.scoreSubmitted(newId, {
            scoreId: newId,
            assignmentId: old.assignmentId,
            entryId: old.entryId,
            candidateId: old.candidateId,
            group: old.group,
            judgeId: old.judgeId,
            value: newValue,
            basedOnMaterialVersion: appeal.rescore.materialVersion,
            rescoreAppealId: p.appealId,
            submittedAt: this.now(),
          }, { occurredAt: this.now() }));
        });
        events.push(E.rescoreCompleted(p.appealId, {
          appealId: p.appealId, group: appeal.group, entryId: appeal.entryId,
          materialVersion: appeal.rescore.materialVersion, completedAt: this.now(),
        }, newScoreIds, { occurredAt: this.now() }));
        events.push(...newScoreEvents);
      }
      return events;
    });
  }

  /* ============================== 命令：组裁决（双角色签署后公布） ============================== */

  async signDecision(p, requestNo = null) {
    return this.#commit(requestNo, { name: "signDecision", body: p }, () => {
      if (!this.s.timelines.has(p.group)) throw new ReviewError(`组别 ${p.group} 未设置时间线`);
      const d = this.#decisionFor(p.group, p.decisionId);
      if (d.finalized) throw new ReviewError("裁决已公布，不能再签署；更正须走追加更正流程");
      this.#assertFreshSigner(new Map(d.signers.map((x) => [x.signerRole, x])), p.signerId, p.signerRole);
      // 第一名签署时冻结当前排名快照；第二名签署时排名必须未变化。
      const ranking = this.computeRanking(p.group);
      if (d.signers.length === 1 && JSON.stringify(d.signers[0].ranking) !== JSON.stringify(ranking)) {
        throw new ReviewError("自第一名签署以来有效评分发生变化，不能按原排名完成签署");
      }
      return [E.decisionSignatureAdded(p.decisionId, {
        decisionId: p.decisionId, group: p.group,
        round: 1, signerId: p.signerId, signerRole: p.signerRole,
        ranking, signedAt: this.now(),
      }, { occurredAt: this.now() })];
    });
  }

  async finalizeDecision(p, requestNo = null) {
    return this.#commit(requestNo, { name: "finalizeDecision", body: p }, () => {
      const d = this.s.decisions.get(p.group);
      if (!d || d.signers.length < 2) throw new ReviewError("最终裁决须经两名不同角色签署后方可公布");
      if (d.decisionId !== p.decisionId) throw new ReviewError("裁决标识与签署记录不一致");
      if (d.finalized) throw new ReviewError("裁决已公布；只能追加更正");
      const ranking = d.signers[d.signers.length - 1].ranking;
      return [E.decisionFinalized(p.decisionId, {
        decisionId: p.decisionId, group: p.group, round: 1,
        publishedAt: this.now(),
      }, ranking, { occurredAt: this.now() })];
    });
  }

  /** 公布后的更正只能追加：提案 + 两名不同角色签署 + 公布（均为新事件）。 */
  async proposeCorrection(p, requestNo = null) {
    return this.#commit(requestNo, { name: "proposeCorrection", body: p }, () => {
      const d = this.s.decisions.get(p.group);
      if (!d?.finalized) throw new ReviewError("只有已公布的决定才能追加更正");
      if (p.appealId) {
        const appeal = this.s.appeals.get(p.appealId);
        if (!appeal || appeal.group !== p.group) throw new ReviewError("更正引用的申诉不存在或不属于该组");
        if (!appeal.rescore?.completed) throw new ReviewError("申诉尚未完成重新评分，不能据此更正");
      }
      const round = d.corrections.length + 1;
      const proposedRanking = this.computeRanking(p.group);
      return [E.decisionCorrectionProposed(d.decisionId, {
        decisionId: d.decisionId, group: p.group, correctionRound: round,
        reason: p.reason, appealId: p.appealId ?? null, proposedBy: p.proposedBy,
        proposedRanking, proposedAt: this.now(),
      }, { occurredAt: this.now() })];
    });
  }

  async addCorrectionSignature(p, requestNo = null) {
    return this.#commit(requestNo, { name: "addCorrectionSignature", body: p }, () => {
      const d = this.s.decisions.get(p.group);
      const c = d?.corrections.find((x) => x.round === p.correctionRound);
      if (!c) throw new ReviewError(`第 ${p.correctionRound} 次更正提案不存在`);
      if (c.published) throw new ReviewError("该更正已公布");
      this.#assertFreshSigner(new Map(c.signers.map((x) => [x.signerRole, x])), p.signerId, p.signerRole);

      const events = [E.correctionSignatureAdded(d.decisionId, {
        decisionId: d.decisionId, group: p.group, correctionRound: c.round,
        signerId: p.signerId, signerRole: p.signerRole, signedAt: this.now(),
      }, { occurredAt: this.now() })];

      if (c.signers.length === 1) {
        const ranking = this.computeRanking(p.group);
        if (JSON.stringify(c.proposedRanking) !== JSON.stringify(ranking)) {
          throw new ReviewError("自更正提案以来有效评分发生变化，请重新提案");
        }
        events.push(E.correctionPublished(d.decisionId, {
          decisionId: d.decisionId, group: p.group, correctionRound: c.round,
          appealId: c.appealId, publishedAt: this.now(),
        }, ranking, { occurredAt: this.now() }));
      }
      return events;
    });
  }

  /* ============================== 查询 ============================== */

  #requireEntry(entryId) {
    const entry = this.s.entries.get(entryId);
    if (!entry) throw new ReviewError(`报名不存在：${entryId}`);
    return entry;
  }

  #requireMaterial(entryId, version) {
    const pack = this.s.materials.get(entryId);
    if (!pack?.has(version)) throw new ReviewError(`材料版本不存在：${entryId}@v${version}`);
    return pack.get(version);
  }

  #entryInGroup(entryId, group) {
    return this.s.entries.get(entryId)?.groups.has(group) ?? false;
  }

  #requireAppeal(appealId) {
    const appeal = this.s.appeals.get(appealId);
    if (!appeal) throw new ReviewError(`申诉不存在：${appealId}`);
    return appeal;
  }

  /** 纯校验：不修改签署集合，状态只允许通过追加事件改变。 */
  #assertFreshSigner(signerMap, signerId, signerRole) {
    if (!signerId || !signerRole) throw new ReviewError("签署需要签署人与角色");
    if (signerMap.has(signerRole)) throw new ReviewError(`角色 ${signerRole} 已签署，两名签署人必须角色不同`);
    for (const existing of signerMap.values()) {
      if (existing.signerId === signerId) throw new ReviewError("同一签署人不能代表两个角色重复签署");
    }
  }

  /** 某组的资格结论（可能复用自另一组）。 */
  qualificationOf(entryId, group) {
    return (this.s.qualifications.get(entryId) ?? new Map()).get(group) ?? null;
  }

  /** 组内当前有效评分：ACTIVE 且候选人在该组资格合格。 */
  effectiveScores(group) {
    const result = [];
    for (const sc of this.s.scores.values()) {
      if (sc.group !== group || sc.status !== "ACTIVE") continue;
      const q = this.qualificationOf(sc.entryId, group);
      if (q?.conclusion !== "ELIGIBLE") continue;
      result.push({ ...sc });
    }
    return result;
  }

  /** 各组独立排序：组内合格候选人按有效评分均值降序，平分按候选人编号。 */
  computeRanking(group) {
    const byCandidate = new Map();
    for (const sc of this.effectiveScores(group)) {
      const bucket = byCandidate.get(sc.entryId) ?? { entryId: sc.entryId, candidateId: sc.candidateId, values: [] };
      bucket.values.push(sc.value);
      byCandidate.set(sc.entryId, bucket);
    }
    return [...byCandidate.values()]
      .map((b) => ({
        entryId: b.entryId,
        candidateId: b.candidateId,
        averageScore: Math.round((b.values.reduce((a, v) => a + v, 0) / b.values.length) * 100) / 100,
        scoreCount: b.values.length,
      }))
      .sort((a, b) => (b.averageScore - a.averageScore) || a.candidateId.localeCompare(b.candidateId))
      .map((x, i) => ({ rank: i + 1, ...x }));
  }

  /** 当前公布序列：优先最新一次已公布更正，否则原公布。 */
  currentPublishedRanking(group) {
    const d = this.s.decisions.get(group);
    if (!d?.finalized) return null;
    const published = [...d.corrections].reverse().find((c) => c.published);
    return {
      source: published ? `CORRECTION#${published.round}` : "DECISION",
      publishedAt: published ? published.publishedAt : d.publishedAt,
      ranking: published ? published.ranking : d.ranking,
    };
  }

  /**
   * 从一项分数反查它为何有效或被排除：完整事件链与当前是否计入排名。
   */
  explainScore(scoreId) {
    const sc = this.s.scores.get(scoreId);
    if (!sc) throw new ReviewError(`评分不存在：${scoreId}`);
    const trail = [];
    const submitted = this.store.events.find(
      (e) => e.event_type === "SCORE_SUBMITTED" && e.payload?.score_id === scoreId,
    );
    if (submitted) trail.push({ eventId: submitted.event_id, type: submitted.event_type, at: submitted.occurred_at, detail: submitted.summary });

    const q = this.qualificationOf(sc.entryId, sc.group);
    let status = sc.status;
    const reasons = [];

    if (sc.status === "SUSPENDED" && sc.suspension) {
      reasons.push(`因迟到利益关系 ${sc.suspension.interestId} 暂停：${sc.suspension.reason}（原评分记录保留，未删除）`);
      const susp = this.store.events.find(
        (e) => e.event_type === "SCORE_SUSPENDED" && e.payload?.score_id === scoreId,
      );
      if (susp) trail.push({ eventId: susp.event_id, type: susp.event_type, at: susp.occurred_at, detail: susp.summary });
    }
    if (sc.status === "REPLACED") {
      reasons.push(`已被申诉 ${sc.replacedByAppeal ?? "?"} 的重新评分替代，新评分：${sc.replacedBy?.join("、")}`);
      for (const e of this.store.events) {
        if ((e.event_type === "RESCORE_COMPLETED" || e.event_type === "RESCORE_PROPOSED") &&
          sc.replacedByAppeal && e.payload?.appeal_id === sc.replacedByAppeal) {
          trail.push({ eventId: e.event_id, type: e.event_type, at: e.occurred_at, detail: e.summary });
        }
      }
    }
    if (sc.status === "ACTIVE") {
      if (!q) {
        status = "EXCLUDED";
        reasons.push(`组别 ${sc.group} 尚无资格结论，暂不计入排名`);
      } else if (q.conclusion === "INELIGIBLE") {
        status = "EXCLUDED";
        reasons.push(`候选人在组别 ${sc.group} 资格结论为不合格${q.reused_from_group ? `（结论复用自组别 ${q.reused_from_group}）` : ""}，评分排除`);
      } else {
        const via = sc.rescoreAppealId ? `（由申诉 ${sc.rescoreAppealId} 重新评分产生）` : "";
        reasons.push(`资格合格（材料版本 v${q.basis_material_version}${q.reused_from_group ? `，结论复用自组别 ${q.reused_from_group}` : ""}），评分有效${via}`);
      }
    }

    const counted = status === "ACTIVE";
    return {
      scoreId,
      group: sc.group,
      entryId: sc.entryId,
      candidateId: sc.candidateId,
      judgeId: sc.judgeId,
      value: sc.value,
      materialVersion: sc.materialVersion,
      assignmentId: sc.assignmentId,
      effectiveStatus: status,           // ACTIVE | SUSPENDED | REPLACED | EXCLUDED
      countedInRanking: counted,
      reasons,
      eventTrail: trail,
    };
  }

  getRequestStatus(requestNo) {
    return this.s.requests.get(requestNo) ?? null;
  }

  getTimeline(group) {
    return this.s.timelines.get(group) ?? null;
  }

  getDecisionView(group) {
    const d = this.s.decisions.get(group);
    if (!d) return null;
    return {
      group,
      decisionId: d.decisionId,
      finalized: d.finalized,
      publishedAt: d.publishedAt,
      signers: d.signers.map((x) => ({ signerId: x.signerId, signerRole: x.signerRole, signedAt: x.signedAt })),
      corrections: d.corrections.map((c) => ({
        round: c.round, reason: c.reason, appealId: c.appealId,
        signers: c.signers.map((x) => `${x.signerRole}:${x.signerId}`),
        published: c.published, publishedAt: c.publishedAt,
      })),
      current: this.currentPublishedRanking(group),
    };
  }
}
