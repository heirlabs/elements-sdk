import { describe, expect, it } from 'vitest';
import { manifestSchema, validateManifest, type ValidateManifestResult } from '../src/manifest.js';
import { makeManifest } from './fixtures.js';

function thirdParty(json: unknown, mode?: 'authoring' | 'submission'): ValidateManifestResult {
  return validateManifest(json, { audience: 'third-party', mode });
}

function firstParty(json: unknown, mode?: 'authoring' | 'submission'): ValidateManifestResult {
  return validateManifest(json, { audience: 'first-party', mode });
}

function errorCodes(r: ValidateManifestResult): string[] {
  return r.errors.map((e) => e.code);
}

function warningCodes(r: ValidateManifestResult): string[] {
  return r.warnings.map((w) => w.code);
}

const VALID_ENDPOINT = {
  origin: 'https://api.example.com',
  purpose: 'sync anonymous settings blobs',
  dataSent: ['settings_blob'],
  dataReceived: ['settings_blob'],
};

describe('manifest schema', () => {
  it('accepts the golden valid fixture', () => {
    const r = thirdParty(makeManifest());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(manifestSchema.safeParse(makeManifest()).success).toBe(true);
  });

  it('rejects unknown top-level fields (strict)', () => {
    const r = thirdParty(makeManifest({ surprise: true }));
    expect(r.ok).toBe(false);
  });

  it('rejects reserved-scope permissions with E_RESERVED_SCOPE (not E_UNKNOWN_PERMISSION)', () => {
    const r = thirdParty(makeManifest({ permissions: ['estate.read'] }));
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_RESERVED_SCOPE');
    expect(errorCodes(r)).not.toContain('E_UNKNOWN_PERMISSION');
  });

  it('rejects every reserved scope prefix', () => {
    for (const prefix of ['estate.', 'identity.', 'wallet.', 'auth.', 'payments.', 'settings.', 'agent.', 'pol.']) {
      const r = thirdParty(makeManifest({ permissions: [`${prefix}anything`] }));
      expect(errorCodes(r), prefix).toContain('E_RESERVED_SCOPE');
    }
  });

  it('rejects unknown permissions with E_UNKNOWN_PERMISSION', () => {
    const r = thirdParty(makeManifest({ permissions: ['telemetry'] }));
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_UNKNOWN_PERMISSION');
  });

  it('rejects duplicate permissions', () => {
    const r = thirdParty(makeManifest({ permissions: ['storage.element', 'storage.element'] }));
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_DUPLICATE_PERMISSION');
  });

  it('rejects a remote entry (URL)', () => {
    const r = thirdParty(makeManifest({ entry: 'https://cdn.example.com/app/index.html' }));
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_ENTRY_PATH');
  });

  it("rejects entry with '..' segments", () => {
    const r = thirdParty(makeManifest({ entry: '../outside.html' }));
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_ENTRY_PATH');
  });

  it('rejects absolute, backslash, and double-slash entries', () => {
    for (const entry of ['/index.html', 'app\\index.html', 'app//index.html']) {
      const r = thirdParty(makeManifest({ entry }));
      expect(errorCodes(r), entry).toContain('E_ENTRY_PATH');
    }
  });

  it('accepts a nested relative entry', () => {
    const r = thirdParty(makeManifest({ entry: 'app/pages/index.html' }));
    expect(r.ok).toBe(true);
  });

  it('rejects endpoint origin wildcards', () => {
    const r = thirdParty(
      makeManifest({ endpoints: [{ ...VALID_ENDPOINT, origin: 'https://*.example.com' }] }),
    );
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_ENDPOINT_ORIGIN');
  });

  it('rejects endpoint origin with a path', () => {
    const r = thirdParty(
      makeManifest({ endpoints: [{ ...VALID_ENDPOINT, origin: 'https://api.example.com/v1' }] }),
    );
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_ENDPOINT_ORIGIN');
  });

  it('rejects http, credentialed, query, and trailing-slash endpoint origins', () => {
    for (const origin of [
      'http://api.example.com',
      'https://user:pass@api.example.com',
      'https://api.example.com?x=1',
      'https://api.example.com#frag',
      'https://api.example.com/',
    ]) {
      const r = thirdParty(makeManifest({ endpoints: [{ ...VALID_ENDPOINT, origin }] }));
      expect(errorCodes(r), origin).toContain('E_ENDPOINT_ORIGIN');
    }
  });

  it('accepts a clean https endpoint origin (with explicit port)', () => {
    const r = thirdParty(
      makeManifest({ endpoints: [{ ...VALID_ENDPOINT, origin: 'https://api.example.com:8443' }] }),
    );
    expect(r.errors).toEqual([]);
  });

  it('rejects personal-data dataSent categories with E_DATASENT_PERSONAL', () => {
    for (const category of ['email_address', 'full name', 'beneficiary-list', 'seed_phrase', 'estate documents']) {
      const r = thirdParty(makeManifest({ endpoints: [{ ...VALID_ENDPOINT, dataSent: [category] }] }));
      expect(errorCodes(r), category).toContain('E_DATASENT_PERSONAL');
    }
  });

  it('allows anonymous dataSent categories', () => {
    const r = thirdParty(
      makeManifest({ endpoints: [{ ...VALID_ENDPOINT, dataSent: ['anonymous_usage_stats'] }] }),
    );
    expect(r.errors).toEqual([]);
  });

  it('rejects subscription pricing at schema level', () => {
    const r = thirdParty(makeManifest({ pricing: { model: 'subscription', priceCents: 999 } }));
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_PRICING_SUBSCRIPTION');
  });

  it('accepts one_time pricing at or above the 200-cent floor and rejects below', () => {
    expect(thirdParty(makeManifest({ pricing: { model: 'one_time', priceCents: 200 } })).ok).toBe(true);
    expect(thirdParty(makeManifest({ pricing: { model: 'one_time', priceCents: 199 } })).ok).toBe(false);
  });

  it('metered pricing requires maxTokensPerAction', () => {
    const good = thirdParty(
      makeManifest({
        pricing: { model: 'metered', actions: [{ action: 'summarize', postedCreditPrice: 5, maxTokensPerAction: 2000 }] },
      }),
    );
    expect(good.ok).toBe(true);
    const bad = thirdParty(
      makeManifest({ pricing: { model: 'metered', actions: [{ action: 'summarize', postedCreditPrice: 5 }] } }),
    );
    expect(bad.ok).toBe(false);
  });

  it('rejects bad ids', () => {
    for (const id of ['nodots', 'Com.Example', 'com..double', '.leading', 'com.example.', 'com.exa_mple', 'a'.repeat(81)]) {
      const r = thirdParty(makeManifest({ id }));
      expect(r.ok, id).toBe(false);
    }
  });

  it('rejects an oversize name', () => {
    const r = thirdParty(makeManifest({ name: 'x'.repeat(41) }));
    expect(r.ok).toBe(false);
  });

  it('rejects invalid semver versions', () => {
    for (const version of ['1.0', 'v1.0.0', '1.0.0.0', 'latest']) {
      expect(thirdParty(makeManifest({ version })).ok, version).toBe(false);
    }
  });

  it('rejects window sizes outside 1..4096', () => {
    expect(thirdParty(makeManifest({ window: { defaultSize: [0, 600], minSize: [320, 400], resizable: true } })).ok).toBe(false);
    expect(thirdParty(makeManifest({ window: { defaultSize: [400, 5000], minSize: [320, 400], resizable: true } })).ok).toBe(false);
  });
});

