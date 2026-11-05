import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 插件自己的状态：群↔会话绑定、已处理消息、见过的群、统计。
 * 存成单个 JSON（tmp + rename 原子写），高频写入用节流。
 */
export class Store {
  #file;
  #logger;
  #data = null;
  #dirty = false;
  #timer = null;
  #writing = null;

  constructor(stateDir, { logger } = {}) {
    this.#file = join(stateDir, 'state.json');
    this.#logger = logger ?? console;
  }

  get file() {
    return this.#file;
  }

  async load() {
    try {
      const text = await readFile(this.#file, 'utf8');
      const parsed = JSON.parse(text);
      this.#data = {
        version: 1,
        bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
        seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
        groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
        stats: parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {},
        pad: parsed.pad && typeof parsed.pad === 'object' ? parsed.pad : {},
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#logger.warn?.(`[wechat-pad] 读取状态失败，按空状态继续：${error?.message ?? error}`);
      this.#data = { version: 1, bindings: {}, seen: {}, groups: {}, stats: {}, pad: {} };
    }
    return this.#data;
  }

  #ensure() {
    if (!this.#data) this.#data = { version: 1, bindings: {}, seen: {}, groups: {}, stats: {}, pad: {} };
    return this.#data;
  }

  snapshot() {
    return this.#ensure();
  }

  /** 只做内存改动，落盘由 scheduleSave 负责。 */
  touch() {
    this.#dirty = true;
    this.scheduleSave();
  }

  scheduleSave(delayMs = 800) {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delayMs);
    this.#timer.unref?.();
  }

  async flush() {
    if (!this.#dirty) return;
    this.#dirty = false;
    const data = this.#ensure();
    const body = `${JSON.stringify(data, null, 2)}\n`;
    if (this.#writing) await this.#writing.catch(() => undefined);
    this.#writing = (async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.#file);
    })();
    try {
      await this.#writing;
    } catch (error) {
      this.#dirty = true;
      this.#logger.warn?.(`[wechat-pad] 写状态失败：${error?.message ?? error}`);
    } finally {
      this.#writing = null;
    }
  }

  async close() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }

  // ---- 绑定 ----
  binding(groupId) {
    return this.#ensure().bindings[groupId]?.sessionId ?? '';
  }

  setBinding(groupId, sessionId, meta = {}) {
    this.#ensure().bindings[groupId] = {
      sessionId,
      updatedAt: Date.now(),
      ...meta,
    };
    this.touch();
  }

  dropBinding(groupId) {
    const data = this.#ensure();
    if (data.bindings[groupId]) {
      delete data.bindings[groupId];
      this.touch();
    }
  }

  // ---- 去重 ----
  hasSeen(msgId, ttlSec) {
    const data = this.#ensure();
    const at = data.seen[msgId];
    if (!at) return false;
    if (Date.now() - at > ttlSec * 1000) {
      delete data.seen[msgId];
      return false;
    }
    return true;
  }

  markSeen(msgId, ttlSec) {
    const data = this.#ensure();
    data.seen[msgId] = Date.now();
    const cutoff = Date.now() - ttlSec * 1000;
    for (const [key, at] of Object.entries(data.seen)) {
      if (at < cutoff) delete data.seen[key];
    }
    this.touch();
  }

  // ---- 群 ----
  noteGroup({ id, name, sender, text }) {
    if (!id) return;
    const data = this.#ensure();
    const entry = data.groups[id] ?? { name: '', lastSeen: 0, messages: 0, lastText: '' };
    if (name) entry.name = name;
    entry.lastSeen = Date.now();
    entry.messages = (entry.messages ?? 0) + 1;
    if (text) entry.lastText = String(text).slice(0, 120);
    if (sender) entry.lastSender = sender;
    data.groups[id] = entry;
    this.touch();
  }

  groups() {
    return Object.entries(this.#ensure().groups)
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  }

  // ---- 统计 ----
  bump(key, by = 1) {
    const data = this.#ensure();
    data.stats[key] = (data.stats[key] ?? 0) + by;
    data.stats.lastAt = Date.now();
    this.touch();
  }

  stats() {
    return { ...this.#ensure().stats };
  }

  // ---- 协议端自身信息 ----
  padInfo(patch = {}) {
    const data = this.#ensure();
    data.pad = { ...data.pad, ...patch };
    this.touch();
    return data.pad;
  }
}
