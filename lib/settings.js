import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 用户在「设置 → 微信」里能改的东西。只放运行时行为，不放连接参数——
 * 协议端地址、token、webhook 密钥仍然走配置文件，改坏了会直接连不上。
 */
export const SETTINGS_SCHEMA = [
  {
    key: 'enabled',
    type: 'boolean',
    label: '启用自动回复',
    hint: '关掉以后消息照收，但不会转给模型。',
    default: true,
  },
  {
    key: 'groupMode',
    type: 'enum',
    label: '群里怎么说话',
    hint: '被 @ 才回最安静；全部回复等于每句都接；关闭则群里完全不理。',
    default: 'mention',
    options: [
      { value: 'mention', label: '只回 @ 我的' },
      { value: 'all', label: '群里每句都回' },
      { value: 'off', label: '群里不理' },
    ],
  },
  {
    key: 'autoReplyDM',
    type: 'boolean',
    label: '私聊自动回复',
    hint: '关掉以后只记录私聊消息，不回复。',
    default: true,
  },
  {
    key: 'allowUnknownGroups',
    type: 'boolean',
    label: '自动加入新群',
    hint: '关掉时只理白名单里的群；打开后任何群里被 @ 都会回。',
    default: false,
  },
  {
    key: 'coalesceMs',
    type: 'number',
    label: '连发合并窗口（毫秒）',
    hint: '同一个人连续几条消息合并成一次提问；0 表示不合并。',
    default: 800,
    min: 0,
    max: 10000,
    step: 100,
  },
  {
    key: 'maxReplyChars',
    type: 'number',
    label: '单条回复上限（字）',
    hint: '超过就截断。微信里太长会被折叠。',
    default: 4000,
    min: 100,
    max: 20000,
    step: 100,
  },
  {
    key: 'chunkChars',
    type: 'number',
    label: '超长回复分段长度',
    hint: '超过上限的回复按这个长度切开发送。',
    default: 1500,
    min: 100,
    max: 5000,
    step: 50,
  },
  {
    key: 'timeoutSec',
    type: 'number',
    label: '等待模型超时（秒）',
    hint: '超过这个时间还没答完，就回一句兜底话。',
    default: 120,
    min: 10,
    max: 600,
    step: 5,
  },
  {
    key: 'timeoutReply',
    type: 'string',
    label: '超时兜底话',
    hint: '留空则什么都不发。',
    default: '我想得有点久，等下再答你。',
    maxLength: 200,
  },
  {
    key: 'replyPrefix',
    type: 'string',
    label: '回复前缀',
    hint: '每条回复前面加的话，留空不加。',
    default: '',
    maxLength: 40,
  },
  {
    key: 'ratePerMinPerGroup',
    type: 'number',
    label: '单个会话每分钟上限',
    hint: '防止刷屏。',
    default: 5,
    min: 1,
    max: 60,
    step: 1,
  },
  {
    key: 'ratePerMinGlobal',
    type: 'number',
    label: '全局每分钟上限',
    hint: '所有会话加起来。',
    default: 10,
    min: 1,
    max: 120,
    step: 1,
  },
  {
    key: 'template',
    type: 'string',
    label: '说话风格提示',
    hint: '会加在每次提问前面，用来限定语气和长度。留空则不加。',
    default: '微信里聊天，回复尽量短，两三句话就够；不要用 markdown 标题和列表。',
    maxLength: 500,
    multiline: true,
  },
];

export const SETTINGS_FILE = 'settings.json';

const BY_KEY = new Map(SETTINGS_SCHEMA.map((item) => [item.key, item]));

function clampInt(value, fallback, min, max) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 只保留 schema 里定义的字段，并按类型收敛。 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const item of SETTINGS_SCHEMA) {
    const value = source[item.key];
    if (item.type === 'boolean') {
      out[item.key] = typeof value === 'boolean' ? value : item.default;
    } else if (item.type === 'number') {
      out[item.key] = clampInt(value, item.default, item.min, item.max);
    } else if (item.type === 'enum') {
      const allowed = new Set(item.options.map((option) => option.value));
      out[item.key] = allowed.has(value) ? value : item.default;
    } else {
      const text = typeof value === 'string' ? value : item.default;
      const sliced = item.maxLength ? text.slice(0, item.maxLength) : text;
      // 风格提示首尾空白没有意义，顺手去掉；前缀保留（有人爱用「（AI） 」这种尾空格）
      out[item.key] = item.key === 'template' ? sliced.trim() : sliced;
    }
  }
  return out;
}

export function defaultSettings() {
  return normalizeSettings({});
}

/** 把设置叠加到配置上（返回新对象，不改原 cfg）。 */
export function applySettings(cfg, settings) {
  const s = normalizeSettings(settings);
  const next = {
    ...cfg,
    enabled: s.enabled,
    groupMode: s.groupMode,
    autoReplyDM: s.autoReplyDM,
    answerDirectMessages: s.autoReplyDM,
    allowUnknownGroups: s.allowUnknownGroups,
    coalesceMs: s.coalesceMs,
    maxReplyChars: s.maxReplyChars,
    chunkChars: s.chunkChars,
    timeoutSec: s.timeoutSec,
    timeoutReply: s.timeoutReply,
    replyPrefix: s.replyPrefix,
    ratePerMinPerGroup: s.ratePerMinPerGroup,
    ratePerMinGlobal: s.ratePerMinGlobal,
    template: s.template,
  };
  next.defaultTrigger = s.groupMode === 'all' ? 'all' : s.groupMode === 'off' ? 'off' : 'mention';
  next.systemHint = s.template || cfg.systemHint || '';
  return Object.freeze(next);
}

export async function loadSettings(stateDir, logger) {
  const file = join(stateDir, SETTINGS_FILE);
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return { settings: normalizeSettings(parsed), file, existed: true };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`[wechat-pad] 读取设置失败，用默认值：${error?.message ?? error}`);
    }
    return { settings: defaultSettings(), file, existed: false };
  }
}

export async function saveSettings(stateDir, settings, logger) {
  const file = join(stateDir, SETTINGS_FILE);
  const normalized = normalizeSettings(settings);
  await mkdir(stateDir, { recursive: true }).catch(() => undefined);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  logger?.info?.('[wechat-pad] 设置已保存');
  return normalized;
}

/** 面板用：把 schema 去掉内部字段，直接给前端渲染。 */
export function settingsSchemaForClient() {
  return SETTINGS_SCHEMA.map((item) => ({ ...item }));
}

export function describeSettings(settings) {
  const labels = { mention: '只回 @', all: '全部回', off: '不理' };
  return {
    enabled: settings.enabled ? '开' : '关',
    groupMode: labels[settings.groupMode] ?? settings.groupMode,
    autoReplyDM: settings.autoReplyDM ? '开' : '关',
  };
}

export function isKnownKey(key) {
  return BY_KEY.has(key);
}
