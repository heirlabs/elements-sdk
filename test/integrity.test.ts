import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  base64ToBytes,
  buildSignPayload,
  bundleHash,
  bytesToBase64,
  canonicalJson,
  generateKeypair,
  manifestHash,
  sha256Hex,
  signSubmission,
  verifySubmission,
} from '../src/integrity.js';
import { makeManifest } from './fixtures.js';

// TEST ONLY — RFC 8032 TEST 1 secret key. Never use outside tests.
const TEST_PRIV_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const TEST_PUB_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/../g) ?? [];
  return new Uint8Array(pairs.map((b) => parseInt(b, 16)));
}

const TEST_PRIV = hexToBytes(TEST_PRIV_HEX);
const TEST_PUB = hexToBytes(TEST_PUB_HEX);

// Known-answer values computed once from this exact fixture; they anchor the
// wire format against accidental canonicalization or domain changes.
const KAT_MANIFEST_HASH = 'b08b9356762bd07a1c435969bc4727a994610af70a06ceb501ed30d97b0475fa';
const KAT_BUNDLE_BYTES = new TextEncoder().encode('heir-element-test-bundle-v1');
const KAT_BUNDLE_HASH = 'sha256-b0d47be179b466b591cc8eec4f7d6e94b72f9c5953bbf7d654a6d75dc0cf120f';
const KAT_PAYLOAD =
  'heir-element-registry-v1\n' +
  'com.example.pomodoro\n' +
  '1.0.0\n' +
  `${KAT_BUNDLE_HASH}\n` +
  `${KAT_MANIFEST_HASH}\n`;
const KAT_SIGNATURE =
  'ed25519:lL1Z+QdqJtes0p1gZr3qjH+hHqYjvDSiRiqqZnpkPAk5KNLWlUjNwaEoh5K9ySgHETMDRE3scQ/a4In6aoWLCA==';

const KAT_FIELDS = {
  id: 'com.example.pomodoro',
  version: '1.0.0',
  bundleHash: KAT_BUNDLE_HASH,
  manifestHash: KAT_MANIFEST_HASH,
};

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ b: 1, a: [2, 'x'], c: { z: true, y: null } })).toBe(
      '{"a":[2,"x"],"b":1,"c":{"y":null,"z":true}}',
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: [{ b: 2, a: 1 }] })).toBe('{"a":[{"a":1,"b":2}]}');
  });

  it('handles unicode keys and values without extra escaping', () => {
    expect(canonicalJson({ 'é': '☃' })).toBe('{"é":"☃"}');
    expect(canonicalJson({ 'b': 1, 'é': 2, 'a': 3 })).toBe('{"a":3,"b":1,"é":2}');
  });

  it('escapes control characters and quotes like JSON', () => {
    expect(canonicalJson({ a: 'line\n"quoted"' })).toBe('{"a":"line\\n\\"quoted\\""}');
  });

  it('emits no whitespace', () => {
    expect(canonicalJson({ a: { b: [1, 2] } })).not.toMatch(/\s/);
  });

  it('skips undefined object values, nulls undefined array items', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson(-Infinity)).toThrow(TypeError);
  });

  it('rejects unserializable types', () => {
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson(BigInt(1))).toThrow(TypeError);
  });
});

