/** 记者选拔回避与复核使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 幂等键：同编号同内容只生效一次；同编号异内容拒绝。 */
  request_id?: string;
  /** 评审组别：各组独立排序，评分严格隔离；资格结论可跨组复用。 */
  group_id?: string;
  candidate_id?: string;
  reviewer_id?: string;
  /** 申诉与重新评分必须指向的具体材料版本。 */
  material_version?: number;
  /** 申诉可指向的程序事件标识。 */
  incident_id?: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

export type DomainEventType =
  | "ENTRY_ACCEPTED"
  | "MATERIAL_VERSION_SUBMITTED"
  | "INTEREST_DECLARED"
  | "REVIEWER_ASSIGNED"
  | "RECUSAL_DECLARED"
  | "QUALIFICATION_DECIDED"
  | "SCORE_SUBMITTED"
  | "LATE_INTEREST_RECEIVED"
  | "SCORE_SUSPENDED"
  | "SUBSTITUTE_APPROVED"
  | "INCIDENT_CONFIRMED"
  | "APPEAL_FILED"
  | "RESCORE_REQUESTED"
  | "RESCORE_SIGNED"
  | "DECISION_FINALIZED"
  | "DECISION_PUBLISHED"
  | "DECISION_CORRECTED"
  | "DEADLINE_SCHEDULED"
  | "REQUEST_REJECTED"
  | "REQUEST_DEDUPLICATED";

export type AggregateType =
  | "candidate_entry"
  | "judging_assignment"
  | "score_sheet"
  | "appeal_case"
  | "review_round"
  | "request_record";
