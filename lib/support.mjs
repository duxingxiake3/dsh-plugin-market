/**
 * Shared host-side helpers for the Plugin Market.
 *
 * Deliberately dependency-free: the bundle is installed from a local directory as
 * a build-free package, so it must not rely on any npm dependency being resolved.
 */

/** Markers used by the market UI to label provenance. */
export const OFFICIAL_NPM_SCOPE = '@deepseek-ai/';
export const OFFICIAL_GITHUB_ORG = 'deepseek-ai';

const DEFAULT_UA = 'dsh-plugin-market/1.0 (+local profile bundle)';

/**
 * One bounded HTTP request with retries. GitHub and raw.githubusercontent both
 * flake under parallel load, so a couple of retries is cheaper than a failed card.
 *
 * @param {string} url absolute URL.
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, tries?: number, accept?: string }} [options]
 * @returns {Promise<{ ok: true, status: number, text: string } | { ok: false, status?: number, error: string }>}
 */
export async function request(url, options = {}) {
  const { headers = {}, timeoutMs = 15000, tries = 3 } = options;
  let last = { ok: false, error: 'not attempted' };
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': DEFAULT_UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (response.status === 404) return { ok: false, status: 404, error: 'not found' };
      if (!response.ok) {
        last = { ok: false, status: response.status, error: `HTTP ${response.status}` };
        // 4xx other than rate limiting will not improve on retry.
        if (response.status < 500 && response.status !== 403 && response.status !== 429) return last;
      } else {
        return { ok: true, status: response.status, text: await response.text() };
      }
    } catch (error) {
      last = { ok: false, error: String(error?.message ?? error) };
    }
    if (attempt < tries - 1) await sleep(300 * (attempt + 1));
  }
  return last;
}

/**
 * Fetch and parse JSON, tolerating a non-JSON body.
 *
 * @param {string} url absolute URL.
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, tries?: number }} [options]
 * @returns {Promise<unknown | null>} parsed value, or null when unavailable.
 */
export async function fetchJson(url, options) {
  const result = await request(url, { ...options, headers: { accept: 'application/json', ...options?.headers } });
  if (!result.ok) return null;
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

/**
 * Fetch text, returning null instead of throwing.
 *
 * @param {string} url absolute URL.
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, tries?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function fetchText(url, options) {
  const result = await request(url, options);
  return result.ok ? result.text : null;
}

/**
 * Fetch bytes under a hard size cap, returning null instead of throwing.
 *
 * Used to confirm that a screenshot URL actually resolves to a real image before the UI
 * offers it, and to read its intrinsic dimensions. `content-length` is treated as a hint
 * only: a response without it is still read, then rejected if it overruns the cap.
 *
 * @param {string} url absolute URL.
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<Uint8Array | null>}
 */
export async function fetchBytes(url, options = {}) {
  const { headers = {}, timeoutMs = 10000, maxBytes = 512 * 1024, tries = 2 } = options;
  let last = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': DEFAULT_UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        // A retry only helps on a transient failure, and an image host flaking is exactly
        // that; without it one dropped connection would silently lose a good screenshot.
        last = null;
      } else {
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (Number.isFinite(declared) && declared > maxBytes) return null;
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return null;
        return new Uint8Array(buffer);
      }
    } catch {
      last = null;
    }
    if (attempt < tries - 1) await sleep(250 * (attempt + 1));
  }
  return last;
}

/**
 * Fetch only the leading bytes of a resource and stop.
 *
 * Reading a header should not cost a whole download: a real SVG screenshot in the wild
 * was 530 KB, which is far more than the numbers needed to size it.
 *
 * @param {string} url absolute URL.
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<Uint8Array | null>}
 */
export async function fetchPrefix(url, options = {}) {
  const { headers = {}, timeoutMs = 10000, maxBytes = 8192 } = options;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': DEFAULT_UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!response.ok) return null;
      if (!response.body) {
        const whole = new Uint8Array(await response.arrayBuffer());
        return whole.subarray(0, maxBytes);
      }
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      // The rest of the body is not needed; release the connection instead of draining it.
      try {
        await reader.cancel();
      } catch {
        // Already closed by the peer.
      }
      const out = new Uint8Array(Math.min(total, maxBytes));
      let offset = 0;
      for (const chunk of chunks) {
        if (offset >= out.length) break;
        const take = Math.min(chunk.byteLength, out.length - offset);
        out.set(chunk.subarray(0, take), offset);
        offset += take;
      }
      return out;
    } catch {
      // Retry once: image hosts flake, and a transient failure would lose a good picture.
    }
    if (attempt === 0) await sleep(250);
  }
  return null;
}

