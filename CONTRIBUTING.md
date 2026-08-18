# Contributing

PRs against `main` are welcome for docs, tests, and bug fixes. Protocol
changes (new methods, permissions, manifest fields, error codes) are a spec
change — update [SPEC.md](SPEC.md) in the same PR and note the deviation in
the commit body.

## Setup

Node.js `>= 18`. From a clone of this repo:

```sh
npm ci
npm run build
npm test
```

`npm run build` compiles TypeScript to `dist/` (gitignored) and regenerates
`schemas/manifest.v1.json`. That schema file is committed. If the drift test
fails, run `npm run gen:schema` and include the schema in the PR.

## What lives where

| Path | Role |
|---|---|
| `src/` | Implementation. `src/constants.ts` is the single source of truth for the closed protocol enums. |
| `test/` | Vitest. Mirror a new check here before claiming it. |
| `docs/` | Public how-to and reference. Must match `src/`. |
| `SPEC.md` | Binding implementation contract. Deviate only with a written note. |
| `schemas/manifest.v1.json` | Generated JSON Schema. Do not hand-edit. |

The desk host and the `heir-element` CLI import this package. Do not fork
validation, scanning, or signing into those repos.

## Commit style

Conventional Commits, imperative mood:

```
feat(scanner): reject remote workers
fix(manifest): reject trailing-slash origins
docs: correct install path
```

No AI attribution, no `Co-authored-by` trailers, no emojis.

## Pull requests

1. Branch off `main`.
2. Keep the PR to one concern.
3. `npm test` and `npm run build` must pass locally.
4. If you change a public export, update `docs/API.md` or `docs/MANIFEST.md`
   in the same PR.
5. Do not commit secrets, `.env` files, or publisher private keys.

## What this repo is not

This is the protocol SDK. It is not the desk UI, the marketplace storefront,
or the CLI. Those live elsewhere and consume this package. Do not add host
runtime, HTTP servers, or publish-pipeline code here.
