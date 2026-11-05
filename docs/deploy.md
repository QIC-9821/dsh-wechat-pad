# 部署一台协议端

插件只是「脑子」，得先有一台能登录微信的「手」。这里以 WeChatPadPro 为例，给一套最小可用的部署。

## 0. 先想清楚

- 协议端必须**长期在线**：它掉线，微信就收不到消息，插件再聪明也没用。
- 同一个微信号**同时只能有一个协议端在跑**，多开会互相踢下线。
- 出口 IP、设备指纹要稳定，频繁变化会触发风控。

## 1. 起服务（Docker Compose）

```yaml
# docker-compose.yml
services:
  mysql:
    image: mysql:8.0
    command: --innodb-buffer-pool-size=128M --performance-schema=OFF
    environment:
      MYSQL_ROOT_PASSWORD: change-me
      MYSQL_DATABASE: wechatpad
    volumes: ["mysql:/var/lib/mysql"]
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 128mb --maxmemory-policy allkeys-lru
    restart: unless-stopped

  wechatpad:
    image: wechatpadpro/wechatpadpro:latest
    depends_on: [mysql, redis]
    ports: ["8080:8080", "1238:1238"]
    environment:
      ADMIN_KEY: change-me-too
    volumes: ["./data:/app/data"]
    restart: unless-stopped

volumes:
  mysql:
```

```bash
docker compose up -d
docker compose logs -f wechatpad   # 看到 started 再往下
```

资源参考：2 vCPU / 2 GB 内存足够；协议端常驻约 300–600 MB。

## 2. 拿 AuthKey

二进制版可以直接本地签（Docker 版看它的管控台 `:1238`）：

```bash
curl "http://127.0.0.1:8848/login/GenAuthKey2?key=<ADMIN_KEY>&count=1&days=365"
```

把结果填进插件的 `padToken`（或写进环境变量 `DSH_WECHAT_PAD_TOKEN`，用 `padTokenRef` 读）。

## 3. 登录

打开 DSH 的 `/wechat-pad` 面板，点「扫码登录」，手机微信扫。扫完等面板显示在线。

> 新号/新设备常见「24 小时内掉一次」，按协议端文档重扫；稳定后一般能挂很久。前半段别频繁操作（建群、拉人、加好友都有冷却期）。

## 4. 让协议端回调到插件

如果协议端和 DSH 在同一台机器：

- `padUrl: http://127.0.0.1:8080`
- 插件自动把 `http://127.0.0.1:<dsh 端口>/wechat-pad/hook` 写回去。

不在同一台机器：给 DSH 一个能到达的地址，两种常见做法：

```bash
# cloudflared 快速隧道
cloudflared tunnel --url http://127.0.0.1:3080

# 或 tailscale，直接用它给的 100.x 地址
```

然后把 `padUrl` 指向协议端，并把面板里「回调地址」改成隧道域名 + `/wechat-pad/hook`（`autoConfigureWebhook: false` 时自己填）。

## 5. 验证

1. 面板「统计」里应该开始出现消息计数。
2. 私聊发一句，应该回。
3. 拉进群，@ 它，应该在群里回一条带 `@你` 的消息。
4. 不在白名单的群，@ 也不回（日志里记 `skip:group-not-allowed`）。

## 6. 出问题先看哪里

| 现象 | 先查 |
| --- | --- |
| 面板一直「离线」 | `padUrl` 通不通、AuthKey 对不对、协议端日志 |
| 有消息计数但不回 | 群是否在白名单、是否真的 @ 到、`selfWxid` 对不对 |
| 回复发不出去 | `sendText` 路径是否命中（日志里 `#textSpec`）、协议端是否掉线 |
| 回调收不到 | 隧道是否通、`webhookSecret` 是否一致、协议端 webhook 状态 |

日志前缀：`[dsh-wechat-pad]`。
