/**
 * Static bundle scanner — environment-agnostic (no Node APIs, browser-safe).
 *
 * Single source of truth for the review-assist scan: the CLI (`heir-element
 * validate` / `pack`) and the registry run the exact same checks by feeding
 * bundle files into `scanBundle`. Mirrors the server-side checks in plan
 * section 4.1 step 4 — review-assist; the CSP is the actual boundary.
 */

export interface Finding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file: string;
  line: number;
}

export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

const HIGH_ENTROPY_THRESHOLD = 4.5;
const HIGH_ENTROPY_MIN_LENGTH = 40;
// Hex encoding tops out at 4 bits/char, so a random hex key never reaches the
// 4.5 general threshold. A near-full-alphabet hex run above 3.2 is the
// common raw-private-key shape (64 hex chars ~ entropy 3.9-4.0).
const HEX_ENTROPY_THRESHOLD = 3.2;
const TIGHT_LOOP_MS = 250;
const BASE64_BLOB_BYTES = 100 * 1024;

const JS_FILE_RE = /\.(?:js|mjs|cjs)$/i;
const HTML_FILE_RE = /\.html?$/i;

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

interface PatternCheck {
  re: RegExp;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/** Text-level checks applied to both JS and HTML (inline scripts) content. */
const TEXT_CHECKS: PatternCheck[] = [
  {
    re: /\beval\s*\(/g,
    severity: 'error',
    code: 'E_EVAL',
    message: 'eval() is forbidden in element bundles',
  },
  {
    re: /\bnew\s+Function\b/g,
    severity: 'error',
    code: 'E_EVAL',
    message: 'new Function() is forbidden in element bundles',
  },
  {
    re: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g,
    severity: 'error',
    code: 'E_EVAL',
    message: 'string-argument setTimeout/setInterval is forbidden (implicit eval)',
  },
  {
    re: /\bdocument\s*\.\s*cookie\b/g,
    severity: 'error',
    code: 'E_OPAQUE_STORAGE',
    message: 'document.cookie throws in the opaque-origin sandbox; use the bridge storage API',
  },
  {
    re: /\blocalStorage\b/g,
    severity: 'error',
    code: 'E_OPAQUE_STORAGE',
    message: 'localStorage throws in the opaque-origin sandbox; use the bridge storage API',
  },
  {
    re: /\bsessionStorage\b/g,
    severity: 'error',
    code: 'E_OPAQUE_STORAGE',
    message: 'sessionStorage throws in the opaque-origin sandbox; use the bridge storage API',
  },
  {
    re: /\bindexedDB\b/g,
    severity: 'error',
    code: 'E_OPAQUE_STORAGE',
    message: 'indexedDB throws in the opaque-origin sandbox; use the bridge storage API',
  },
  {
    re: /\bcaches\s*[.[]/g,
    severity: 'error',
    code: 'E_OPAQUE_STORAGE',
    message: 'the Cache API is unavailable in the opaque-origin sandbox',
  },
  {
    re: /\bnavigator\s*\.\s*serviceWorker\b/g,
    severity: 'error',
    code: 'E_SERVICE_WORKER',
    message: 'service workers are forbidden in element bundles',
  },
  {
    re: /\b(?:import\s*\(\s*|import\s+|from\s*)["'](?:https?:)?\/\//g,
    severity: 'error',
    code: 'E_REMOTE_CODE',
    message: 'importing code from a URL is forbidden (all code must ship in the bundle)',
  },
  {
    re: /\bwindow\s*\.\s*(?:top|parent)\b/g,
    severity: 'warning',
    code: 'W_FRAME_ESCAPE',
    message: 'window.top/window.parent access is a frame-escape smell; elements must use the bridge',
  },
];

// Blank out string/template literals and comments (preserving length and
// newlines) so structural scans don't trip on braces or code-like text inside
// them. Template interpolations are blanked with their literal — acceptable
// for the warning-severity heuristics that use this.
function stripLiteralsAndComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const pair = src.slice(i, i + 2);
    let end: number;
    if (pair === '//') {
      const nl = src.indexOf('\n', i);
      end = nl === -1 ? src.length : nl;
    } else if (pair === '/*') {
      const close = src.indexOf('*/', i + 2);
      end = close === -1 ? src.length : close + 2;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length && src.charAt(j) !== ch) j += src.charAt(j) === '\\' ? 2 : 1;
      end = Math.min(j + 1, src.length);
    } else {
      out += ch;
      i += 1;
      continue;
    }
    out += src.slice(i, end).replace(/[^\n]/g, ' ');
    i = end;
  }
  return out;
}

function matchingBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code.charAt(i) === '{') depth += 1;
    else if (code.charAt(i) === '}' && (depth -= 1) === 0) return i;
  }
  return code.length;
}

