# Contributing

Thanks for taking the time to improve `dsh-wechat-pad`.

## Development

Requirements: Node.js ≥ 22 (or the Node.js bundled with DeepSeek Harness) and,
for real testing, a self-hosted protocol backend.

```bash
git clone https://github.com/QIC-9821/dsh-wechat-pad.git
cd dsh-wechat-pad
npm test
node --check index.js
```

The plugin has **zero runtime dependencies** and that is intentional; please do
not add any.

To try the plugin locally, install the checkout as a bundle into a throwaway
profile:

```bash
dsh plugin --profile smoke add /absolute/path/to/dsh-wechat-pad
```

Never test with an account you cannot afford to lose.

## Pull requests

- Keep one logical change per PR.
- Run `npm test` before pushing; CI runs Node 22 and 24.
- Update `README.md`, `README.en.md` and `CHANGELOG.md` when behaviour,
  configuration or compatibility changes.
- Never commit secrets, tokens, QR payloads, real chat logs, or personal paths.
- Mention which backend and version you tested against; the protocol backend is
  not part of this repository.

## Commit messages

Short imperative subject line, optional body explaining why. Examples:

```
fix: keep the group queue alive after a send timeout
docs: list tested backend versions
```

## Reporting bugs

Use the issue templates. Redact account ids, group names, tokens and webhook
secrets from logs before pasting. Security issues go through
[SECURITY.md](SECURITY.md), not the public issue tracker.