describe('hashing', () => {
  it('sha256Hex matches a known vector', () => {
    // sha256("abc")
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('manifestHash KAT: exact hash with integrity removed', () => {
    expect(manifestHash(makeManifest())).toBe(KAT_MANIFEST_HASH);
  });

  it('manifestHash ignores the integrity property', () => {
    const withIntegrity = makeManifest({
      integrity: { bundleHash: KAT_BUNDLE_HASH, sizeBytes: 1, publisherSig: null, registrySig: null },
    });
    expect(manifestHash(withIntegrity)).toBe(KAT_MANIFEST_HASH);
  });

  it('manifestHash is key-order independent', () => {
    const shuffled = Object.fromEntries(Object.entries(makeManifest()).reverse());
    expect(manifestHash(shuffled)).toBe(KAT_MANIFEST_HASH);
  });

  it('bundleHash prefixes sha256- and hex-encodes', () => {
    expect(bundleHash(KAT_BUNDLE_BYTES)).toBe(KAT_BUNDLE_HASH);
    expect(bundleHash(new Uint8Array(0))).toBe(
      'sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('sign payload', () => {
  it('builds the exact domain-separated payload with trailing newline', () => {
    expect(buildSignPayload(KAT_FIELDS)).toBe(KAT_PAYLOAD);
    expect(KAT_PAYLOAD.endsWith('\n')).toBe(true);
    expect(KAT_PAYLOAD.startsWith('heir-element-registry-v1\n')).toBe(true);
  });

  it('rejects malformed fields', () => {
    expect(() => buildSignPayload({ ...KAT_FIELDS, bundleHash: 'deadbeef' })).toThrow(TypeError);
    expect(() => buildSignPayload({ ...KAT_FIELDS, id: 'a\nb' })).toThrow(TypeError);
    expect(() => buildSignPayload({ ...KAT_FIELDS, version: '' })).toThrow(TypeError);
  });
});

describe('ed25519 signing', () => {
  it('signature KAT: exact base64 with the fixed test key', () => {
    expect(signSubmission(KAT_FIELDS, TEST_PRIV)).toBe(KAT_SIGNATURE);
  });

  it('is deterministic: signing twice yields identical bytes', () => {
    expect(signSubmission(KAT_FIELDS, TEST_PRIV)).toBe(signSubmission(KAT_FIELDS, TEST_PRIV));
  });

  it('the fixed test key derives the RFC 8032 public key', () => {
    expect(bytesToBase64(ed25519.getPublicKey(TEST_PRIV))).toBe(bytesToBase64(TEST_PUB));
  });

  it('verifies the KAT signature', () => {
    expect(verifySubmission(KAT_FIELDS, KAT_SIGNATURE, TEST_PUB)).toBe(true);
  });

  it('sign/verify round-trips with a fresh keypair', () => {
    const { privateKey, publicKey } = generateKeypair();
    expect(privateKey).toHaveLength(32);
    expect(publicKey).toHaveLength(32);
    const sig = signSubmission(KAT_FIELDS, privateKey);
    expect(sig.startsWith('ed25519:')).toBe(true);
    expect(verifySubmission(KAT_FIELDS, sig, publicKey)).toBe(true);
  });

  it('detects tampered fields', () => {
    expect(verifySubmission({ ...KAT_FIELDS, version: '1.0.1' }, KAT_SIGNATURE, TEST_PUB)).toBe(false);
    expect(
      verifySubmission(
        { ...KAT_FIELDS, bundleHash: `sha256-${'0'.repeat(64)}` },
        KAT_SIGNATURE,
        TEST_PUB,
      ),
    ).toBe(false);
  });

  it('detects a tampered signature (flipped byte)', () => {
    const raw = base64ToBytes(KAT_SIGNATURE.slice('ed25519:'.length));
    raw[10] = (raw[10] as number) ^ 0xff;
    const tampered = 'ed25519:' + bytesToBase64(raw);
    expect(verifySubmission(KAT_FIELDS, tampered, TEST_PUB)).toBe(false);
  });

  it('rejects the wrong public key and malformed signatures', () => {
    const { publicKey } = generateKeypair();
    expect(verifySubmission(KAT_FIELDS, KAT_SIGNATURE, publicKey)).toBe(false);
    expect(verifySubmission(KAT_FIELDS, 'rsa:abcd', TEST_PUB)).toBe(false);
    expect(verifySubmission(KAT_FIELDS, 'ed25519:!!!!', TEST_PUB)).toBe(false);
    expect(verifySubmission(KAT_FIELDS, 'ed25519:aGk=', TEST_PUB)).toBe(false);
  });
});

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    expect([...base64ToBytes('aGk=')]).toEqual([104, 105]);
    const random = new Uint8Array(64).map((_, i) => (i * 37) % 256);
    expect([...base64ToBytes(bytesToBase64(random))]).toEqual([...random]);
  });

  it('rejects invalid base64', () => {
    expect(() => base64ToBytes('a')).toThrow(TypeError);
    expect(() => base64ToBytes('ab$c')).toThrow(TypeError);
  });
});
