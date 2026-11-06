import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridge } from '../lib/bridge.js';
import { normalizeConfig } from '../lib/config.js';
import { normalizeWebhook } from '../lib/parse.js';
import { Store } from '../lib/store.js';

const SELF = 'wxid_bot';

function payload(overrides = {}) {
  return {
    event_type: 'message',
    timestamp: Math.floor(Date.now() / 1000),
    data: {
      NewMsgId: overrides.NewMsgId ?? 1001,
      MsgId: overrides.NewMsgId ?? 1001,
      FromUserName: { string: 'group_a@chatroom' },
      ToUserName: { string: SELF },
      MsgType: 1,
      Content: { string: '@机器人 早上好' },
      MsgSource: '<msgsource><atuserlist><![CDATA[wxid_bot]]></atuserlist></msgsource>',
      IsSender: 0,
      SenderName: '小明',
      ...overrides,
    },
  };
}

async function setup({ config = {}, reply = '收到，早上好。' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-pad-test-'));
  const cfg = normalizeConfig({
    stateDir: dir,
    workspaceDir: join(dir, 'ws'),
    selfWxid: SELF,
    botNames: ['机器人'],
    groups: [{ id: 'group_a@chatroom', name: '测试群', trigger: 'mention' }],
    coalesceMs: 0, // 单测里不合并，逐条断言
    ...config,
  }, {});

  const store = new Store(dir);
  await store.load();

  const sent = [];
  const pad = {
    sendText: async (to, text) => {
      sent.push({ to, text });
      return { code: 200 };
    },
  };

  const prompts = [];
  const sessions = [];
  let emit = () => {};
  const harness = {
    createSession: async () => {
      const id = `sess-${sessions.length + 1}`;
      sessions.push(id);
      return id;
    },
    prompt: async (sessionId, text) => {
      prompts.push({ sessionId, text });
      setTimeout(() => {
        emit({ id: sessionId }, { type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: reply }] } } });
        emit({ id: sessionId }, { type: 'turn/end', seq: 11, data: { reason: { kind: 'completed' } } });
      }, 5);
    },
    onSessionEvent: (handler) => {
      emit = handler;
      return () => {};
    },
  };

  const bridge = createBridge({ cfg, pad, store, harness, logger: { info() {}, warn() {}, error() {} } });
  return { dir, cfg, store, sent, prompts, sessions, bridge, harness };
}

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test('群消息被 @ 时建会话、发 prompt、回消息', async () => {
  const env = await setup();
  try {
    env.bridge.handlePayload(payload());
    await tick();

    assert.equal(env.sessions.length, 1, '应该建一个会话');
    assert.equal(env.prompts.length, 1);
    assert.match(env.prompts[0].text, /测试群/);
    assert.match(env.prompts[0].text, /早上好/);
    assert.equal(env.sent.length, 1);
    assert.equal(env.sent[0].to, 'group_a@chatroom');
    assert.match(env.sent[0].text, /^@小明 /, '群里回复应带 @ 前缀');
    assert.match(env.sent[0].text, /收到，早上好/);
    assert.equal(env.store.binding('group_a@chatroom'), env.sessions[0], '绑定应落盘');
  } finally {
    await env.bridge.dispose();
    await env.store.close();
  }
});

test('未被 @ 的群消息不触发', async () => {
  const env = await setup();
  try {
    env.bridge.handlePayload(payload({ MsgSource: '<msgsource></msgsource>', Content: { string: '随便聊聊' } }));
    await tick();
    assert.equal(env.prompts.length, 0);
    assert.equal(env.sent.length, 0);
  } finally {
    await env.bridge.dispose();
    await env.store.close();
  }
});

test('同一条消息重复投递只处理一次', async () => {
  const env = await setup();
  try {
    env.bridge.handlePayload(payload({ NewMsgId: 777 }));
    await tick();
    env.bridge.handlePayload(payload({ NewMsgId: 777 }));
    await tick();
    assert.equal(env.prompts.length, 1);
  } finally {
    await env.bridge.dispose();
    await env.store.close();
  }
});

