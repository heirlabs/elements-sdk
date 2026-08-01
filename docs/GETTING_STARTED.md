# Getting started: zero to a running Element in 30 minutes

This walkthrough takes you from nothing to a validated, packed, signed (dry-run) Element using the `heir-element` CLI and this SDK.

## Prerequisites

- Node.js >= 18 (`node --version`)
- npm

## 1. Install the CLI (2 min)

```sh
npm install -g github:heirlabs/elements-cli
```

Verify:

```sh
heir-element --version
```

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
  package.json
```

The scaffold already depends on `@heir/element-sdk` and calls `connectElement()` for you.

## 3. Run the dev emulator (3 min)

```sh
heir-element dev
```

This serves your element in a sandboxed iframe with the same CSP production uses, an in-memory storage backend, a deterministic `llm.complete` stub, and a bridge log pane showing every call (`rpcId`, method, ok, ms). Open the printed URL in your browser.

## 4. Edit your element (10 min)

Open `src/main.js`. The bridge surface:

```js
import { connectElement } from '@heir/element-sdk';

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

Save and the dev server reloads the frame. Watch the bridge log to see each call.

Anything not in the capability table simply does not exist: no cookies, no fetch to undeclared origins (CSP blocks it), no parent-window access (cross-origin sandbox).

## 5. Validate the manifest (2 min)

```sh
heir-element validate
```

Runs `validateManifest` from this SDK in `authoring` mode against `manifest.json` and prints errors and warnings with paths and codes. Fix anything red; see [MANIFEST.md](MANIFEST.md) for every code.

## 6. Pack the bundle (2 min)

```sh
heir-element pack
```

Produces `dist/my-timer-1.0.0.tar.gz`, computes its `bundleHash` (`sha256-<hex>`) and `sizeBytes`, and writes them into the manifest's `integrity` block.

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
- The emulator is importable for tests: `@heir/element-sdk/emulator` gives you `EmulatorCore` with in-memory storage in Node.
