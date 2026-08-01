import { describe, expect, it } from 'vitest';
import {
  EmulatorCore,
  InMemoryStorage,
  attachIframeHost,
  type EmulatorLogEntry,
  type EmulatorOptions,
} from '../src/emulator.js';
import type { RpcRequest, RpcResponse } from '../src/protocol.js';
import { makeFullPermissionManifest, makeValidManifest } from './fixtures.js';

let nextId = 0;

function req(method: string, params: unknown = {}): RpcRequest {
  return { v: 1, rpcId: `rpc-${nextId++}`, method, params };
}

function makeCore(opts: EmulatorOptions = {}, manifestOverrides: Record<string, unknown> = {}): EmulatorCore {
  return new EmulatorCore(makeFullPermissionManifest(manifestOverrides), opts);
}

function expectOk(resp: RpcResponse): Record<string, unknown> {
  expect(resp.ok, JSON.stringify(resp)).toBe(true);
  if (!resp.ok) throw new Error('unreachable');
  return resp.result as Record<string, unknown>;
}

function expectErr(resp: RpcResponse, code: string): void {
  expect(resp.ok).toBe(false);
  if (resp.ok) throw new Error('unreachable');
  expect(resp.error.code).toBe(code);
}

describe('EmulatorCore happy paths', () => {
  it('element.getContext returns synthetic context with ZERO user data', async () => {
    const core = makeCore();
    const result = expectOk(await core.handleRequest(req('element.getContext')));
    expect(Object.keys(result).sort()).toEqual(
      ['deskVersion', 'elementId', 'installId', 'locale', 'theme', 'version', 'viewport'].sort(),
    );
    expect(result.elementId).toBe('com.example.pomodoro');
    expect(result.version).toBe('1.0.0');
    expect(result.viewport).toEqual({ w: 400, h: 600 });
    // The forbidden fields are structurally impossible:
    for (const forbidden of ['name', 'email', 'deskName', 'userId']) {
      expect(forbidden in result).toBe(false);
    }
  });

  it('storage set/get/list/delete flow', async () => {
    const core = makeCore();
    expectOk(await core.handleRequest(req('storage.set', { key: 'todo:1', value: 'water plants' })));
    expectOk(await core.handleRequest(req('storage.set', { key: 'todo:2', value: 'stretch' })));
    expectOk(await core.handleRequest(req('storage.set', { key: 'other', value: 'x' })));

    const got = expectOk(await core.handleRequest(req('storage.get', { key: 'todo:1' })));
    expect(got).toEqual({ value: 'water plants' });

    const missing = expectOk(await core.handleRequest(req('storage.get', { key: 'nope' })));
    expect(missing).toEqual({ value: null });

    const listed = expectOk(await core.handleRequest(req('storage.list', { prefix: 'todo:' })));
    expect(listed).toEqual({ keys: ['todo:1', 'todo:2'] });

    const listedAll = expectOk(await core.handleRequest(req('storage.list', {})));
    expect((listedAll.keys as string[]).length).toBe(3);

    expectOk(await core.handleRequest(req('storage.delete', { key: 'todo:1' })));
    const afterDelete = expectOk(await core.handleRequest(req('storage.get', { key: 'todo:1' })));
    expect(afterDelete).toEqual({ value: null });
  });

  it('ui.setTitle invokes the host callback', async () => {
    const titles: string[] = [];
    const core = makeCore({ onSetTitle: (t) => titles.push(t) });
    expectOk(await core.handleRequest(req('ui.setTitle', { title: 'Focus 25:00' })));
    expect(titles).toEqual(['Focus 25:00']);
  });

  it('ui.requestResize clamps to manifest minSize and 4096 by default', async () => {
    const core = makeCore();
    const result = expectOk(await core.handleRequest(req('ui.requestResize', { width: 100, height: 5000 })));
    expect(result).toEqual({ width: 320, height: 4096 });
  });

  it('ui.requestResize defers to the host callback when provided', async () => {
    const core = makeCore({ onRequestResize: () => ({ width: 640, height: 480 }) });
    const result = expectOk(await core.handleRequest(req('ui.requestResize', { width: 9, height: 9 })));
    expect(result).toEqual({ width: 640, height: 480 });
  });

  it('ui.toast invokes the host callback', async () => {
    const messages: string[] = [];
    const core = makeCore({ onToast: (m) => messages.push(m) });
    expectOk(await core.handleRequest(req('ui.toast', { message: 'Saved' })));
    expect(messages).toEqual(['Saved']);
  });

  it('ui.confirm reflects the host decision (and defaults to confirmed)', async () => {
    const declined = makeCore({ onConfirm: () => false });
    expect(expectOk(await declined.handleRequest(req('ui.confirm', { title: 'Reset?', message: 'Sure?' })))).toEqual({
      confirmed: false,
    });
    const defaulted = makeCore();
    expect(expectOk(await defaulted.handleRequest(req('ui.confirm', { title: 'Reset?', message: 'Sure?' })))).toEqual({
      confirmed: true,
    });
  });

  it('ui.openExternal passes the full url to the host', async () => {
    const urls: string[] = [];
    const core = makeCore({
      onOpenExternal: (url) => {
        urls.push(url);
        return true;
      },
    });
    const result = expectOk(await core.handleRequest(req('ui.openExternal', { url: 'https://example.com/help' })));
    expect(result).toEqual({ opened: true });
    expect(urls).toEqual(['https://example.com/help']);
  });

  it('clipboard.writeText records the text', async () => {
    const core = makeCore();
    expectOk(await core.handleRequest(req('clipboard.writeText', { text: 'pomodoro stats' })));
    expect(core.lastClipboardText).toBe('pomodoro stats');
  });

  it('llm.complete uses the deterministic dev stub by default', async () => {
    const core = makeCore();
    const result = expectOk(await core.handleRequest(req('llm.complete', { prompt: 'Summarize my day' })));
    expect(result.text).toBe('[dev-emulator] Summarize my day');
    expect(result.model).toBe('heir-dev-emulator');
    expect(typeof result.tokensUsed).toBe('number');
    // Deterministic: same prompt, same output.
    const again = expectOk(await core.handleRequest(req('llm.complete', { prompt: 'Summarize my day' })));
    expect(again).toEqual(result);
  });
});

