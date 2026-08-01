/**
 * Wire types and per-method zod schemas for `heir-element-api@1`.
 *
 * The method table is CLOSED: adding a method is a spec change. Both params
 * and results are schema-validated on both sides of the bridge; the host side
 * additionally treats result schemas as a response allowlist (unknown fields
 * are stripped, never echoed).
 */
import { z } from 'zod';
import {
  API_VERSION,
  ERROR_CODES,
  HOST_EVENTS,
  type ErrorCode,
  type Permission,
} from './constants.js';

export * from './constants.js';

// ---------------------------------------------------------------------------
// Wire envelopes (structured-clone-safe JSON only)
// ---------------------------------------------------------------------------

export interface RpcRequest {
  v: 1;
  rpcId: string;
  method: string;
  params: unknown;
}

export type RpcResponse =
  | { v: 1; rpcId: string; ok: true; result: unknown }
  | { v: 1; rpcId: string; ok: false; error: { code: ErrorCode; message: string } };

export interface HostEvent {
  v: 1;
  event: string;
  data: unknown;
}

export const errorCodeSchema = z.enum(ERROR_CODES);

export const rpcRequestSchema = z
  .object({
    v: z.literal(1),
    rpcId: z.string().min(1),
    method: z.string().min(1),
    params: z.unknown(),
  })
  .strict();

export const rpcErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string(),
  })
  .strict();

export const rpcResponseSchema = z.union([
  z.object({ v: z.literal(1), rpcId: z.string().min(1), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ v: z.literal(1), rpcId: z.string().min(1), ok: z.literal(false), error: rpcErrorSchema }).strict(),
]);

export const hostEventSchema = z
  .object({
    v: z.literal(1),
    event: z.string().min(1),
    data: z.unknown(),
  })
  .strict();

export function okResponse(rpcId: string, result: unknown): RpcResponse {
  return { v: 1, rpcId, ok: true, result };
}

export function errResponse(rpcId: string, code: ErrorCode, message: string): RpcResponse {
  return { v: 1, rpcId, ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Method table
// ---------------------------------------------------------------------------

const positiveInt = z.number().int().positive();

/**
 * Element context. Deliberately contains ZERO user data — no name, no email,
 * no desk name. Anything user-identifying never crosses the bridge.
 */
export const contextResultSchema = z.object({
  elementId: z.string(),
  installId: z.string(),
  version: z.string(),
  locale: z.string(),
  theme: z.enum(['light', 'dark']),
  viewport: z.object({ w: positiveInt, h: positiveInt }),
  deskVersion: z.string(),
});
export type ElementContext = z.infer<typeof contextResultSchema>;

const emptyParams = z.object({}).strict();
const emptyResult = z.object({});

export interface MethodDef {
  permission: Permission | null;
  params: z.ZodTypeAny;
  result: z.ZodTypeAny;
}

export const METHOD_TABLE = {
  'element.getContext': {
    permission: null,
    params: emptyParams,
    result: contextResultSchema,
  },
  'storage.get': {
    permission: 'storage.element',
    params: z.object({ key: z.string().min(1) }).strict(),
    result: z.object({ value: z.string().nullable() }),
  },
  'storage.set': {
    permission: 'storage.element',
    params: z.object({ key: z.string().min(1), value: z.string() }).strict(),
    result: emptyResult,
  },
  'storage.delete': {
    permission: 'storage.element',
    params: z.object({ key: z.string().min(1) }).strict(),
    result: emptyResult,
  },
  'storage.list': {
    permission: 'storage.element',
    params: z.object({ prefix: z.string().optional() }).strict(),
    result: z.object({ keys: z.array(z.string()) }),
  },
  'ui.setTitle': {
    permission: null,
    params: z.object({ title: z.string().max(200) }).strict(),
    result: emptyResult,
  },
  'ui.requestResize': {
    permission: null,
    params: z.object({ width: positiveInt, height: positiveInt }).strict(),
    result: z.object({ width: positiveInt, height: positiveInt }),
  },
  'ui.toast': {
    permission: 'notifications',
    params: z.object({ message: z.string().min(1).max(500) }).strict(),
    result: emptyResult,
  },
  'ui.confirm': {
    permission: null,
    params: z
      .object({
        title: z.string().min(1).max(200),
        message: z.string().min(1).max(2000),
        confirmLabel: z.string().min(1).max(40).optional(),
        cancelLabel: z.string().min(1).max(40).optional(),
      })
      .strict(),
    result: z.object({ confirmed: z.boolean() }),
  },
  'ui.openExternal': {
    permission: null,
    params: z.object({ url: z.string().url() }).strict(),
    result: z.object({ opened: z.boolean() }),
  },
  'clipboard.writeText': {
    permission: 'clipboard.write',
    params: z.object({ text: z.string() }).strict(),
    result: emptyResult,
  },
  'llm.complete': {
    permission: 'llm.completion',
    params: z
      .object({
        prompt: z.string().min(1),
        system: z.string().optional(),
        maxTokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
      })
      .strict(),
    result: z.object({
      text: z.string(),
      model: z.string(),
      tokensUsed: z.number().int().nonnegative(),
    }),
  },
} as const satisfies Record<string, MethodDef>;

export type MethodName = keyof typeof METHOD_TABLE;
export const METHOD_NAMES = Object.keys(METHOD_TABLE) as MethodName[];

export function isKnownMethod(method: string): method is MethodName {
  return Object.prototype.hasOwnProperty.call(METHOD_TABLE, method);
}

export type MethodParams<M extends MethodName> = z.input<(typeof METHOD_TABLE)[M]['params']>;
export type MethodResult<M extends MethodName> = z.output<(typeof METHOD_TABLE)[M]['result']>;

// ---------------------------------------------------------------------------
// Host→element events
// ---------------------------------------------------------------------------

export const EVENT_TABLE = {
  'theme-changed': z.object({ theme: z.enum(['light', 'dark']) }),
  'visibility-changed': z.object({ visible: z.boolean() }),
  resize: z.object({ width: positiveInt, height: positiveInt }),
} as const satisfies Record<(typeof HOST_EVENTS)[number], z.ZodTypeAny>;

export type EventName = keyof typeof EVENT_TABLE;
export type EventData<E extends EventName> = z.output<(typeof EVENT_TABLE)[E]>;

export function isKnownEvent(event: string): event is EventName {
  return Object.prototype.hasOwnProperty.call(EVENT_TABLE, event);
}
