/**
 * Element manifest v1: zod schema, JSON-Schema re-export, and
 * `validateManifest` (schema + semantic rules A7/A9 and integrity modes).
 */
import { z } from 'zod';
import { API_VERSION, PERMISSIONS, RESERVED_SCOPE_PREFIXES } from './constants.js';
import { CONFUSABLES } from './confusables.js';

export { manifestJsonSchema } from './manifest-schema.generated.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$/;

// Official semver regex (semver.org).
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const positiveDim = z.number().int().positive().max(4096);
const sizeTuple = z.tuple([positiveDim, positiveDim]);

function customIssue(ctx: z.RefinementCtx, heirCode: string, message: string, path?: (string | number)[]): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    ...(path ? { path } : {}),
    params: { heirCode },
  });
}

// Entry: bundle-relative path only.
const entrySchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((val, ctx) => {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(val)) {
      customIssue(ctx, 'E_ENTRY_PATH', 'entry must be a bundle-relative path; URLs (remote entry) are forbidden');
    }
    if (val.startsWith('/')) {
      customIssue(ctx, 'E_ENTRY_PATH', 'entry must be bundle-relative; absolute paths are forbidden');
    }
    if (val.includes('\\')) {
      customIssue(ctx, 'E_ENTRY_PATH', 'entry must use forward slashes; backslashes are forbidden');
    }
    if (val.includes('//')) {
      customIssue(ctx, 'E_ENTRY_PATH', "entry must not contain '//'");
    }
    if (val.split('/').includes('..')) {
      customIssue(ctx, 'E_ENTRY_PATH', "entry must not contain '..' segments");
    }
  });

// Permissions: closed enum, unique, reserved scopes get a dedicated error.
const permissionsSchema = z.array(z.string()).superRefine((arr, ctx) => {
  const seen = new Set<string>();
  arr.forEach((p, i) => {
    const reserved = RESERVED_SCOPE_PREFIXES.find((prefix) => p.startsWith(prefix));
    if (reserved !== undefined) {
      customIssue(
        ctx,
        'E_RESERVED_SCOPE',
        `permission '${p}' uses reserved scope prefix '${reserved}'; reserved scopes are never grantable to elements`,
        [i],
      );
    } else if (!(PERMISSIONS as readonly string[]).includes(p)) {
      customIssue(ctx, 'E_UNKNOWN_PERMISSION', `unknown permission '${p}'; allowed: ${PERMISSIONS.join(', ')}`, [i]);
    }
    if (seen.has(p)) {
      customIssue(ctx, 'E_DUPLICATE_PERMISSION', `duplicate permission '${p}'`, [i]);
    }
    seen.add(p);
  });
});

// Endpoint origin: https origin only — no path/query/hash, no wildcard, no credentials.
function originProblem(origin: string): string | null {
  if (origin.includes('*')) return 'wildcards are not allowed in endpoint origins';
  if (!origin.startsWith('https://')) return 'endpoint origin must be an https origin';
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return 'endpoint origin is not a valid URL';
  }
  if (u.username !== '' || u.password !== '') return 'credentials are not allowed in endpoint origins';
  if (u.search !== '' || u.hash !== '') return 'endpoint origin must not contain a query or fragment';
  if (u.pathname !== '/') return 'endpoint origin must not contain a path';
  if (origin !== u.origin) return 'endpoint origin must be exactly https://host[:port] (no trailing slash)';
  return null;
}

/**
 * Personal-data category denylist for `endpoints[].dataSent` (plan §3.3):
 * at v3 no permission can produce personal data, so declaring that it is sent
 * is a schema error, not a review flag.
 */
const PERSONAL_DATA_TOKENS = [
  'name',
  'names',
  'full_name',
  'display_name',
  'email',
  'emails',
  'email_address',
  'address',
  'addresses',
  'phone',
  'phone_number',
  'contact',
  'contacts',
  'estate',
  'beneficiary',
  'beneficiaries',
  'heir',
  'heirs',
  'inheritance',
  'will',
  'probate',
  'executor',
  'death',
  'deceased',
  'ssn',
  'passport',
  'national_id',
  'government_id',
  'dob',
  'date_of_birth',
  'birthdate',
  'location',
  'geolocation',
  'gps',
  'ip_address',
  'wallet',
  'seed',
  'seed_phrase',
  'private_key',
  'recovery',
  'recovery_phrase',
  'health',
  'medical',
  'biometric',
  'biometrics',
  'pii',
  'personal',
  'personal_data',
  'identity',
  'user_id',
] as const;