describe('EmulatorCore permission gating', () => {
  const GATED: Array<[string, unknown]> = [
    ['storage.get', { key: 'k' }],
    ['storage.set', { key: 'k', value: 'v' }],
    ['storage.delete', { key: 'k' }],
    ['storage.list', {}],
    ['ui.toast', { message: 'hi' }],
    ['clipboard.writeText', { text: 'x' }],
    ['llm.complete', { prompt: 'hi' }],
  ];

  for (const [method, params] of GATED) {
    it(`${method} is denied without its permission`, async () => {
      const core = new EmulatorCore(makeValidManifest({ permissions: [] }));
      expectErr(await core.handleRequest(req(method, params)), 'E_PERMISSION_DENIED');
    });
  }

  it('ungated methods work with zero permissions', async () => {
    const core = new EmulatorCore(makeValidManifest({ permissions: [] }));
    expectOk(await core.handleRequest(req('element.getContext')));
    expectOk(await core.handleRequest(req('ui.setTitle', { title: 'T' })));
    expectOk(await core.handleRequest(req('ui.confirm', { title: 'T', message: 'M' })));
  });
});

describe('EmulatorCore deny-by-default dispatch', () => {
  it('unknown method → E_UNKNOWN_METHOD, zero state change', async () => {
    const storage = new InMemoryStorage();
    const core = makeCore({ storage });
    expectErr(await core.handleRequest(req('storage.dropAll', {})), 'E_UNKNOWN_METHOD');
    expect(storage.list()).toEqual([]);
  });

  it('invalid params → E_INVALID_PARAMS, zero state change', async () => {
    const storage = new InMemoryStorage();
    const core = makeCore({ storage });
    expectErr(await core.handleRequest(req('storage.set', { key: 'k' })), 'E_INVALID_PARAMS');
    expectErr(await core.handleRequest(req('storage.set', { key: 'k', value: 'v', extra: 1 })), 'E_INVALID_PARAMS');
    expect(storage.list()).toEqual([]);
  });

  it('malformed envelope → E_INVALID_PARAMS', async () => {
    const core = makeCore();
    expectErr(await core.handleRequest('garbage'), 'E_INVALID_PARAMS');
    expectErr(await core.handleRequest({ v: 2, rpcId: 'x', method: 'storage.get', params: {} }), 'E_INVALID_PARAMS');
    expectErr(await core.handleRequest(null), 'E_INVALID_PARAMS');
  });
});

