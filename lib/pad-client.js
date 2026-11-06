/**
 * 协议端（默认 WeChatPadPro）HTTP 客户端。
 *
 * 设计原则：
 * - 不假设某一版接口一定存在，发送类接口按候选清单逐个试，成功一次就记住。
 * - 所有调用都有超时与明确的错误文本，方便在日志里定位。
 */

const TEXT_SEND_CANDIDATES = [
  { path: '/api/v1/message/SendText', body: (to, text) => ({ toUserName: to, content: text }) },
  { path: '/api/v1/message/SendTextMsg', body: (to, text) => ({ toUserName: to, content: text }) },
  { path: '/api/v1/message/sendText', body: (to, text) => ({ toUserName: to, content: text }) },
  { path: '/api/message/SendText', body: (to, text) => ({ toUserName: to, content: text }) },
  { path: '/api/v1/message/SendText', body: (to, text) => ({ toUserName: to, msgType: 1, content: { string: text } }) },
];

export class PadError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message);
    this.name = 'PadError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export class PadClient {
  #cfg;
  #logger;
  #token = '';
  #textSpec = null;
  #fileSpec = null;

  constructor(cfg, { logger } = {}) {
    this.#cfg = cfg;
    this.#logger = logger ?? console;
    this.#token = cfg.padToken || '';
  }

  get baseUrl() {
    return this.#cfg.padUrl;
  }

  setToken(token) {
    this.#token = String(token ?? '').trim();
  }

  hasToken() {
    return this.#token !== '';
  }

  async #request(path, { method = 'POST', body, raw, headers = {}, timeoutMs } = {}) {
    if (!this.#cfg.padUrl) throw new PadError('padUrl 未配置', { path });
    const url = `${this.#cfg.padUrl}${path}`;
    const init = { method, headers: { accept: 'application/json', ...headers } };
    if (this.#token) init.headers.authorization = `Bearer ${this.#token}`;
    if (raw !== undefined) {
      init.body = raw;
    } else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs ?? this.#cfg.requestTimeoutMs),
      });
    } catch (error) {
      throw new PadError(`请求协议端失败 ${method} ${path}: ${error?.message ?? error}`, { path });
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      throw new PadError(`协议端返回 ${response.status} ${method} ${path}`, {
        status: response.status,
        body: parsed,
        path,
      });
    }
    return parsed;
  }

  /** 探活：能连上协议端就算活着。 */
  async probe() {
    try {
      const data = await this.#request('/api/v1/status', { method: 'GET', timeoutMs: 5000 });
      return { ok: true, data };
    } catch (error) {
      if (error instanceof PadError && error.status === 404) return { ok: true, data: null, note: 'status 端点不存在，但服务可达' };
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  /**
   * 手动让协议端扫一次数据库（本地 hook 才有这个端点；WeChatPadPro 没有）。
   * 用于「我怀疑漏消息了，点一下立刻扫」。
   */
  async scan(discover = true) {
    return this.#request('/api/v1/scan', { body: { discover }, timeoutMs: 20000 });
  }

  /** 申请登录二维码。 */
  async loginQr(extra = {}) {
    return this.#request('/api/login/GetLoginQrCodeNewX', {
      body: { proxy: '', deviceName: 'DSH', deviceId: '', ...extra },
      timeoutMs: 20000,
    });
  }

  /** 查询扫码状态。 */
  async loginStatus(uuid) {
    return this.#request(`/api/login/CheckLoginStatus?key=${encodeURIComponent(uuid)}`, { method: 'GET' });
  }

  /** 提交短信/辅助验证码。 */
  async verifyCode(uuid, code) {
    return this.#request('/api/login/AutoVerificationcode', { body: { uuid, code } });
  }

  /** 发纯文本；父级会负责切分与节流。 */
  async sendText(toUserName, text) {
    const candidates = this.#textSpec ? [this.#textSpec, ...TEXT_SEND_CANDIDATES] : TEXT_SEND_CANDIDATES;
    const tried = [];
    for (const spec of candidates) {
      try {
        const result = await this.#request(spec.path, { body: spec.body(toUserName, text) });
        this.#textSpec = spec;
        return result;
      } catch (error) {
        tried.push(`${spec.path} → ${error?.message ?? error}`);
        if (error instanceof PadError && (error.status === 404 || error.status === 405 || error.status === 400)) continue;
        throw error;
      }
    }
    throw new PadError(`没有可用的发文本接口：${tried.join(' | ')}`);
  }

  /** 发文件/图片。buffer 为二进制内容。 */
  async sendFile(toUserName, { buffer, filename, kind = 'image', mime = 'application/octet-stream' }) {
    const attempts = this.#fileSpec ? [this.#fileSpec] : [
      { path: '/api/v1/message/sendFile', field: 'fileData', withTo: true },
      { path: '/api/v1/message/sendFile', field: 'file', withTo: true },
      { path: '/api/v1/message/SendFile', field: 'fileData', withTo: true },
    ];
    const tried = [];
    for (const spec of attempts) {
      try {
        const form = new FormData();
        form.append('toUserName', toUserName);
        form.append('fileName', filename ?? 'file.bin');
        form.append('fileType', kind);
        form.append(spec.field, new Blob([buffer], { type: mime }), filename ?? 'file.bin');
        const result = await this.#request(spec.path, { body: undefined, raw: form, timeoutMs: 60000 });
        this.#fileSpec = spec;
        return result;
      } catch (error) {
        tried.push(`${spec.path}#${spec.field} → ${error?.message ?? error}`);
        if (error instanceof PadError && (error.status === 404 || error.status === 405)) continue;
        throw error;
      }
    }
    throw new PadError(`没有可用的发文件接口：${tried.join(' | ')}`);
  }

  /** 让协议端把消息推到本插件。 */
  async configureWebhook(url, { types = [1, 3, 49], includeSelf = false } = {}) {
    const spec = { url, types, includeSelf };
    const attempts = [
      () => this.#request('/v1/webhook/Config', { body: { webhookUrl: url, types, includeSelf } }),
      () => this.#request('/v1/webhook/Update', { method: 'PUT', body: { webhookUrl: url, types, includeSelf } }),
      () => this.#request('/api/webhook/Config', { body: { webhookUrl: url, types, includeSelf } }),
    ];
    const tried = [];
    for (const attempt of attempts) {
      try {
        return { ok: true, spec, result: await attempt() };
      } catch (error) {
        tried.push(error?.message ?? String(error));
      }
    }
    return { ok: false, spec, tried };
  }

  async webhookStatus() {
    for (const path of ['/v1/webhook/Status', '/v1/webhook/List', '/api/webhook/Status']) {
      try {
        return { ok: true, path, data: await this.#request(path, { method: 'GET' }) };
      } catch {
        // 继续试下一个
      }
    }
    return { ok: false };
  }

  /** 尽力拿群列表；拿不到不致命（首页仪表盘会展示从消息里发现的群）。 */
  async listGroups() {
    for (const path of ['/api/v1/group/GetGroupList', '/api/v1/group/list', '/api/group/GetGroupList']) {
      try {
        const data = await this.#request(path, { method: 'GET' });
        return { ok: true, path, data };
      } catch {
        // 继续
      }
    }
    return { ok: false };
  }
}
