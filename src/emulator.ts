/**
 * EmulatorCore: environment-agnostic host-side implementation of the bridge,
 * used by the CLI dev server and a browser shell, and fully testable in Node.
 *
 * Plus `attachIframeHost`, a thin browser-only helper that wires an iframe to
 * a core over a MessageChannel.
 */
import {
  API_VERSION,
  DEFAULT_RATE_LIMIT,
  INIT_MESSAGE_TYPE,
  READY_MESSAGE_TYPE,
  STORAGE_QUOTA_BYTES,
  type ErrorCode,
} from './constants.js';
import {
  EVENT_TABLE,
  METHOD_TABLE,
  errResponse,
  isKnownEvent,
  isKnownMethod,
  okResponse,
  rpcRequestSchema,
  type ElementContext,
  type EventData,
  type EventName,
  type HostEvent,
  type MethodParams,
  type MethodResult,
  type RpcResponse,
} from './protocol.js';
import type { ElementManifest } from './manifest.js';

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export interface StorageBackend {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  list(prefix?: string): Promise<string[]> | string[];
}

export class InMemoryStorage implements StorageBackend {
  private readonly map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  list(prefix = ''): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export interface LlmBackend {
  complete(
    params: MethodParams<'llm.complete'>,
  ): Promise<MethodResult<'llm.complete'>> | MethodResult<'llm.complete'>;
}

/** Deterministic dev stub — no network, no key. */
export const devLlmBackend: LlmBackend = {
  complete(params) {
    const text = `[dev-emulator] ${params.prompt.slice(0, 200)}`;
    return {
      text,
      model: 'heir-dev-emulator',
      tokensUsed: Math.ceil((params.prompt.length + text.length) / 4),
    };
  },
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EmulatorLogEntry {
  rpcId: string;
  method: string;
  ok: boolean;
  ms: number;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface EmulatorOptions {
  storage?: StorageBackend;
  llm?: LlmBackend;
  onToast?: (message: string) => void;
  onConfirm?: (request: ConfirmRequest) => boolean | Promise<boolean>;
  onOpenExternal?: (url: string) => boolean | Promise<boolean>;
  onSetTitle?: (title: string) => void;
  onRequestResize?: (
    size: { width: number; height: number },
  ) => { width: number; height: number } | Promise<{ width: number; height: number }>;
  /** EVERY bridge call is logged, success or failure (INV-29 parity). */
  log?: (entry: EmulatorLogEntry) => void;
  rateLimit?: { calls: number; perMs: number };
  /** Overrides for the synthetic dev context. */
  context?: Partial<ElementContext>;
}

class RpcFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RpcFailure';
  }
}

const utf8Encoder = new TextEncoder();

function utf8Bytes(s: string): number {
  return utf8Encoder.encode(s).length;
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `emu-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// ---------------------------------------------------------------------------
// EmulatorCore
// ---------------------------------------------------------------------------

export class EmulatorCore {
  readonly storage: StorageBackend;
  private readonly llm: LlmBackend;
  private readonly granted: ReadonlySet<string>;
  private readonly rateLimit: { calls: number; perMs: number };
  private readonly callTimestamps: number[] = [];
  private readonly installId = randomId();
  private clipboardText: string | null = null;

  constructor(
    private readonly manifest: ElementManifest,
    private readonly opts: EmulatorOptions = {},
  ) {
    this.storage = opts.storage ?? new InMemoryStorage();
    this.llm = opts.llm ?? devLlmBackend;
    this.granted = new Set(manifest.permissions);
    this.rateLimit = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
  }

  /** The context handed to the element — ZERO user data by design. */
  getContext(): ElementContext {
    return {
      elementId: this.manifest.id,
      installId: this.installId,
      version: this.manifest.version,
      locale: 'en-US',
      theme: 'light',
      viewport: {
        w: this.manifest.window.defaultSize[0],
        h: this.manifest.window.defaultSize[1],
      },
      deskVersion: '0.0.0-emulator',
      ...this.opts.context,
    };
  }

  /** Last text written via clipboard.writeText (dev inspection). */
  get lastClipboardText(): string | null {
    return this.clipboardText;
  }

  async handleRequest(req: unknown): Promise<RpcResponse> {
    const started = Date.now();
    const rawReq = (typeof req === 'object' && req !== null ? req : {}) as Record<string, unknown>;
    const fallbackRpcId = typeof rawReq.rpcId === 'string' ? rawReq.rpcId : '';
    const fallbackMethod = typeof rawReq.method === 'string' ? rawReq.method : '';

    const finish = (method: string, resp: RpcResponse): RpcResponse => {
      this.opts.log?.({ rpcId: resp.rpcId, method, ok: resp.ok, ms: Date.now() - started });
      return resp;
    };

    const envelope = rpcRequestSchema.safeParse(req);
    if (!envelope.success) {
      return finish(fallbackMethod, errResponse(fallbackRpcId, 'E_INVALID_PARAMS', 'malformed request envelope'));
    }
    const { rpcId, method, params } = envelope.data;

    // Rate limit (sliding window).
    const windowStart = started - this.rateLimit.perMs;
    while (this.callTimestamps.length > 0 && (this.callTimestamps[0] as number) < windowStart) {
      this.callTimestamps.shift();
    }
    if (this.callTimestamps.length >= this.rateLimit.calls) {
      return finish(
        method,
        errResponse(rpcId, 'E_RATE_LIMITED', `rate limit exceeded (${this.rateLimit.calls} calls / ${this.rateLimit.perMs} ms)`),
      );
    }
    this.callTimestamps.push(started);

    // Deny-by-default dispatch.
    if (!isKnownMethod(method)) {
      return finish(method, errResponse(rpcId, 'E_UNKNOWN_METHOD', `unknown method '${method}'`));
    }
    const def = METHOD_TABLE[method];
    if (def.permission !== null && !this.granted.has(def.permission)) {
      return finish(
        method,
        errResponse(rpcId, 'E_PERMISSION_DENIED', `method '${method}' requires permission '${def.permission}'`),
      );
    }
    const parsedParams = def.params.safeParse(params);
    if (!parsedParams.success) {
      const detail = parsedParams.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      return finish(method, errResponse(rpcId, 'E_INVALID_PARAMS', `invalid params for '${method}': ${detail}`));
    }

    let rawResult: unknown;
    try {
      rawResult = await this.dispatch(method, parsedParams.data);
    } catch (err) {
      if (err instanceof RpcFailure) {
        return finish(method, errResponse(rpcId, err.code, err.message));
      }
      return finish(method, errResponse(rpcId, 'E_INTERNAL', err instanceof Error ? err.message : 'internal error'));
    }

    // Host-side response allowlist (INV-10 parity): results are re-validated
    // against the method's result schema; unknown fields are stripped, never echoed.
    const parsedResult = def.result.safeParse(rawResult);
    if (!parsedResult.success) {
      return finish(method, errResponse(rpcId, 'E_INTERNAL', `handler produced an invalid result for '${method}'`));
    }
    return finish(method, okResponse(rpcId, parsedResult.data));
  }

  makeEvent<E extends EventName>(name: E, data: EventData<E>): HostEvent {
    if (!isKnownEvent(name)) {
      throw new TypeError(`unknown host event '${String(name)}'`);
    }
    const parsed = EVENT_TABLE[name].safeParse(data);
    if (!parsed.success) {
      throw new TypeError(`invalid data for host event '${name}'`);
    }
    return { v: 1, event: name, data: parsed.data };
  }

  // -------------------------------------------------------------------------

  private async dispatch(method: keyof typeof METHOD_TABLE, params: unknown): Promise<unknown> {
    switch (method) {
      case 'element.getContext':
        return this.getContext();

      case 'storage.get': {
        const { key } = params as MethodParams<'storage.get'>;
        return { value: await this.storage.get(key) };
      }
      case 'storage.set': {
        const { key, value } = params as MethodParams<'storage.set'>;
        await this.checkQuota(key, value);
        await this.storage.set(key, value);
        return {};
      }
      case 'storage.delete': {
        const { key } = params as MethodParams<'storage.delete'>;
        await this.storage.delete(key);
        return {};
      }
      case 'storage.list': {
        const { prefix } = params as MethodParams<'storage.list'>;
        return { keys: await this.storage.list(prefix ?? '') };
      }

      case 'ui.setTitle': {
        const { title } = params as MethodParams<'ui.setTitle'>;
        this.opts.onSetTitle?.(title);
        return {};
      }
      case 'ui.requestResize': {
        const size = params as MethodParams<'ui.requestResize'>;
        if (this.opts.onRequestResize) return this.opts.onRequestResize(size);
        const [minW, minH] = this.manifest.window.minSize;
        return {
          width: Math.min(Math.max(size.width, minW), 4096),
          height: Math.min(Math.max(size.height, minH), 4096),
        };
      }
      case 'ui.toast': {
        const { message } = params as MethodParams<'ui.toast'>;
        this.opts.onToast?.(message);
        return {};
      }
      case 'ui.confirm': {
        const request = params as MethodParams<'ui.confirm'>;
        const confirmed = this.opts.onConfirm ? await this.opts.onConfirm(request) : true;
        return { confirmed };
      }
      case 'ui.openExternal': {
        const { url } = params as MethodParams<'ui.openExternal'>;
        const opened = this.opts.onOpenExternal ? await this.opts.onOpenExternal(url) : true;
        return { opened };
      }

      case 'clipboard.writeText': {
        const { text } = params as MethodParams<'clipboard.writeText'>;
        this.clipboardText = text;
        return {};
      }

      case 'llm.complete':
        return this.llm.complete(params as MethodParams<'llm.complete'>);
    }
  }

  /** Quota: 1 MB total across all entries, counted as UTF-8 key+value bytes. */
  private async checkQuota(key: string, newValue: string): Promise<void> {
    let total = utf8Bytes(key) + utf8Bytes(newValue);
    const keys = await this.storage.list('');
    for (const existingKey of keys) {
      if (existingKey === key) continue;
      const value = await this.storage.get(existingKey);
      total += utf8Bytes(existingKey) + utf8Bytes(value ?? '');
    }
    if (total > STORAGE_QUOTA_BYTES) {
      throw new RpcFailure('E_QUOTA_EXCEEDED', `storage quota of ${STORAGE_QUOTA_BYTES} bytes exceeded`);
    }
  }
}

// ---------------------------------------------------------------------------
// attachIframeHost (browser-only helper — kept thin by design)
// ---------------------------------------------------------------------------

export interface IframeHostOptions {
  targetOrigin?: string;
  onReady?: () => void;
}

export interface IframeHost {
  /** Post the init message (called automatically on iframe `load`). */
  start(): void;
  sendEvent<E extends EventName>(name: E, data: EventData<E>): void;
  destroy(): void;
}

export function attachIframeHost(
  iframe: HTMLIFrameElement,
  core: EmulatorCore,
  opts: IframeHostOptions = {},
): IframeHost {
  const channel = new MessageChannel();
  let started = false;

  const start = (): void => {
    if (started) return;
    started = true;
    iframe.contentWindow?.postMessage(
      { type: INIT_MESSAGE_TYPE, api: API_VERSION, context: core.getContext() },
      opts.targetOrigin ?? '*',
      [channel.port2],
    );
  };

  channel.port1.onmessage = (ev: MessageEvent) => {
    const data: unknown = ev.data;
    if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === READY_MESSAGE_TYPE) {
      opts.onReady?.();
      return;
    }
    void core.handleRequest(data).then((resp) => channel.port1.postMessage(resp));
  };

  const onLoad = (): void => start();
  iframe.addEventListener('load', onLoad);

  return {
    start,
    sendEvent(name, data) {
      channel.port1.postMessage(core.makeEvent(name, data));
    },
    destroy() {
      iframe.removeEventListener('load', onLoad);
      channel.port1.close();
    },
  };
}
