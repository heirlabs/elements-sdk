import { afterEach, describe, expect, it } from 'vitest';
import { ElementApiError, connectElement, type WindowLike } from '../src/client.js';
import { EmulatorCore } from '../src/emulator.js';
import { API_VERSION, INIT_MESSAGE_TYPE } from '../src/constants.js';
import { makeFullPermissionManifest, makeValidManifest } from './fixtures.js';

interface FakeWindow extends WindowLike {
  dispatch(ev: unknown): void;
  listenerCount(): number;
}

function createFakeWindow(): FakeWindow {
  const listeners = new Set<(ev: unknown) => void>();
  return {
    addEventListener: (_type, handler) => listeners.add(handler as (ev: unknown) => void),
    removeEventListener: (_type, handler) => listeners.delete(handler as (ev: unknown) => void),
    dispatch: (ev) => {
      for (const l of [...listeners]) l(ev);
    },
    listenerCount: () => listeners.size,
  };
}

const openChannels: MessageChannel[] = [];

afterEach(() => {
  for (const ch of openChannels.splice(0)) {
    ch.port1.close();
    ch.port2.close();
  }
});

/** Wire a real EmulatorCore to the client over a real MessageChannel. */
function hostFor(core: EmulatorCore): { win: FakeWindow; init: () => void } {
  const channel = new MessageChannel();
  openChannels.push(channel);
  channel.port1.addEventListener('message', (ev) => {
    const data: unknown = (ev as MessageEvent).data;
    if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'heir-element-ready') return;
    void core.handleRequest(data).then((resp) => channel.port1.postMessage(resp));
  });
  channel.port1.start();
  const win = createFakeWindow();
  const init = (): void =>
    win.dispatch({
      data: { type: INIT_MESSAGE_TYPE, api: API_VERSION, context: core.getContext() },
      ports: [channel.port2],
    });
  return { win, init };
}

describe('connectElement', () => {
  it('handshakes and serves typed calls end to end', async () => {
    const core = new EmulatorCore(makeFullPermissionManifest());
    const { win, init } = hostFor(core);
    const apiPromise = connectElement({ windowRef: win });
    init();
    const api = await apiPromise;

    const ctx = await api.getContext();
    expect(ctx.elementId).toBe('com.example.pomodoro');
    expect(ctx.theme).toBe('light');

    await api.storage.set('greeting', 'hola');
    expect(await api.storage.get('greeting')).toBe('hola');
    expect(await api.storage.list()).toEqual(['greeting']);
    await api.storage.delete('greeting');
    expect(await api.storage.get('greeting')).toBeNull();

    expect(await api.ui.confirm({ title: 'Sure?', message: 'Really?' })).toBe(true);
    const resized = await api.ui.requestResize(1000, 700);
    expect(resized).toEqual({ width: 1000, height: 700 });

    const completion = await api.llm.complete({ prompt: 'ping' });
    expect(completion.text).toBe('[dev-emulator] ping');

    // The init listener is removed after the handshake.
    expect(win.listenerCount()).toBe(0);
  });

  it('ignores broadcast messages after init (double-init ignored)', async () => {
    const core = new EmulatorCore(makeFullPermissionManifest());
    const { win, init } = hostFor(core);
    const apiPromise = connectElement({ windowRef: win });
    init();
    const api = await apiPromise;
    // A second init and random broadcasts must not disturb the session.
    init();
    win.dispatch({ data: { type: INIT_MESSAGE_TYPE, api: API_VERSION }, ports: [] });
    win.dispatch({ data: { v: 1, rpcId: 'forged', ok: true, result: {} } });
    expect(await api.storage.get('nope')).toBeNull();
  });

  it('propagates host error codes as ElementApiError', async () => {
    const core = new EmulatorCore(makeValidManifest({ permissions: [] }));
    const { win, init } = hostFor(core);
    const apiPromise = connectElement({ windowRef: win });
    init();
    const api = await apiPromise;
    await expect(api.ui.toast('hi')).rejects.toMatchObject({
      name: 'ElementApiError',
      code: 'E_PERMISSION_DENIED',
    });
  });

  it('rejects when the host returns an invalid result shape and leaves no dangling state', async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    channel.port1.addEventListener('message', (ev) => {
      const data = (ev as MessageEvent).data as { type?: string; rpcId?: string };
      if (data?.type === 'heir-element-ready') return;
      // Malicious/buggy host: wrong result shape for storage.get.
      channel.port1.postMessage({ v: 1, rpcId: data.rpcId, ok: true, result: { bogus: true } });
    });
    channel.port1.start();
    const win = createFakeWindow();
    const apiPromise = connectElement({ windowRef: win });
    win.dispatch({ data: { type: INIT_MESSAGE_TYPE, api: API_VERSION }, ports: [channel.port2] });
    const api = await apiPromise;
    await expect(api.storage.get('k')).rejects.toBeInstanceOf(ElementApiError);
    await expect(api.storage.get('k')).rejects.toMatchObject({ code: 'E_INVALID_PARAMS' });
  });

  it('dispatches host events to subscribers with unsubscribe support', async () => {
    const core = new EmulatorCore(makeFullPermissionManifest());
    const channel = new MessageChannel();
    openChannels.push(channel);
    channel.port1.addEventListener('message', (ev) => {
      const data: unknown = (ev as MessageEvent).data;
      if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'heir-element-ready') return;
      void core.handleRequest(data).then((resp) => channel.port1.postMessage(resp));
    });
    channel.port1.start();
    const win = createFakeWindow();
    const apiPromise = connectElement({ windowRef: win });
    win.dispatch({ data: { type: INIT_MESSAGE_TYPE, api: API_VERSION, context: core.getContext() }, ports: [channel.port2] });
    const api = await apiPromise;

    const seen: string[] = [];
    const unsubscribe = api.onEvent('theme-changed', (data) => seen.push(data.theme));

    channel.port1.postMessage(core.makeEvent('theme-changed', { theme: 'dark' }));
    // Round-trip an RPC to be sure the event was delivered first.
    await api.getContext();
    expect(seen).toEqual(['dark']);

    unsubscribe();
    channel.port1.postMessage(core.makeEvent('theme-changed', { theme: 'light' }));
    await api.getContext();
    expect(seen).toEqual(['dark']);
  });

  it('rejects an init with a mismatched api version', async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    const win = createFakeWindow();
    const apiPromise = connectElement({ windowRef: win });
    win.dispatch({ data: { type: INIT_MESSAGE_TYPE, api: 'heir-element-api@99' }, ports: [channel.port2] });
    await expect(apiPromise).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
  });

  it('times out the handshake when no init arrives', async () => {
    const win = createFakeWindow();
    await expect(connectElement({ windowRef: win, timeoutMs: 30 })).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    expect(win.listenerCount()).toBe(0);
  });

  it('fails fast without a window', async () => {
    await expect(connectElement()).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
  });
});
