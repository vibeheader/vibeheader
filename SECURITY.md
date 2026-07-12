# Security Policy

VibeHeader can modify the HTTP headers your browser sends and receives, so we
take security seriously. Thank you for helping keep users safe.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through either of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  (the **Security** tab → *Report a vulnerability*), or
- email **hello@vibeheader.com** with the details.

Please include:

- what the issue is and where (file / URL / manifest permission),
- a proof of concept or reproduction steps if you have one,
- the impact you believe it has.

We aim to acknowledge reports within **72 hours** and to ship a fix or a
mitigation plan for confirmed issues as quickly as we reasonably can. We're
happy to credit you in the release notes unless you'd rather stay anonymous.

## Scope

In scope:

- the extension source in this repository (background, popup, content script,
  shared services),
- the manifest permission model,
- the share-link import/export flow.

Out of scope:

- the marketing website (reported separately),
- vulnerabilities that require a already-compromised machine or a malicious
  extension already installed alongside VibeHeader.

## What VibeHeader does with your data

- All configuration (header names, values, scopes) is stored **locally** in
  `chrome.storage.local`. There is **no backend, no account, and no
  telemetry** — nothing is sent to us or any third party.
- Share links encode the config into the URL fragment (`#c=`), which the
  browser never transmits to a server. Sharing happens entirely client-side.
- Host access is used only to apply your header rules via the
  `declarativeNetRequest` API.