// requestAnimationFrame is only a mining/jank signal when it re-schedules — a
// one-shot rAF (layout read, animation kick) is legitimate. Flag a file when
// it has two or more rAF call sites (kickoff + loop), or when a lone
// rAF(callback) sits inside the body of the very function it passes (the
// minimal self-rescheduling loop).
function scanRafLoops(rel: string, content: string, findings: Finding[]): void {
  const code = stripLiteralsAndComments(content);
  const calls = [...code.matchAll(/\brequestAnimationFrame\s*\(\s*([A-Za-z_$][\w$]*)?/g)];
  if (calls.length === 0) return;
  const warn = (index: number, message: string) =>
    findings.push({ severity: 'warning', code: 'W_TIGHT_LOOP', message, file: rel, line: lineOf(content, index) });

  if (calls.length >= 2) {
    warn(
      calls[0]?.index ?? 0,
      `${calls.length} requestAnimationFrame call sites; frame-rate loop (< ${TIGHT_LOOP_MS} ms) — possible mining/jank pattern`,
    );
    return;
  }

  const call = calls[0];
  const id = call?.[1];
  if (!call || !id) return;
  const callIndex = call.index ?? 0;
  const escaped = id.split('$').join('\\$');
  const declRe = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(|\\b(?:const|let|var)\\s+${escaped}\\s*=`, 'g');
  for (const decl of code.matchAll(declRe)) {
    const declEnd = (decl.index ?? 0) + decl[0].length;
    const firstBrace = code.indexOf('{', declEnd);
    const firstSemi = code.indexOf(';', declEnd);
    const arrow = decl[0].startsWith('function') ? -1 : code.indexOf('=>', declEnd);
    const arrowLeads =
      arrow !== -1 && (firstBrace === -1 || arrow < firstBrace) && (firstSemi === -1 || arrow < firstSemi);
    let bodyStart: number;
    let bodyEnd: number;
    if (arrowLeads) {
      let k = arrow + 2;
      while (k < code.length && /\s/.test(code.charAt(k))) k += 1;
      if (code.charAt(k) === '{') {
        bodyStart = k;
        bodyEnd = matchingBrace(code, k);
      } else {
        // concise arrow body: runs to the end of the statement
        bodyStart = arrow;
        bodyEnd = firstSemi === -1 ? code.length : firstSemi;
      }
    } else {
      if (firstBrace === -1) continue;
      bodyStart = firstBrace;
      bodyEnd = matchingBrace(code, firstBrace);
    }
    if (callIndex > bodyStart && callIndex < bodyEnd) {
      warn(
        callIndex,
        `requestAnimationFrame(${id}) re-schedules inside ${id}'s own body; frame-rate loop (< ${TIGHT_LOOP_MS} ms) — possible mining/jank pattern`,
      );
      return;
    }
  }
}

function scanText(rel: string, content: string, findings: Finding[]): void {
  for (const check of TEXT_CHECKS) {
    check.re.lastIndex = 0;
    for (const match of content.matchAll(check.re)) {
      findings.push({
        severity: check.severity,
        code: check.code,
        message: check.message,
        file: rel,
        line: lineOf(content, match.index ?? 0),
      });
    }
  }

  // setInterval with a numeric-literal interval under 250 ms. The callback
  // may contain one level of nested parens (arrow/function callbacks).
  for (const match of content.matchAll(/\bsetInterval\s*\((?:[^,()]|\([^()]*\))*,\s*(\d+)\s*[,)]/g)) {
    const interval = Number(match[1]);
    if (interval < TIGHT_LOOP_MS) {
      findings.push({
        severity: 'warning',
        code: 'W_TIGHT_LOOP',
        message: `setInterval every ${interval} ms (< ${TIGHT_LOOP_MS} ms); possible mining/jank pattern`,
        file: rel,
        line: lineOf(content, match.index ?? 0),
      });
    }
  }

  scanRafLoops(rel, content, findings);

  // Large inline base64 blobs (> 100 KB contiguous).
  for (const match of content.matchAll(/[A-Za-z0-9+/]{102400,}={0,2}/g)) {
    findings.push({
      severity: 'warning',
      code: 'W_BASE64_BLOB',
      message: `inline base64 blob of ${(match[0] as string).length} chars (> ${BASE64_BLOB_BYTES} bytes)`,
      file: rel,
      line: lineOf(content, match.index ?? 0),
    });
  }
}

