import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * 假协议端：模拟 WeChatPadPro 的登录 / 发送 / webhook 配置接口，
 * 还能反向给插件投递一条「微信群消息」，用来在不起真微信的情况下跑通全链路。
 *
 *   node test/mock-pad.mjs --port 8899
 *
 * 也可以被测试文件直接 import：const pad = await startMockPad();
 */

const QR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function json(res, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return {};
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return {};
    }
  }
  return { raw: raw.toString('utf8'), bytes: raw.length };
}

export function startMockPad({ port = 0, secret = '' } = {}) {
  const sends = [];
  const state = { webhookUrl: '', loginStatus: 'waiting', uuid: '' };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/api/v1/status') {
      json(res, 200, { code: 200, msg: 'ok', data: { version: 'mock-1.0' } });
      return;
    }

    if (path === '/api/login/GetLoginQrCodeNewX' && req.method === 'POST') {
      state.uuid = `mock-uuid-${Date.now()}`;
      json(res, 200, { code: 200, msg: 'ok', uuid: state.uuid, qrcode: QR_PNG_BASE64, qrcodeUrl: '', expireTime: 300 });
      return;
    }

    if (path === '/api/login/CheckLoginStatus') {
      const key = url.searchParams.get('key') ?? '';
      json(res, 200, {
        code: 200,
        msg: 'ok',
        logged: state.loginStatus === 'logged',
        uuid: key,
        data: state.loginStatus === 'logged' ? { userInfo: { wxid: 'wxid_mock_bot', nickName: 'MockBot' } } : null,
      });
      return;
    }

    if (path === '/api/v1/message/SendText' && req.method === 'POST') {
      const payload = await body(req);
      sends.push({ kind: 'text', to: payload.toUserName, text: payload.content, at: Date.now() });
      json(res, 200, { code: 200, msg: 'ok', data: { msgId: `mock-${sends.length}` } });
      return;
    }

    if (path === '/api/v1/message/sendFile' && req.method === 'POST') {
      const payload = await body(req);
      sends.push({ kind: 'file', to: '', bytes: payload.bytes ?? 0, at: Date.now() });
      json(res, 200, { code: 200, msg: 'ok' });
      return;
    }

    if (path === '/v1/webhook/Config' && req.method === 'POST') {
      const payload = await body(req);
      state.webhookUrl = payload.webhookUrl ?? '';
      json(res, 200, { code: 200, msg: 'ok', data: { url: state.webhookUrl } });
      return;
    }

    if (path === '/v1/webhook/Status') {
      json(res, 200, { code: 200, msg: 'ok', data: { url: state.webhookUrl } });
      return;
    }

    // --- 测试辅助 ---
    if (path === '/_test/login' && req.method === 'POST') {
      state.loginStatus = 'logged';
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/_test/sends') {
      json(res, 200, { ok: true, sends });
      return;
    }

    if (path === '/_test/webhook') {
      json(res, 200, { ok: true, url: state.webhookUrl });
      return;
    }

    if (path === '/_test/message' && req.method === 'POST') {
      const payload = await body(req);
      if (!state.webhookUrl) {
        json(res, 409, { ok: false, error: 'webhook-not-configured' });
        return;
      }
      const raw = JSON.stringify(payload.body);
      const headers = { 'content-type': 'application/json' };
      if (secret) headers['x-pad-signature'] = createHmac('sha256', secret).update(raw).digest('hex');
      const response = await fetch(state.webhookUrl, { method: 'POST', headers, body: raw });
      json(res, 200, { ok: response.ok, status: response.status });
      return;
    }

    json(res, 404, { code: 404, msg: 'not-found', path });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const base = `http://127.0.0.1:${address.port}`;
      resolve({
        baseUrl: base,
        port: address.port,
        sends,
        state,
        get webhookUrl() {
          return state.webhookUrl;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 8899;
  startMockPad({ port }).then((pad) => {
    console.log(`[mock-pad] listening on ${pad.baseUrl}`);
    console.log('[mock-pad] 端点：/api/login/GetLoginQrCodeNewX, /api/v1/message/SendText, /v1/webhook/Config');
    console.log('[mock-pad] 测试用：POST /_test/login, GET /_test/sends, POST /_test/message {"body":{...}}');
  });
}
