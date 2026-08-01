# Client API reference

All element-side code talks to the desk through the object returned by `connectElement()`. Every call is validated with zod on both sides, permission-checked by the host, rate-limited (120 calls / 10 s by default), and logged.

## `connectElement(opts?)`

```ts
import { connectElement } from '@morbidcorp/element-sdk';

const api = await connectElement();            // default 10 s handshake timeout
const api = await connectElement({ timeoutMs: 5000 });
```

Resolves after the handshake: the host posts `heir-element-init` with a dedicated `MessageChannel` port; the client replies `heir-element-ready` on that port. All RPC then flows on the port only — broadcast `message` events are never trusted after init. A second init is ignored. Calls made before init are queued and flushed after the handshake.

Per-call timeout: 10 s (120 s for `llm.complete`). On timeout the call rejects with a local `ElementApiError` (`code: 'E_UNAVAILABLE'`) and its pending state is cleaned up — no dangling listeners.

Errors reject as `ElementApiError { code, message }` where `code` is always one of the closed enum: `E_PERMISSION_DENIED`, `E_UNKNOWN_METHOD`, `E_INVALID_PARAMS`, `E_QUOTA_EXCEEDED`, `E_RATE_LIMITED`, `E_USER_DECLINED`, `E_UNAVAILABLE`, `E_INTERNAL`. Client-local rejections reuse the same enum: `E_UNAVAILABLE` for timeouts (call or handshake) and missing/mismatched hosts, `E_INVALID_PARAMS` when a host response fails result-schema validation. A wire error code outside the enum is folded to `E_INTERNAL`.

## `api.getContext()`

```ts
const ctx = await api.getContext();
// { elementId, installId, version, locale, theme: 'light'|'dark',
//   viewport: { w, h }, deskVersion }
```

Contains zero user data — no name, email, or desk name, ever.

## `api.onEvent(name, cb)` → unsubscribe

```ts
const off = api.onEvent('theme-changed', ({ theme }) => setTheme(theme));
api.onEvent('visibility-changed', ({ visible }) => visible ? resume() : pause());
api.onEvent('resize', ({ width, height }) => relayout(width, height));
// later:
off();
```

Event payloads are schema-validated; unknown events are ignored.

## `api.storage` — permission `storage.element`

Element-scoped persistent strings. Quota: 1 MB total (UTF-8 key + value bytes). Store JSON by stringifying.

```ts
await api.storage.set('prefs', JSON.stringify({ sound: true }));
const raw = await api.storage.get('prefs');        // string | null
const keys = await api.storage.list('todo:');      // string[] (prefix optional)
await api.storage.delete('prefs');
```

Over quota, `set` rejects with `E_QUOTA_EXCEEDED`.

## `api.ui`

```ts
await api.ui.setTitle('Focus 24:59');
```
Sets the window title. The host sanitizes it and it never reaches agent context.

```ts
const { width, height } = await api.ui.requestResize(800, 600);
```
Asks for a new size. The host clamps; the returned size is what you actually got.

```ts
await api.ui.toast('Session saved');               // permission: notifications
```
Host-rendered toast, attributed to your element.

```ts
const confirmed = await api.ui.confirm({
  title: 'Reset timer?',
  message: 'This clears all recorded sessions.',
  confirmLabel: 'Reset',       // optional
  cancelLabel: 'Keep',         // optional
});                                                 // boolean
```
The dialog is drawn by the host outside your frame — you cannot style, cover, or auto-accept it.

```ts
const opened = await api.ui.openExternal('https://example.com/docs');  // boolean
```
The host shows a confirm displaying the full URL before opening.

## `api.clipboard.writeText(text)` — permission `clipboard.write`

```ts
await api.clipboard.writeText(stats);
```

Requires a fresh user gesture (click/keypress); otherwise the host rejects.

## `api.llm.complete(params)` — permission `llm.completion`

```ts
const { text, model, tokensUsed } = await api.llm.complete({
  prompt: 'Summarize: ' + notes,
  system: 'You are terse.',   // optional
  maxTokens: 256,             // optional
  temperature: 0.3,           // optional, 0..2
});
```

Proxied by the host. The API key never crosses the bridge. Metered elements must declare per-action prices and `maxTokensPerAction` in the manifest. In the dev emulator this returns a deterministic stub: `[dev-emulator] <prompt…>`.

## Advanced entry points

- `@morbidcorp/element-sdk/protocol` — `METHOD_TABLE` (per-method zod schemas for params and results), wire envelope schemas, event schemas, constants.
- `@morbidcorp/element-sdk/emulator` — `EmulatorCore` for Node tests:

```ts
import { EmulatorCore, InMemoryStorage } from '@morbidcorp/element-sdk/emulator';

const core = new EmulatorCore(manifest, {
  storage: new InMemoryStorage(),
  onToast: (m) => console.log('toast:', m),
  log: (entry) => console.log(entry),          // {rpcId, method, ok, ms}
  rateLimit: { calls: 120, perMs: 10_000 },
});
const resp = await core.handleRequest({ v: 1, rpcId: 'r1', method: 'storage.get', params: { key: 'k' } });
```

- `@morbidcorp/element-sdk/csp` — `generateElementCsp(manifest, { frameAncestors? })` produces the exact production CSP for a manifest.
- `@morbidcorp/element-sdk/integrity` — `canonicalJson`, `manifestHash`, `bundleHash`, `buildSignPayload`, `generateKeypair`, `signSubmission`, `verifySubmission`.