/**
 * High-entropy token scan. Quoted-string extraction on minified bundles is
 * unreliable (quotes inside regex literals produce giant bogus "strings"), so
 * the secret smell is detected as unbroken base64/hex-ish token runs instead:
 * over 40 chars of [A-Za-z0-9+/=_-] with Shannon entropy above 4.5, outside
 * any URL (URLs are covered by the endpoint allowlist check). Pure-hex runs
 * get a lower threshold (see HEX_ENTROPY_THRESHOLD) because hex encoding
 * caps entropy at 4 bits/char.
 */
function scanEntropyTokens(rel: string, content: string, urlSpans: Array<[number, number]>, findings: Finding[]): void {
  const inUrl = (start: number, end: number): boolean =>
    urlSpans.some(([s, e]) => start < e && end > s);
  for (const match of content.matchAll(/[A-Za-z0-9+/=_-]{41,}/g)) {
    const value = match[0] as string;
    const start = match.index ?? 0;
    if (inUrl(start, start + value.length)) continue;
    const entropy = shannonEntropy(value);
    if (entropy > HIGH_ENTROPY_THRESHOLD) {
      findings.push({
        severity: 'warning',
        code: 'W_HIGH_ENTROPY',
        message: `high-entropy string literal (entropy ${entropy.toFixed(2)}, ${value.length} chars) — embedded key/secret smell`,
        file: rel,
        line: lineOf(content, start),
      });
    } else if (
      entropy > HEX_ENTROPY_THRESHOLD &&
      /^[0-9a-fA-F]+$/.test(value) &&
      /\d/.test(value) &&
      /[a-fA-F]/.test(value)
    ) {
      // Hex-encoded keys (the most common raw-key encoding) cap at 4 bits of
      // entropy per char and would sail under the general threshold.
      findings.push({
        severity: 'warning',
        code: 'W_HIGH_ENTROPY',
        message: `high-entropy hex string literal (entropy ${entropy.toFixed(2)}, ${value.length} chars) — embedded key/secret smell`,
        file: rel,
        line: lineOf(content, start),
      });
    }
  }
}

const URL_RE = /(?:https?|wss?):\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:[/?#][^\s'"`<>()\\]*)?/g;

function findUrlSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of content.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    spans.push([start, start + (match[0] as string).length]);
  }
  return spans;
}

function scanUrls(rel: string, content: string, declared: ReadonlySet<string>, findings: Finding[]): void {
  URL_RE.lastIndex = 0;
  for (const match of content.matchAll(URL_RE)) {
    const url = match[0] as string;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      continue;
    }
    // DOCUMENTED SPEC DEVIATION: the SPEC table reads every ws(s) URL whose
    // origin is not in manifest.endpoints as an error, and endpoints can only
    // hold https origins — so under the strict letter every wss URL errors.
    // We instead accept a wss URL whose host matches a declared https origin,
    // mirroring CSP/Fetch ws->https scheme normalization (the runtime CSP
    // treats them as the same origin). wss to an UNDECLARED host still errors.
    const httpsEquivalent = origin.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    if (declared.has(origin) || declared.has(httpsEquivalent)) continue;
    findings.push({
      severity: 'error',
      code: 'E_UNDECLARED_URL',
      message: `network URL '${url}' has origin ${origin}, which is not in manifest.endpoints`,
      file: rel,
      line: lineOf(content, match.index ?? 0),
    });
  }
}