test('私聊不需要 @ 也会回', async () => {
  const env = await setup();
  try {
    env.bridge.handlePayload({
      data: {
        NewMsgId: 2001,
        FromUserName: { string: 'wxid_friend' },
        ToUserName: { string: SELF },
        MsgType: 1,
        Content: { string: '在吗' },
        IsSender: 0,
      },
    });
    await tick();
    assert.equal(env.prompts.length, 1);
    assert.equal(env.sent[0].to, 'wxid_friend');
    assert.doesNotMatch(env.sent[0].text, /^@/, '私聊不加 @ 前缀');
  } finally {
    await env.bridge.dispose();
    await env.store.close();
  }
});

test('白名单外的群不说话', async () => {
  const env = await setup();
  try {
    env.bridge.handlePayload(payload({ FromUserName: { string: 'group_z@chatroom' } }));
    await tick();
    assert.equal(env.prompts.length, 0);
  } finally {
    await env.bridge.dispose();
    await env.store.close();
  }
});

test('自己发的消息不处理', async () => {
  const env = await setup();
  try {
    env.bridge.handlePayload(payload({ IsSender: 1, MsgSource: '<msgsource><atuserlist><![CDATA[wxid_bot]]></atuserlist></msgsource>' }));
    await tick();
    assert.equal(env.prompts.length, 0);
  } finally {
    await env.bridge.dispose();
    await env.store.close();
  }
});

test('超时回一句兜底，不把沉默当回答', async () => {
  const env = await setup({ config: { timeoutSec: 10, timeoutReply: '等下再答你' } });
  try {
    // 覆盖 prompt：永不回事件
    env.harness.prompt = async () => {};
    const bridge = createBridge({
      cfg: { ...env.cfg, timeoutSec: 0.05 },
      pad: { sendText: async (to, text) => env.sent.push({ to, text }) },
      store: env.store,
      harness: env.harness,
      logger: { info() {}, warn() {}, error() {} },
    });
    bridge.handlePayload(payload({ NewMsgId: 3001 }));
    await tick(120);
    assert.equal(env.sent.length, 1);
    assert.ok(env.sent[0].text.endsWith('等下再答你'), `兜底文案不对：${env.sent[0].text}`);
    await bridge.dispose();
  } finally {
    await env.bridge.dispose();
    await env.store.close();
  }
});

test('长回答按段落切分', async () => {
  const long = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 段：${'内容'.repeat(120)}`).join('\n');
  const env = await setup({ reply: long, config: { chunkChars: 300, chunkDelayMs: 0 } });
  try {
    env.bridge.handlePayload(payload({ NewMsgId: 4001 }));
    await tick(150);
    assert.ok(env.sent.length > 1, '应该切成多条');
    const joined = env.sent.map((item) => item.text.replace(/^@小明 /, '')).join('');
    assert.ok(joined.length >= long.length * 0.9, `切成了 ${env.sent.length} 段，拼回来 ${joined.length} / ${long.length} 字`);
  } finally {
    await env.bridge.dispose();
    await env.store.close();
  }
});

test('同一个人连发几条，合并成一次 prompt', async () => {
  const env = await setup({ config: { coalesceMs: 80 } });
  try {
    env.bridge.handlePayload(payload({ NewMsgId: 5001, Content: { string: '@机器人 在吗' } }));
    env.bridge.handlePayload(payload({ NewMsgId: 5002, Content: { string: '帮我看个东西' } }));
    env.bridge.handlePayload(payload({ NewMsgId: 5003, Content: { string: '是个报错' } }));
    await tick(200);
    assert.equal(env.prompts.length, 1, '三条短消息应该只跑一次');
    assert.match(env.prompts[0].text, /在吗\n帮我看个东西\n是个报错/);
    assert.equal(env.sent.length, 1, '只回一条');
  } finally {
    await env.bridge.dispose();
    await env.store.close();
  }
});

test('webhook 载荷解析：字符串包体、at 列表、@ 前缀', () => {
  const [message] = normalizeWebhook(payload(), { selfWxid: SELF, botNames: ['机器人'] });
  assert.equal(message.groupId, 'group_a@chatroom');
  assert.equal(message.isGroup, true);
  assert.equal(message.atMe, true);
  assert.equal(message.text, '早上好');
  assert.deepEqual(message.atList, [SELF]);
});
