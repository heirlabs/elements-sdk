/**
 * Content-Security-Policy generation for element frames.
 *
 * This is the exact function the desk/monolith imports later — the emulator,
 * the CLI dev server, and production serve the same policy.
 */

export interface CspManifestInput {
  endpoints?: ReadonlyArray<{ origin: string }>;
}

export interface CspOptions {
  frameAncestors?: readonly string[];
}

export function generateElementCsp(manifest: CspManifestInput, opts: CspOptions = {}): string {
  const origins: string[] = [];
  for (const endpoint of manifest.endpoints ?? []) {
    if (!origins.includes(endpoint.origin)) origins.push(endpoint.origin);
  }
  const connectSrc = origins.length > 0 ? origins.join(' ') : "'none'";
  const frameAncestors =
    opts.frameAncestors !== undefined && opts.frameAncestors.length > 0
      ? opts.frameAncestors.join(' ')
      : "'none'";

  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self'",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}
