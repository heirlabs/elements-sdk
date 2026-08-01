/**
 * Element-side bridge client.
 *
 * `connectElement()` performs the handshake (host posts `heir-element-init`
 * with a dedicated MessageChannel port; we reply `heir-element-ready` on the
 * port) and returns a typed API surface. All RPC flows on the port only —
 * broadcast `message` events are never trusted after init.
 */
import {
  API_VERSION,
  DEFAULT_CALL_TIMEOUT_MS,
  INIT_MESSAGE_TYPE,
  LLM_CALL_TIMEOUT_MS,
  READY_MESSAGE_TYPE,
} from './constants.js';
import {
  EVENT_TABLE,
  METHOD_TABLE,
  isKnownEvent,
  type ElementContext,
  type EventData,
  type EventName,
  type MethodName,
  type MethodParams,
  type MethodResult,
} from './protocol.js';

export class ElementApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ElementApiError';
  }
}

// Minimal structural types so the client is testable outside a real browser.
export interface MessagePortLike {
  postMessage(data: unknown): void;
  addEventListener?(type: 'message', handler: (ev: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
  onmessage?: ((ev: { data: unknown }) => void) | null;
}

export interface WindowLike {
  addEventListener(type: 'message', handler: (ev: MessageEventLike) => void): void;
  removeEventListener(type: 'message', handler: (ev: MessageEventLike) => void): void;
}

export interface MessageEventLike {
  data?: unknown;
  ports?: readonly MessagePortLike[];
}

export interface ConnectElementOptions {
  /** Handshake timeout in ms (default 10 000). */
  timeoutMs?: number;
  /** Test hook; defaults to the global `window`. */
  windowRef?: WindowLike;
}

export interface ElementApi {
  getContext(): Promise<ElementContext>;
  onEvent<E extends EventName>(name: E, cb: (data: EventData<E>) => void): () => void;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  ui: {
    setTitle(title: string): Promise<void>;
    requestResize(width: number, height: number): Promise<{ width: number; height: number }>;
    toast(message: string): Promise<void>;
    confirm(opts: MethodParams<'ui.confirm'>): Promise<boolean>;
    openExternal(url: string): Promise<boolean>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
  };
  llm: {
    complete(params: MethodParams<'llm.complete'>): Promise<MethodResult<'llm.complete'>>;
  };
}

interface PendingCall {
  method: MethodName;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `rpc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function listenPort(port: MessagePortLike, handler: (data: unknown) => void): void {
  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', (ev) => handler(ev.data));
    port.start?.();
  } else {
    port.onmessage = (ev) => handler(ev.data);
  }
}

export function connectElement(opts: ConnectElementOptions = {}): Promise<ElementApi> {
  const win =
    opts.windowRef ??
    (typeof window !== 'undefined' ? (window as unknown as WindowLike) : undefined);
  if (!win) {
    return Promise.reject(new ElementApiError('E_UNAVAILABLE', 'connectElement requires a window (or windowRef)'));
  }
  const handshakeTimeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  let port: MessagePortLike | null = null;
  let initialized = false;
  const pending = new Map<string, PendingCall>();
  const queue: Array<() => void> = [];
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();

  function onPortMessage(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const msg = data as Record<string, unknown>;

    if (typeof msg.event === 'string') {
      if (!isKnownEvent(msg.event)) return;
      const parsed = EVENT_TABLE[msg.event].safeParse(msg.data);
      if (!parsed.success) return;
      const listeners = eventListeners.get(msg.event);
      if (listeners) {
        for (const cb of [...listeners]) cb(parsed.data);
      }
      return;
    }

    if (typeof msg.rpcId !== 'string') return;
    const call = pending.get(msg.rpcId);
    if (!call) return; // stale (timed out) or unknown — never leaves a dangling listener
    pending.delete(msg.rpcId);
    clearTimeout(call.timer);

    if (msg.ok === true) {
      const parsed = METHOD_TABLE[call.method].result.safeParse(msg.result);
      if (parsed.success) {
        call.resolve(parsed.data);
      } else {
        call.reject(
          new ElementApiError('E_INVALID_PARAMS', `host returned an invalid result for '${call.method}'`),
        );
      }
    } else {
      const error = (msg.error ?? {}) as Record<string, unknown>;
      call.reject(
        new ElementApiError(
          typeof error.code === 'string' ? error.code : 'E_INTERNAL',
          typeof error.message === 'string' ? error.message : 'rpc failed',
        ),
      );
    }
  }

  function rpc<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const send = (): void => {
        const rpcId = randomId();
        const timeoutMs = method === 'llm.complete' ? LLM_CALL_TIMEOUT_MS : DEFAULT_CALL_TIMEOUT_MS;
        const timer = setTimeout(() => {
          pending.delete(rpcId);
          reject(new ElementApiError('E_TIMEOUT', `'${method}' timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(rpcId, {
          method,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        (port as MessagePortLike).postMessage({ v: 1, rpcId, method, params });
      };
      if (port) {
        send();
      } else {
        // Calls made before init queue and flush after the handshake.
        queue.push(send);
      }
    });
  }

