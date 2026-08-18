# Security policy

This package is the sandbox contract for HEIR Desk Elements: CSP generation,
bridge schema validation, reserved-scope rejection, bundle scanning, and
ed25519 submission signatures. Treat sandbox escapes, signature bypasses, and
reserved-scope leaks as security issues, not ordinary bugs.

## Reporting

**Do not file a public GitHub issue** for a vulnerability.

1. Use [GitHub private vulnerability reporting](https://github.com/heirlabs/elements-sdk/security/advisories/new)
   if it is enabled on this repository.
2. Or email **logan@h3ir.com** with:
   - a description of the issue
   - a minimal reproduction or proof of concept
   - affected versions (`@morbidcorp/element-sdk` version, commit SHA)
   - impact (what an Element or a publisher could do that the model forbids)

Please give us a reasonable window to patch before any public disclosure.

## What is in scope

- Breaks of the documented security model in [README.md](README.md)
- Manifest / scanner checks that can be bypassed while still producing a
  bundle the host would accept
- Signature or canonical-JSON bugs that let a publisher bind a different
  bundle than the one that was signed
- Anything that lets an Element reach undeclared origins, reserved scopes
  (`estate.`, `identity.`, `wallet.`, `auth.`, `payments.`, `settings.`,
  `agent.`, `pol.`), credentials, or host-drawn UI it does not own

## What is out of scope

- The desk host, marketplace flags, and install surface (those are in the
  HEIR web backend, not this package)
- Social-engineering the publisher key
- Issues that require a compromised host process
- Feature requests for new permissions or capabilities

## Supported versions

Only the latest published `0.x` on npm is supported. There is no LTS line
yet. Report against `@morbidcorp/element-sdk@0.2.0` or `main`.
