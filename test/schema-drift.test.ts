import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { manifestJsonSchema, manifestSchema, validateManifest } from '../src/manifest.js';
import { makeManifest } from './fixtures.js';

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'manifest.v1.json');
const committed = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

describe('schemas/manifest.v1.json drift', () => {
  it('matches an in-memory regeneration from the zod schema', () => {
    const regenerated = zodToJsonSchema(manifestSchema, { name: 'HeirElementManifestV1' });
    expect(JSON.parse(JSON.stringify(regenerated))).toEqual(committed);
  });

  it('matches the manifestJsonSchema re-export', () => {
    expect(manifestJsonSchema).toEqual(committed);
  });

  it('is a named-definition JSON Schema', () => {
    expect(committed.$ref).toBe('#/definitions/HeirElementManifestV1');
    const definitions = committed.definitions as Record<string, unknown>;
    expect(definitions.HeirElementManifestV1).toBeTruthy();
  });
});

describe('examples/hello-manifest.json', () => {
  const examplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'hello-manifest.json');
  const example = JSON.parse(readFileSync(examplePath, 'utf8')) as Record<string, unknown>;

  it('matches the golden test fixture', () => {
    expect(example).toEqual(makeManifest());
  });

  it('validates in third-party authoring mode', () => {
    const { ok, errors } = validateManifest(example, {
      audience: 'third-party',
      mode: 'authoring',
    });
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
  });
});
