/**
 * @heir/element-sdk — client, types, constants.
 *
 * Subpath exports:
 * - `@heir/element-sdk/protocol`  — wire types + per-method zod schemas
 * - `@heir/element-sdk/manifest`  — manifest schema + validateManifest
 * - `@heir/element-sdk/integrity` — canonical JSON, hashing, signing
 * - `@heir/element-sdk/csp`       — generateElementCsp
 * - `@heir/element-sdk/emulator`  — EmulatorCore + attachIframeHost
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
