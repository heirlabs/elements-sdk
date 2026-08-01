# @morbidcorp/element-sdk

SDK for building **HEIR Desk Elements** — small third-party apps that run inside the HEIR desk in a hard sandbox. This package provides the element-side bridge client, the manifest schema and validator, CSP generation, integrity/signing helpers, and a development emulator.

Status: pre-v3.0 platform work. This repository is private and nothing in it describes an existing HEIR feature.

## Install

Not yet on npm. Install as a git dependency (the `prepare` script builds on install):

```sh
npm install github:heirlabs/elements-sdk
```

Requires Node >= 18. ESM only.

## The security model in one screen

- An element is static HTML/JS/CSS served from a **sandboxed, cross-origin iframe** with a locked-down CSP (`default-src 'none'`; network access only to endpoints declared in the manifest).
- The only way in or out is the **host-relayed bridge**: a `MessageChannel` port handed to the frame at init. Every call is schema-validated on both sides, permission-checked, rate-limited, and logged by the host.
- The frame **never holds any credential**. `llm.complete` is proxied by the host; the API key never crosses the bridge. `element.getContext` contains zero user data — no name, no email, no desk name.
- Elements can **never** access estate data, PII, wallets, proof-of-life, or auth. The corresponding scope prefixes (`estate.`, `identity.`, `wallet.`, `auth.`, `payments.`, `settings.`, `agent.`, `pol.`) are reserved and rejected at schema level — there is no permission tier at any price that grants them.
- Sensitive UI (`ui.confirm`, `ui.openExternal`) is drawn by the host **outside** the frame, so an element cannot fake or suppress it.
- Bundles are content-addressed (`sha256`) and signed (ed25519) by the publisher; the registry countersigns. See [docs/MANIFEST.md](docs/MANIFEST.md).

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
| `ui.toast` | `notifications` | Host-rendered, attributed to the element |
| `ui.confirm` | none | Host-drawn dialog outside the frame |
| `ui.openExternal` | none | Host-drawn confirm showing the full URL |
| `clipboard.writeText` | `clipboard.write` | Requires a fresh user gesture |
| `llm.complete` | `llm.completion` | Host-proxied; key never crosses the bridge |

Host→element events: `theme-changed`, `visibility-changed`, `resize`.

## Quick start

```ts
import { connectElement } from '@morbidcorp/element-sdk';

const api = await connectElement();
const ctx = await api.getContext();

await api.storage.set('count', '1');
api.onEvent('theme-changed', ({ theme }) => document.body.dataset.theme = theme);
```

## Package layout

| Entry point | Contents |
|---|---|
| `@morbidcorp/element-sdk` | `connectElement`, types, constants |
| `@morbidcorp/element-sdk/protocol` | Wire types + per-method zod schemas (params and results) |
| `@morbidcorp/element-sdk/manifest` | Manifest type, zod schema, `validateManifest`, JSON-Schema re-export |
| `@morbidcorp/element-sdk/integrity` | Canonical JSON, hashing, sign payload, ed25519 sign/verify |
| `@morbidcorp/element-sdk/csp` | `generateElementCsp` |
| `@morbidcorp/element-sdk/emulator` | `EmulatorCore` (environment-agnostic) + `attachIframeHost` |
| `@morbidcorp/element-sdk/scanner` | Static bundle scanner (`scanBundle`) — environment-agnostic, no Node APIs |

## Docs

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — zero to running in 30 minutes
- [docs/API.md](docs/API.md) — full client API reference
- [docs/MANIFEST.md](docs/MANIFEST.md) — manifest field-by-field, every error code

## Development

```sh
npm ci
npm run build   # tsc + regenerates schemas/manifest.v1.json
npm test        # vitest
```

`schemas/manifest.v1.json` is generated from the zod schema and committed; a drift test fails if they diverge.

## License

Proprietary. Copyright (c) 2026 Heir Labs. All rights reserved. See [LICENSE](LICENSE).