/**
 * Read intrinsic dimensions from an image header without decoding it.
 *
 * A URL that 200s is not proof of a picture: dead links, HTML error pages and 1x1
 * tracking pixels all pass a plain fetch. Parsing the header is what lets the market
 * keep only real screenshots.
 *
 * @param {Uint8Array} bytes
 * @returns {{ format: 'png' | 'gif' | 'jpeg' | 'webp', width: number, height: number } | null}
 */
export function imageDimensions(bytes) {
  if (!bytes || bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then an IHDR chunk with width/height as u32 big-endian.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: "GIF87a"/"GIF89a", then width/height as u16 little-endian.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { format: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // JPEG: walk the marker chain to the first SOFn frame header.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return { format: 'jpeg', width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + length;
    }
    return null;
  }
  // WebP: RIFF container; VP8X carries 24-bit canvas size, VP8/VP8L their own layouts.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8X') {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { format: 'webp', width, height };
    }
    if (chunk === 'VP8 ') {
      return { format: 'webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { format: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  return null;
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded-concurrency map. Keeps GitHub/raw request pressure predictable.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        out[index] = await worker(items[index], index);
      } catch (error) {
        out[index] = /** @type {R} */ (/** @type {unknown} */ ({ error: String(error?.message ?? error) }));
      }
    }
  });
  await Promise.all(runners);
  return out;
}

/** A tiny TTL cache so repeat views do not re-hit the network. */
export class TtlCache {
  /** @param {number} ttlMs */
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    /** @type {Map<string, { at: number, value: unknown }>} */
    this.entries = new Map();
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} produce
   * @returns {Promise<T>}
   */
  async get(key, produce) {
    const hit = this.entries.get(key);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return /** @type {T} */ (hit.value);
    const value = await produce();
    this.entries.set(key, { at: now, value });
    if (this.entries.size > 400) {
      for (const [k, v] of this.entries) {
        if (now - v.at >= this.ttlMs) this.entries.delete(k);
      }
    }
    return value;
  }

  clear() {
    this.entries.clear();
  }

  /** Store a value directly, for callers that compute it outside a `get` producer. */
  set(key, value) {
    this.entries.set(key, { at: Date.now(), value });
  }

  /** Read without producing: returns undefined on a miss or an expired entry. */
  peek(key) {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.ttlMs) return undefined;
    return hit.value;
  }
}

