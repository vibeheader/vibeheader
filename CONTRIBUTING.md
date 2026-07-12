# Contributing to VibeHeader

Thanks for your interest in improving VibeHeader! This is a small, focused
extension — a lightweight, ad-free, privacy-first HTTP header editor. We'd
rather keep it simple than add every feature, so a quick issue to discuss
larger changes before you build them is appreciated.

## Development setup

```bash
git clone https://github.com/vibeheader/vibeheader.git
cd vibeheader
npm install

# Dev build (watch); uses manifest.dev.json
npm run dev

# One-off dev build
npm run build

# Production build (for store submission); uses manifest.prod.json
npm run build:prod
```

Load the unpacked extension:

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. After each rebuild, click the reload icon on the extension card

## Checks before opening a PR

```bash
npm run lint      # ESLint
npm run test      # Jest
```

- Keep the diff scoped to one thing.
- Match the surrounding code style (vanilla JS, no framework).
- **Never render untrusted data with `innerHTML`.** Header names/values and
  anything from a share link must go through `textContent` or safe DOM
  construction. Share-link imports must pass validation in
  `ValidationUtils` before being applied.
- If you touch the manifest permissions, explain why in the PR — we try to
  request as little as possible.

## Pull request flow

1. Fork and create a branch (`feature/…` or `fix/…`).
2. Make your change with a clear commit message.
3. Open a PR describing what changed and why.

For anything security-related, see [SECURITY.md](SECURITY.md) — please report
privately rather than in a public PR or issue.
