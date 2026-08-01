/**
 * Protocol constants for `heir-element-api@1`.
 * Single source of truth — every other module imports from here.
 */

export const API_VERSION = 'heir-element-api@1';

/** Closed permission set. Adding a permission is a spec change. */
export const PERMISSIONS = [
  'storage.element',
  'notifications',
  'clipboard.write',
  'llm.completion',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Reserved scope prefixes. Any permission string starting with one of these is
 * rejected at schema level — there is no permission tier at any price that
 * grants access to these domains.
 */
export const RESERVED_SCOPE_PREFIXES = [
  'estate.',
  'identity.',
  'wallet.',
  'auth.',
  'payments.',
  'settings.',
  'agent.',
  'pol.',
] as const;

export const ERROR_CODES = [
  'E_PERMISSION_DENIED',
  'E_UNKNOWN_METHOD',
  'E_INVALID_PARAMS',
  'E_QUOTA_EXCEEDED',
  'E_RATE_LIMITED',
  'E_USER_DECLINED',
  'E_UNAVAILABLE',
  'E_INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Host→element event names. */
export const HOST_EVENTS = ['theme-changed', 'visibility-changed', 'resize'] as const;
export type HostEventName = (typeof HOST_EVENTS)[number];

/** Handshake message types. */
export const INIT_MESSAGE_TYPE = 'heir-element-init';
export const READY_MESSAGE_TYPE = 'heir-element-ready';

/** Per-element storage quota: sum of UTF-8 key+value bytes. */
export const STORAGE_QUOTA_BYTES = 1024 * 1024;

/** Default bridge rate limit: 120 calls per 10 seconds. */
export const DEFAULT_RATE_LIMIT = { calls: 120, perMs: 10_000 } as const;

/** Client-side per-call timeouts. */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;
export const LLM_CALL_TIMEOUT_MS = 120_000;
