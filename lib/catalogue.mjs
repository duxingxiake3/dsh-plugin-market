/**
 * Catalogue discovery for the Plugin Market.
 *
 * Two sources with different jobs:
 *   - the npm registry is the *install* source: `installBundle` needs a registry
 *     spec, and published DSH plugins carry the `dsh-plugin` keyword. Search here
 *     yields an exact installable identity.
 *   - GitHub is the *presentation* source: stars, licence, README, and the
 *     developer-uploaded descriptor that supplies screenshots and long-form copy.
 *
 * The unauthenticated GitHub core API allows only 60 requests per hour per IP, so
 * per-repository metadata is fetched lazily, only for detail views, and cached.
 * raw.githubusercontent.com is a CDN and is not part of that quota, which is why
 * manifests and descriptors are read from there.
 */

import {
  TtlCache, clamp, compatibilityOf, fetchJson, fetchText, isOfficial, mapLimit, repoSlug,
} from './support.mjs';
import { isAllowedImageUrl, screenshotCandidates, verifyScreenshots } from './enrich.mjs';

const NPM_REGISTRY = 'https://registry.npmjs.org';
const NPM_SEARCH = `${NPM_REGISTRY}/-/v1/search`;
const GITHUB_API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

/** The keyword a published DSH plugin is expected to carry. */
export const MARKET_KEYWORD = 'dsh-plugin';

/** Descriptor file a plugin author can add to their repository. */
export const DESCRIPTOR_FILE = 'dsh-market.json';
/**
 * Folder the market keeps every author-supplied asset in: the descriptor, the logo and the
 * screenshots. One folder is easier to explain and easier for an author to delete.
 */
export const DESCRIPTOR_FOLDER = 'dsh-market';
export const DESCRIPTOR_FOLDER_FILE = `${DESCRIPTOR_FOLDER}/market.json`;
export const DESCRIPTOR_SCHEMA_VERSION = 1;

/**
 * Wall-clock ceiling on entry-point fetching during a risk review. A review that runs
 * long is worse than a review with less code to read: the UI can say the code was not
 * fully read, but it cannot give the user their time back.
 */
const ENTRY_FETCH_BUDGET_MS = 20_000;

/**
 * Whole-review wall-clock ceiling. A stalled GitHub makes every optional fetch — the
 * manifest chain, the repository API, the descriptor, the README — burn its own timeout,
 * and the entry budget alone left the review running for well over a minute. Optional
 * work is skipped once this passes.
 */
export const REVIEW_BUDGET_MS = 40_000;

/** Milliseconds left before a deadline, never more than `cap` and never negative. */
function remainingMs(deadline, cap) {
  return Math.max(0, Math.min(cap, deadline - Date.now()));
}

/** Cache lifetimes: catalogue listings are stale-tolerant, details less so. */
const searchCache = new TtlCache(5 * 60_000);
const manifestCache = new TtlCache(30 * 60_000);
const detailCache = new TtlCache(15 * 60_000);

/**
 * The ranked candidate pool, keyed by query alone.
 *
 * Paging must walk ONE stable order. Rebuilding the pool for every page made the pages depend
 * on the network: if one of the pool's requests failed, the pool came back shorter, every
 * later page shifted by that much, and an item appeared on two pages (or none). Caching the
 * pool by query removes that — page 2 reads the same list page 1 read — and it also turns a
 * three-page walk from thirty registry requests into ten.
 */
const poolCache = new TtlCache(5 * 60_000);

/**
 * Unverified screenshot candidates per detail key.
 *
 * The browser half asks for metadata first and pictures second, so the base record must
 * not be rebuilt — and the README must not be refetched — to satisfy the second call.
 * This holds the shortlist the base build already derived.
 */
const shotCandidates = new TtlCache(30 * 60_000);

/** @typedef {{ status: string, detail: string }} Compatibility */

/**
 * @typedef {object} MarketItem
 * @property {string} id stable key: npm name, or `gh:owner/repo`.
 * @property {'npm' | 'github'} source
 * @property {string} installSpec what to hand to pluginManager.installBundle.
 * @property {string} name npm package name or repository name.
 * @property {string} title
 * @property {string} summary
 * @property {string | null} author
 * @property {string | null} version
 * @property {boolean} official
 * @property {string | null} repository
 * @property {string | null} homepage
 * @property {string | null} license
 * @property {string | null} updatedAt
 * @property {number | null} stars
 * @property {string[]} keywords
 * @property {Compatibility | null} compatibility
 * @property {boolean} hasBundle declared `dsh.bundle.patch`.
 * @property {boolean} hasClient declared `dsh.client`.
 * @property {boolean} installedAlready
 */

/** Collapse any localised field to one string for the requested locale. */
function pickLocalized(value, locale) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    const order = locale === 'zh' ? ['zh', 'zh-CN', 'en'] : ['en', 'zh'];
    for (const key of order) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
    const first = Object.values(record).find((entry) => typeof entry === 'string');
    if (typeof first === 'string') return first;
  }
  return '';
}

/**
 * Read one package manifest from the registry, cached.
 *
 * @param {string} name npm package name.
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function npmManifest(name) {
  return /** @type {Promise<Record<string, unknown> | null>} */ (manifestCache.get(name, async () => {
    const value = await fetchJson(`${NPM_REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}/latest`);
    return value && typeof value === 'object' ? value : null;
  }));
}

/**
 * Turn one npm search object into a market item.
 *
 * @param {Record<string, any>} object
 * @param {string} locale
 * @param {string | null} runtimeVersion
 * @param {ReadonlySet<string>} installed
 * @returns {Promise<MarketItem>}
 */
