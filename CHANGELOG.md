# Changelog

Versions follow the package on npm (`@morbidcorp/element-sdk`). Dates are UTC
publish days.

## 0.2.0 — 2026-08-01

- Add `@morbidcorp/element-sdk/scanner`: environment-agnostic `scanBundle`
  over an in-memory file map (no Node APIs). This is the same review-assist
  scan the CLI and the registry run.
- Rescope the package from the aspirational `@heir/element-sdk` name to
  `@morbidcorp/element-sdk` (the `@heir` npm scope is not owned by the org).

## 0.1.0 — 2026-08-01

- Initial protocol SDK for `heir-element-api@1`:
  - `connectElement` bridge client
  - manifest v1 schema + `validateManifest`
  - integrity (canonical JSON, hashing, ed25519 sign/verify)
  - `generateElementCsp`
  - `EmulatorCore` + `attachIframeHost`
