import { mkdir } from 'node:fs/promises';

import { isConfigured, normalizeConfig } from './lib/config.js';
import { createBridge } from './lib/bridge.js';
import { configureWebhook, createDashboardHandler } from './lib/dashboard.js';
import { createHarness } from './lib/harness.js';
import { PadClient } from './lib/pad-client.js';
import { Store } from './lib/store.js';
import {
  applySettings,
  loadSettings,
  saveSettings,
  settingsSchemaForClient,
} from './lib/settings.js';
import { createHookHandler } from './lib/webhook.js';

export const name = 'dsh-wechat-pad';

/**
 * 数组形式的 inject 由 Cordis 直接按服务名解析；webServer 用来挂面板与 webhook，
 * connection/typertGateway 用来在进程内建会话。
 */
export const inject = ['webServer', 'connection', 'typertGateway'];

function pickLogger(ctx) {
  if (typeof ctx?.logger === 'function') {
    try {
      return ctx.logger('wechat-pad');
    } catch {
      // 回退
    }
  }
  return ctx?.logger ?? console;
}

function safeOrigin(ctx) {
  try {
    return typeof ctx?.webServer?.getOrigin === 'function' ? ctx.webServer.getOrigin() : '';
  } catch {
    return '';
  }
}

function resolveToken(cfg, env) {
  if (cfg.padToken) return cfg.padToken;
  const ref = cfg.padTokenRef;
  if (!ref) return '';
  return String(env?.[ref] ?? '').trim();
}

export async function apply(ctx, config = {}) {
  const logger = pickLogger(ctx);
  const cfg = normalizeConfig(config, process.env);

  await mkdir(cfg.stateDir, { recursive: true }).catch(() => undefined);
  await mkdir(cfg.workspaceDir, { recursive: true }).catch(() => undefined);

  const store = new Store(cfg.stateDir, { logger });
  await store.load();

  const pad = new PadClient(cfg, { logger });
  const token = resolveToken(cfg, process.env);
  if (token) pad.setToken(token);

  let harness = null;
  let harnessError = '';
  try {
    harness = createHarness(ctx, { logger });
  } catch (error) {
    harnessError = error?.message ?? String(error);
  }

  // 运行时可换：面板上改设置后，用新配置重建 bridge，旧的一个个拆掉。
  const loaded = await loadSettings(cfg.stateDir, logger);
  const makeBridge = (nextCfg) => (harness
    ? createBridge({ cfg: nextCfg, pad, store, harness, logger })
    : { handlePayload: () => 0, dispose: async () => {}, pending: 0 });

  let runtime = {
    cfg: applySettings(cfg, loaded.settings),
    settings: loaded.settings,
    settingsFile: loaded.file,
    settingsSchema: settingsSchemaForClient(),
    pad,
    store,
    bridge: makeBridge(applySettings(cfg, loaded.settings)),
  };
  const bridgeFacade = {
    handlePayload: (payload) => runtime.bridge.handlePayload(payload),
    handleMessage: (message) => runtime.bridge.handleMessage?.(message),
    get pending() {
      return runtime.bridge?.pending ?? 0;
    },
  };

  const onSettings = async (patch) => {
    const merged = { ...runtime.settings, ...(patch ?? {}) };
    const saved = await saveSettings(cfg.stateDir, merged, logger);
    const nextCfg = applySettings(cfg, saved);
    const previous = runtime.bridge;
    const nextBridge = makeBridge(nextCfg);
    runtime = { ...runtime, cfg: nextCfg, settings: saved, bridge: nextBridge };
    if (nextBridge !== previous) await previous.dispose?.().catch(() => undefined);
    logger.info?.(
      `[wechat-pad] 设置已应用：${saved.enabled ? '开' : '关'}，群聊 ${saved.groupMode}，合并 ${saved.coalesceMs}ms`,
    );
    return { settings: saved };
  };

  const dashboard = createDashboardHandler({
    getRuntime: () => runtime,
    onSettings,
    logger,
  });
  const disposers = [];

  // 面板：即使没配 padUrl 也挂上，方便看「还差什么」。
  try {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/wechat-pad', handler: dashboard }));
  } catch (error) {
    logger.warn?.(`[wechat-pad] 面板路由注册失败：${error?.message ?? error}`);
  }

  if (isConfigured(cfg) && harness) {
    const hook = createHookHandler({ cfg, bridge: bridgeFacade, store, logger });
    try {
      disposers.push(ctx.webServer.register({ kind: 'exact', path: cfg.hookPath, handler: hook }));
    } catch (error) {
      logger.error?.(`[wechat-pad] webhook 路由注册失败（${cfg.hookPath}）：${error?.message ?? error}`);
    }

    const origin = safeOrigin(ctx);
    if (cfg.autoConfigureWebhook && origin) {
      const timer = setTimeout(() => {
        void configureWebhook({ cfg, pad, logger, origin }).catch(() => undefined);
      }, 1500);
      timer.unref?.();
      disposers.push(() => clearTimeout(timer));
    }

    logger.info?.(
      `[wechat-pad] 已启动：协议端 ${cfg.padUrl}，webhook ${origin || '（未知 origin）'}${cfg.hookPath}，`
      + `状态目录 ${cfg.stateDir}`,
    );
    if (!token) {
      logger.warn?.(
        `[wechat-pad] 没有协议端 token：请把 AuthKey 放进环境变量 ${cfg.padTokenRef}，或配置 padToken。`
        + '没有 token 时登录与发送都会失败。',
      );
    }
  } else if (!isConfigured(cfg)) {
    logger.info?.('[wechat-pad] 还没有配置 padUrl，插件待命中。打开 /wechat-pad 看配置说明。');
  } else if (harnessError) {
    logger.warn?.(`[wechat-pad] 当前宿主里拿不到会话通道（${harnessError}），消息不会转给 agent。`);
  }

  const dispose = async () => {
    for (const disposer of disposers.reverse()) {
      try {
        disposer();
      } catch {
        // 忽略
      }
    }
    await runtime.bridge?.dispose?.();
    await harness?.dispose?.();
    await store.close();
  };

  ctx.effect?.(() => () => dispose(), 'dsh-wechat-pad: teardown');
  return dispose;
}