/**
 * The subdirectory a package lives in, for a monorepo that publishes one folder.
 *
 * npm lets an author say `"repository": { "url": "...", "directory": "plugins/bundle" }`, and
 * when they do, the package's files are under that folder rather than at the repository root.
 * Measured on `@dfy-plugins/dsh-bundle`: it declares `plugins/bundle`, the repository has a
 * root `package.json` and no root `index.js`, and ignoring the field sent the review looking
 * for entry points that could not exist there.
 *
 * @param {Record<string, any> | null} manifest
 * @returns {string | null} normalised `a/b` path, or null when the package is at the root.
 */
function repoDirectory(manifest) {
  const raw = /** @type {any} */ (manifest?.repository);
  const value = typeof raw === 'object' && raw !== null ? raw.directory : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^\.?\//, '').replace(/\/+$/, '');
  return trimmed && !trimmed.startsWith('..') ? trimmed : null;
}

/**
 * Turn one npm search object into a market item.
 *
 * @param {Record<string, any>} object
 * @param {string} locale
 * @param {string | null} runtimeVersion
 * @param {ReadonlySet<string>} installed
 * @returns {Promise<MarketItem>}
 */
async function fromNpm(object, locale, runtimeVersion, installed) {
  const pkg = object.package ?? {};
  const name = String(pkg.name ?? '');
  const manifest = await npmManifest(name).catch(() => null);
  const dsh = /** @type {Record<string, any> | undefined} */ (manifest?.dsh);
  const repository = repoSlug(pkg.links?.repository);
  const manifestRepository = repoSlug(/** @type {any} */ (manifest?.repository)?.url ?? /** @type {any} */ (manifest?.repository));
  return {
    id: name,
    source: 'npm',
    installSpec: name,
    name,
    title: name,
    summary: clamp(pkg.description ?? pickLocalized(dsh?.summary, locale), 300),
    author: pkg.author?.name ?? pkg.publisher?.username ?? null,
    version: pkg.version ?? null,
    official: isOfficial(name, repository ?? manifestRepository),
    repository: repository ? `https://github.com/${repository}` : (pkg.links?.repository ?? null),
    // Carried so the review reads the folder the package actually lives in.
    repositoryDirectory: repoDirectory(manifest),
    homepage: pkg.links?.homepage ?? null,
    license: typeof manifest?.license === 'string' ? manifest.license : null,
    updatedAt: pkg.date ?? null,
    stars: null,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords.slice(0, 12) : [],
    compatibility: manifest ? compatibilityOf(manifest, runtimeVersion) : null,
    hasBundle: Boolean(dsh?.bundle?.patch),
    hasClient: Boolean(dsh?.client),
    installedAlready: installed.has(name),
  };
}

/**
 * Turn one GitHub repository search hit into a market item. These are repos that
 * look like DSH plugins but were not found on the registry.
 *
 * @param {Record<string, any>} repo
 * @param {string} locale
 * @param {string | null} runtimeVersion
 * @returns {Promise<MarketItem>}
 */
async function fromGithub(repo, locale, runtimeVersion) {
  const slug = String(repo.full_name ?? '');
  const manifest = await repoManifest(slug, repo.default_branch).catch(() => null);
  const dsh = /** @type {Record<string, any> | undefined} */ (manifest?.dsh);
  const name = typeof manifest?.name === 'string' && manifest.name ? manifest.name : slug.split('/')[1] ?? slug;
  return {
    id: `gh:${slug}`,
    source: 'github',
    installSpec: `github:${slug}`,
    name,
    title: name,
    summary: clamp(repo.description ?? pickLocalized(dsh?.summary, locale), 300),
    author: repo.owner?.login ?? null,
    version: typeof manifest?.version === 'string' ? manifest.version : null,
    official: isOfficial(name, slug),
    repository: repo.html_url ?? `https://github.com/${slug}`,
    // The search rows render the same logo the detail page does. Without this the GitHub
    // branch produced entries with no `logoUrl` at all, so a plugin that shows its logo on
    // its own page still showed a letter tile in the list.
    logoUrl: resolveLogoUrl(null, manifest, slug, repo.default_branch ?? 'main'),
    homepage: repo.homepage ?? null,
    license: repo.license?.spdx_id ?? null,
    updatedAt: repo.pushed_at ?? null,
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : null,
    keywords: Array.isArray(repo.topics) ? repo.topics.slice(0, 12) : [],
    compatibility: manifest ? compatibilityOf(manifest, runtimeVersion) : null,
    hasBundle: Boolean(dsh?.bundle?.patch),
    hasClient: Boolean(dsh?.client),
    installedAlready: false,
  };
}

/** Read a repository's root package.json from the CDN (no API quota). */
async function repoManifest(slug, branch) {
  const key = `manifest:${slug}:${branch ?? ''}`;
  return /** @type {Promise<Record<string, unknown> | null>} */ (manifestCache.get(key, async () => {
    for (const candidate of [branch, 'main', 'master'].filter(Boolean)) {
      // A branch that does not exist is definitive, so one attempt per branch.
      const text = await fetchText(`${RAW}/${slug}/${candidate}/package.json`, { timeoutMs: 10000, tries: 1 });
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // keep trying other branches
      }
    }
    return null;
  }));
}

/**
 * Resolve a repository's logo to a URL the browser may render.
 *
 * Shared by the detail page and the search rows on purpose: they disagreed once, and a plugin
 * that showed its logo on its own page still showed a letter tile in the list. Sources are
 * tried in the order an author would expect — an explicit descriptor `logo` beats the shipped
 * `icon` field — and the host rule is enforced here rather than at each call site.
 *
 * @param {Record<string, any> | null} descriptor parsed `dsh-market/market.json`, if any.
 * @param {Record<string, any> | null} manifest the repository's package.json, if readable.
 * @param {string | null} repository `owner/name`.
 * @param {string} branch branch the assets should be read from.
 * @returns {string | null} allowed image URL, or null when the plugin ships no usable logo.
 */
