# VibeHeader

> A lightweight, ad-free HTTP header editor for Chrome — with one-click shareable configs. A clean ModHeader alternative.

VibeHeader lets you add custom HTTP **request headers** to your browser traffic and share that setup with a single link. No account, no ads, no tracking — everything stays on your machine.

## ✨ Features

- 🎯 **Focused** — add, edit, toggle, and remove request headers. Nothing else to get in the way.
- 🔗 **One-click sharing** — turn your headers into a link and send it to a teammate; they import it in one click.
- 🔒 **Privacy-first** — all data is stored locally in `chrome.storage.local`. No backend, no account, nothing uploaded.
- ⚡ **Fast toggle** — pause or resume all headers instantly.
- 🪶 **Local-only data** — needs all-sites host access (granted at install) to apply your headers, but nothing ever leaves your machine.

## Why VibeHeader over ModHeader?

ModHeader was the default header editor for years, but it added ads and went closed-source — so we built VibeHeader as an open, ad-free alternative. ModHeader was later caught shipping malware, which only confirmed why an auditable tool matters.

- **Open source (MIT)** — every line is auditable, so a bad update can't hide.
- **No ads. Ever.**
- **Local by design** — your config lives in `chrome.storage.local`; the extension uploads nothing.
- **Minimal permissions** — host access only to apply the headers you set.

[Why we built VibeHeader →](https://vibeheader.com/blog/modheader-malware-why-i-built-vibeheader/)

## 📦 Install

- **Chrome Web Store:** [VibeHeader](https://chromewebstore.google.com/detail/vibeheader/imjffcblfdblnjcekpamheljmolejoll)
- **From source:** see [Development](#-development) below, then load the `dist/` folder as an unpacked extension.

## 🚀 Usage

1. Click the VibeHeader toolbar icon.
2. Add a header — a name (e.g. `Authorization`) and a value (e.g. `Bearer token123`).
3. The header is applied to your requests. Use **Pause / Resume** to toggle all headers at once.
4. Click **Copy Link** to generate a share link containing your enabled headers.
5. Whoever opens that link (with VibeHeader installed) can import the headers in one click.

> Header modification is powered by Chrome's Manifest V3 `declarativeNetRequest` API, which governs exactly which headers can be changed.

## 🔒 Privacy

VibeHeader is built to not touch your data:

- **Local only** — header names, values, and settings live in `chrome.storage.local` and are never uploaded.
- **No backend, no account** — the extension itself sends nothing to us or any third party.
- **Share links never hit a server** — a config is encoded in the URL fragment (`#c=`), which the browser does not transmit. Sharing is entirely client-side.
- **Host access** — VibeHeader requests all-sites host access at install time so it can apply your configured headers to the requests you make. It's used only to modify the request headers you set up — never to read or transmit page content.

The code is fully open — audit it yourself. Report security issues via [SECURITY.md](SECURITY.md).

## 🛠️ Development

```bash
git clone https://github.com/vibeheader/vibeheader.git
cd vibeheader
npm install

# Dev build (watch), uses manifest.dev.json
npm run dev

# One-off dev build
npm run build

# Production build (for store submission), uses manifest.prod.json
npm run build:prod

# Lint & test
npm run lint
npm run test

# Produce a store-ready zip of dist/
npm run zip
```

Load the unpacked extension:

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Reload the extension card after each rebuild

### Project layout

```
src/
├── background/     # service worker: message router + DNR rule sync
├── content/        # postMessage bridge for the share page
├── popup/          # the header editor UI
├── shared/
│   ├── models/     # Config data model
│   ├── services/   # ConfigService (storage + DNR rules)
│   └── utils/      # storage + validation helpers
└── assets/icons/   # extension icons
```

### Build variants

- `manifest.dev.json` — dev build; also injects `localhost` share pages for local testing.
- `manifest.prod.json` — production build; only matches `https://vibeheader.com/s*`.

Rollup copies the right one to `dist/manifest.json` based on `BUILD_ENV`.

## 🤝 Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For security issues, please follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

## 📄 License

[MIT](LICENSE)
