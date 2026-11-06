function json(res, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>微信 · iPad 协议端</title>
<style>
  :root{color-scheme:light dark;--fg:#1c1c1e;--muted:#6b6b70;--bg:#f6f6f7;--card:#fff;--line:#e3e3e6;--accent:#10a37f}
  @media (prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#9a9aa2;--bg:#17171a;--card:#1f1f23;--line:#303036}}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:var(--muted);margin-bottom:20px}
  .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));max-width:1100px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
  .card h2{font-size:14px;margin:0 0 12px;font-weight:600}
  .row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed var(--line)}
  .row:last-child{border-bottom:none}
  .k{color:var(--muted)}
  .v{text-align:right;word-break:break-all}
  button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button:disabled{opacity:.5;cursor:default}
  .qr{display:flex;justify-content:center;padding:8px}
  .qr img{width:220px;height:220px;image-rendering:pixelated;border-radius:8px;background:#fff}
  .muted{color:var(--muted);font-size:12.5px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:rgba(127,127,127,.12);padding:1px 5px;border-radius:4px}
  ul{margin:8px 0 0;padding-left:18px}
  li{margin:3px 0}
  .ok{color:#10a37f}.bad{color:#d9534f}
</style></head><body>
<h1>微信 · iPad 协议端</h1>
<div class="sub">DSH ↔ 协议端 ↔ 微信。群里默认只有 @ 它才说话；私聊直接回。</div>
<div class="grid">
  <div class="card"><h2>连接</h2><div id="status">读取中…</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="probe">重新探活</button>
      <button id="hook" class="primary">配置 webhook</button>
    </div>
    <div class="muted" style="margin-top:10px" id="hookMsg"></div>
  </div>

  <div class="card"><h2>扫码登录</h2>
    <div class="qr" id="qrBox"><span class="muted">点下面的按钮取二维码</span></div>
    <div style="display:flex;gap:8px;justify-content:center">
      <button id="login" class="primary">获取二维码</button>
      <button id="refresh">刷新状态</button>
    </div>
    <div class="muted" style="margin-top:10px;text-align:center" id="loginMsg"></div>
  </div>

  <div class="card"><h2>群白名单</h2>
    <div class="muted">在 <code>config.groups</code> 里加群里看到的 id；不加就只在私聊里回。</div>
    <div id="groups" style="margin-top:10px"></div>
  </div>

  <div class="card"><h2>统计</h2><div id="stats"></div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let currentUuid = '';

async function api(path, init) {
  const res = await fetch(path, init);
  return res.json().catch(() => ({}));
}

function rows(obj) {
  return Object.entries(obj).map(([k, v]) =>
    '<div class="row"><span class="k">' + k + '</span><span class="v">' + (v === '' || v === null || v === undefined ? '—' : String(v)) + '</span></div>'
  ).join('');
}

async function refreshStatus() {
  const data = await api('/wechat-pad/api/status');
  $('status').innerHTML = rows({
    '协议端地址': data.padUrl || '（未配置）',
    '服务可达': data.probe?.ok ? '是' : '否',
    '探活详情': data.probe?.error || data.probe?.note || '正常',
    '已登录账号': data.pad?.selfName || data.pad?.selfWxid || '未知',
    'webhook': data.webhook?.ok ? '已配置' : (data.webhook?.error || '未确认'),
    '待处理队列': data.pending ?? 0,
  });
  $('stats').innerHTML = rows({
    '收到载荷': data.stats['hook:received'] || 0,
    '已回复': data.stats.replied || 0,
    '超时': data.stats.timeouts || 0,
    '跳过：没 @': data.stats['skip:not-mentioned'] || 0,
    '跳过：限速': data.stats['skip:rate-limited'] || 0,
    '跳过：群未授权': data.stats['skip:group-not-allowed'] || 0,
    '错误': data.stats.errors || 0,
  });
  const groups = data.groups || [];
  $('groups').innerHTML = groups.length === 0
    ? '<div class="muted">还没有发现群消息。先把机器人拉进群、发一条消息试试。</div>'
    : '<ul>' + groups.slice(0, 12).map((g) =>
        '<li><code>' + g.id + '</code>' + (g.name ? ' ' + g.name : '') +
        ' <span class="muted">· ' + (g.messages || 0) + ' 条</span></li>').join('') + '</ul>';
}

async function startLogin() {
  $('loginMsg').textContent = '正在向协议端取二维码…';
  const data = await api('/wechat-pad/api/login', { method: 'POST' });
  if (!data.ok) {
    $('loginMsg').textContent = '取码失败：' + (data.error || '未知错误');
    return;
  }
  currentUuid = data.uuid || '';
  const img = data.qrcode || data.qr || data.qrcodeUrl || '';
  if (img) {
    $('qrBox').innerHTML = '<img alt="登录二维码" src="' + img + '">';
    $('loginMsg').textContent = '用手机微信扫一扫（' + Math.round((data.expireTime || 300) / 60) + ' 分钟内有效）';
  } else {
    $('loginMsg').textContent = '协议端没返回图片，原始响应：' + JSON.stringify(data).slice(0, 120);
  }
}

async function checkLogin() {
  if (!currentUuid) { $('loginMsg').textContent = '先获取二维码'; return; }
  const data = await api('/wechat-pad/api/login/status?uuid=' + encodeURIComponent(currentUuid));
  const state = JSON.stringify(data.detail || data).slice(0, 200);
  $('loginMsg').textContent = '状态：' + state;
  if (data.loggedIn) refreshStatus();
}

$('login').onclick = startLogin;
$('refresh').onclick = checkLogin;
$('probe').onclick = refreshStatus;
$('hook').onclick = async () => {
  $('hookMsg').textContent = '配置中…';
  const data = await api('/wechat-pad/api/webhook/configure', { method: 'POST' });
  $('hookMsg').textContent = data.ok ? '已指向 ' + data.url : '失败：' + (data.error || JSON.stringify(data.tried || []));
};
refreshStatus();
setInterval(refreshStatus, 15000);
</script>
</body></html>`;

/**
 * 首页/接口。挂在 `/wechat-pad` 前缀上，webhook 是单独注册的 exact 路由。
 *
 * getRuntime 每次请求现取，这样面板上改设置后可以立刻换掉旧的 bridge。
 */
export function createDashboardHandler({
  getRuntime,
  onSettings,
  mountPath = '/wechat-pad',
  logger,
}) {
  const log = logger ?? console;

  return async function dashboardHandler(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const runtime = getRuntime?.() ?? {};
    const { cfg, pad, store, bridge } = runtime;

    try {
      if (req.method === 'GET' && (path === mountPath || path === `${mountPath}/`)) {
        html(res, PAGE);
        return;
      }

      if (req.method === 'GET' && path === `${mountPath}/api/status`) {
        const probe = await pad.probe();
        const webhook = await pad.webhookStatus().catch(() => ({ ok: false }));
        json(res, 200, {
          padUrl: cfg.padUrl,
          probe,
          webhook,
          pad: store.snapshot().pad ?? {},
          stats: store.stats(),
          groups: store.groups(),
          pending: bridge?.pending ?? 0,
          settings: runtime.settings ?? null,
          settingsFile: runtime.settingsFile ?? '',
        });
        return;
      }

      if (req.method === 'GET' && path === `${mountPath}/api/settings`) {
        json(res, 200, {
          ok: true,
          settings: runtime.settings ?? {},
          schema: runtime.settingsSchema ?? [],
          file: runtime.settingsFile ?? '',
        });
        return;
      }

      if (req.method === 'POST' && path === `${mountPath}/api/settings`) {
        if (typeof onSettings !== 'function') {
          json(res, 503, { ok: false, error: '当前上下文不支持保存设置' });
          return;
        }
        const body = await readJson(req);
        try {
          const result = await onSettings(body?.settings ?? body ?? {});
          json(res, 200, { ok: true, ...result });
        } catch (error) {
          json(res, 400, { ok: false, error: error?.message ?? String(error) });
        }
        return;
      }

      if (req.method === 'POST' && path === `${mountPath}/api/sessions/reset`) {
        const dropped = typeof bridge?.dropSessions === 'function' ? bridge.dropSessions() : 0;
        json(res, 200, { ok: true, dropped });
        return;
      }

      if (req.method === 'POST' && path === `${mountPath}/api/scan`) {
        try {
          const result = await pad.scan(true);
          json(res, 200, { ok: true, result });
        } catch (error) {
          json(res, 502, { ok: false, error: error?.message ?? String(error) });
        }
        return;
      }

      if (req.method === 'POST' && path === `${mountPath}/api/login`) {
        try {
          const data = await pad.loginQr();
          const uuid = data?.uuid ?? data?.Uuid ?? data?.data?.uuid ?? '';
          const image = data?.qrcode ?? data?.data?.qrcode ?? '';
          json(res, 200, {
            ok: Boolean(uuid),
            uuid,
            qr: image ? (String(image).startsWith('data:') ? image : `data:image/png;base64,${image}`) : '',
            expireTime: data?.expireTime ?? 300,
            raw: data,
          });
        } catch (error) {
          json(res, 502, { ok: false, error: error?.message ?? String(error) });
        }
        return;
      }

      if (req.method === 'GET' && path === `${mountPath}/api/login/status`) {
        const uuid = url.searchParams.get('uuid') ?? '';
        if (!uuid) {
          json(res, 400, { ok: false, error: 'uuid-required' });
          return;
        }
        try {
          const detail = await pad.loginStatus(uuid);
          const text = JSON.stringify(detail ?? {});
          const loggedIn = /(logged|success|online|"code"\s*:\s*200)/i.test(text) && !/(wait|scan_?pending)/i.test(text);
          if (loggedIn) {
            const self = detail?.data?.userInfo ?? detail?.data ?? null;
            if (self) store.padInfo({ selfWxid: self?.wxid ?? self?.UserName ?? '', selfName: self?.nickName ?? self?.NickName ?? '' });
          }
          json(res, 200, { ok: true, loggedIn, detail });
        } catch (error) {
          json(res, 502, { ok: false, error: error?.message ?? String(error) });
        }
        return;
      }

      if (req.method === 'POST' && path === `${mountPath}/api/verify`) {
        const body = await readJson(req);
        try {
          json(res, 200, { ok: true, detail: await pad.verifyCode(body.uuid, body.code) });
        } catch (error) {
          json(res, 502, { ok: false, error: error?.message ?? String(error) });
        }
        return;
      }

      if (req.method === 'POST' && path === `${mountPath}/api/webhook/configure`) {
        const result = await configureWebhook({ cfg, pad, logger: log });
        json(res, 200, result);
        return;
      }

      json(res, 404, { ok: false, error: 'not-found' });
    } catch (error) {
      log.error?.(`[wechat-pad] 面板请求失败：${error?.stack ?? error}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  };
}

/** 把本插件的 webhook 地址写进协议端。 */
export async function configureWebhook({ cfg, pad, logger, origin }) {
  const base = origin ?? cfg.publicOrigin;
  if (!base) return { ok: false, error: '拿不到本机对外地址（webServer.getOrigin 不可用）' };
  const query = cfg.webhookSecret ? `?secret=${encodeURIComponent(cfg.webhookSecret)}` : '';
  const url = `${String(base).replace(/\/+$/, '')}${cfg.hookPath}${query}`;
  const result = await pad.configureWebhook(url, { types: [1, 3, 49] });
  if (result.ok) {
    logger?.info?.(`[wechat-pad] webhook 已指向 ${url}`);
    return { ok: true, url, detail: result.result };
  }
  logger?.warn?.(`[wechat-pad] webhook 配置失败：${result.tried.join(' | ')}`);
  return { ok: false, url, tried: result.tried };
}