/** Trim a string to a byte-ish budget, appending an explicit marker. */
export function clamp(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

/** Extract `owner/name` from any common GitHub URL form. */
export function repoSlug(url) {
  const value = String(url ?? '').trim();
  if (!value) return null;
  const match = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(value);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`;
}

/** True when the package is published by the DSH vendor. */
export function isOfficial(packageName, repo) {
  if (typeof packageName === 'string' && packageName.startsWith(OFFICIAL_NPM_SCOPE)) return true;
  const slug = repoSlug(repo);
  return Boolean(slug && slug.toLowerCase().startsWith(`${OFFICIAL_GITHUB_ORG}/`));
}

/* ------------------------------------------------------------------ *
 * Minimal semver range evaluation.
 *
 * The authoritative compatibility check is performed by DSH itself inside
 * pluginManager.installBundle; this exists only so a card can say something
 * useful before the user commits to an install.
 * ------------------------------------------------------------------ */

/** @param {string} value */
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** @param {ReturnType<typeof parseVersion>} a @param {ReturnType<typeof parseVersion>} b */
function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNum = /^\d+$/.test(left);
    const rightNum = /^\d+$/.test(right);
    if (leftNum && rightNum) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Evaluate one comparator such as `^0.1.7`, `>=1.2`, `1.x` or `*`.
 *
 * @param {string} comparator
 * @param {ReturnType<typeof parseVersion>} version
 */
function testComparator(comparator, version) {
  const raw = comparator.trim();
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'latest') return true;
  const match = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?/.exec(raw);
  if (!match) return null; // unparseable → caller reports "unknown"
  const [, operator = '=', majorRaw, minorRaw, patchRaw, prerelease] = match;
  const base = parseVersion(`${majorRaw}.${minorRaw && /[xX*]/.test(minorRaw) ? '0' : (minorRaw ?? '0')}.${patchRaw && /[xX*]/.test(patchRaw) ? '0' : (patchRaw ?? '0')}${prerelease ? `-${prerelease}` : ''}`);
  if (!base) return null;
  const wildcardMinor = minorRaw === undefined || /[xX*]/.test(minorRaw);
  const wildcardPatch = patchRaw === undefined || /[xX*]/.test(patchRaw);
  const order = compare(version, base);

  switch (operator) {
    case '>=':
      return order >= 0;
    case '>':
      return order > 0;
    case '<=':
      return order <= 0;
    case '<':
      return order < 0;
    case '^': {
      if (order < 0) return false;
      if (base.major > 0) return version.major === base.major;
      if (base.minor > 0) return version.major === 0 && version.minor === base.minor;
      return version.major === 0 && version.minor === 0 && version.patch === base.patch;
    }
    case '~': {
      if (order < 0) return false;
      if (wildcardMinor) return version.major === base.major;
      return version.major === base.major && version.minor === base.minor;
    }
    default: {
      if (wildcardMinor) return version.major === base.major;
      if (wildcardPatch) return version.major === base.major && version.minor === base.minor;
      return order === 0;
    }
  }
}

/**
 * Check a version against a range expression.
 *
 * Standard semver excludes prereleases from ranges that do not mention one, which
 * would report the DSH release-candidate runtime as incompatible with `^0.1.7`.
 * A prerelease whose release tuple satisfies the range is therefore reported as
 * `prerelease` rather than a flat failure, so the UI can say "verify manually"
 * instead of claiming a mismatch.
 *
 * @param {string} version
 * @param {string} range
 * @returns {{ status: 'compatible' | 'incompatible' | 'prerelease' | 'unknown', detail: string }}
 */
export function checkRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return { status: 'unknown', detail: `无法解析版本 ${version}` };

  /**
   * @param {ReturnType<typeof parseVersion>} candidate
   * @returns {'match' | 'nomatch' | 'unknown'}
   */
  const evaluate = (candidate) => {
    let sawUnparseable = false;
    for (const alternative of String(range).split('||')) {
      const comparators = alternative.trim().split(/\s+/).filter(Boolean);
      if (comparators.length === 0) continue;
      let all = true;
      let anyNull = false;
      for (const comparator of comparators) {
        const result = testComparator(comparator, candidate);
        if (result === null) { anyNull = true; break; }
        if (!result) { all = false; break; }
      }
      if (anyNull) { sawUnparseable = true; continue; }
      if (all) return 'match';
    }
    return sawUnparseable ? 'unknown' : 'nomatch';
  };

  const direct = evaluate(parsed);
  if (direct === 'match') {
    return { status: parsed.prerelease.length ? 'prerelease' : 'compatible', detail: range };
  }
  if (parsed.prerelease.length) {
    // A prerelease of a satisfying release is a "verify manually", not a mismatch.
    const releaseOnly = { ...parsed, prerelease: [] };
    if (evaluate(releaseOnly) === 'match') return { status: 'prerelease', detail: range };
  }
  if (direct === 'unknown') return { status: 'unknown', detail: `无法解析版本范围 ${range}` };
  return { status: 'incompatible', detail: `当前 DSH ${version} 不满足 ${range}` };
}

/**
 * Decide compatibility from a package manifest.
 *
 * @param {Record<string, unknown>} pkg
 * @param {string | null} runtimeVersion
 * @returns {{ status: 'compatible' | 'incompatible' | 'prerelease' | 'unknown' | 'undeclared', detail: string }}
 */
export function compatibilityOf(pkg, runtimeVersion) {
  if (!runtimeVersion) return { status: 'unknown', detail: '无法确定当前 DSH 版本' };
  const declared = /** @type {Record<string, unknown> | undefined} */ (pkg?.dsh)?.compatibility;
  let range = null;
  let source = '';
  if (typeof declared === 'string') {
    range = declared;
    source = 'dsh.compatibility';
  } else if (declared && typeof declared === 'object') {
    const record = /** @type {Record<string, unknown>} */ (declared);
    const candidate = record.dsh ?? record['@deepseek-ai/dsh'] ?? record.harness;
    if (typeof candidate === 'string') {
      range = candidate;
      source = 'dsh.compatibility';
    }
  }
  if (!range) {
    const peers = /** @type {Record<string, string> | undefined} */ (pkg?.peerDependencies);
    if (peers) {
      const candidate = peers['@deepseek-ai/dsh'] ?? peers['@deepseek-ai/dsh-base'];
      if (typeof candidate === 'string') {
        range = candidate;
        source = 'peerDependencies';
      }
    }
  }
  if (!range) return { status: 'undeclared', detail: '作者未声明兼容范围，安装时由 DSH 强制校验' };
  const verdict = checkRange(runtimeVersion, range);
  return { ...verdict, detail: `${source}: ${range}${verdict.status === 'incompatible' ? ` — ${verdict.detail}` : ''}` };
}
