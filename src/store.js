/**
 * 只追加事件存储：JSONL 文件，每行一个事件信封。
 *
 * 重启后重新回放全部事件即可恢复服务状态（服务无其他持久化状态）。
 */
import { appendFile, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";

export class EventStore {
  constructor(path = null) {
    this.path = path;
    /** @type {object[]} */
    this.events = [];
    /** 已落盘的事件 id，回放/写入时去重 */
    this.knownIds = new Set();
  }

  async load() {
    if (!this.path || !existsSync(this.path)) return this.events;
    const text = await readFile(this.path, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed);
      if (this.knownIds.has(event.event_id)) continue; // 幂等回放
      this.knownIds.add(event.event_id);
      this.events.push(event);
    }
    return this.events;
  }

  /**
   * 原子地追加一批事件（先写临时文件再 rename 不适用于 append；
   * 这里整批一次性 append，崩溃时以 event_id 去重保证重放安全）。
   */
  async append(events) {
    if (events.length === 0) return;
    for (const event of events) {
      if (this.knownIds.has(event.event_id)) {
        throw new Error(`事件标识重复：${event.event_id}`);
      }
    }
    const chunk = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    if (this.path) {
      await appendFile(this.path, chunk, "utf8");
    }
    for (const event of events) {
      this.knownIds.add(event.event_id);
      this.events.push(event);
    }
  }

  /** 另存为新文件（便于演示/测试导出）。 */
  async snapshotTo(targetPath) {
    const text = this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const tmp = `${targetPath}.tmp`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(tmp, text, "utf8");
    await rename(tmp, targetPath);
  }
}