function resolveLogoUrl(descriptor, manifest, repository, branch) {
  if (!repository) return null;
  const source = (typeof descriptor?.logo === 'string' && descriptor.logo.trim())
    || (typeof manifest?.icon === 'string' && manifest.icon.trim())
    || null;
  if (!source) return null;
  const candidate = resolveAsset(source, `${RAW}/${repository}/${branch}/`);
  return candidate && isAllowedImageUrl(candidate) ? candidate : null;
}

/**
 * Largest page asked of the registry in one request. Larger `size` values stall instead of
 * returning more, and the pool is assembled from several such requests anyway.
 */
const MAX_REGISTRY_PAGE = 50;

/**
 * Score one registry hit against the words the reader typed.
 *
 * The registry's own ordering is a plain text score: its `score.detail` fields arrive
 * saturated at 1.0 for these packages, so popularity never enters into it, and a package
 * with 89k monthly downloads ranks below one with 758. What it cannot know is *where* the
 * words matched, which is the whole of relevance here — the package literally named
 * `dsh-whale-widget` must outrank one that merely mentions whales in its README blurb.
 *
 * Weights are ordered by how deliberate a match is: an exact package name beats a name
 * token, which beats a declared keyword, which beats prose in the description.
 *
 * @param {Record<string, any>} object one `/v1/search` hit.
 * @param {string[]} terms lower-cased words the reader typed.
 * @returns {number} 0 when nothing matched.
 */
function scoreHit(object, terms) {
  if (terms.length === 0) return 0;
  const pkg = object?.package ?? {};
  const name = String(pkg.name ?? '').toLowerCase();
  // A scope is publisher plumbing, not part of what the package is called.
  const bareName = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  const nameTokens = new Set(bareName.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean));
  const keywords = (Array.isArray(pkg.keywords) ? pkg.keywords : []).map((k) => String(k).toLowerCase());
  const description = String(pkg.description ?? '').toLowerCase();
  const publisher = String(pkg.publisher?.username ?? '').toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (name === term || bareName === term) score += 1000;
    else if (bareName.includes(term)) score += 300;
    else if (nameTokens.has(term)) score += 200;
    else if (keywords.some((k) => k === term)) score += 150;
    else if (keywords.some((k) => k.includes(term))) score += 60;
    else if (description.includes(term)) score += 40;
    else if (publisher.includes(term)) score += 10;
    else return 0; // every term must match somewhere, so a second word narrows
  }

  // Whole-phrase bonus, so "cost meter" prefers `dsh-cost-meter` over a package that
  // happens to contain both words far apart.
  const phrase = terms.join(' ');
  if (terms.length > 1 && (bareName.includes(terms.join('-')) || bareName.includes(phrase))) score += 250;

  // A mild, compressed popularity nudge — only ever a tie-breaker. These download counts
  // are wildly inflated across the ecosystem (the 25th percentile is 4.7k), so letting them
  // weigh more would rank whoever inflated hardest above whoever fits the query best.
  const monthly = Number(object?.downloads?.monthly ?? 0);
  score += Math.min(60, Math.log10(1 + monthly) * 8);

  // Freshness, for packages that are otherwise indistinguishable.
  const stamp = Date.parse(object?.package?.date ?? object?.updated ?? '');
  if (Number.isFinite(stamp)) {
    const days = (Date.now() - stamp) / 86_400_000;
    if (days < 30) score += 15;
    else if (days < 180) score += 8;
  }
  return score;
}

/**
 * Rank a candidate pool by relevance to the typed words, dropping everything that misses.
 *
 * Exported so the ranking can be measured against a fixed pool of real registry records
 * without spending a network round trip on every experiment.
 *
 * @param {Record<string, any>[]} objects registry hits.
 * @param {string[]} terms lower-cased words the reader typed; an empty list keeps the pool order.
 * @returns {Record<string, any>[]} best match first.
 */
export function rankHits(objects, terms) {
  if (terms.length === 0) return [...objects];
  const scored = [];
  for (const object of objects) {
    const score = scoreHit(object, terms);
    if (score > 0) scored.push({ object, score });
  }
  scored.sort((a, b) => b.score - a.score
    // Name order breaks ties so paging is stable and reproducible.
    || String(a.object?.package?.name ?? '').localeCompare(String(b.object?.package?.name ?? '')));
  return scored.map((entry) => entry.object);
}

/**
 * Search the registry for `dsh-plugin` packages, filtered and ranked by the reader's words.
 *
 * `/v1/search` cannot answer "how many match": its `total` is the size of the whole keyword
 * set and does not move with the query, so it is deliberately not returned as a result count.
 * With no query it is an honest count of the corpus, which is what the unfiltered page shows.
 *
 * Ranking happens here rather than being taken from the registry, because the registry only
 * knows *that* the words appeared, not *where*. The candidate pool is collected first and
 * then sorted, so the best match on any fetched page leads the list — the registry's own
 * order puts a package that merely mentions the word above one named after it.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {number} options.page zero-based page index into the ranked results.
 * @param {number} options.perPage
 * @param {number} [options.poolSize] candidates to rank before paging; fixed for every page.
 * @param {(url: string) => Promise<any>} [options.fetchJsonImpl] injected for tests.
 * @returns {Promise<{ items: Record<string, any>[], total: number | null, warning: string | null }>}
 */
