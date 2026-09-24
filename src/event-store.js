import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 仅追加事件存储：事件一经接收不可原地改写，业务更正只能产生后继事件。
 *
 * 命令以事务方式写入：append 先进入待提交缓冲，由 ReviewService 在业务校验
 * 与重复判定全部通过后 commit 落盘；校验失败或命中重复时 rollback 丢弃缓冲，
 * 已提交的历史事件不受影响。进程重启后用 recover() 重放。
 */
export class EventStore {
  #events = [];
  #seq = 0;
  #filePath = null;
  #pending = [];
  #writeChain = Promise.resolve();

  constructor({ filePath } = {}) {
    this.#filePath = filePath ?? null;
  }

  /** 从磁盘重放历史日志；崩溃恢复后状态与截止时间按原记录继续。 */
  async recover() {
    if (!this.#filePath || !existsSync(this.#filePath)) return [];
    const raw = await readFile(this.#filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    const recovered = [];
    for (const line of lines) {
      const event = JSON.parse(line);
      this.#events.push(event);
      this.#seq = Math.max(this.#seq, event.seq ?? 0);
      recovered.push(event);
    }
    return recovered;
  }

  /** 追加到当前事务缓冲；commit 前对崩溃/重复/校验失败均可回滚。 */
  append(event) {
    this.#seq += 1;
    const stored = { seq: this.#seq, ...event };
    this.#pending.push(stored);
    return stored;
  }

  /** 提交事务：事件进入内存历史并串行排队写入 JSONL。 */
  async commit() {
    if (this.#pending.length === 0) return;
    const chunk = this.#pending;
    this.#pending = [];
    this.#events.push(...chunk);
    if (this.#filePath) {
      const text = chunk.map((e) => JSON.stringify(e)).join("\n") + "\n";
      this.#writeChain = this.#writeChain
        .then(async () => {
          await mkdir(dirname(this.#filePath), { recursive: true });
          await appendFile(this.#filePath, text);
        });
    }
  }

  /** 放弃当前事务缓冲（命令校验失败或命中重复请求）。 */
  rollback() {
    const dropped = this.#pending;
    this.#pending = [];
    if (dropped.length) this.#seq -= dropped.length;
    return dropped;
  }

  /** 事务之外直接提交一条事件（用于幂等/冲突审计记录）。 */
  commitDirect(event) {
    this.#seq += 1;
    const stored = { seq: this.#seq, ...event };
    this.#events.push(stored);
    if (this.#filePath) {
      this.#writeChain = this.#writeChain
        .then(async () => {
          await mkdir(dirname(this.#filePath), { recursive: true });
          await appendFile(this.#filePath, JSON.stringify(stored) + "\n");
        });
    }
    return stored;
  }

  /** 等待所有已提交的落盘完成；崩溃恢复演示前调用。 */
  async flush() {
    await this.#writeChain;
  }

  all() {
    return this.#events.slice();
  }

  /** 供投影使用的只读迭代。 */
  *[Symbol.iterator]() {
    for (const event of this.#events) yield event;
  }

  get size() {
    return this.#events.length;
  }
}
