# Manifest v1 reference

Every element ships a `manifest.json` conforming to manifest v1. Validation is two-layered:

1. The zod schema (`manifestSchema` from `@heir/element-sdk/manifest`); a generated JSON Schema is committed at `schemas/manifest.v1.json` and re-exported as `manifestJsonSchema`.
2. Semantic rules applied by `validateManifest` (audience, denylist, processor tier, integrity mode).

```ts
import { validateManifest } from '@heir/element-sdk/manifest';

const { ok, errors, warnings } = validateManifest(json, {
  audience: 'third-party',        // or 'first-party'
  mode: 'authoring',              // or 'submission' (default 'authoring')
});
// errors/warnings: Array<{ path: string, code: string, message: string }>
```

## Fields

| Field | Type / rule |
|---|---|
| `manifestVersion` | literal `1` |
| `id` | reverse-DNS: `^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$`, must contain a dot, max 80 chars. Example: `com.example.pomodoro` |
| `name` | 1–40 chars. Subject to the A7 denylist for third-party publishers |
| `version` | semver (`1.2.3`, prerelease/build metadata allowed) |
| `description` | 1–500 chars. Also subject to the A7 denylist |
| `publisher` | `{ id, displayName, tier: 0–3 }` |
| `category` | `utilities` \| `games` \| `devtools` \| `estate` \| `identity` — the last two are closed to third parties |
| `icons` | free object, optional |
| `surfaces` | exactly `["window"]` |
| `window` | `{ defaultSize: [w,h], minSize: [w,h], resizable }` — positive integers <= 4096 |
| `runtime` | exactly `{ type: 'sandboxed-iframe', api: 'heir-element-api@1' }` |
| `entry` | bundle-relative path only. Rejected: URLs/schemes, absolute paths, `//`, `..` segments, backslashes |
| `permissions` | unique subset of `storage.element`, `notifications`, `clipboard.write`, `llm.completion` |
| `endpoints` | array (may be empty) of `{ origin, purpose, dataSent, dataReceived }` |
| `dataUse` | `{ collectsPersonalData, sells, retention, privacyPolicy? }` |
| `pricing` | `{ model: 'free' }` \| `{ model: 'one_time', priceCents >= 200 }` \| `{ model: 'metered', actions: [{ action, postedCreditPrice >= 1, maxTokensPerAction }] }`. `subscription` is rejected at schema level |
| `compat` | `{ minDeskVersion }` |
| `ageRating` | `adult` \| `everyone` |
| `support` | `{ email, url? }` |
| `integrity` | `{ bundleHash: 'sha256-<64 hex>', sizeBytes, publisherSig: 'ed25519:<base64>' \| null, registrySig: string \| null }`. Optional in `authoring` mode; required (with non-null `publisherSig`) in `submission` mode |

### Endpoint origins

`origin` must be exactly an https origin: `https://host` or `https://host:port`. No path, query, fragment, credentials, trailing slash, or `*` anywhere. The CSP `connect-src` is generated from these origins — an element can only ever reach what it declared.

### `dataSent` categories

Checked against a personal-data denylist (names, emails, addresses, phone, location, estate, beneficiary, wallet/seed/recovery, health, biometrics, identifiers, ...). At v3 no permission can produce personal data, so declaring that it is sent is an error (`E_DATASENT_PERSONAL`), not a review flag.

## A7 phishing surface (third-party audience only)

- `category: estate` or `identity` → `E_CATEGORY_CLOSED`.
- `name` and `description` are folded (NFKC normalization → invisible format-character strip (Unicode Cf: zero-width space/joiner/non-joiner, soft hyphen, …) → confusable folding for common Cyrillic/Greek/fullwidth lookalikes → diacritic strip → lowercase) and checked against:
  - `heir` — substring match (brand);
  - word-boundary terms: `estate, inheritance, inherit, probate, will, trust, executor, death, deceased, wallet, seed phrase, recovery phrase, recovery, beneficiary, proof of life, legal advice`.