export async function searchRegistryPage(options) {
  const {
    query = '', page = 0, perPage = 20, poolSize = 200,
    fetchJsonImpl = (url) => fetchJson(url, { timeoutMs: 20000 }),
  } = options;
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = [String(query ?? '').trim(), `keywords:${MARKET_KEYWORD}`].filter(Boolean).join(' ');

  // Without a query there is nothing to rank or filter, so one page is the answer.
  if (terms.length === 0) {
    const url = `${NPM_SEARCH}?text=${encodeURIComponent(text)}&size=${perPage}&from=${page * perPage}`;
    const result = /** @type {any} */ (await fetchJsonImpl(url));
    if (!result) return { items: [], total: null, warning: 'npm registry 检索失败或触发限流' };
    const objects = Array.isArray(result.objects) ? result.objects : [];
    return { items: objects, total: Number(result.total ?? 0), warning: null };
  }

  // Collect a fixed candidate pool, then rank it once and page through that ranking.
  //
  // The pool is cached per query and therefore IDENTICAL for every page. Two earlier
  // attempts got this wrong in different ways: growing the pool per page changed the ranking
  // between requests (page 3 ranked against a deeper pool than page 1), and rebuilding a
  // fixed-size pool per page made the pages depend on the network, so one failed request
  // shifted every later page and items repeated across pages. A cached pool is stable by
  // construction and costs the registry one walk instead of one per page.
  //
  // The registry keeps listing non-matching candidates after the matching ones run out, so
  // the pool is deep enough that a query's matches are not cut off: measurements put match
  // density at 0-8% beyond the first 250 candidates, and effectively zero past that.
  const pool = await poolCache.get(text, async () => {
    const collected = [];
    let fetchedAny = false;
    // One request per step, but never a large one: a big `perPage` must not turn the first
    // request into a 500-record fetch, which the registry answers slowly or not at all.
    const step = Math.max(1, Math.min(perPage, MAX_REGISTRY_PAGE));
    for (let offset = 0; offset < poolSize; offset += step) {
      const url = `${NPM_SEARCH}?text=${encodeURIComponent(text)}&size=${step}&from=${offset}`;
      const result = /** @type {any} */ (await fetchJsonImpl(url));
      if (!result) {
        // Nothing at all on the first request is a real failure; failing later only means the
        // candidate pool ended early.
        if (!fetchedAny) return null;
        break;
      }
      fetchedAny = true;
      const objects = Array.isArray(result.objects) ? result.objects : [];
      if (objects.length === 0) break;
      collected.push(...objects);
    }
    return fetchedAny ? collected : null;
  });
  if (!pool) return { items: [], total: null, warning: 'npm registry 检索失败或触发限流' };

  const rankedList = rankHits(pool, terms);
  const start = page * perPage;
  return {
    items: rankedList.slice(start, start + perPage),
    total: null, // the registry's total is the keyword-set size, not a match count
    warning: null,
  };
}

/**
 * Search the catalogue.
 *
 * @param {object} options
 * @param {string} [options.query] free-text query.
 * @param {'npm' | 'github' | 'all'} [options.source]
 * @param {number} [options.page] zero-based page.
 * @param {number} [options.perPage]
 * @param {string} [options.locale]
 * @param {string | null} [options.runtimeVersion]
 * @param {ReadonlySet<string>} [options.installed]
 * @returns {Promise<{ items: MarketItem[], total: number | null, page: number, perPage: number, warnings: string[] }>}
 */
