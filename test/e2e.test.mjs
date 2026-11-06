import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridge } from '../lib/bridge.js';
import { normalizeConfig } from '../lib/config.js';
import { configureWebhook } from '../lib/dashboard.js';
import { PadClient } from '../lib/pad-client.js';
import { Store } from '../lib/store.js';
import { createHookHandler } from '../lib/webhook.js';
import { startMockPad } from './mock-pad.mjs';

const silent = { info() {}, warn() {}, error() {} };

function tick(ms = 120) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('端到端：假协议端 → webhook → 会话 → 回复', async () => {
  const secret = 'test-secret';
  const pad = await startMockPad({ secret });
  const dir = await mkdtemp(join(tmpdir(), 'wechat-pad-e2e-'));
  const store = new Store(dir);
  await store.load();

  const cfg = normalizeConfig({
    padUrl: pad.baseUrl,
    padToken: 'mock-token',
    webhookSecret: secret,
    stateDir: dir,
    workspaceDir: join(dir, 'ws'),
    selfWxid: 'wxid_bot',
    botNames: ['机器人'],
    groups: [{ id: 'group_e2e@chatroom', name: '联调群' }],
    queueLimit: 3,
    coalesceMs: 0,
  }, {});

  const client = new PadClient(cfg, { logger: silent });
  assert.equal((await client.probe()).ok, true, '假协议端应可达');

  // 发文本的候选路径里，第一个就命中假协议端
  await client.sendText('wxid_friend', '自检');
  assert.equal(pad.sends.length, 1);
  assert.equal(pad.sends[0].text, '自检');

  const prompts = [];
  let emit = () => {};
  const harness = {
    createSession: async () => 'sess-e2e',
    prompt: async (sessionId, text) => {
      prompts.push(text);
      setTimeout(() => {
        emit({ id: sessionId }, { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: '我在群里说话。' }] } } });
        emit({ id: sessionId }, { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } });
      }, 5);
    },
    onSessionEvent: (handler) => {
      emit = handler;
      return () => {};
    },
  };

  const bridge = createBridge({ cfg, pad: client, store, harness, logger: silent });
  const hook = createHookHandler({ cfg, bridge, store, logger: silent });
  const server = createServer(hook);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const hooksOrigin = `http://127.0.0.1:${server.address().port}`;

  try {
    const configured = await configureWebhook({ cfg, pad: client, logger: silent, origin: hooksOrigin });
    assert.equal(configured.ok, true, `webhook 应配置成功：${JSON.stringify(configured)}`);
    assert.equal(pad.webhookUrl, configured.url);
    assert.match(pad.webhookUrl, /secret=/, 'webhook 地址应带上密钥');

    const response = await fetch(`${pad.baseUrl}/_test/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: {
          event_type: 'message',
          data: {
            NewMsgId: 90001,
            FromUserName: { string: 'group_e2e@chatroom' },
            ToUserName: { string: 'wxid_bot' },
            MsgType: 1,
            Content: { string: '@机器人 联调一下' },
            MsgSource: '<msgsource><atuserlist><![CDATA[wxid_bot]]></atuserlist></msgsource>',
            IsSender: 0,
            SenderName: '联调',
          },
        },
      }),
    });
    assert.equal(response.ok, true);

    await tick(200);
    assert.equal(prompts.length, 1, '应该把群消息转给 agent');
    const replies = pad.sends.filter((item) => item.to === 'group_e2e@chatroom');
    assert.equal(replies.length, 1, '应该回一条到群里');
    assert.match(replies[0].text, /^@联调 /);
    assert.match(replies[0].text, /我在群里说话/);
  } finally {
    await bridge.dispose();
    await store.close();
    await new Promise((resolve) => server.close(resolve));
    await pad.close();
  }
});

test('错误密钥的 webhook 被拒', async () => {
  const pad = await startMockPad({ secret: 'right-secret' });
  const dir = await mkdtemp(join(tmpdir(), 'wechat-pad-e2e-bad-'));
  const store = new Store(dir);
  await store.load();
  const cfg = normalizeConfig({ webhookSecret: 'right-secret', stateDir: dir, padUrl: pad.baseUrl }, {});
  const bridge = createBridge({
    cfg,
    pad: { sendText: async () => {} },
    store,
    harness: { createSession: async () => 's', prompt: async () => {}, onSessionEvent: () => () => {} },
    logger: silent,
  });
  const server = createServer(createHookHandler({ cfg, bridge, store, logger: silent }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/wechat-pad/hook?secret=wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { Content: { string: 'hi' } } }),
    });
    assert.equal(response.status, 401);
  } finally {
    await bridge.dispose();
    await store.close();
    await new Promise((resolve) => server.close(resolve));
    await pad.close();
  }
});
