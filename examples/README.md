# Examples

## `hello-manifest.json`

Golden valid manifest v1 (authoring mode — no `integrity` block). Same object
as the in-repo test fixture and the example in [docs/MANIFEST.md](../docs/MANIFEST.md).

Validate it against this package after `npm ci && npm run build`:

```js
import { readFile } from 'node:fs/promises';
import { validateManifest } from '@morbidcorp/element-sdk/manifest';

const json = JSON.parse(await readFile(new URL('./hello-manifest.json', import.meta.url), 'utf8'));
const { ok, errors, warnings } = validateManifest(json, {
  audience: 'third-party',
  mode: 'authoring',
});
console.log({ ok, errors, warnings });
```

From a clone of this repo you can import the built file directly:

```js
import { validateManifest } from '../dist/manifest.js';
```

To scaffold a full running Element (HTML + bridge client + emulator), use
the CLI instead of copying files from here:

```sh
npm install -g @morbidcorp/elements-cli
heir-element init my-timer
cd my-timer
heir-element dev
```
