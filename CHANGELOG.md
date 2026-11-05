# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-05

First public release. **Experimental**: the plugin talks to a self-hosted,
unofficial iPad-protocol backend, and using one with a personal WeChat account
carries a real risk of the account being restricted or banned.

### Added

- DM replies and group replies gated by @-mention and a per-group allowlist.
- One independent DSH session per chat, created through the host's in-process
  connection/typert gateway (no launch token, no relay).
- Control panel at `/wechat-pad`: connection status, QR login, group allowlist
  and counters.
- Webhook registration with the backend on startup, with three accepted
  authentication schemes.
- Per-group send queue with rate limiting, message splitting and a timeout
  fallback.
- Tests covering parsing, policy, queueing and the end-to-end webhook path.
