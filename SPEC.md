# @morbidcorp/element-sdk — SPEC v0.1.0 (binding)

Contract source: HEIR Desk Elements v3 Marketplace Plan (2026-08-01), §3.2 (bridge + capability
list), §3.3 (manifest), §3.5/3.6 (integrity/signing), amendments A5–A14, Appendix B #13.
This spec is the implementation contract. Deviate only with a written note in the PR/commit body.

Status framing (claims-gating, plan §7.8): this is pre-v3.0 platform work. Nothing here may be
described publicly as an existing HEIR feature. Repo stays private until the operator flips it.

## Package

- name: `@morbidcorp/element-sdk`, version `0.1.0`, `"license": "UNLICENSED"` (+ LICENSE file:
  proprietary, © Heir Labs, all rights reserved), `"private": false` (installable via git dep),
  `type: module`, engines node >= 18.
- Runtime deps: `zod` (^3.23), `@noble/hashes` (sha256, isomorphic sync), `@noble/curves`
  (ed25519, isomorphic). Nothing else. Dev deps: typescript, vitest, zod-to-json-schema.
- Build: `tsc` (strict, NodeNext ESM) → `dist/` (JS + .d.ts). `"prepare": "npm run build"` is
  REQUIRED so `github:heirlabs/elements-sdk` git-dependency installs work before npm publish.
- `dist/` gitignored; `schemas/manifest.v1.json` is generated at build (`npm run gen:schema`)
  and COMMITTED, with a vitest drift test (regenerate in-memory, deep-equal against the file).
- Exports map:
  - `.` → client, types, constants
  - `./protocol` → wire types + per-method zod schemas (params AND results)
  - `./manifest` → manifest type, zod schema, `validateManifest`, JSON-Schema re-export
  - `./integrity` → canonical JSON, hashing, sign payload, ed25519 sign/verify helpers
  - `./csp` → `generateElementCsp`
  - `./emulator` → `EmulatorCore` (environment-agnostic) + `attachIframeHost` browser helper

## Protocol — `heir-element-api@1`

Constants (single source of truth, exported):

```ts
export const API_VERSION = 'heir-element-api@1';
export const PERMISSIONS = ['storage.element', 'notifications', 'clipboard.write', 'llm.completion'] as const; // CLOSED
export const RESERVED_SCOPE_PREFIXES = ['estate.', 'identity.', 'wallet.', 'auth.', 'payments.', 'settings.', 'agent.', 'pol.'] as const;
```

Method table (closed; adding a method is a spec change):

| Method | Permission | Params → Result |
|---|---|---|
| `element.getContext` | none | `{}` → `{elementId, installId, version, locale, theme:'light'\|'dark', viewport:{w,h}, deskVersion}` — ZERO user data (no name/email/deskName) |
| `storage.get` | `storage.element` | `{key}` → `{value: string \| null}` |
| `storage.set` | `storage.element` | `{key, value: string}` → `{}` (E_QUOTA_EXCEEDED over 1 MB total) |
| `storage.delete` | `storage.element` | `{key}` → `{}` |
| `storage.list` | `storage.element` | `{prefix?}` → `{keys: string[]}` |
| `ui.setTitle` | none | `{title}` → `{}` (host sanitizes; never reaches agent context) |
| `ui.requestResize` | none | `{width, height}` → `{width, height}` (host-clamped) |
| `ui.toast` | `notifications` | `{message}` → `{}` (host-rendered, attributed) |
| `ui.confirm` | none | `{title, message, confirmLabel?, cancelLabel?}` → `{confirmed: boolean}` (host-drawn OUTSIDE frame) |
| `ui.openExternal` | none | `{url}` → `{opened: boolean}` (host-drawn confirm showing full URL) |
| `clipboard.writeText` | `clipboard.write` | `{text}` → `{}` (requires fresh user gesture) |
| `llm.complete` | `llm.completion` | `{prompt, system?, maxTokens?, temperature?}` → `{text, model, tokensUsed}` (host-proxied; key never crosses bridge) |

