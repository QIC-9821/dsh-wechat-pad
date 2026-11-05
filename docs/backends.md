# 协议端接入约定

插件只依赖一层很窄的 HTTP 契约。任何能提供这套端点的后端都能用；不适配的地方只集中在 `lib/pad-client.js`（路径表）和 `lib/parse.js`（字段归一化）。

## 必需的端点

| 用途 | 请求 | 期望返回 |
| --- | --- | --- |
| 探活 | `GET {padUrl}/api/v1/status`（或任意 200 的只读端点） | 2xx |
| 扫码登录 | `POST /api/login/GetLoginQrCodeNewX` body `{deviceName?, deviceId?}` | `{uuid, qrcode}`（base64 PNG 或 data URL） |
| 登录状态 | `GET /api/login/CheckLoginStatus?key=<uuid>` | `{status}`，`1`/`2`/`ok` 之类的成功态 |
| 验证码 | `POST /api/login/AutoVerificationcode` body `{uuid, code}` | 2xx |
| 发文本 | `POST /api/v1/message/SendText` body `{toUserName, content}` | 2xx |
| 配回调 | `POST /v1/webhook/Config` body `{url, types?, includeSelf?}` | 2xx |
| 回调状态 | `GET /v1/webhook/Status` | `{url}` 之类 |

认证统一走 `Authorization: Bearer <AuthKey>`。

`sendText` 会按顺序试几个候选路径（`/api/v1/message/SendText`、`/api/v1/message/SendTextMsg`、`/api/v1/message/sendText`、`/api/message/SendText`，以及把 `content` 写成 `{string: "..."}` 的变体），第一个成功的会被记住，后续不再试探。所以后端只要命中其中一种就行。

## 回调（webhook）

插件把 `POST {DSH origin}{hookPath}?secret=<webhookSecret>` 写回后端。校验支持三种方式，任一命中即可：

- 请求头 `x-pad-secret` 或 `x-webhook-secret`
- query `?secret=`
- `x-pad-signature`：对原始 body 做 HMAC-SHA256（密钥同上）

收到即回 `200`，处理放在 `queueMicrotask` 里，避免后端重试风暴。

载荷字段尽量宽松地读：

```jsonc
{
  "event_type": "message",
  "data": {
    "NewMsgId": 123456789,                 // 去重键
    "FromUserName": {"string": "xxx@chatroom"},
    "ToUserName":   {"string": "wxid_bot"},
    "MsgType": 1,
    "Content": {"string": "@机器人 在吗"},
    "MsgSource": "<msgsource><atuserlist><![CDATA[wxid_bot]]></atuserlist></msgsource>",
    "IsSender": 0,
    "SenderName": "小明",
    "PushContent": "小明:\n@机器人 在吗"    // 只有预览时也能解析
  }
}
```

`normalizeWebhook()` 会处理 `{string: ...}` 包装、`data` 为数组、`PushContent` 预览、以及 `MsgSource` 里的 `atuserlist`。群聊判定：id 以 `@chatroom` 结尾。

如果某个后端的 at 列表字段不一样（比如是 JSON 数组而不是 CDATA），只改 `parseAtList()`。

## 已实测

**WeChatPadPro**（Go，闭源二进制；release 资产 `wechatpadpro_vios18.61-861_*.zip`，另有 Docker 镜像）：

- 端口：`8080` API、`1238` 管控台；需要 MySQL + Redis。
- AuthKey 可本地自签（二进制版 `http://127.0.0.1:8848/login/GenAuthKey2?key=<ADMIN_KEY>&count=1&days=365`），一个授权码对一个微信号。
- 有一个 `sendFile`（multipart）用于图片/文件，文本接口见上（本插件自动探路）。
- webhook 配置接口同时存在 `/v1/webhook/Config` 与 `/v1/webhook/Update`，插件先 Config 失败再试 Update。

## 换后端时要改的地方

1. `lib/pad-client.js`：路径表、字段名。
2. `lib/parse.js`：`normalizeWebhook` / `parseAtList`。
3. 跑 `npm test`：`test/mock-pad.mjs` 就是照着这套契约写的假后端，改完契约顺手改它。
