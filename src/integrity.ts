/**
 * Integrity and signing: canonical JSON (RFC 8785-lite), sha256 hashing,
 * the domain-separated registry sign payload, and ed25519 helpers.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';

export const SIGN_DOMAIN = 'heir-element-registry-v1';

// ---------------------------------------------------------------------------
// Canonical JSON (RFC 8785-lite)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization: recursively key-sorted objects, arrays in
 * order, no whitespace, UTF-8. Non-finite numbers are rejected; `undefined`
 * object values are skipped (as in JSON.stringify); `undefined` array items
 * serialize as null (as in JSON.stringify).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: non-finite numbers are not allowed');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']';
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(record[k]));
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new TypeError(`canonicalJson: cannot serialize value of type ${typeof value}`);
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input;
  return bytesToHex(sha256(bytes));
}

/**
 * Hash of the canonical manifest with the `integrity` property removed
 * (the manifest cannot contain its own hash).
 */
export function manifestHash(manifest: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (k !== 'integrity') copy[k] = v;
  }
  return sha256Hex(canonicalJson(copy));
}

/** `sha256-<hex>` digest of the bundle `.tar.gz` bytes. */
export function bundleHash(bundleBytes: Uint8Array): string {
  return 'sha256-' + sha256Hex(bundleBytes);
}

// ---------------------------------------------------------------------------
// Sign payload
// ---------------------------------------------------------------------------

export interface SignPayloadFields {
  id: string;
  version: string;
  /** In `sha256-<hex>` form. */
  bundleHash: string;
  /** Plain hex sha256 of the canonical manifest without `integrity`. */
  manifestHash: string;
}

/**
 * Domain-separated payload string (trailing newline included):
 * `heir-element-registry-v1\n{id}\n{version}\n{bundleHash}\n{manifestHash}\n`
 */
export function buildSignPayload(fields: SignPayloadFields): string {
  for (const key of ['id', 'version', 'bundleHash', 'manifestHash'] as const) {
    const v = fields[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new TypeError(`buildSignPayload: missing field '${key}'`);
    }
    if (v.includes('\n')) {
      throw new TypeError(`buildSignPayload: field '${key}' must not contain newlines`);
    }
  }
  if (!/^sha256-[0-9a-f]{64}$/.test(fields.bundleHash)) {
    throw new TypeError("buildSignPayload: bundleHash must be in 'sha256-<64 hex>' form");
  }
  return `${SIGN_DOMAIN}\n${fields.id}\n${fields.version}\n${fields.bundleHash}\n${fields.manifestHash}\n`;
}

// ---------------------------------------------------------------------------
// Base64 (isomorphic, no Buffer)
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new TypeError('base64ToBytes: invalid base64 input');
  }
  const clean = b64.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    buffer = (buffer << 6) | B64_ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Ed25519 helpers (raw 32-byte keys)
// ---------------------------------------------------------------------------

export const SIG_PREFIX = 'ed25519:';

export interface Keypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateKeypair(): Keypair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Sign a submission. Returns `ed25519:<base64(std, padded)>` over the
 * domain-separated payload. Ed25519 is deterministic: signing the same
 * payload with the same key always yields identical bytes.
 */
export function signSubmission(fields: SignPayloadFields, privateKey: Uint8Array): string {
  const payload = textEncoder.encode(buildSignPayload(fields));
  const sig = ed25519.sign(payload, privateKey);
  return SIG_PREFIX + bytesToBase64(sig);
}

/** Verify a `ed25519:<base64>` signature over the payload fields. */
export function verifySubmission(fields: SignPayloadFields, signature: string, publicKey: Uint8Array): boolean {
  try {
    if (!signature.startsWith(SIG_PREFIX)) return false;
    const sigBytes = base64ToBytes(signature.slice(SIG_PREFIX.length));
    if (sigBytes.length !== 64) return false;
    const payload = textEncoder.encode(buildSignPayload(fields));
    return ed25519.verify(sigBytes, payload, publicKey);
  } catch {
    return false;
  }
}
