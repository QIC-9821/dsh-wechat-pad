import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function send(res, status, body) {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function headerValue(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 协议端 webhook 的 HTTP 处理：校验 → 立刻 200 → 异步交给 bridge。
 *
 * 校验方式（配置了 webhookSecret 才会启用）：
 * - 请求头 x-pad-secret / x-webhook-secret 等于配置值；或
 * - 查询串 ?secret=… 等于配置值；或
 * - 请求头 x-pad-signature 是 body 的 HMAC-SHA256（hex）。
 */
export function createHookHandler({ cfg, bridge, store, logger, onPayload }) {
  const log = logger ?? console;

  return async function hookHandler(req, res) {
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }

    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > cfg.maxBodyBytes) {
          send(res, 413, { ok: false, error: 'payload-too-large' });
          return;
        }
        chunks.push(chunk);
      }
    } catch (error) {
      send(res, 400, { ok: false, error: `read-failed:${error?.message ?? error}` });
      return;
    }

    const raw = Buffer.concat(chunks);
    if (cfg.webhookSecret) {
      const headerSecret = headerValue(req.headers, 'x-pad-secret') ?? headerValue(req.headers, 'x-webhook-secret');
      const query = new URL(req.url ?? '/', 'http://127.0.0.1');
      const querySecret = query.searchParams.get('secret');
      const signature = headerValue(req.headers, 'x-pad-signature');
      let ok = false;
      if (headerSecret && safeEqual(headerSecret, cfg.webhookSecret)) ok = true;
      if (!ok && querySecret && safeEqual(querySecret, cfg.webhookSecret)) ok = true;
      if (!ok && signature) {
        const expected = createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex');
        ok = safeEqual(signature.replace(/^sha256=/i, ''), expected);
      }
      if (!ok) {
        store?.bump('hook:rejected');
        send(res, 401, { ok: false, error: 'bad-secret' });
        return;
      }
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      store?.bump('hook:bad-json');
      send(res, 400, { ok: false, error: 'bad-json' });
      return;
    }

    store?.bump('hook:received');
    // 先回 200：协议端重试是因为没收到响应，处理慢不能拖累它。
    send(res, 200, { ok: true });
    queueMicrotask(() => {
      try {
        const handled = onPayload ? onPayload(payload) : bridge.handlePayload(payload);
        if (typeof handled === 'number' && handled === 0 && cfg.logRawPayloads) {
          log.info?.(`[wechat-pad] 载荷里没解析出消息：${raw.toString('utf8').slice(0, 600)}`);
        }
      } catch (error) {
        store?.bump('hook:error');
        log.error?.(`[wechat-pad] 处理 webhook 失败：${error?.stack ?? error}`);
      }
    });
  };
}
