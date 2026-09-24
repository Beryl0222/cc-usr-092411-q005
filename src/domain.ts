/** 记者选拔回避与复核使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 业务字段统一放在 payload；信封本身只承载标识、时间与版本。 */
  payload?: Record<string, unknown>;
}

/**
 * 事件类型（只追加，不改写；更正通过后继事件表达）：
 *
 * 报名与材料：ENTRY_ACCEPTED / MATERIAL_SUBMITTED / INTEREST_DECLARED /
 *             QUALIFICATION_CONCLUDED
 * 受派与回避：ASSIGNMENT_FROZEN（受派时冻结已申报关系）/
 *             LATE_INTEREST_RECEIVED（迟到关系）/ SCORE_SUSPENDED（暂停，原记录保留）/
 *             RECUSAL_DECLARED / SUBSTITUTE_APPROVED（不同机构批准，对原评委不可见）
 * 评分：SCORE_SUBMITTED（按组隔离；重评分产生新评分并标记旧评分为 REPLACED）
 * 程序：INCIDENT_CONFIRMED / TIMELINE_SET（各组回避与申诉截止时间）
 * 复核：APPEAL_FILED（须指向材料版本或程序事件）/ RESCORE_PROPOSED /
 *       RESCORE_SIGNATURE_ADDED（两名不同角色签署）/ RESCORE_COMPLETED
 * 终局：DECISION_SIGNATURE_ADDED / DECISION_FINALIZED /
 *       DECISION_CORRECTION_PROPOSED / CORRECTION_SIGNATURE_ADDED /
 *       CORRECTION_PUBLISHED（公布后只能追加更正）
 * 请求登记：REQUEST_SEEN（完全重复回放、同编号异内容冲突）
 */
export type DomainEventType =
  | "ENTRY_ACCEPTED"
  | "QUALIFICATION_CONCLUDED"
  | "MATERIAL_SUBMITTED"
  | "INTEREST_DECLARED"
  | "ASSIGNMENT_FROZEN"
  | "LATE_INTEREST_RECEIVED"
  | "SCORE_SUSPENDED"
  | "RECUSAL_DECLARED"
  | "SUBSTITUTE_APPROVED"
  | "SCORE_SUBMITTED"
  | "INCIDENT_CONFIRMED"
  | "TIMELINE_SET"
  | "APPEAL_FILED"
  | "RESCORE_PROPOSED"
  | "RESCORE_SIGNATURE_ADDED"
  | "RESCORE_COMPLETED"
  | "DECISION_SIGNATURE_ADDED"
  | "DECISION_FINALIZED"
  | "DECISION_CORRECTION_PROPOSED"
  | "CORRECTION_SIGNATURE_ADDED"
  | "CORRECTION_PUBLISHED"
  | "REQUEST_SEEN";

export type AggregateType =
  | "candidate_entry"
  | "qualification_record"
  | "material_pack"
  | "interest_record"
  | "judging_assignment"
  | "score_sheet"
  | "incident_record"
  | "group_timeline"
  | "appeal_case"
  | "group_decision"
  | "request_log";
