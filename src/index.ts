/**
 * @morbidcorp/element-sdk — client, types, constants.
 *
 * Subpath exports:
 * - `@morbidcorp/element-sdk/protocol`  — wire types + per-method zod schemas
 * - `@morbidcorp/element-sdk/manifest`  — manifest schema + validateManifest
 * - `@morbidcorp/element-sdk/integrity` — canonical JSON, hashing, signing
 * - `@morbidcorp/element-sdk/csp`       — generateElementCsp
 * - `@morbidcorp/element-sdk/emulator`  — EmulatorCore + attachIframeHost
 */
export * from './constants.js';
export {
  connectElement,
  ElementApiError,
  type ConnectElementOptions,
  type ElementApi,
  type MessageEventLike,
  type MessagePortLike,
  type WindowLike,
} from './client.js';
export type {
  ElementContext,
  EventData,
  EventName,
  HostEvent,
  MethodName,
  MethodParams,
  MethodResult,
  RpcRequest,
  RpcResponse,
} from './protocol.js';
