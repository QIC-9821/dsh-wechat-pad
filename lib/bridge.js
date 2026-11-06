import { randomUUID } from 'node:crypto';

import { policyFor } from './config.js';
import { messageText } from './harness.js';
import { normalizeWebhook } from './parse.js';

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function chunkText(text, size) {
  const source = String(text ?? '').trim();
  if (source.length <= size) return source ? [source] : [];
  const out = [];
  let rest = source;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('。', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 群消息 → DSH 会话 → 回复。
 *
 * 依赖注入的 harness 只需提供 createSession/prompt/onSessionEvent，
 * 所以这个类可以脱离宿主单测（见 test/bridge.test.mjs）。
 */
export function createBridge({ cfg, pad, store, harness, logger }) {
  const log = logger ?? console;
  const waiters = new Map(); // sessionId -> waiter
  const lastSeq = new Map(); // sessionId -> 已见的最大 seq
  const coalesce = new Map(); // groupId -> { items, timer }
  const queues = new Map(); // groupId -> { running, items }
  const rate = { global: [], perGroup: new Map() };
  let disposed = false;
  let workerActive = 0;
  const MAX_WORKERS = 2;

  const unsubscribe = harness.onSessionEvent((session, event) => {
    const sessionId = session?.id;
    if (!sessionId || !event || typeof event !== 'object') return;
    if (Number.isSafeInteger(event.seq)) {
      const previous = lastSeq.get(sessionId) ?? 0;
      if (event.seq > previous) lastSeq.set(sessionId, event.seq);
    }
    const waiter = waiters.get(sessionId);
    if (!waiter) return;
    if (Number.isSafeInteger(event.seq) && event.seq <= waiter.baseSeq) return;

    if (event.type === 'assistant/message') {
      const text = messageText(event.data);
      if (text) waiter.parts.push(text);
      return;
    }
    if (event.type === 'turn/end') {
      const kind = event.data?.reason?.kind ?? 'completed';
      if (kind === 'completed') {
        finishWaiter(sessionId, waiter.parts.join('\n\n').trim(), 'completed');
      } else {
        finishWaiter(sessionId, '', `turn-end:${kind}`);
      }
    }
  });

  function finishWaiter(sessionId, text, reason) {
    const waiter = waiters.get(sessionId);
    if (!waiter) return;
    waiters.delete(sessionId);
    clearTimeout(waiter.timer);
    waiter.resolve({ text, reason });
  }

  /** 等这一轮说完；超时交给调用方决定怎么回。 */
  function waitForAnswer(sessionId) {
    const baseSeq = lastSeq.get(sessionId) ?? 0;
    return new Promise((resolve) => {
      const waiter = {
        baseSeq,
        parts: [],
        resolve,
        timer: setTimeout(() => {
          finishWaiter(sessionId, '', 'timeout');
        }, cfg.timeoutSec * 1000),
      };
      waiter.timer.unref?.();
      waiters.set(sessionId, waiter);
    });
  }

  function allowRate(groupId, limitPerMin) {
    const now = Date.now();
    const windowStart = now - 60_000;
    rate.global = rate.global.filter((at) => at > windowStart);
    if (cfg.ratePerMinGlobal > 0 && rate.global.length >= cfg.ratePerMinGlobal) return false;
    const stamps = (rate.perGroup.get(groupId) ?? []).filter((at) => at > windowStart);
    if (limitPerMin > 0 && stamps.length >= limitPerMin) {
      rate.perGroup.set(groupId, stamps);
      return false;
    }
    stamps.push(now);
    rate.perGroup.set(groupId, stamps);
    rate.global.push(now);
    return true;
  }

  function groupLabel(message) {
    if (message.groupName) return message.groupName;
    const known = cfg.groups.find((group) => group.id === message.groupId);
    return known?.name || message.groupId;
  }

  function composePrompt(message) {
    const where = message.isGroup ? `微信群「${groupLabel(message)}」` : '微信私聊';
    const who = message.senderName || message.senderId || '对方';
    const hint = cfg.systemHint ? `${cfg.systemHint}\n\n` : '';
    return `${hint}[${where} · ${who}]\n${message.text}`;
  }

  async function ensureSession(message) {
    const key = message.groupId;
    const existing = store.binding(key);
    if (existing) return existing;
    const sessionId = await harness.createSession(cfg.workspaceDir, cfg.agentPreset);
    store.setBinding(key, sessionId, { kind: message.isGroup ? 'group' : 'direct', name: message.groupName });
    log.info?.(`[wechat-pad] 为 ${key} 建了新会话 ${sessionId}`);
    return sessionId;
  }

  async function sendReply(message, text) {
    const body = `${cfg.replyPrefix}${text}`.slice(0, cfg.maxReplyChars);
    const chunks = chunkText(body, cfg.chunkChars);
    for (let index = 0; index < chunks.length; index += 1) {
      const prefix = message.isGroup && index === 0 && message.senderName ? `@${message.senderName} ` : '';
      await pad.sendText(message.groupId, `${prefix}${chunks[index]}`);
      if (index < chunks.length - 1 && cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);
    }
  }

  async function processOne(message) {
    const sessionId = await ensureSession(message);
    const answerPromise = waitForAnswer(sessionId);
    try {
      await harness.prompt(sessionId, composePrompt(message), `wechat-pad-${randomUUID()}`);
    } catch (error) {
      finishWaiter(sessionId, '', `prompt-error:${error?.message ?? error}`);
      throw error;
    }
    const { text, reason } = await answerPromise;
    if (reason === 'timeout') {
      store.bump('timeouts');
      if (cfg.timeoutReply) await sendReply(message, cfg.timeoutReply);
      return { replied: false, reason };
    }
    if (!text) {
      store.bump('empty');
      log.warn?.(`[wechat-pad] 会话 ${sessionId} 这一轮没有正文（${reason}）`);
      return { replied: false, reason };
    }
    await sendReply(message, text);
    store.bump('replied');
    return { replied: true, reason };
  }

  function pump(groupId) {
    if (disposed) return;
    while (workerActive < MAX_WORKERS) {
      const next = [...queues.entries()].find(([, queue]) => !queue.running && queue.items.length > 0);
      if (!next) return;
      const [key, queue] = next;
      const message = queue.items.shift();
      queue.running = true;
      workerActive += 1;
      void processOne(message)
        .catch((error) => {
          store.bump('errors');
          log.error?.(`[wechat-pad] 处理 ${key} 的消息失败：${error?.message ?? error}`);
        })
        .finally(() => {
          queue.running = false;
          workerActive -= 1;
          if (queue.items.length === 0 && queues.get(key) === queue) queues.delete(key);
          pump(groupId);
        });
    }
  }

  function enqueue(message) {
    const key = message.groupId;
    const queue = queues.get(key) ?? { running: false, items: [] };
    if (queue.items.length >= cfg.queueLimit) {
      store.bump('overflow');
      log.warn?.(`[wechat-pad] ${key} 排队超过 ${cfg.queueLimit} 条，丢弃最新一条`);
      return false;
    }
    queue.items.push(message);
    queues.set(key, queue);
    pump(key);
    return true;
  }

  function handleMessage(message) {
    store.noteGroup({
      id: message.groupId,
      name: message.groupName,
      sender: message.senderName || message.senderId,
      text: message.text,
    });
    if (message.isSelf) {
      store.bump('self');
      return;
    }
    if (cfg.enabled === false) {
      store.bump('skip:disabled');
      return;
    }
    if (store.hasSeen(message.msgId, cfg.dedupeTtlSec)) {
      store.bump('duplicate');
      return;
    }
    store.markSeen(message.msgId, cfg.dedupeTtlSec);

    const policy = policyFor(cfg, { id: message.groupId, isGroup: message.isGroup });
    if (!policy.allowed) {
      store.bump(`skip:${policy.reason ?? 'policy'}`);
      return;
    }
    if (message.isGroup && policy.trigger === 'mention' && !message.atMe) {
      store.bump('skip:not-mentioned');
      return;
    }
    if (!message.text) {
      store.bump('skip:empty');
      return;
    }
    if (!allowRate(message.groupId, policy.ratePerMin)) {
      store.bump('skip:rate-limited');
      log.warn?.(`[wechat-pad] ${message.groupId} 触发限速，跳过一条`);
      return;
    }
    enqueue(message);
  }

  /** webhook 载荷入口；返回本次识别出的消息条数。 */
  function handlePayload(payload) {
    const messages = normalizeWebhook(payload, { selfWxid: cfg.selfWxid, botNames: cfg.botNames });
    for (const message of messages) {
      if (cfg.coalesceMs > 0) bufferMessage(message);
      else handleMessage(message);
    }
    return messages.length;
  }

  /**
   * 合并窗口：同一个人连发几条短消息时，等 coalesceMs 一起送进 agent。
   * 一次回复只付一次上下文，比逐条各跑一轮省得多。
   */
  function bufferMessage(message) {
    const key = message.groupId;
    const pending = coalesce.get(key);
    if (pending) {
      pending.items.push(message);
      clearTimeout(pending.timer);
    } else {
      coalesce.set(key, { items: [message], timer: 0 });
    }
    const entry = coalesce.get(key);
    entry.timer = setTimeout(() => {
      coalesce.delete(key);
      const items = entry.items;
      const last = items[items.length - 1];
      const merged = items.length === 1
        ? last
        : {
          ...last,
          text: items.map((item) => item.text).filter(Boolean).join('\n'),
          // 只要其中一条 @ 了就算 @：连着说「在吗」「帮我看个事」时不会被后半句漏掉
          atMe: items.some((item) => item.atMe),
          atList: [...new Set(items.flatMap((item) => item.atList ?? []))],
          mergedCount: items.length,
        };
      handleMessage(merged);
    }, cfg.coalesceMs);
    entry.timer.unref?.();
  }

  async function dispose() {
    disposed = true;
    try {
      unsubscribe?.();
    } catch {
      // 忽略
    }
    for (const [sessionId, waiter] of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ text: '', reason: 'disposed' });
      waiters.delete(sessionId);
    }
    for (const [, entry] of coalesce) clearTimeout(entry.timer);
    coalesce.clear();
    queues.clear();
  }

  /** 清掉会话绑定：下一次消息会新建一个干净的会话（面板上的「重开会话」）。 */
  function dropSessions() {
    const bindings = store.snapshot()?.bindings ?? {};
    const ids = Object.keys(bindings);
    for (const id of ids) store.dropBinding(id);
    return ids.length;
  }

  return {
    handlePayload,
    handleMessage,
    dispose,
    dropSessions,
    get pending() {
      return [...queues.values()].reduce((sum, queue) => sum + queue.items.length, 0);
    },
  };
}
