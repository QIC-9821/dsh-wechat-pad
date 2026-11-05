# Security policy

## Supported versions

The latest `0.1.x` release receives fixes. Please upgrade before reporting an
issue.

## Read this before using it

This plugin drives a **personal WeChat account through an unofficial
iPad-protocol backend**. That is a terms-of-service violation and carries a real
risk that the account is restricted or permanently banned. Use a secondary
account you are willing to lose.

## What this plugin does (threat model)

- It does **not** implement the WeChat protocol. It forwards messages to and
  from a backend you host yourself (for example WeChatPadPro). Login
  credentials, the account session and message content live in that backend.
- Webhook requests arrive on your DSH web server at `/wechat-pad/hook`; the
  plugin accepts a shared secret via header, query or path (see the README) and
  rejects everything else. Anyone who knows the secret can inject messages that
  the agent will treat as chat input.
- Message text is passed to a DSH agent session and therefore to your model
  provider. Do not enable it on chats whose contents you would not send to that
  provider.
- The panel at `/wechat-pad` is served by DSH and protected by DSH's own access
  control; it can display account state and group names.
- State (bindings, counters, dedupe keys) is stored under the plugin's state
  directory on this machine. It does not contain your WeChat password.
- No telemetry, no third-party services other than the backend and your model
  provider.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private advisory form:

https://github.com/QIC-9821/dsh-wechat-pad/security/advisories/new

Include the version, backend, configuration (redacted), and a minimal
reproduction. You should get an initial reply within a week.

## Handling secrets

- Keep backend tokens, webhook secrets and QR payloads out of issues and logs.
- Redact account ids, group names and message text before sharing logs.
