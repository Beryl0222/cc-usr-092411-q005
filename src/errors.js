/** 业务可预期的错误类型，便于调用方按 code 区分。 */
export class DomainRuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainRuleError";
    this.code = code;
    this.details = details;
  }
}

export const CONFLICTING_REQUEST = "CONFLICTING_REQUEST";
export const DUPLICATE_REQUEST = "DUPLICATE_REQUEST";
export const ACCESS_DENIED = "ACCESS_DENIED";
export const DEADLINE_PASSED = "DEADLINE_PASSED";
export const INVALID_TARGET = "INVALID_TARGET";
export const SIGNATURE_REQUIRED = "SIGNATURE_REQUIRED";
export const ILLEGAL_STATE = "ILLEGAL_STATE";
export const NOT_FOUND = "NOT_FOUND";
