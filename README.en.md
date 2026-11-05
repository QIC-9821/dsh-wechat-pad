# dsh-wechat-pad

Bring your **personal WeChat** into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): answer DMs directly, speak in group chats only when mentioned.

The plugin contains no WeChat protocol code. It talks to a **self-hosted iPad-protocol backend** (currently shaped after [WeChatPadPro](https://github.com/WeChatPadPro/WeChatPadPro)); the backend logs in and moves bytes, the plugin decides who is talking, whether to answer, which session to use, and how to reply.

> ⚠️ Logging a personal WeChat account in through a third-party protocol **violates WeChat's terms** and can get the account banned (1 day → permanent). Use an account you are willing to lose. This project ships no backend, no accounts, and nothing that circumvents risk controls.

## What it does

- **DMs** — replies to whoever writes (can be disabled).
- **Groups** — only answers when mentioned, prefixes the reply with `@sender`; groups not on the whitelist are ignored.
- **One session per group** — contexts never bleed between a group and a DM.
- **Dashboard** at `/wechat-pad` — QR login, connection status, group whitelist, stats.
- **Webhook self-configuration** — on start it writes its own callback URL back to the backend.

## How it works

```
WeChat ←→ backend (WeChatPadPro, your machine/cloud)
                │  webhook
                ▼
        dsh-wechat-pad (Host plugin, in-process in DSH)
                │  session/create · session/prompt · session/event
                ▼
             DSH agent ←→ your model, your tools, your memory
                │  answer
                ▼
        backend SendText → WeChat
```

It runs inside the DSH process and calls the host's session services directly — no launch token, no extra HTTP relay. Panel and webhook both ride on DSH's own `webServer`.

## Requirements

1. A machine that can run the backend 24/7 (Linux/Docker recommended).
2. A WeChat account you're willing to risk (a secondary one is wise).
3. A stable egress IP and a way for the backend to reach DSH's webhook (public URL or tunnel if they're on different hosts).
4. DSH 0.2.x.

## Install

```bash
dsh plugin add /path/to/dsh-wechat-pad   # local
dsh plugin add dsh-wechat-pad            # once published
```

Enable `dsh-wechat-pad`, then open `http://127.0.0.1:<dsh-port>/wechat-pad`.

## Configure

Minimum: `padUrl` + token (`padToken`, or `padTokenRef` to read it from env/credentials — recommended).

Key options (full table in the Chinese README):

| key | default | meaning |
| --- | --- | --- |
| `padUrl` | — | backend base URL |
| `padTokenRef` | `DSH_WECHAT_PAD_TOKEN` | where to read the AuthKey from |
| `hookPath` | `/wechat-pad/hook` | webhook path |
| `webhookSecret` | generated | callback secret (header / query / HMAC) |
| `selfWxid` | auto | the bot's own wxid |
| `botNames` | `[]` | extra aliases that count as "mentioned" |
| `answerDirectMessages` | `true` | reply in DMs |
| `defaultTrigger` | `mention` | group trigger: `mention` or `all` |
| `groups` | `[]` | group whitelist: `{id, name, enabled, trigger, ratePerMin}` |
| `timeoutSec` | `120` | max wait for the agent |
| `chunkChars` / `chunkDelayMs` | `1500` / `1500` | long replies are split |
| `ratePerMinPerGroup` / `ratePerMinGlobal` | `5` / `10` | rate limits |

## Safety

- Bans are a real possibility; that's the price of the protocol.
- Messages pass through your backend, your DSH, and your model provider.
- The plugin creates sessions as the host owner — the agent keeps whatever tools you gave it. Don't hand dangerous tools to an account that talks to strangers.
- Keep the backend token out of config files; use `padTokenRef`.

## Development

```bash
npm test   # 11 tests, including an e2e run against a mock backend
```

## License

MIT