describe('A7 phishing surface (third-party audience)', () => {
  const REJECT_DENYLIST = ['Estate Vault', 'Heir Verify', 'Recovery Phrase Backup', 'Proof of Life Helper', 'Will Checklist'];
  const REJECT_HOMOGLYPH = ['Неir Assist', 'ＨＥＩＲ Tools'];
  const ACCEPT = ['Pomodoro Timer', 'Chess Puzzles', 'Willow Notes', 'Trustworthy Notes'];

  for (const name of REJECT_DENYLIST) {
    it(`rejects name '${name}' with E_NAME_DENYLIST`, () => {
      const r = thirdParty(makeManifest({ name }));
      expect(r.ok).toBe(false);
      expect(errorCodes(r)).toContain('E_NAME_DENYLIST');
    });
  }

  for (const name of REJECT_HOMOGLYPH) {
    it(`rejects confusable name '${name}' with E_NAME_HOMOGLYPH`, () => {
      const r = thirdParty(makeManifest({ name }));
      expect(r.ok).toBe(false);
      expect(errorCodes(r)).toContain('E_NAME_HOMOGLYPH');
    });
  }

  // Invisible Cf format characters inside a denylisted term must not evade
  // the match (ZWSP, soft hyphen, ZWNJ).
  const REJECT_INVISIBLE: Array<[string, string]> = [
    ['ZWSP', 'He\u200Bir Tools'],
    ['soft hyphen', 'He\u00ADir Tools'],
    ['ZWNJ', 'Es\u200Ctate Vault'],
  ];
  for (const [label, name] of REJECT_INVISIBLE) {
    it(`rejects invisible-character evasion (${label}) with E_NAME_HOMOGLYPH`, () => {
      const r = thirdParty(makeManifest({ name }));
      expect(r.ok).toBe(false);
      expect(errorCodes(r)).toContain('E_NAME_HOMOGLYPH');
    });
  }

  for (const name of ACCEPT) {
    it(`accepts name '${name}'`, () => {
      const r = thirdParty(makeManifest({ name }));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }

  it('applies the denylist to descriptions too', () => {
    const r = thirdParty(makeManifest({ description: 'Helps you manage your estate paperwork.' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'description' && e.code === 'E_NAME_DENYLIST')).toBe(true);
  });

  it('closes estate and identity categories to third parties', () => {
    for (const category of ['estate', 'identity']) {
      const r = thirdParty(makeManifest({ category }));
      expect(errorCodes(r), category).toContain('E_CATEGORY_CLOSED');
    }
  });
});

describe('first-party audience', () => {
  it('allows estate category and estate-flavored names', () => {
    const r = firstParty(makeManifest({ category: 'estate', name: 'Estate Overview' }));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still rejects reserved scopes — no permission tier at any price', () => {
    const r = firstParty(makeManifest({ category: 'estate', permissions: ['wallet.read'] }));
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_RESERVED_SCOPE');
  });
});

describe('A9 processor combination', () => {
  it('warns W_PROCESSOR_TIER for storage.element + endpoints', () => {
    const r = thirdParty(makeManifest({ permissions: ['storage.element'], endpoints: [VALID_ENDPOINT] }));
    expect(r.ok).toBe(true);
    expect(warningCodes(r)).toContain('W_PROCESSOR_TIER');
    expect(warningCodes(r)).not.toContain('I_NO_NETWORK');
  });

  it('emits informational I_NO_NETWORK for zero endpoints', () => {
    const r = thirdParty(makeManifest());
    expect(r.ok).toBe(true);
    expect(warningCodes(r)).toContain('I_NO_NETWORK');
    expect(warningCodes(r)).not.toContain('W_PROCESSOR_TIER');
  });
});

describe('integrity modes', () => {
  const FULL_INTEGRITY = {
    bundleHash: `sha256-${'a'.repeat(64)}`,
    sizeBytes: 12_345,
    publisherSig: 'ed25519:bGVnaXRzaWc=',
    registrySig: null,
  };

  it('authoring mode passes without integrity', () => {
    expect(thirdParty(makeManifest(), 'authoring').ok).toBe(true);
  });

  it('submission mode requires integrity', () => {
    const r = thirdParty(makeManifest(), 'submission');
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_INTEGRITY_REQUIRED');
  });

  it('submission mode requires a non-null publisherSig', () => {
    const r = thirdParty(makeManifest({ integrity: { ...FULL_INTEGRITY, publisherSig: null } }), 'submission');
    expect(r.ok).toBe(false);
    expect(errorCodes(r)).toContain('E_INTEGRITY_REQUIRED');
  });

  it('submission mode passes with full integrity', () => {
    const r = thirdParty(makeManifest({ integrity: FULL_INTEGRITY }), 'submission');
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects malformed bundleHash and publisherSig at schema level', () => {
    expect(thirdParty(makeManifest({ integrity: { ...FULL_INTEGRITY, bundleHash: 'sha256-short' } })).ok).toBe(false);
    expect(thirdParty(makeManifest({ integrity: { ...FULL_INTEGRITY, publisherSig: 'rsa:abc' } })).ok).toBe(false);
  });
});