- Word-boundary matching means "Willow Notes" and "Trustworthy Notes" pass while "Will Checklist" fails.
- If the folded text differs from the raw lowercase text and the folded text hits, the code is `E_NAME_HOMOGLYPH` (e.g. Cyrillic `Неir Assist`, fullwidth `ＨＥＩＲ Tools`); otherwise `E_NAME_DENYLIST`.
- First-party audience skips the category closure and denylist. Reserved permission scopes are still rejected for everyone.

## A9 processor combination

- `storage.element` + at least one endpoint → warning `W_PROCESSOR_TIER`: distributing stored data to your own backend makes you a data processor; the registry requires a DPA and a named processor role.
- Zero endpoints → informational `I_NO_NETWORK` (badge-eligible: the element provably cannot phone home).

## Integrity and signing

- `manifestHash` = hex sha256 of the canonical JSON (recursively key-sorted, no whitespace, UTF-8) of the manifest **with `integrity` removed**.
- `bundleHash` = `sha256-` + hex sha256 of the packed `.tar.gz` bytes.
- Sign payload (UTF-8, trailing newline included):
  `heir-element-registry-v1\n{id}\n{version}\n{bundleHash}\n{manifestHash}\n`
- `publisherSig` = `ed25519:` + standard padded base64 of the raw 64-byte signature. Keys are raw 32-byte ed25519.

## Error and warning codes

Wire-level bridge codes are documented in [API.md](API.md). Validator codes:

| Code | Meaning |
|---|---|
| `E_SCHEMA` | Generic schema violation (wrong type, missing field, range, regex, unknown field) |
| `E_RESERVED_SCOPE` | Permission starts with a reserved prefix (`estate.`, `identity.`, `wallet.`, `auth.`, `payments.`, `settings.`, `agent.`, `pol.`) |
| `E_UNKNOWN_PERMISSION` | Permission not in the closed set |
| `E_DUPLICATE_PERMISSION` | Permission listed twice |
| `E_ENTRY_PATH` | Entry is a URL, absolute, contains `//`, `..`, or backslashes |
| `E_ENDPOINT_ORIGIN` | Endpoint origin is not a clean https origin (wildcard, path, query, credentials, http, trailing slash) |
| `E_DATASENT_PERSONAL` | `dataSent` declares a personal-data category |
| `E_PRICING_SUBSCRIPTION` | `pricing.model: 'subscription'` — not a supported model |
| `E_CATEGORY_CLOSED` | `estate`/`identity` category from a third-party publisher |
| `E_NAME_DENYLIST` | Name/description hits the semantic denylist |
| `E_NAME_HOMOGLYPH` | Denylist hit only after confusable folding (lookalike characters) |
| `E_INTEGRITY_REQUIRED` | `submission` mode without `integrity` or without a publisher signature |
| `W_PROCESSOR_TIER` | Warning: `storage.element` + endpoints (DPA + processor role required) |
| `I_NO_NETWORK` | Informational: zero endpoints, badge-eligible |

## Golden example

```json
{
  "manifestVersion": 1,
  "id": "com.example.pomodoro",
  "name": "Pomodoro Timer",
  "version": "1.0.0",
  "description": "A minimalist focus timer for your desk.",
  "publisher": { "id": "pub_1a2b3c", "displayName": "Example Labs", "tier": 1 },
  "category": "utilities",
  "surfaces": ["window"],
  "window": { "defaultSize": [400, 600], "minSize": [320, 400], "resizable": true },
  "runtime": { "type": "sandboxed-iframe", "api": "heir-element-api@1" },
  "entry": "index.html",
  "permissions": ["storage.element"],
  "endpoints": [],
  "dataUse": { "collectsPersonalData": false, "sells": false, "retention": "none" },
  "pricing": { "model": "free" },
  "compat": { "minDeskVersion": "3.0.0" },
  "ageRating": "everyone",
  "support": { "email": "support@example.com" }
}
```