Host→element events (subscription client-side via `onEvent`): `theme-changed {theme}`,
`visibility-changed {visible}`, `resize {width, height}`.

Wire format (structured-clone-safe JSON only):

```ts
type RpcRequest  = { v: 1, rpcId: string, method: string, params: unknown };
type RpcResponse = { v: 1, rpcId: string, ok: true, result: unknown }
                 | { v: 1, rpcId: string, ok: false, error: { code: ErrorCode, message: string } };
type HostEvent   = { v: 1, event: string, data: unknown };
```

Error codes: `E_PERMISSION_DENIED`, `E_UNKNOWN_METHOD`, `E_INVALID_PARAMS`, `E_QUOTA_EXCEEDED`,
`E_RATE_LIMITED`, `E_USER_DECLINED`, `E_UNAVAILABLE`, `E_INTERNAL`.

Handshake: after iframe load, host posts `{type:'heir-element-init', api: API_VERSION, context}`
via `window.postMessage(msg, '*', [port])` with a dedicated `MessageChannel` port. Element
replies `{type:'heir-element-ready'}` on the port. All RPC flows on the port only; the client
never trusts broadcast `message` events after init. Unknown methods / failed zod parse →
error response, zero state change (deny-by-default dispatch).

## Client (`connectElement`)

- `connectElement(opts?: {timeoutMs?}) : Promise<ElementApi>` — resolves after handshake.
  Typed surface: `api.getContext()`, `api.onEvent(name, cb) → unsubscribe`, `api.storage.*`,
  `api.ui.*`, `api.clipboard.writeText`, `api.llm.complete`.
- Every response zod-validated against the method's result schema before resolving; invalid →
  reject with `E_INVALID_PARAMS`-style local error. Per-call timeout: 10 s default, 120 s for
  `llm.complete`. rpcIds are `crypto.randomUUID()`. Calls made before init queue; double-init
  ignored. Rejected calls never leave dangling listeners.

## Manifest v1

Zod schema mirroring plan §3.3 exactly; JSON-Schema emitted from it. Fields:

- `manifestVersion: 1` (literal).
- `id`: reverse-DNS, regex `^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$`, must contain a dot, max 80.
- `name` (1–40), `version` (semver), `description` (1–500).
- `publisher: { id: string, displayName: string, tier: number (0–3) }`.
- `category`: enum `['utilities','games','devtools','estate','identity']`. Audience rule below.
- `icons: {}` (free object, optional), `surfaces: ['window']` (literal single-element).
- `window: { defaultSize: [w,h], minSize: [w,h], resizable: boolean }` (positive ints ≤ 4096).
- `runtime: { type: 'sandboxed-iframe', api: 'heir-element-api@1' }` (literals).
- `entry`: bundle-relative path only — reject absolute paths, `//`, any URL scheme, `..`
  segments, backslashes. (Remote entry is a schema error, per plan.)
- `permissions`: array of the CLOSED enum, unique. Any string starting with a reserved prefix →
  dedicated error `E_RESERVED_SCOPE` (distinct from generic `E_UNKNOWN_PERMISSION`).
- `endpoints`: array (may be empty) of `{ origin, purpose, dataSent: string[], dataReceived: string[] }`.
  `origin` must be an https origin with no path/query/hash/port-wildcard, no `*` anywhere,
  no credentials. `dataSent` categories checked against a personal-data denylist
  (names/emails/addresses/estate/beneficiary/etc. → `E_DATASENT_PERSONAL` at v3 — no permission
  can produce personal data, plan §3.3).
- `dataUse: { collectsPersonalData: boolean, sells: boolean, retention: string, privacyPolicy?: url }`.
- `pricing: { model: 'free' } | { model: 'one_time', priceCents: int ≥ 200 } |
  { model: 'metered', actions: [{ action, postedCreditPrice: int ≥ 1, maxTokensPerAction: int }] }`.
  `subscription` rejected AT SCHEMA LEVEL (A8/A6 ceilings: metered requires maxTokensPerAction).
