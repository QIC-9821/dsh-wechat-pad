import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeConfig, policyFor } from '../lib/config.js';
import {
  applySettings,
  defaultSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
  settingsSchemaForClient,
} from '../lib/settings.js';

test('默认设置能收敛到 schema 里的值', () => {
  const settings = defaultSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.groupMode, 'mention');
  assert.equal(settings.coalesceMs, 800);
  assert.ok(settings.template.length > 0);
});

test('越界和非法值会被夹回合法范围', () => {
  const settings = normalizeSettings({
    groupMode: 'whatever',
    coalesceMs: 999999,
    maxReplyChars: -5,
    ratePerMinGlobal: 'abc',
    enabled: 'yes',
  });
  assert.equal(settings.groupMode, 'mention');
  assert.equal(settings.coalesceMs, 10000);
  assert.equal(settings.maxReplyChars, 100);
  assert.equal(settings.ratePerMinGlobal, 10);
  assert.equal(settings.enabled, true, '非布尔值回落到默认值');
});

test('群聊策略跟着 groupMode 走', () => {
  const base = normalizeConfig({ groups: [{ id: 'g1@chatroom', name: '测试群' }] }, {});
  const group = { id: 'g1@chatroom', isGroup: true };

  const mention = applySettings(base, { groupMode: 'mention' });
  assert.equal(policyFor(mention, group).allowed, true);
  assert.equal(policyFor(mention, group).trigger, 'mention');

  const all = applySettings(base, { groupMode: 'all' });
  assert.equal(policyFor(all, group).trigger, 'all');

  const off = applySettings(base, { groupMode: 'off' });
  assert.equal(policyFor(off, group).allowed, false);
  assert.equal(policyFor(off, group).reason, 'group-off');
});

test('关掉私聊回复后私聊也不触发', () => {
  const base = normalizeConfig({}, {});
  const dm = { id: 'wxid_friend', isGroup: false };
  assert.equal(policyFor(applySettings(base, { autoReplyDM: false }), dm).allowed, false);
  assert.equal(policyFor(applySettings(base, { autoReplyDM: true }), dm).allowed, true);
});

test('设置能存盘、读回、并原子写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-pad-settings-'));
  const first = await loadSettings(dir);
  assert.equal(first.existed, false);

  await saveSettings(dir, { groupMode: 'all', coalesceMs: 0, template: '  短一点  ' }, {});
  const text = await readFile(join(dir, 'settings.json'), 'utf8');
  assert.match(text, /"groupMode": "all"/);
  assert.match(text, /"coalesceMs": 0/);

  const again = await loadSettings(dir);
  assert.equal(again.existed, true);
  assert.equal(again.settings.groupMode, 'all');
  assert.equal(again.settings.template, '短一点');
});

test('给前端的 schema 有标签和默认值', () => {
  const schema = settingsSchemaForClient();
  assert.ok(schema.length >= 10);
  for (const item of schema) {
    assert.ok(item.key);
    assert.ok(item.label);
    assert.ok(item.type);
  }
  assert.ok(schema.some((item) => item.key === 'groupMode' && item.options.length === 3));
});
