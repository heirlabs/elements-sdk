import type { ElementManifest } from '../src/manifest.js';

/**
 * Golden valid manifest (authoring mode — no integrity block).
 * Keep in sync with the KAT scratch values in integrity.test.ts: the KAT
 * hashes are computed over exactly this object.
 */
export function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'com.example.pomodoro',
    name: 'Pomodoro Timer',
    version: '1.0.0',
    description: 'A minimalist focus timer for your desk.',
    publisher: { id: 'pub_1a2b3c', displayName: 'Example Labs', tier: 1 },
    category: 'utilities',
    surfaces: ['window'],
    window: { defaultSize: [400, 600], minSize: [320, 400], resizable: true },
    runtime: { type: 'sandboxed-iframe', api: 'heir-element-api@1' },
    entry: 'index.html',
    permissions: ['storage.element'],
    endpoints: [],
    dataUse: { collectsPersonalData: false, sells: false, retention: 'none' },
    pricing: { model: 'free' },
    compat: { minDeskVersion: '3.0.0' },
    ageRating: 'everyone',
    support: { email: 'support@example.com' },
    ...overrides,
  };
}

export function makeValidManifest(overrides: Record<string, unknown> = {}): ElementManifest {
  return makeManifest(overrides) as unknown as ElementManifest;
}

/** Manifest granting every permission — used by emulator happy-path tests. */
export function makeFullPermissionManifest(overrides: Record<string, unknown> = {}): ElementManifest {
  return makeValidManifest({
    permissions: ['storage.element', 'notifications', 'clipboard.write', 'llm.completion'],
    ...overrides,
  });
}