- `compat: { minDeskVersion: string }`, `ageRating: 'adult' | 'everyone'`.
- `support: { email, url? }`.
- `integrity: { bundleHash: 'sha256-<64 hex>', sizeBytes: int, publisherSig: 'ed25519:<base64>' | null, registrySig: string | null }`.
  Optional at authoring time (validator mode `authoring` skips integrity; mode `submission`
  requires bundleHash/sizeBytes/publisherSig).

### validateManifest

```ts
validateManifest(json: unknown, opts: { audience: 'third-party' | 'first-party', mode?: 'authoring' | 'submission' })
  → { ok: boolean, errors: Issue[], warnings: Issue[] }   // Issue = {path, code, message}
```

Rules beyond zod:

- **A7 phishing surface** (`audience: 'third-party'` only): `category` `estate`/`identity` →
  `E_CATEGORY_CLOSED`. Name/description semantic denylist, word-boundary matched after
  NFKC normalization + Unicode format-character strip (`\p{Cf}`: ZWSP/ZWNJ/soft hyphen —
  closes invisible-character evasion) + confusable folding (ship a confusables map covering
  common Cyrillic/Greek/fullwidth Latin lookalikes) + diacritic strip + lowercase:
  `heir` (substring match, brand), and the terms `estate, inheritance, inherit, probate, will,
  trust, executor, death, deceased, wallet, seed phrase, recovery phrase, recovery, beneficiary,
  proof of life, legal advice`. Word-boundary so `willow`/`trustworthy…` — no: `trust` and
  `will` are word-boundary matched, so "Willow Notes" passes and "Will Checklist" fails.
  Codes: `E_NAME_DENYLIST`, `E_NAME_HOMOGLYPH` (fires when raw ≠ folded and folded hits).