function scanHtml(rel: string, content: string, findings: Finding[]): void {
  // Remote <script src>.
  for (const match of content.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']+)["'][^>]*>/gi)) {
    findings.push({
      severity: 'error',
      code: 'E_REMOTE_CODE',
      message: `remote script '${match[1]}' is forbidden (all code must ship in the bundle)`,
      file: rel,
      line: lineOf(content, match.index ?? 0),
    });
  }

  // Hidden iframes: srcdoc, display:none/visibility:hidden, or zero-size.
  for (const match of content.matchAll(/<iframe\b[^>]*>/gi)) {
    const tag = match[0] as string;
    const reasons: string[] = [];
    if (/\bsrcdoc\s*=/i.test(tag)) reasons.push('srcdoc');
    if (/style\s*=\s*["'][^"']*display\s*:\s*none/i.test(tag)) reasons.push('display:none');
    if (/style\s*=\s*["'][^"']*visibility\s*:\s*hidden/i.test(tag)) reasons.push('visibility:hidden');
    if (/\b(?:width|height)\s*=\s*["']?0(?:px)?["'\s>]/i.test(tag)) reasons.push('zero-size');
    if (/style\s*=\s*["'][^"']*\b(?:width|height)\s*:\s*0(?:px)?\b/i.test(tag)) reasons.push('zero-size');
    if (reasons.length > 0) {
      findings.push({
        severity: 'error',
        code: 'E_HIDDEN_IFRAME',
        message: `hidden iframe (${[...new Set(reasons)].join(', ')}) — concealed embedding is forbidden`,
        file: rel,
        line: lineOf(content, match.index ?? 0),
      });
    }
  }
}

/** Compressed-size cap check (spec: compressed bundle > 5 MB is an error). */
export function checkBundleSize(sizeBytes: number): Finding | null {
  if (sizeBytes <= MAX_BUNDLE_BYTES) return null;
  return {
    severity: 'error',
    code: 'E_BUNDLE_SIZE',
    message: `compressed bundle is ${sizeBytes} bytes (cap ${MAX_BUNDLE_BYTES})`,
    file: 'bundle.tar.gz',
    line: 1,
  };
}

/** Declared endpoint origins (`manifest.endpoints[].origin`), extracted defensively. */
export function declaredOrigins(manifest: Record<string, unknown>): Set<string> {
  const origins = new Set<string>();
  const endpoints = manifest.endpoints;
  if (Array.isArray(endpoints)) {
    for (const ep of endpoints) {
      if (typeof ep === 'object' && ep !== null && typeof (ep as { origin?: unknown }).origin === 'string') {
        origins.add((ep as { origin: string }).origin);
      }
    }
  }
  return origins;
}

export interface ScanBundleInput {
  /** Bundle-relative path → file contents (Uint8Array contents decoded as UTF-8). */
  files: Record<string, string | Uint8Array>;
  /** Parsed manifest object; `entry` and `endpoints[].origin` are consulted. */
  manifest: Record<string, unknown>;
  /** Compressed (.tar.gz) bundle size; when given, the 5 MB cap is enforced. */
  gzSizeBytes?: number;
}

export interface ScanBundleResult {
  /** True when the scan produced zero error-severity findings. */
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
}

const decoder = /* @__PURE__ */ new TextDecoder();

function asText(content: string | Uint8Array): string {
  return typeof content === 'string' ? content : decoder.decode(content);
}

/**
 * Static scan of a built bundle held in memory. Environment-agnostic: the CLI
 * feeds it the staging dir contents; the registry feeds it the unpacked
 * upload. Review-assist only — the CSP is the actual boundary.
 */
export function scanBundle(input: ScanBundleInput): ScanBundleResult {
  const { files, manifest, gzSizeBytes } = input;
  const findings: Finding[] = [];
  const declared = declaredOrigins(manifest);
  const entry = typeof manifest.entry === 'string' ? manifest.entry : '';
  const paths = Object.keys(files).sort();

  if (!Object.prototype.hasOwnProperty.call(files, entry)) {
    findings.push({
      severity: 'error',
      code: 'E_ENTRY_MISSING',
      message: `manifest entry '${entry}' is missing from the built bundle`,
      file: entry,
      line: 1,
    });
  }

  for (const rel of paths.filter((p) => JS_FILE_RE.test(p))) {
    const content = asText(files[rel] as string | Uint8Array);
    scanText(rel, content, findings);
    scanEntropyTokens(rel, content, findUrlSpans(content), findings);
    scanUrls(rel, content, declared, findings);
  }

  for (const rel of paths.filter((p) => HTML_FILE_RE.test(p))) {
    const content = asText(files[rel] as string | Uint8Array);
    scanText(rel, content, findings);
    scanEntropyTokens(rel, content, findUrlSpans(content), findings);
    scanUrls(rel, content, declared, findings);
    scanHtml(rel, content, findings);
  }

  if (gzSizeBytes !== undefined) {
    const sizeFinding = checkBundleSize(gzSizeBytes);
    if (sizeFinding !== null) findings.push(sizeFinding);
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}
