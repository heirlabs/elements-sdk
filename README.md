# HEIR Desk Element SDK

Typed protocol SDK for **HEIR Desk Elements** — small third-party apps that run
inside the HEIR desk in a hard sandbox.

This package is the contract the desk host, the registry, and the `heir-element`
CLI all import. It ships the element-side bridge client, the manifest v1 schema
and validator, CSP generation, integrity/signing helpers, a static bundle
scanner, and a development emulator.

| | |
|---|---|
| npm | [`@morbidcorp/element-sdk`](https://www.npmjs.com/package/@morbidcorp/element-sdk) `0.2.0` |
| Protocol | `heir-element-api@1` |
| Repo | [`heirlabs/elements-sdk`](https://github.com/heirlabs/elements-sdk) |
| CLI | [`@morbidcorp/elements-cli`](https://www.npmjs.com/package/@morbidcorp/elements-cli) (`heir-element`) |
| Node | `>= 18` · ESM only |

[![npm](https://img.shields.io/npm/v/@morbidcorp/element-sdk.svg)](https://www.npmjs.com/package/@morbidcorp/element-sdk)
[![CI](https://github.com/heirlabs/elements-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/heirlabs/elements-sdk/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/@morbidcorp/element-sdk.svg)](https://www.npmjs.com/package/@morbidcorp/element-sdk)
[![License: proprietary](https://img.shields.io/badge/license-proprietary-lightgrey.svg)](LICENSE)

## Status (as of 2026-08-18)

This repository is **public**. The package is on npm. The HEIR desk host and
marketplace registry import this SDK as their single source of truth for
validation, scanning, and signing.

The marketplace listing UI and third-party install surface ship independently
of this package and are not claimed as a live public store here. Use this repo
to author, validate, and test Elements against the published protocol.

Not this repo: [`heirlabs/element-sdk`](https://github.com/heirlabs/element-sdk)
(singular) is the legacy DEFAI monorepo (`@defai/element-sdk`). Do not install
it for Desk work.

## Install

```sh
npm install @morbidcorp/element-sdk
```

Requires Node.js `>= 18`. ESM only.

To scaffold and run an Element locally, install the CLI (also on npm):

```sh
npm install -g @morbidcorp/elements-cli
heir-element --version
```

Git-install still works (`npm install github:heirlabs/elements-sdk`); the
`prepare` script builds on install. Prefer the npm package.

## Security model

- An Element is static HTML/JS/CSS served from a **sandboxed, cross-origin
  iframe** with a locked-down CSP (`default-src 'none'`; network access only
  to origins declared in the manifest).
- The only way in or out is the **host-relayed bridge**: a `MessageChannel`
  port handed to the frame at init. Every call is schema-validated on both
  sides, permission-checked, rate-limited (120 calls / 10 s by default), and
  logged by the host.
- The frame **never holds a credential**. `llm.complete` is proxied by the
  host; the API key never crosses the bridge. `element.getContext` contains
  zero user data — no name, no email, no desk name.
- Elements can **never** access estate data, PII, wallets, proof-of-life, or
  auth. The corresponding scope prefixes (`estate.`, `identity.`, `wallet.`,
  `auth.`, `payments.`, `settings.`, `agent.`, `pol.`) are reserved and
  rejected at schema level. There is no permission tier that grants them.
- Sensitive UI (`ui.confirm`, `ui.openExternal`) is drawn by the host
  **outside** the frame, so an Element cannot fake or suppress it.
- Bundles are content-addressed (`sha256`) and signed (ed25519) by the
  publisher; the registry countersigns. See [docs/MANIFEST.md](docs/MANIFEST.md).

```
┌─────────────────────────────────────────────────────────┐
│  Element iframe   sandbox + cross-origin + locked CSP   │
│  HTML / JS / CSS only. No cookies, no parent access.    │
└──────────────────────────┬──────────────────────────────┘
                           │ MessageChannel (only path)
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Host desk                                              │
│  validate → permission-check → rate-limit → log         │
│  storage (1 MB, element-scoped)                         │
│  llm.complete (host-proxied; key stays on the host)     │
│  confirm / toast / openExternal (host-drawn)            │
└─────────────────────────────────────────────────────────┘
```

## Capabilities (`heir-element-api@1`, closed set)

| Method | Permission | Notes |
|---|---|---|
| `element.getContext` | none | `{elementId, installId, version, locale, theme, viewport, deskVersion}` — zero user data |
| `storage.get` | `storage.element` | `{key}` → `{value: string \| null}` |
| `storage.set` | `storage.element` | `{key, value}` → `{}`; `E_QUOTA_EXCEEDED` over 1 MB total |
| `storage.delete` | `storage.element` | `{key}` → `{}` |
| `storage.list` | `storage.element` | `{prefix?}` → `{keys}` |
| `ui.setTitle` | none | Host sanitizes; never reaches agent context |
| `ui.requestResize` | none | Host-clamped; returns the granted size |
| `ui.toast` | `notifications` | Host-rendered, attributed to the Element |
| `ui.confirm` | none | Host-drawn dialog outside the frame |
| `ui.openExternal` | none | Host-drawn confirm showing the full URL |
| `clipboard.writeText` | `clipboard.write` | Requires a fresh user gesture |
| `llm.complete` | `llm.completion` | Host-proxied; key never crosses the bridge |

Host→element events: `theme-changed`, `visibility-changed`, `resize`.

Anything not in this table does not exist. Adding a method or permission is a
protocol change and requires a SPEC update.

## Quick start

```ts
import { connectElement } from '@morbidcorp/element-sdk';

const api = await connectElement();
const ctx = await api.getContext();

await api.storage.set('count', '1');
api.onEvent('theme-changed', ({ theme }) => {
  document.body.dataset.theme = theme;
});
```

Zero-to-running walkthrough (scaffold, emulator, validate, pack, dry-run
publish): [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).

Validate a manifest from Node:

```ts
import { validateManifest } from '@morbidcorp/element-sdk/manifest';

const { ok, errors, warnings } = validateManifest(json, {
  audience: 'third-party',
  mode: 'authoring',
});
```

A golden `manifest.json` lives at [examples/hello-manifest.json](examples/hello-manifest.json).

## Package layout

| Entry point | Contents |
|---|---|
| `@morbidcorp/element-sdk` | `connectElement`, types, constants |
| `@morbidcorp/element-sdk/protocol` | Wire types + per-method zod schemas (params and results) |
| `@morbidcorp/element-sdk/manifest` | Manifest type, zod schema, `validateManifest`, JSON-Schema re-export |
| `@morbidcorp/element-sdk/integrity` | Canonical JSON, hashing, sign payload, ed25519 sign/verify |
| `@morbidcorp/element-sdk/csp` | `generateElementCsp` |
| `@morbidcorp/element-sdk/emulator` | `EmulatorCore` (environment-agnostic) + `attachIframeHost` |
| `@morbidcorp/element-sdk/scanner` | Static bundle scanner (`scanBundle`) — no Node APIs |

Runtime dependencies: `zod`, `@noble/hashes`, `@noble/curves`. Nothing else.

## Docs

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — zero to running
- [docs/API.md](docs/API.md) — client API reference
- [docs/MANIFEST.md](docs/MANIFEST.md) — manifest fields and every validator code
- [SPEC.md](SPEC.md) — binding implementation contract (contributors)
- [CHANGELOG.md](CHANGELOG.md)

## Development

```sh
git clone https://github.com/heirlabs/elements-sdk.git
cd elements-sdk
npm ci
npm run build   # tsc + regenerates schemas/manifest.v1.json
npm test        # vitest — 190 tests as of 0.2.0
```

`schemas/manifest.v1.json` is generated from the zod schema and committed; a
drift test fails if they diverge.

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

Proprietary. Copyright (c) 2026 Heir Labs. All rights reserved.
See [LICENSE](LICENSE). Access to this repository is not a grant of rights.
