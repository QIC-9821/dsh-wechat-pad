import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 所有可配项的默认值；用户配置里没写的字段都从这里取。 */
export const DEFAULTS = Object.freeze({
  // 协议端
  backend: 'wechatpadpro',
  padUrl: '',
  padTokenRef: 'DSH_WECHAT_PAD_TOKEN',
  padToken: '',
  requestTimeoutMs: 15000,
  autoConfigureWebhook: true,

  // 本插件对外
  hookPath: '/wechat-pad/hook',
  webhookSecret: '',
  maxBodyBytes: 1024 * 1024,
  logRawPayloads: false,

  // 状态与工作区
  stateDir: '',
  workspaceDir: '',

  // 行为
  defaultTrigger: 'mention', // mention | all
  answerDirectMessages: true,
  botNames: [], // 群里被 @ 的识别名（不含 @）；空则只信协议端的 at 列表
  selfWxid: '',
  timeoutSec: 120,
  timeoutReply: '我想得有点久，等下再答你。',
  agentPreset: '', // 用哪个 agent 预设跑微信会话（留空=宿主默认）
  coalesceMs: 800, // 同一个人连发几条时合并成一次 prompt；0=不合并
  maxReplyChars: 4000,
  chunkChars: 1500,
  chunkDelayMs: 1500,
  ratePerMinPerGroup: 5,
  ratePerMinGlobal: 10,
  queueLimit: 5,
  dedupeTtlSec: 3600,
  groups: [], // [{ id, name, enabled, trigger, ratePerMin }]
  allowUnknownGroups: false,
  replyPrefix: '',
  systemHint: '', // 追加到每条 prompt 前的提示
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min || i > max) return fallback;
  return i;
}

function normalizeGroups(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    if (!item) continue;
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) out.push({ id, name: '', enabled: true, trigger: '', ratePerMin: 0 });
      continue;
    }
    if (!isPlainObject(item)) continue;
    const id = String(item.id ?? item.wxid ?? '').trim();
    if (!id) continue;
    const trigger = item.trigger === 'all' || item.trigger === 'mention' ? item.trigger : '';
    out.push({
      id,
      name: String(item.name ?? '').trim(),
      enabled: item.enabled !== false,
      trigger,
      ratePerMin: toInt(item.ratePerMin, 0, 0, 600),
    });
  }
  return out;
}

function normalizeNames(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  return list.map((name) => String(name ?? '').trim().replace(/^@/, '')).filter(Boolean);
}

/**
 * 把 Loader 行里的 config 归一化。空字符串视作「没写」，便于用户清空某项后回到默认值。
 */
export function normalizeConfig(raw = {}, env = process.env) {
  const source = isPlainObject(raw) ? raw : {};
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '' && key !== 'webhookSecret') continue;
    merged[key] = value;
  }

  const dshHome = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : join(homedir(), '.dsh');
  const stateDir = resolve(String(merged.stateDir || join(dshHome, 'wechat-pad')));
  const workspaceDir = resolve(String(merged.workspaceDir || join(stateDir, 'workspace')));

  const hookPath = String(merged.hookPath || DEFAULTS.hookPath).startsWith('/')
    ? String(merged.hookPath || DEFAULTS.hookPath)
    : `/${merged.hookPath}`;

  return Object.freeze({
    backend: String(merged.backend || DEFAULTS.backend),
    padUrl: String(merged.padUrl || '').replace(/\/+$/, ''),
    padTokenRef: String(merged.padTokenRef || DEFAULTS.padTokenRef),
    padToken: String(merged.padToken || ''),
    requestTimeoutMs: toInt(merged.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 1000, 120000),
    autoConfigureWebhook: merged.autoConfigureWebhook !== false,

    hookPath,
    webhookSecret: String(merged.webhookSecret || ''),
    maxBodyBytes: toInt(merged.maxBodyBytes, DEFAULTS.maxBodyBytes, 1024, 8 * 1024 * 1024),
    logRawPayloads: merged.logRawPayloads === true,

    stateDir,
    workspaceDir,

    defaultTrigger: merged.defaultTrigger === 'all' ? 'all' : merged.defaultTrigger === 'off' ? 'off' : 'mention',
    enabled: merged.enabled !== false,
    answerDirectMessages: merged.answerDirectMessages !== false,
    botNames: normalizeNames(merged.botNames),
    selfWxid: String(merged.selfWxid || '').trim(),
    timeoutSec: toInt(merged.timeoutSec, DEFAULTS.timeoutSec, 10, 900),
    timeoutReply: String(merged.timeoutReply ?? DEFAULTS.timeoutReply),
    agentPreset: String(merged.agentPreset || '').trim(),
    coalesceMs: toInt(merged.coalesceMs, DEFAULTS.coalesceMs, 0, 10000),
    maxReplyChars: toInt(merged.maxReplyChars, DEFAULTS.maxReplyChars, 100, 20000),
    chunkChars: toInt(merged.chunkChars, DEFAULTS.chunkChars, 100, 4000),
    chunkDelayMs: toInt(merged.chunkDelayMs, DEFAULTS.chunkDelayMs, 0, 10000),
    ratePerMinPerGroup: toInt(merged.ratePerMinPerGroup, DEFAULTS.ratePerMinPerGroup, 0, 600),
    ratePerMinGlobal: toInt(merged.ratePerMinGlobal, DEFAULTS.ratePerMinGlobal, 0, 600),
    queueLimit: toInt(merged.queueLimit, DEFAULTS.queueLimit, 1, 100),
    dedupeTtlSec: toInt(merged.dedupeTtlSec, DEFAULTS.dedupeTtlSec, 60, 7 * 86400),
    groups: normalizeGroups(merged.groups),
    allowUnknownGroups: merged.allowUnknownGroups === true,
    replyPrefix: String(merged.replyPrefix || ''),
    systemHint: String(merged.systemHint || ''),
  });
}

/** 这台插件是否已经能干活（有协议端地址）。 */
export function isConfigured(cfg) {
  return Boolean(cfg && cfg.padUrl);
}

/** 某个群/私聊的有效策略。 */
export function policyFor(cfg, group) {
  const configured = cfg.groups.find((g) => g.id === group.id);
  if (configured && configured.enabled === false) return { allowed: false, reason: 'group-disabled' };
  const trigger = configured?.trigger || cfg.defaultTrigger;
  const ratePerMin = configured?.ratePerMin || cfg.ratePerMinPerGroup;
  if (!group.isGroup) return { allowed: cfg.answerDirectMessages && trigger !== 'off', trigger: 'all', ratePerMin };
  if (!configured && !cfg.allowUnknownGroups) return { allowed: false, reason: 'group-not-allowed', trigger, ratePerMin };
  if (trigger === 'off') return { allowed: false, reason: 'group-off', trigger, ratePerMin };
  return { allowed: true, trigger, ratePerMin };
}
