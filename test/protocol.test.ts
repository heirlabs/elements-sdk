import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  EVENT_TABLE,
  METHOD_NAMES,
  METHOD_TABLE,
  PERMISSIONS,
  RESERVED_SCOPE_PREFIXES,
  hostEventSchema,
  isKnownEvent,
  isKnownMethod,
  rpcRequestSchema,
  rpcResponseSchema,
  type MethodName,
} from '../src/protocol.js';

interface Sample {
  params: unknown;
  badParams: unknown;
  result: unknown;
}

const SAMPLES: Record<MethodName, Sample> = {
  'element.getContext': {
    params: {},
    badParams: { extra: 1 },
    result: {
      elementId: 'com.example.app',
      installId: 'inst-1',
      version: '1.0.0',
      locale: 'en-US',
      theme: 'light',
      viewport: { w: 400, h: 600 },
      deskVersion: '3.0.0',
    },
  },
  'storage.get': { params: { key: 'k' }, badParams: {}, result: { value: null } },
  'storage.set': { params: { key: 'k', value: 'v' }, badParams: { key: 'k', value: 5 }, result: {} },
  'storage.delete': { params: { key: 'k' }, badParams: { key: 1 }, result: {} },
  'storage.list': { params: { prefix: 'p' }, badParams: { prefix: 4 }, result: { keys: ['a', 'b'] } },
  'ui.setTitle': { params: { title: 'My Element' }, badParams: { title: 3 }, result: {} },
  'ui.requestResize': {
    params: { width: 300, height: 400 },
    badParams: { width: -1, height: 400 },
    result: { width: 300, height: 400 },
  },
  'ui.toast': { params: { message: 'saved' }, badParams: { message: '' }, result: {} },
  'ui.confirm': {
    params: { title: 'Reset?', message: 'This clears local data.' },
    badParams: { title: 'Reset?' },
    result: { confirmed: true },
  },
  'ui.openExternal': {
    params: { url: 'https://example.com/docs' },
    badParams: { url: 'not-a-url' },
    result: { opened: false },
  },
  'clipboard.writeText': { params: { text: 'copy me' }, badParams: {}, result: {} },
  'llm.complete': {
    params: { prompt: 'say hi', maxTokens: 64, temperature: 0.2 },
    badParams: { prompt: '' },
    result: { text: 'hi', model: 'stub', tokensUsed: 3 },
  },
};

describe('method table', () => {
  it('is closed at exactly the 12 spec methods', () => {
    expect(METHOD_NAMES.sort()).toEqual(
      [
        'element.getContext',
        'storage.get',
        'storage.set',
        'storage.delete',
        'storage.list',
        'ui.setTitle',
        'ui.requestResize',
        'ui.toast',
        'ui.confirm',
        'ui.openExternal',
        'clipboard.writeText',
        'llm.complete',
      ].sort(),
    );
  });

  for (const method of Object.keys(SAMPLES) as MethodName[]) {
    const sample = SAMPLES[method];
    const def = METHOD_TABLE[method];

    it(`${method}: params round-trip`, () => {
      expect(def.params.safeParse(sample.params).success).toBe(true);
      expect(def.params.safeParse(sample.badParams).success).toBe(false);
    });

    it(`${method}: result round-trip and unknown-field stripping`, () => {
      const parsed = def.result.safeParse(sample.result);
      expect(parsed.success).toBe(true);
      const withExtra = def.result.safeParse({ ...(sample.result as object), sneaky: 'x' });
      expect(withExtra.success).toBe(true);
      expect(withExtra.success && 'sneaky' in (withExtra.data as object)).toBe(false);
    });
  }

  it('rejects unknown methods', () => {
    expect(isKnownMethod('estate.read')).toBe(false);
    expect(isKnownMethod('storage.getAll')).toBe(false);
    expect(isKnownMethod('storage.get')).toBe(true);
  });
});

describe('wire envelopes', () => {
  it('accepts a valid request envelope', () => {
    const parsed = rpcRequestSchema.safeParse({ v: 1, rpcId: 'abc', method: 'storage.get', params: { key: 'k' } });
    expect(parsed.success).toBe(true);
  });

  it('accepts an unknown-method envelope (dispatch rejects it, not the envelope)', () => {
    const parsed = rpcRequestSchema.safeParse({ v: 1, rpcId: 'abc', method: 'nope.nope', params: {} });
    expect(parsed.success).toBe(true);
    expect(isKnownMethod('nope.nope')).toBe(false);
  });

  it('rejects malformed envelopes', () => {
    expect(rpcRequestSchema.safeParse({ v: 2, rpcId: 'abc', method: 'storage.get', params: {} }).success).toBe(false);
    expect(rpcRequestSchema.safeParse({ v: 1, method: 'storage.get', params: {} }).success).toBe(false);
    expect(rpcRequestSchema.safeParse({ v: 1, rpcId: '', method: 'storage.get', params: {} }).success).toBe(false);
    expect(rpcRequestSchema.safeParse('not an object').success).toBe(false);
  });

  it('accepts ok and error response envelopes', () => {
    expect(rpcResponseSchema.safeParse({ v: 1, rpcId: 'a', ok: true, result: {} }).success).toBe(true);
    expect(
      rpcResponseSchema.safeParse({
        v: 1,
        rpcId: 'a',
        ok: false,
        error: { code: 'E_PERMISSION_DENIED', message: 'no' },
      }).success,
    ).toBe(true);
    expect(
      rpcResponseSchema.safeParse({ v: 1, rpcId: 'a', ok: false, error: { code: 'E_MADE_UP', message: 'no' } }).success,
    ).toBe(false);
  });

  it('accepts host event envelopes', () => {
    expect(hostEventSchema.safeParse({ v: 1, event: 'theme-changed', data: { theme: 'dark' } }).success).toBe(true);
    expect(hostEventSchema.safeParse({ v: 1, event: '', data: {} }).success).toBe(false);
  });
});

describe('host events', () => {
  it('validates each event payload', () => {
    expect(EVENT_TABLE['theme-changed'].safeParse({ theme: 'dark' }).success).toBe(true);
    expect(EVENT_TABLE['theme-changed'].safeParse({ theme: 'blue' }).success).toBe(false);
    expect(EVENT_TABLE['visibility-changed'].safeParse({ visible: true }).success).toBe(true);
    expect(EVENT_TABLE['visibility-changed'].safeParse({ visible: 'yes' }).success).toBe(false);
    expect(EVENT_TABLE['resize'].safeParse({ width: 300, height: 200 }).success).toBe(true);
    expect(EVENT_TABLE['resize'].safeParse({ width: 0, height: 200 }).success).toBe(false);
  });

  it('knows exactly the three spec events', () => {
    expect(isKnownEvent('theme-changed')).toBe(true);
    expect(isKnownEvent('visibility-changed')).toBe(true);
    expect(isKnownEvent('resize')).toBe(true);
    expect(isKnownEvent('navigate')).toBe(false);
  });
});

describe('constants', () => {
  it('pins the api version and closed permission set', () => {
    expect(API_VERSION).toBe('heir-element-api@1');
    expect([...PERMISSIONS]).toEqual(['storage.element', 'notifications', 'clipboard.write', 'llm.completion']);
    expect([...RESERVED_SCOPE_PREFIXES]).toEqual([
      'estate.',
      'identity.',
      'wallet.',
      'auth.',
      'payments.',
      'settings.',
      'agent.',
      'pol.',
    ]);
  });
});
