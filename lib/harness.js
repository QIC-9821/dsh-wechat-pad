/**
 * DSH 宿主侧适配器：在插件进程内建会话、发 prompt、订阅会话事件。
 *
 * 不用 HTTP、不用 launch token —— 插件和 agent 循环在同一个进程里，
 * 走的是 connection.createPeer + typertGateway.invoke 这条宿主内部通道。
 */

function extractSessionId(value) {
  if (!value || typeof value !== 'object') return '';
  const candidates = [
    value.sessionId,
    value.session?.id,
    value.id,
    value.value?.sessionId,
    value.session?.sessionId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return '';
}

export function createHarness(ctx, { logger } = {}) {
  const log = logger ?? console;
  const gateway = typeof ctx?.get === 'function' ? ctx.get('typertGateway') : ctx?.typertGateway;
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : ctx?.connection;
  if (!gateway || typeof gateway.invoke !== 'function') {
    throw new Error('typertGateway 不可用：插件无法与 agent 会话通信');
  }
  if (!connection || typeof connection.createPeer !== 'function') {
    throw new Error('connection 服务不可用：插件无法取得宿主调用身份');
  }

  const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });

  async function invoke(namespace, method, args, signal) {
    return gateway.invoke({
      namespace,
      method,
      args,
      peer,
      ...(signal ? { signal } : {}),
    });
  }

  return {
    peer,
    invoke,

    async createSession(cwd, agentPreset) {
      const request = { cwd };
      if (agentPreset) request.agentPreset = agentPreset;
      const value = await invoke('session', 'create', { request });
      const sessionId = extractSessionId(value);
      if (!sessionId) throw new Error(`session/create 没有返回会话 id：${JSON.stringify(value).slice(0, 200)}`);
      return sessionId;
    },

    async prompt(sessionId, text, requestId) {
      return invoke('session', 'prompt', {
        request: {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
      });
    },

    async cancel(sessionId) {
      try {
        return await invoke('session', 'cancel', { request: { sessionId } });
      } catch (error) {
        log.warn?.(`[wechat-pad] 取消会话失败：${error?.message ?? error}`);
        return undefined;
      }
    },

    /** 监听所有会话的事件；返回解除订阅的函数。 */
    onSessionEvent(handler) {
      if (typeof ctx?.on !== 'function') return () => {};
      return ctx.on('session/event', (session, event) => {
        try {
          handler(session, event);
        } catch (error) {
          log.warn?.(`[wechat-pad] 处理会话事件出错：${error?.message ?? error}`);
        }
      }, { global: true });
    },

    async dispose() {
      await Promise.resolve(peer?.dispose?.()).catch(() => undefined);
    },
  };
}

/** 从 assistant/message 事件里抽出正文（忽略 reasoning）。 */
export function messageText(data) {
  const content = data?.message?.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || block.type !== 'text') continue;
    const text = typeof block.text === 'string' ? block.text : '';
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n').trim();
}