function normalizeCategory(s: string): string {
  return '_' + s.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_';
}

function isPersonalDataCategory(category: string): boolean {
  const norm = normalizeCategory(category);
  return PERSONAL_DATA_TOKENS.some((tok) => norm.includes(`_${tok}_`));
}

const endpointSchema = z
  .object({
    origin: z.string().superRefine((val, ctx) => {
      const problem = originProblem(val);
      if (problem !== null) customIssue(ctx, 'E_ENDPOINT_ORIGIN', problem);
    }),
    purpose: z.string().min(1).max(200),
    dataSent: z.array(z.string()).superRefine((arr, ctx) => {
      arr.forEach((category, i) => {
        if (isPersonalDataCategory(category)) {
          customIssue(
            ctx,
            'E_DATASENT_PERSONAL',
            `dataSent category '${category}' describes personal data; no permission can produce personal data at v3`,
            [i],
          );
        }
      });
    }),
    dataReceived: z.array(z.string()),
  })
  .strict();

const pricingSchema = z.discriminatedUnion('model', [
  z.object({ model: z.literal('free') }).strict(),
  z.object({ model: z.literal('one_time'), priceCents: z.number().int().min(200) }).strict(),
  z
    .object({
      model: z.literal('metered'),
      actions: z
        .array(
          z
            .object({
              action: z.string().min(1),
              postedCreditPrice: z.number().int().min(1),
              maxTokensPerAction: z.number().int().positive(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);

const integritySchema = z
  .object({
    bundleHash: z.string().regex(/^sha256-[0-9a-f]{64}$/),
    sizeBytes: z.number().int().positive(),
    publisherSig: z
      .string()
      .regex(/^ed25519:[A-Za-z0-9+/]+={0,2}$/)
      .nullable(),
    registrySig: z.string().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

export const CATEGORIES = ['utilities', 'games', 'devtools', 'estate', 'identity'] as const;
export type ElementCategory = (typeof CATEGORIES)[number];

export const manifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    id: z.string().max(80).regex(ID_RE, 'id must be reverse-DNS (lowercase alphanumerics and dots)'),
    name: z.string().min(1).max(40),
    version: z.string().regex(SEMVER_RE, 'version must be valid semver'),
    description: z.string().min(1).max(500),
    publisher: z
      .object({
        id: z.string().min(1),
        displayName: z.string().min(1),
        tier: z.number().int().min(0).max(3),
      })
      .strict(),
    category: z.enum(CATEGORIES),
    icons: z.record(z.unknown()).optional(),
    surfaces: z.tuple([z.literal('window')]),
    window: z
      .object({
        defaultSize: sizeTuple,
        minSize: sizeTuple,
        resizable: z.boolean(),
      })
      .strict(),
    runtime: z
      .object({
        type: z.literal('sandboxed-iframe'),
        api: z.literal(API_VERSION),
      })
      .strict(),
    entry: entrySchema,
    permissions: permissionsSchema,
    endpoints: z.array(endpointSchema),
    dataUse: z
      .object({
        collectsPersonalData: z.boolean(),
        sells: z.boolean(),
        retention: z.string().min(1).max(200),
        privacyPolicy: z.string().url().optional(),
      })
      .strict(),
    pricing: pricingSchema,
    compat: z.object({ minDeskVersion: z.string().min(1) }).strict(),
    ageRating: z.enum(['adult', 'everyone']),
    support: z
      .object({
        email: z.string().email(),
        url: z.string().url().optional(),
      })
      .strict(),
    integrity: integritySchema.optional(),
  })
  .strict();

export type ElementManifest = z.infer<typeof manifestSchema>;

// ---------------------------------------------------------------------------
// A7 phishing-surface denylist
// ---------------------------------------------------------------------------

/** Brand terms matched as substrings after folding. */
const BRAND_SUBSTRINGS = ['heir'] as const;

/** Terms matched with word boundaries after folding. */
const DENYLIST_TERMS = [
  'estate',
  'inheritance',
  'inherit',
  'probate',
  'will',
  'trust',
  'executor',
  'death',
  'deceased',
  'wallet',
  'seed phrase',
  'recovery phrase',
  'recovery',
  'beneficiary',
  'proof of life',
  'legal advice',
] as const;

/**
 * Fold text for denylist matching: NFKC normalization, confusable folding,
 * diacritic stripping, lowercase.
 */
export function foldText(raw: string): string {
  const nfkc = raw.normalize('NFKC');
  let folded = '';
  for (const ch of nfkc) {
    folded += CONFUSABLES[ch] ?? ch;
  }
  const stripped = folded.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return stripped.toLowerCase();
}

function denylistHit(folded: string): string | null {
  for (const brand of BRAND_SUBSTRINGS) {
    if (folded.includes(brand)) return brand;
  }
  for (const term of DENYLIST_TERMS) {
    const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    const re = new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])`);
    if (re.test(folded)) return term;
  }
  return null;
}

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

export interface Issue {
  path: string;
  code: string;
  message: string;
}

export interface ValidateManifestOptions {
  audience: 'third-party' | 'first-party';
  mode?: 'authoring' | 'submission';
}

export interface ValidateManifestResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

function zodIssueToIssue(issue: z.ZodIssue, raw: unknown): Issue {
  const path = issue.path.join('.');
  let code = 'E_SCHEMA';
  const params = (issue as { params?: { heirCode?: string } }).params;
  if (issue.code === z.ZodIssueCode.custom && typeof params?.heirCode === 'string') {
    code = params.heirCode;
  } else if (path === 'pricing.model' || path === 'pricing') {
    const model = (raw as { pricing?: { model?: unknown } } | null | undefined)?.pricing?.model;
    if (model === 'subscription') code = 'E_PRICING_SUBSCRIPTION';
  }
  return { path, code, message: issue.message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function validateManifest(json: unknown, opts: ValidateManifestOptions): ValidateManifestResult {
  const mode = opts.mode ?? 'authoring';
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(zodIssueToIssue(issue, json));
    }
  }

  const raw = asRecord(json);

  // A7 phishing surface — third-party audience only.
  if (opts.audience === 'third-party' && raw) {
    if (raw.category === 'estate' || raw.category === 'identity') {
      errors.push({
        path: 'category',
        code: 'E_CATEGORY_CLOSED',
        message: `category '${String(raw.category)}' is closed to third-party publishers`,
      });
    }
    for (const field of ['name', 'description'] as const) {
      const value = raw[field];
      if (typeof value !== 'string') continue;
      const folded = foldText(value);
      const hit = denylistHit(folded);
      if (hit !== null) {
        const homoglyph = folded !== value.toLowerCase();
        errors.push({
          path: field,
          code: homoglyph ? 'E_NAME_HOMOGLYPH' : 'E_NAME_DENYLIST',
          message: homoglyph
            ? `${field} matches denylisted term '${hit}' after confusable folding`
            : `${field} matches denylisted term '${hit}'`,
        });
      }
    }
  }

  // A9 processor combination + no-network badge.
  if (raw) {
    const permissions = Array.isArray(raw.permissions) ? raw.permissions : [];
    const endpoints = Array.isArray(raw.endpoints) ? raw.endpoints : null;
    if (endpoints !== null) {
      if (permissions.includes('storage.element') && endpoints.length > 0) {
        warnings.push({
          path: 'endpoints',
          code: 'W_PROCESSOR_TIER',
          message:
            'storage.element combined with network endpoints requires a DPA and a named processor role at the registry',
        });
      }
      if (endpoints.length === 0) {
        warnings.push({
          path: 'endpoints',
          code: 'I_NO_NETWORK',
          message: 'element declares no network endpoints (badge-eligible)',
        });
      }
    }
  }

  // Integrity requirements per mode.
  if (mode === 'submission') {
    const integrity = raw ? asRecord(raw.integrity) : null;
    if (!raw || raw.integrity === undefined || integrity === null) {
      errors.push({
        path: 'integrity',
        code: 'E_INTEGRITY_REQUIRED',
        message: 'submission mode requires integrity (bundleHash, sizeBytes, publisherSig)',
      });
    } else if (integrity.publisherSig === null || integrity.publisherSig === undefined) {
      errors.push({
        path: 'integrity.publisherSig',
        code: 'E_INTEGRITY_REQUIRED',
        message: 'submission mode requires a publisher signature',
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
