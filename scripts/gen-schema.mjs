// Generates schemas/manifest.v1.json (committed) plus the TS re-export module
// from the zod manifest schema. Run after `tsc` (imports the built schema).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { manifestSchema } from '../dist/manifest.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const schema = zodToJsonSchema(manifestSchema, { name: 'HeirElementManifestV1' });
const jsonPretty = JSON.stringify(schema, null, 2);

mkdirSync(join(root, 'schemas'), { recursive: true });
writeFileSync(join(root, 'schemas', 'manifest.v1.json'), jsonPretty + '\n');

const header = '// GENERATED FILE - do not edit by hand. Run `npm run gen:schema` to regenerate.\n';
writeFileSync(
  join(root, 'src', 'manifest-schema.generated.ts'),
  `${header}export const manifestJsonSchema: Record<string, unknown> = ${jsonPretty};\n`,
);

// Keep dist in sync without a second tsc pass: the module is trivial.
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(
  join(root, 'dist', 'manifest-schema.generated.js'),
  `${header}export const manifestJsonSchema = ${jsonPretty};\n`,
);
writeFileSync(
  join(root, 'dist', 'manifest-schema.generated.d.ts'),
  `${header}export declare const manifestJsonSchema: Record<string, unknown>;\n`,
);

console.log('gen:schema wrote schemas/manifest.v1.json');
