# Getting started: zero to a running Element in 30 minutes

This walkthrough takes you from nothing to a validated, packed, signed (dry-run) Element using the `heir-element` CLI and this SDK.

## Prerequisites

- Node.js >= 18 (`node --version`)
- npm

## 1. Install the CLI (1 min)

```sh
npm install -g @morbidcorp/elements-cli
```

Verify:

```sh
heir-element --version
```

Working from source instead? Clone and link (your git HTTPS auth needs access
to the private repos):

```sh
git clone https://github.com/heirlabs/elements-cli.git
cd elements-cli
npm install
npm install -g .
cd ..
```

> Avoid `npm install -g github:heirlabs/elements-cli`: npm prepares nested git
> dependencies without their devDependencies, so the TypeScript `prepare`
> build fails with `tsc: command not found`. Use the npm package or the clone
> route above.

## 2. Scaffold a new element (2 min)

```sh
heir-element init my-timer
cd my-timer
```

This creates:

```
my-timer/
  manifest.json      # element manifest (v1)
  index.html         # entry point
  src/main.js        # connects to the bridge
  src/style.css
  package.json       # scripts: dev / validate / pack
  README.md
  .gitignore         # node_modules, .heir, dist
```

The scaffold already depends on `@morbidcorp/element-sdk` and calls `connectElement()` for you.

## 3. Run the dev emulator (3 min)

```sh
heir-element dev
```

This serves your element in a sandboxed iframe with the same CSP production uses, a file-backed storage backend (`.heir/dev-storage.json` — persists across restarts; delete the file to simulate uninstall-deletes-data), and a deterministic `llm.complete` stub. Every bridge call is logged to the terminal as `[bridge] <method> ok|err <ms>ms`. Open the printed URL in your browser.

## 4. Edit your element (10 min)

Open `src/main.js`. The bridge surface:

```js
import { connectElement } from '@morbidcorp/element-sdk';

const api = await connectElement();

// Context (no user data — by design):
const { theme, viewport } = await api.getContext();

// Persistent element-scoped storage (1 MB quota):
await api.storage.set('sessions', JSON.stringify([Date.now()]));
const raw = await api.storage.get('sessions');

// React to the desk:
api.onEvent('theme-changed', ({ theme }) => applyTheme(theme));

// Host-drawn UI:
const ok = await api.ui.confirm({ title: 'Reset?', message: 'Clear all local data?' });
```

Save and the dev server reloads the frame. Watch the terminal bridge log to see each call.

Anything not in the capability table simply does not exist: no cookies, no fetch to undeclared origins (CSP blocks it), no parent-window access (cross-origin sandbox).

## 5. Validate the manifest (2 min)

```sh
heir-element validate
```

Runs two local, synchronous stages:

1. **Manifest** — `validateManifest` from this SDK in `authoring` mode against `manifest.json`.
2. **Static scan** — builds the bundle and scans the output for code that cannot work in production: `eval`/`new Function`, opaque-origin APIs (`document.cookie`, `localStorage`, `sessionStorage`, `indexedDB`), remote scripts and imports, network URLs whose origin is not declared in `manifest.endpoints`, hidden iframes, and the 5 MB size cap — plus heuristics (tight loops, large inline blobs, `window.parent` access) that surface as warnings.

Errors and warnings print with paths/file:line and codes; fix anything red — so a code-level error like `E_EVAL` here comes from stage 2, not your manifest. See [MANIFEST.md](MANIFEST.md) for every manifest code.

## 6. Pack the bundle (2 min)

```sh
heir-element pack
```

Builds the bundle and produces a deterministic `.heir/publish/bundle.tar.gz`, computes its `bundleHash` (`sha256-<hex>`) and `sizeBytes`, and writes `.heir/publish/manifest.json` — a copy of your authored manifest with `integrity.bundleHash` and `integrity.sizeBytes` filled in (`publisherSig` stays `null` until publish). The authored `manifest.json` in your project root is left untouched.

## 7. Generate a publisher keypair (1 min)

```sh
heir-element keygen
```

Generates a raw 32-byte ed25519 keypair. Keep the private key out of git; the public key is what you register with the marketplace.

## 8. Sign and dry-run a submission (3 min)

```sh
heir-element publish --dry-run
```

This signs the domain-separated payload

```
heir-element-registry-v1\n{id}\n{version}\n{bundleHash}\n{manifestHash}\n
```

with your publisher key, fills `integrity.publisherSig`, re-validates in `submission` mode, and prints exactly what a real submission would send — without sending anything.

## Where to next

- [API.md](API.md) — every method, with examples
- [MANIFEST.md](MANIFEST.md) — the manifest, field by field
- The emulator is importable for tests: `@morbidcorp/element-sdk/emulator` gives you `EmulatorCore` with in-memory storage in Node.