- **Required passing fixtures** (from plan Appendix B #7 — these are tests, verbatim):
  reject: `Estate Vault`, `Heir Verify`, `Recovery Phrase Backup`, `Proof of Life Helper`,
  `Неir Assist` (Cyrillic Н,е), `ＨＥＩＲ Tools` (fullwidth). Accept: `Pomodoro Timer`,
  `Chess Puzzles`, `Willow Notes`.
- **A9 processor combination**: `storage.element` permission AND `endpoints.length > 0` →
  warning `W_PROCESSOR_TIER` (DPA + named processor role required at registry). Zero
  endpoints → informational `I_NO_NETWORK` (badge-eligible).
- First-party audience: estate/identity categories allowed; denylist skipped; reserved scopes
  STILL rejected (no permission tier at any price, plan §1).

## CSP generation

`generateElementCsp(manifest, opts?: { frameAncestors?: string[] }) → string` — the same
function the desk/monolith will import later. Directives, exactly:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
font-src 'self'; media-src 'self';
connect-src <space-joined declared endpoint origins, or 'none' if empty>;
object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors <opts or 'none'>
```

Snapshot-tested for: zero-endpoint manifest, multi-endpoint manifest, frameAncestors override.

## Integrity & signing

- Canonical JSON: recursively key-sorted, no whitespace, UTF-8 (RFC 8785-lite; arrays keep
  order; reject non-finite numbers). Exported as `canonicalJson(value) → string`.
- `manifestHash` = hex sha256 of canonicalJson(manifest **with `integrity` property removed**).
- `bundleHash` = `sha256-` + hex sha256 of the bundle `.tar.gz` bytes.
- Sign payload = UTF-8 bytes of:
  `heir-element-registry-v1\n{id}\n{version}\n{bundleHash}\n{manifestHash}\n`
  (domain-separated; bundleHash in `sha256-<hex>` form; trailing newline included).
- `publisherSig` = `ed25519:` + base64(std, padded) of the raw 64-byte signature over that
  payload. Keys are raw 32-byte ed25519 (noble); helpers:
  `generateKeypair()`, `signSubmission({id,version,bundleHash,manifestHash}, privKey)`,
  `verifySubmission(payloadFields, sig, pubKey)`.
- KAT test: fixed test-only private key (hex constant in test file, clearly marked TEST ONLY),
  fixed manifest fixture → assert exact manifestHash, payload string, and signature base64.
  Determinism: signing twice yields identical bytes (ed25519 is deterministic).

## EmulatorCore (dev harness)

Environment-agnostic class so logic is testable in Node and reusable by the CLI dev server
and a browser shell:

```ts
new EmulatorCore(manifest, {
  storage: StorageBackend,            // {get,set,delete,list} — in-memory impl exported
  llm?: LlmBackend,                   // default: deterministic stub => `[dev-emulator] ${prompt.slice(0,…)}`
  onToast, onConfirm, onOpenExternal, onSetTitle, onRequestResize,  // host-UI callbacks
  log?: (entry) => void,              // EVERY bridge call logged {rpcId, method, ok, ms} (INV-29 parity)
  rateLimit?: { calls: number, perMs: number },  // default 120 calls / 10 s
})
core.handleRequest(req: unknown) → Promise<RpcResponse>
core.makeEvent(name, data) → HostEvent
```

Behavior: zod-validate request envelope + params; method ∈ granted permissions (grants =
manifest.permissions in dev) else `E_PERMISSION_DENIED`; unknown → `E_UNKNOWN_METHOD`;
storage quota 1 MB (sum of UTF-8 key+value bytes) → `E_QUOTA_EXCEEDED`; rate limit →
`E_RATE_LIMITED`; results zod-validated before return (host-side response allowlist, INV-10
parity — never echo extra fields).

`attachIframeHost(iframe, core, opts)` (browser-only helper): performs the handshake, pumps
port messages through `core.handleRequest`, exposes `sendEvent`. Kept thin; not unit-tested in
Node beyond construction (CLI e2e covers it in a real browser-less smoke via served HTML).

## Docs (part of the A13 exit criterion)

- `README.md`: what an Element is, the security model in one screen (sandboxed cross-origin
  iframe, host-relayed bridge, frame never holds any credential; elements can NEVER access
  estate/PII/wallet/proof-of-life/auth — reserved scopes are schema-rejected), the capability
  table above, links to docs/.
- `docs/GETTING_STARTED.md`: the zero-to-running-in-30-minutes walkthrough (references the
  CLI: install → `heir-element init` → `dev` → edit → `validate` → `pack` → `keygen` →
  `publish --dry-run`). Every command copy-pasteable and accurate.
- `docs/API.md`: full client API reference with examples per method.
- `docs/MANIFEST.md`: field-by-field manifest reference incl. every error code.

## Tests (vitest; minimum bar)

1. Manifest: golden valid fixture passes; each rejection class has a dedicated test
   (reserved scope, unknown permission, remote entry, `..` entry, endpoint wildcard,
   endpoint with path, subscription pricing, bad id, oversize name); ALL A7 fixtures above.
2. Protocol: params/result schemas round-trip for every method; unknown method envelope.
3. EmulatorCore: per-method happy path; permission denial for each gated method when
   permission absent; quota; rate limit; log entries emitted; result-shape stripping.
4. Integrity: canonical JSON vectors (key order, unicode, nested); manifestHash KAT;
   sign/verify round-trip; signature KAT; tamper detection (flip byte → verify false).
5. CSP snapshots. 6. JSON-Schema drift test.

## Repo hygiene / CI / git

- `.gitignore`: node_modules, dist, coverage. `package-lock.json` committed.
- `.github/workflows/ci.yml`: node 20, `npm ci && npm run build && npm test`. (Org Actions
  billing has killed jobs before — commit it regardless; local green is the gate.)
- Conventional commits. NO AI attribution of any kind (no Generated-with, no Co-Authored-By,
  no emojis). Push to `origin main` (https://github.com/heirlabs/elements-sdk).
