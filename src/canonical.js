import { createHash } from "node:crypto";

/**
 * 规范化请求：剔除信封与幂等字段后做稳定序列化，
 * 用于识别“完全相同的重复请求”（含无编号的请求）。
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** 计算业务意图的指纹：同号同内容 / 无号但完全相同 都视为重复。 */
export function fingerprint(payload) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** 判断两个时间戳（ISO 字符串或 Date）先后：a 是否严格晚于 b。 */
export function isAfter(a, b) {
  return new Date(a).getTime() > new Date(b).getTime();
}

/** 当前 ISO 时间；演示中可通过 ReviewService 的 clock 注入固定时间。 */
export function nowIso() {
  return new Date().toISOString();
}