export async function searchCatalog(options = {}) {
  const {
    query = '', source = 'npm', page = 0, perPage = 20, locale = 'zh',
    runtimeVersion = null, installed = new Set(),
  } = options;
  const warnings = [];
  const key = JSON.stringify({ query, source, page, perPage, runtimeVersion, installed: [...installed].sort() });
  return /** @type {any} */ (await searchCache.get(key, async () => {
    /** @type {MarketItem[]} */
    let items = [];
    /** @type {number | null} */
    let total = null;

    if (source === 'npm' || source === 'all') {
      const found = await searchRegistryPage({ query, page, perPage });
      if (found.warning) warnings.push(found.warning);
      total = found.total;
      items = await mapLimit(found.items, 4, (object) => fromNpm(object, locale, runtimeVersion, installed));
    }

    // The GitHub branch runs for `github` always, and for `all` always as well.
    //
    // It used to run for `all` only when the registry returned an incomplete page. That made
    // the default source narrower than its own label: whenever npm filled a page — which is
    // the normal case — the GitHub search never ran, so a plugin that exists on GitHub but is
    // not published to npm could not be found under "官方 + 三方" at all. It was reachable
    // only after switching the source to GitHub, which is exactly the report that led here.
    //
    // `all` is meant to be the union of both sources, so it now asks both. The cost is one
    // extra request per page, and the duplicate filter below is what keeps the union clean.
    if (source === 'github' || source === 'all') {
      // Kept narrow on purpose: a broad query returns unrelated repositories.
      const qualifier = query.trim() ? `${query.trim()} ` : '';
      const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(`${qualifier}${MARKET_KEYWORD} in:name,description,topics`)}`
        + `&sort=stars&order=desc&per_page=${perPage}&page=${page + 1}`;
      const result = /** @type {any} */ (await fetchJson(url, {
        headers: { accept: 'application/vnd.github+json' }, timeoutMs: 20000, tries: 2,
      }));
      if (!result) {
        warnings.push('GitHub 检索失败或触发限流（未认证配额为 10 次/分钟）');
      } else {
        const repositories = Array.isArray(result.items) ? result.items : [];
        const known = new Set(items.map((item) => repoSlug(item.repository)).filter(Boolean));
        const extra = await mapLimit(
          repositories.filter((repo) => !known.has(String(repo.full_name))),
          3,
          (repo) => fromGithub(repo, locale, runtimeVersion),
        );
        // GitHub's topic search does match the query, so its count is meaningful; npm's is
        // not, and `null` propagates instead of a figure that would contradict the list.
        const githubTotal = Number(result.total_count ?? 0);
        total = total === null ? githubTotal : total + githubTotal;
        items = items.concat(extra);
      }
    }

    return { items, total, page, perPage, warnings };
  }));
}

/**
 * Read the developer-uploaded descriptor, if the author ships one.
 *
 * @param {string} slug `owner/name`
 * @param {string | null} branch
 * @param {number} [deadline] epoch ms after which remaining branches are skipped.
 * @returns {Promise<{ descriptor: Record<string, any>, base: string } | null>}
 */
async function readDescriptor(slug, branch, deadline = Number.POSITIVE_INFINITY) {
  for (const candidate of [branch, 'main', 'master'].filter(Boolean)) {
    for (const name of [DESCRIPTOR_FOLDER_FILE, DESCRIPTOR_FILE]) {
      const left = remainingMs(deadline, 8000);
      if (left <= 0) return null;
      const text = await fetchText(`${RAW}/${slug}/${candidate}/${name}`, { timeoutMs: left, tries: 1 });
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          return { descriptor: parsed, base: `${RAW}/${slug}/${candidate}/` };
        }
      } catch {
        return { descriptor: { __invalid: true }, base: `${RAW}/${slug}/${candidate}/` };
      }
    }
  }
  return null;
}

/**
 * Resolve a screenshot reference to an absolute URL.
 *
 * @param {string} reference
 * @param {string} base raw.githubusercontent base for the repository.
 */
function resolveAsset(reference, base) {
  const value = String(reference ?? '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${base}${value.replace(/^\.?\//, '')}`;
}

/**
 * Full detail for one catalogue entry.
 *
 * @param {object} options
 * @param {string} options.id `id` from a search result.
 * @param {string} [options.locale]
 * @param {string | null} [options.runtimeVersion]
 * @param {number} [options.deadline] epoch ms after which optional fetches are skipped.
 * @param {boolean} [options.withScreenshots] verify and attach screenshots.
 * @returns {Promise<Record<string, any>>}
 */
export async function loadDetail(options) {
  const {
    id, locale = 'zh', runtimeVersion = null,
    deadline = Number.POSITIVE_INFINITY, withScreenshots = false,
  } = options;
  // The base record is cached without regard to screenshots, so the browser half can ask
  // for metadata first and pictures second without paying for the metadata twice.
  const base = /** @type {any} */ (await detailCache.get(`${id}:${locale}:${runtimeVersion}`, async () => {
    const isGithubId = id.startsWith('gh:');
    const name = isGithubId ? id.slice(3).split('/')[1] : id;
    const slugFromId = isGithubId ? id.slice(3) : null;

    const manifest = isGithubId ? await repoManifest(slugFromId, null) : await npmManifest(name);
    const repository = slugFromId
      ?? repoSlug(/** @type {any} */ (manifest?.repository)?.url ?? /** @type {any} */ (manifest?.repository));
    // For a monorepo publishing one folder, the package's files — and therefore its entry
    // point — are under this directory rather than at the repository root.
    const directory = repoDirectory(manifest);

    /** @type {Record<string, any> | null} */
    let repoInfo = null;
    // Stars, licence and the default branch are decoration on the detail page: fetched
    // once, never retried, and dropped entirely rather than stalling the page.
    if (repository && remainingMs(deadline, 12000) > 0) {
      repoInfo = /** @type {any} */ (await fetchJson(`${GITHUB_API}/repos/${repository}`, {
        headers: { accept: 'application/vnd.github+json' },
        timeoutMs: remainingMs(deadline, 12000), tries: 1,
      }));
    }

    const branch = repoInfo?.default_branch ?? null;
    const descriptorResult = repository && remainingMs(deadline, 8000) > 0
      ? await readDescriptor(repository, branch, deadline)
      : null;
    const descriptor = descriptorResult?.descriptor ?? null;

    // README is the fallback long-form copy when the author ships no descriptor, and the
    // source of README-embedded screenshots, so the branch that answered is remembered:
    // a relative image path only resolves against the branch the README actually came from.
    let readme = null;
    let readmeBranch = null;
    if (repository) {
      for (const candidate of [branch, 'main', 'master'].filter(Boolean)) {
        const left = remainingMs(deadline, 8000);
        if (left <= 0) break;
        // A README is long-form copy, not the decision input: without it the page still
        // renders, so a missing path is not worth a retry or a long timeout.
        readme = await fetchText(`${RAW}/${repository}/${candidate}/README.md`, { timeoutMs: left, tries: 1 });
        if (readme) {
          readmeBranch = candidate;
          break;
        }
      }
    }

    const dsh = /** @type {Record<string, any> | undefined} */ (manifest?.dsh);

    // Screenshots come from two places, author-curated first: a `dsh-market.json`
    // descriptor, then the images the author already embedded in their README. The
    // README is the source that actually pays off today — no published DSH plugin ships
    // a descriptor, but a probe found 0-153 usable README images per repository.
    //
    // Verification is opt-in because the risk review calls this same function and has no
    // use for pictures; fetching them there would only spend its deadline.
    const descriptorShots = Array.isArray(descriptor?.screenshots) && descriptorResult
      ? descriptor.screenshots
        .map((entry) => {
          const record = typeof entry === 'string' ? { url: entry } : (entry ?? {});
          const url = resolveAsset(record.url ?? record.src ?? record.path, descriptorResult.base);
          // The same host rule as README images: a descriptor must not become a way to make
          // every reader's browser announce itself to an arbitrary server.
          if (!url || !isAllowedImageUrl(url)) return null;
          return {
            url,
            caption: pickLocalized(record.caption ?? record.title, locale) || null,
          };
        })
        .filter(Boolean)
      : [];
    const readmeShots = readme && repository
      ? screenshotCandidates(readme, repository, readmeBranch ?? 'main')
      : [];
    // Stashed for the enrich pass; the base record itself carries no pictures.
    shotCandidates.set(`${id}:${locale}:${runtimeVersion}`, [...descriptorShots, ...readmeShots]);
    const screenshots = [];

    // One identity for both the search card and this page: the repository name is only a
    // fallback, because a package published under a scope would otherwise show a
    // different name on the card than on its own detail page.
    const packageName = typeof manifest?.name === 'string' && manifest.name ? manifest.name : name;
    const official = isOfficial(packageName, repository);

    // The author's own logo, when they ship one. `icon` in package.json is the shipped field
    // the official Plugins page already reads, so honouring it costs an author nothing; a
    // `logo` in the descriptor wins when they want the market to differ. It is not fetched
    // here: the browser renders it and falls back to the letter tile if it fails.
    const logoUrl = resolveLogoUrl(descriptor, manifest, repository, readmeBranch ?? branch ?? 'main');

    return {
      id,
      name: packageName,
      title: pickLocalized(descriptor?.displayName, locale) || packageName,
      version: typeof manifest?.version === 'string' ? manifest.version : null,
      official,
      logoUrl,
      installSpec: isGithubId ? `github:${slugFromId}` : name,
      summary: pickLocalized(descriptor?.summary, locale) || clamp(manifest?.description ?? '', 400),
      description: pickLocalized(descriptor?.description, locale) || null,
      developer: {
        name: pickLocalized(descriptor?.developer?.name, locale)
          || (typeof manifest?.author === 'string' ? manifest.author : manifest?.author?.name)
          || repoInfo?.owner?.login || null,
        url: descriptor?.developer?.url ?? repoInfo?.owner?.html_url ?? null,
        avatar: repoInfo?.owner?.avatar_url ?? null,
      },
      repository: repository ? `https://github.com/${repository}` : null,
      repositoryDirectory: directory,
      homepage: descriptor?.homepage ?? manifest?.homepage ?? repoInfo?.homepage ?? null,
      license: (typeof descriptor?.license === 'string' ? descriptor.license : null)
        ?? (typeof manifest?.license === 'string' ? manifest.license : null)
        ?? repoInfo?.license?.spdx_id ?? null,
      stars: typeof repoInfo?.stargazers_count === 'number' ? repoInfo.stargazers_count : null,
      openIssues: typeof repoInfo?.open_issues_count === 'number' ? repoInfo.open_issues_count : null,
      archived: Boolean(repoInfo?.archived),
      pushedAt: repoInfo?.pushed_at ?? null,
      createdAt: repoInfo?.created_at ?? null,
      topics: Array.isArray(repoInfo?.topics) ? repoInfo.topics : [],
      compatibility: manifest ? compatibilityOf(manifest, runtimeVersion) : { status: 'unknown', detail: '未取得包清单' },
      capabilities: {
        bundle: Boolean(dsh?.bundle?.patch),
        client: Boolean(dsh?.client),
        clientPlatform: dsh?.client?.platform ?? null,
      },
      // Surfaced so the risk review and the user both see what an install will run.
      installScripts: Object.fromEntries(
        Object.entries(/** @type {Record<string, string>} */ (manifest?.scripts ?? {}))
          .filter(([key]) => /^(pre|post)?install$|^prepare$/.test(key)),
      ),
      dependencies: Object.keys(/** @type {Record<string, string>} */ (manifest?.dependencies ?? {})).slice(0, 40),
      descriptor: descriptor && !descriptor.__invalid
        ? { present: true, schemaVersion: descriptor.schemaVersion ?? null, categories: descriptor.categories ?? [] }
        : { present: false, invalid: Boolean(descriptor?.__invalid) },
      screenshots,
      readme: readme ? clamp(readme, 12000) : null,
    };
  }));

  if (!withScreenshots) return base;
  return {
    ...base,
    screenshots: await attachScreenshots(base, { deadline, key: `${id}:${locale}:${runtimeVersion}` }),
  };
}

/**
 * Verify and attach the screenshots a base detail record's README pointed at.
 *
 * Split out from `loadDetail` so the browser half can render metadata immediately and
 * fill pictures in afterwards: verifying images costs a fetch each, and a slow image host
 * must not hold up the whole page.
 *
 * @param {Record<string, any>} detail base record from `loadDetail`.
 * @param {{ deadline?: number, key?: string }} [options]
 * @returns {Promise<Array<{ url: string, caption: string | null, width: number, height: number }>>}
 */
export async function attachScreenshots(detail, options = {}) {
  const { deadline = Date.now() + 15_000, key } = options;
  const candidates = (key ? shotCandidates.peek(key) : undefined) ?? [];
  if (candidates.length === 0) return [];
  const verified = await verifyScreenshots(candidates, { deadline });
  return verified.map((shot) => ({
    url: shot.url,
    caption: shot.caption,
    width: shot.width,
    height: shot.height,
  }));
}

/** Resolve a dependency-free module name to the file a repository would hold. */
function resolveRelativeEntry(base, target) {
  if (typeof target !== 'string' || !target) return null;
  if (/^https?:/i.test(target)) return null;
  if (target.startsWith('.')) return target;
  const directory = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  return `./${directory}${target}`;
}

/**
 * Collect the JavaScript entry paths a manifest points at: `main`, `module`, `browser`,
 * and every string leaf of `exports`, resolved relative to each subpath key.
 *
 * @param {Record<string, any> | null} manifest
 * @returns {string[]}
 */
function entryPathsOf(manifest) {
  if (!manifest) return [];
  const out = [];
  for (const key of ['main', 'module', 'browser']) {
    const value = manifest[key];
    if (typeof value === 'string') out.push(value.startsWith('.') ? value : `./${value}`);
  }
  const walk = (node, base) => {
    if (typeof node === 'string') {
      const resolved = resolveRelativeEntry(base, node);
      if (resolved) out.push(resolved);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        // Subpath keys such as "./lib/*" describe a file, so treat them as the base.
        const nextBase = key.startsWith('./') && !key.includes('*') ? key : base;
        walk(child, nextBase);
      }
    }
  };
  walk(manifest.exports, './index.js');
  return out;
}

/**
 * The official catalogue: the plugin bundles this DSH installation itself supplies.
 *
 * A keyword search cannot find these — the vendor's published packages carry no npm
 * keywords at all (verified against the registry), so nothing would ever earn the
 * "official" label. Reading them from the installation is both accurate and the only
 * source that is guaranteed to be populated.
 *
 * @param {any} pluginManager
 * @param {{ locale?: string, runtimeVersion?: string | null }} [options]
 * @returns {Promise<MarketItem[]>}
 */
export async function officialCatalog(pluginManager, options = {}) {
  const { locale = 'zh', runtimeVersion = null } = options;
  const bundles = await pluginManager.listBundles();
  /** @type {MarketItem[]} */
  const items = [];
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    const name = bundle?.name;
    if (typeof name !== 'string' || !name) continue;
    // Only the vendor's own scope carries the green label.
    if (!name.startsWith('@deepseek-ai/')) continue;
    const rows = Array.isArray(bundle.rows) ? bundle.rows : [];
    items.push({
      id: `official:${name}`,
      source: 'official',
      installSpec: name,
      name,
      title: pickLocalized(bundle.meta?.title, locale) || name,
      summary: clamp(
        pickLocalized(bundle.meta?.description, locale) || bundle.description || '',
        300,
      ),
      author: 'DeepSeek',
      version: typeof bundle.version === 'string' ? bundle.version : null,
      official: true,
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
      homepage: null,
      license: null,
      updatedAt: null,
      stars: null,
      keywords: [],
      compatibility: {
        status: 'compatible',
        detail: runtimeVersion ? `随当前 DSH ${runtimeVersion} 一同提供` : '随当前 DSH 一同提供',
      },
      hasBundle: rows.length > 0,
      hasClient: false,
      installedAlready: Boolean(bundle.installed),
    });
  }
  return items;
}

/**
 * Detail for one official bundle, assembled from the installation rather than the
 * network: name, version, supplied rows, and whether the profile selected it.
 *
 * @param {any} pluginManager
 * @param {string} name bundle package name.
 * @param {{ locale?: string, runtimeVersion?: string | null }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function officialDetail(pluginManager, name, options = {}) {
  const { locale = 'zh', runtimeVersion = null } = options;
  const bundles = await pluginManager.listBundles();
  const bundle = (Array.isArray(bundles) ? bundles : []).find((entry) => entry?.name === name) ?? null;
  const rows = Array.isArray(bundle?.rows) ? bundle.rows : [];
  return {
    id: `official:${name}`,
    name,
    title: pickLocalized(bundle?.meta?.title, locale) || name,
    version: typeof bundle?.version === 'string' ? bundle.version : null,
    official: true,
    installSpec: name,
    summary: pickLocalized(bundle?.meta?.description, locale) || bundle?.description || '',
    description: bundle?.description ?? null,
    developer: { name: 'DeepSeek', url: 'https://github.com/deepseek-ai', avatar: null },
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    homepage: null,
    license: null,
    stars: null,
    openIssues: null,
    archived: false,
    pushedAt: null,
    createdAt: null,
    topics: [],
    compatibility: {
      status: 'compatible',
      detail: runtimeVersion ? `随当前 DSH ${runtimeVersion} 一同提供` : '随当前 DSH 一同提供',
    },
    capabilities: { bundle: rows.length > 0, client: false, clientPlatform: null },
    installScripts: {},
    dependencies: [],
    descriptor: { present: false, invalid: false },
    screenshots: [],
    readme: null,
    installedAlready: Boolean(bundle?.installed),
    // Official bundles need no install review; the client disables the action.
    rows: rows.map((row) => ({
      id: row?.rowId ?? null,
      moduleName: row?.moduleName ?? null,
      title: pickLocalized(row?.meta?.title, locale) || row?.rowId || row?.moduleName || null,
      enabled: typeof row?.entryId === 'string',
    })),
    enabled: Boolean(bundle?.enabled),
    optional: Boolean(bundle?.optional),
    problem: bundle?.error?.code ?? null,
  };
}

/**
 * Everything the risk review needs about one candidate, gathered from public sources.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {string | null} [options.runtimeVersion]
 * @param {number} [options.budgetMs] whole-review wall-clock ceiling.
 * @returns {Promise<{ subject: Record<string, any>, evidence: string, metadata: string, code: string, codeFiles: number, sources: string[], truncated: boolean }>}
 */
export async function collectEvidence(options) {
  const budgetMs = Number.isFinite(options?.budgetMs) ? Number(options.budgetMs) : REVIEW_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  // The detail lookup runs under the same deadline, so a stalled host cannot spend the
  // whole budget on decoration before the entry code is even attempted.
  const detail = await loadDetail({ ...options, deadline });
  const repository = repoSlug(detail.repository);
  const metadataChunks = [];
  const codeChunks = [];
  const sources = [];
  let truncated = false;

  const push = (bucket, label, content, budget) => {
    if (!content) return;
    const text = String(content);
    if (text.length > budget) truncated = true;
    bucket.push(`### ${label}\n${clamp(text, budget)}`);
  };

  // Manifests go in the metadata bucket: their repository/homepage URLs are
  // descriptive, not network calls, and must not be read as code signals.
  push(metadataChunks, 'package.json', JSON.stringify({
    name: detail.name,
    version: detail.version,
    scripts: detail.installScripts,
    dependencies: detail.dependencies,
    repository: detail.repository,
  }, null, 2), 3000);

  if (repository) {
    const manifest = await repoManifest(repository, null);
    if (manifest) push(metadataChunks, 'repository package.json', JSON.stringify(manifest, null, 2), 4000);
    sources.push(`https://github.com/${repository}`);

    // Review the code that is actually in the repository.
    //
    // The manifest describes the *published* package, and that is not what the repository
    // holds. Measured on real plugins: `michengai/dsh-archive-manager` declares
    // `main: lib/index.js`, but the repository has no `lib/` at all — it has `src/index.ts`,
    // and `lib/` is written by the build and never committed. `liustack/modsearch` likewise
    // keeps its entry at `src/main.ts`. Ordering the candidates by the manifest alone
    // therefore missed the file that exists in favour of one that cannot, and because the
    // list was truncated, the source paths were never reached.
    //
    // So committed source is tried first, then the declared paths, then build output. A 404
    // on raw.githubusercontent costs no API quota and comes back quickly, so the candidate
    // list can be generous; the wall-clock deadline below is the real bound.
    //
    // When npm says the package lives in a subdirectory, that prefix is tried first with the
    // root kept as a fallback — the field is occasionally stale, and a wrong prefix should
    // not cost the review the code it could otherwise read.
    const sub = typeof detail.repositoryDirectory === 'string' && detail.repositoryDirectory
      ? `${detail.repositoryDirectory.replace(/\/+$/, '')}/`
      : null;
    const candidatesAt = (prefix) => [
      // Committed source, most likely first. These are what a repository actually contains.
      `${prefix}src/index.ts`,
      `${prefix}src/index.mts`,
      `${prefix}src/index.mjs`,
      `${prefix}src/main.ts`,
      `${prefix}src/plugin.ts`,
      `${prefix}index.ts`,
      `${prefix}index.mjs`,
      `${prefix}index.js`,
      // What the manifest declares: correct whenever the build output is committed.
      ...entryPathsOf(manifest).map((entry) => `${prefix}${entry.replace(/^\.\//, '')}`),
      // Committed build output, for repositories that do commit it.
      `${prefix}lib/index.js`,
      `${prefix}lib/index.mjs`,
      `${prefix}dist/index.js`,
      `${prefix}dist/index.mjs`,
      `${prefix}src/index.js`,
      // Host and client halves kept in their own directories, which is how the plugins that
      // publish `lib/host/index.js` are laid out.
      `${prefix}lib/host/index.js`,
      `${prefix}src/host/index.ts`,
      `${prefix}host/index.js`,
      `${prefix}lib/client/index.js`,
      `${prefix}lib/client.js`,
    ];
    const entryCandidates = (sub ? [...candidatesAt(sub), ...candidatesAt('')] : candidatesAt(''))
      // `package.json` is metadata, not code: counting it as reviewed code would hide the
      // very gap this list exists to close. It belongs in the metadata bucket, which is
      // filled separately above.
      .filter((entry) => !/package\.json$/i.test(entry))
      .slice(0, 16);
    // Entry fetching gets whatever is left of the review budget, capped so the model
    // still has time to run after the code is gathered.
    const entryDeadline = Math.min(deadline, Date.now() + ENTRY_FETCH_BUDGET_MS);
    const seen = new Set();
    let budget = 14000;
    for (const entry of entryCandidates) {
      if (budget <= 0 || seen.has(entry)) continue;
      const remaining = entryDeadline - Date.now();
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      seen.add(entry);
      for (const branch of ['main', 'master']) {
        // Cap each request by what is left of the budget, so the whole search ends at
        // the deadline instead of one request period past it.
        const left = entryDeadline - Date.now();
        if (left <= 0) break;
        const text = await fetchText(`${RAW}/${repository}/${branch}/${entry.replace(/^\.\//, '')}`, {
          // A 404 means the path is simply wrong; retrying only spends the budget.
          timeoutMs: Math.min(8000, left), tries: 1,
        });
        if (!text) continue;
        const slice = clamp(text, Math.min(budget, 8000));
        if (text.length > slice.length) truncated = true;
        budget -= slice.length;
        push(codeChunks, `entry ${entry} @${branch}`, slice, 8000);
        sources.push(`${RAW}/${repository}/${branch}/${entry.replace(/^\.\//, '')}`);
        break;
      }
    }
  }

  const metadata = metadataChunks.join('\n\n');
  const code = codeChunks.join('\n\n');

  return {
    subject: {
      id: detail.id,
      name: detail.name,
      version: detail.version,
      official: detail.official,
      repository: detail.repository,
      installSpec: detail.installSpec,
      compatibility: detail.compatibility,
      installScripts: detail.installScripts,
    },
    evidence: [metadata, code].filter(Boolean).join('\n\n'),
    metadata,
    code,
    codeFiles: codeChunks.length,
    sources,
    truncated,
  };
}