  const api: ElementApi = {
    getContext: () => rpc('element.getContext', {}),
    onEvent(name, cb) {
      let set = eventListeners.get(name);
      if (!set) {
        set = new Set();
        eventListeners.set(name, set);
      }
      const wrapped = cb as (data: unknown) => void;
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
      };
    },
    storage: {
      get: (key) => rpc('storage.get', { key }).then((r) => r.value),
      set: (key, value) => rpc('storage.set', { key, value }).then(() => undefined),
      delete: (key) => rpc('storage.delete', { key }).then(() => undefined),
      list: (prefix) => rpc('storage.list', prefix === undefined ? {} : { prefix }).then((r) => r.keys),
    },
    ui: {
      setTitle: (title) => rpc('ui.setTitle', { title }).then(() => undefined),
      requestResize: (width, height) => rpc('ui.requestResize', { width, height }),
      toast: (message) => rpc('ui.toast', { message }).then(() => undefined),
      confirm: (confirmOpts) => rpc('ui.confirm', confirmOpts).then((r) => r.confirmed),
      openExternal: (url) => rpc('ui.openExternal', { url }).then((r) => r.opened),
    },
    clipboard: {
      writeText: (text) => rpc('clipboard.writeText', { text }).then(() => undefined),
    },
    llm: {
      complete: (params) => rpc('llm.complete', params),
    },
  };

  return new Promise<ElementApi>((resolve, reject) => {
    const timer = setTimeout(() => {
      win.removeEventListener('message', onInit);
      reject(new ElementApiError('E_TIMEOUT', `handshake timed out after ${handshakeTimeoutMs} ms`));
    }, handshakeTimeoutMs);

    const onInit = (ev: MessageEventLike): void => {
      const data = ev?.data as Record<string, unknown> | undefined;
      if (typeof data !== 'object' || data === null || data.type !== INIT_MESSAGE_TYPE) return;
      if (initialized) return; // double-init ignored
      const initPort = ev.ports?.[0];
      if (!initPort) return;
      if (data.api !== API_VERSION) {
        clearTimeout(timer);
        win.removeEventListener('message', onInit);
        reject(new ElementApiError('E_UNAVAILABLE', `unsupported api version '${String(data.api)}'`));
        return;
      }
      initialized = true;
      port = initPort;
      clearTimeout(timer);
      win.removeEventListener('message', onInit);
      listenPort(initPort, onPortMessage);
      initPort.postMessage({ type: READY_MESSAGE_TYPE });
      while (queue.length > 0) {
        queue.shift()?.();
      }
      resolve(api);
    };

    win.addEventListener('message', onInit);
  });
}