describe('EmulatorCore quota', () => {
  it('rejects a single oversized value with E_QUOTA_EXCEEDED', async () => {
    const core = makeCore();
    const big = 'x'.repeat(1024 * 1024); // key bytes push it over 1 MB
    expectErr(await core.handleRequest(req('storage.set', { key: 'big', value: big })), 'E_QUOTA_EXCEEDED');
  });

  it('enforces the quota cumulatively across keys', async () => {
    const core = makeCore();
    const chunk = 'x'.repeat(600_000);
    expectOk(await core.handleRequest(req('storage.set', { key: 'a', value: chunk })));
    expectErr(await core.handleRequest(req('storage.set', { key: 'b', value: chunk })), 'E_QUOTA_EXCEEDED');
  });

  it('replacing an existing key counts the new value, not both', async () => {
    const core = makeCore();
    const chunk = 'x'.repeat(600_000);
    expectOk(await core.handleRequest(req('storage.set', { key: 'a', value: chunk })));
    expectOk(await core.handleRequest(req('storage.set', { key: 'a', value: chunk })));
  });

  it('counts multi-byte characters as UTF-8 bytes', async () => {
    const core = makeCore();
    // 350 000 snowmen = 1 050 000 UTF-8 bytes > 1 MB.
    const snow = '☃'.repeat(350_000);
    expectErr(await core.handleRequest(req('storage.set', { key: 's', value: snow })), 'E_QUOTA_EXCEEDED');
  });
});

describe('EmulatorCore rate limiting', () => {
  it('returns E_RATE_LIMITED past the configured budget', async () => {
    const core = makeCore({ rateLimit: { calls: 3, perMs: 60_000 } });
    expectOk(await core.handleRequest(req('element.getContext')));
    expectOk(await core.handleRequest(req('element.getContext')));
    expectOk(await core.handleRequest(req('element.getContext')));
    expectErr(await core.handleRequest(req('element.getContext')), 'E_RATE_LIMITED');
  });
});

describe('EmulatorCore logging (INV-29 parity)', () => {
  it('logs every bridge call, success and failure, with timing', async () => {
    const entries: EmulatorLogEntry[] = [];
    const core = makeCore({ log: (e) => entries.push(e) });

    expectOk(await core.handleRequest(req('element.getContext')));
    expectErr(await core.handleRequest(req('no.such.method')), 'E_UNKNOWN_METHOD');
    expectErr(await core.handleRequest('garbage'), 'E_INVALID_PARAMS');

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ method: 'element.getContext', ok: true });
    expect(entries[1]).toMatchObject({ method: 'no.such.method', ok: false });
    expect(entries[2]).toMatchObject({ ok: false });
    for (const entry of entries) {
      expect(typeof entry.rpcId).toBe('string');
      expect(entry.ms).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('EmulatorCore result allowlist (INV-10 parity)', () => {
  it('strips fields the result schema does not declare', async () => {
    const core = makeCore({
      llm: {
        complete: () =>
          ({ text: 'hi', model: 'leaky', tokensUsed: 1, apiKey: 'sk-SECRET', debug: { hostPath: '/etc' } }) as never,
      },
    });
    const result = expectOk(await core.handleRequest(req('llm.complete', { prompt: 'x' })));
    expect(result).toEqual({ text: 'hi', model: 'leaky', tokensUsed: 1 });
    expect('apiKey' in result).toBe(false);
  });

  it('errors E_INTERNAL when a backend produces an invalid result shape', async () => {
    const core = makeCore({ llm: { complete: () => ({ text: 42 }) as never } });
    expectErr(await core.handleRequest(req('llm.complete', { prompt: 'x' })), 'E_INTERNAL');
  });
});

describe('EmulatorCore events', () => {
  it('makeEvent builds validated host events', () => {
    const core = makeCore();
    expect(core.makeEvent('theme-changed', { theme: 'dark' })).toEqual({
      v: 1,
      event: 'theme-changed',
      data: { theme: 'dark' },
    });
    expect(core.makeEvent('visibility-changed', { visible: false })).toEqual({
      v: 1,
      event: 'visibility-changed',
      data: { visible: false },
    });
    expect(core.makeEvent('resize', { width: 500, height: 300 })).toEqual({
      v: 1,
      event: 'resize',
      data: { width: 500, height: 300 },
    });
  });

  it('makeEvent rejects unknown events and invalid payloads', () => {
    const core = makeCore();
    expect(() => core.makeEvent('self-destruct' as never, {} as never)).toThrow();
    expect(() => core.makeEvent('theme-changed', { theme: 'plaid' } as never)).toThrow();
  });
});

describe('attachIframeHost', () => {
  it('is exported as a function (browser e2e lives in the CLI)', () => {
    expect(typeof attachIframeHost).toBe('function');
  });
});
