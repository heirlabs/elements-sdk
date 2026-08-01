import { describe, expect, it } from 'vitest';
import { generateElementCsp } from '../src/csp.js';
import { makeManifest } from './fixtures.js';

const endpoint = (origin: string) => ({
  origin,
  purpose: 'sync',
  dataSent: ['settings_blob'],
  dataReceived: ['settings_blob'],
});

describe('generateElementCsp', () => {
  it('zero-endpoint manifest', () => {
    const csp = generateElementCsp(makeManifest() as { endpoints: [] });
    expect(csp).toMatchSnapshot();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('multi-endpoint manifest', () => {
    const manifest = makeManifest({
      endpoints: [endpoint('https://api.example.com'), endpoint('https://telemetry.example.net')],
    }) as { endpoints: Array<{ origin: string }> };
    const csp = generateElementCsp(manifest);
    expect(csp).toMatchSnapshot();
    expect(csp).toContain('connect-src https://api.example.com https://telemetry.example.net');
  });

  it('frameAncestors override', () => {
    const csp = generateElementCsp(makeManifest() as { endpoints: [] }, {
      frameAncestors: ['https://desk.heir.es'],
    });
    expect(csp).toMatchSnapshot();
    expect(csp).toContain('frame-ancestors https://desk.heir.es');
  });

  it('deduplicates repeated endpoint origins', () => {
    const manifest = makeManifest({
      endpoints: [endpoint('https://api.example.com'), endpoint('https://api.example.com')],
    }) as { endpoints: Array<{ origin: string }> };
    expect(generateElementCsp(manifest)).toContain('connect-src https://api.example.com;');
  });

  it('locks down every non-connect directive', () => {
    const csp = generateElementCsp(makeManifest() as { endpoints: [] });
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "media-src 'self'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
});
