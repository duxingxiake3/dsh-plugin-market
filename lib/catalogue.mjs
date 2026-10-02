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
 * Does one registry hit actually say what the reader typed?
 *
 * The registry's `keywords:` qualifier defines the *candidate set*; the typed words are only
 * a ranking hint on top of it, so past the first few hits the results stop matching. This is
 * what turns that ranking hint into a filter. Every word must appear somewhere the reader can
 * see — name, description, keywords, or publisher — so a two-word query narrows rather than
 * widens.
 *
 * @param {Record<string, any>} object one `/v1/search` hit.
 * @param {string[]} terms lower-cased words the reader typed.
 */
function hitsQueryText(object, terms) {
  if (terms.length === 0) return true;
  const pkg = object?.package ?? {};
  const haystack = [
    pkg.name ?? '',
    pkg.description ?? '',
    Array.isArray(pkg.keywords) ? pkg.keywords.join(' ') : '',
    pkg.publisher?.username ?? '',
  ].join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * One page of registry results, filtered by the reader's words.
 *
 * `/v1/search` cannot answer "how many match": its `total` is the size of the whole keyword
 * set and does not move with the query — asking for `whale keywords:dsh-plugin` and for
 * `keywords:dsh-plugin` both report 6572. Returning that as a result count is what made the
 * page footer claim thousands of matches for a query that had a handful. The count is
 * therefore returned only when there is no query, where it honestly describes the corpus.
 *
 * Because the registry keeps listing non-matching candidates after the matching ones run
 * out, several requests may be needed to fill one page. The walk stops the moment it has
 * enough, so a query with plenty of hits costs exactly one request and only a rare one costs
 * more.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {number} options.page zero-based page index into the filtered results.
 * @param {number} options.perPage
 * @param {number} [options.maxPages] ceiling on registry requests for one page of results.
 * @param {(url: string) => Promise<any>} [options.fetchJsonImpl] injected for tests.
 * @returns {Promise<{ items: Record<string, any>[], total: number | null, warning: string | null }>}
 */
export async function searchRegistryPage(options) {
  const {
    query = '', page = 0, perPage = 20, maxPages = 6,
    fetchJsonImpl = (url) => fetchJson(url, { timeoutMs: 20000 }),
  } = options;
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = [String(query ?? '').trim(), `keywords:${MARKET_KEYWORD}`].filter(Boolean).join(' ');

  let count = null;
  // Pages before the requested one may have been consumed by filtered-out candidates, so the
  // walk always starts at the registry's first page and counts matches itself.
  let skip = page * perPage;
  const items = [];
  let offset = 0;

  for (let fetched = 0; fetched < maxPages && items.length < perPage; fetched += 1) {
    const url = `${NPM_SEARCH}?text=${encodeURIComponent(text)}&size=${perPage}&from=${offset}`;
    const result = /** @type {any} */ (await fetchJsonImpl(url));
    if (!result) {
      // Nothing on the first request is a real failure; running out later only means the
      // results end here.
      if (fetched === 0) return { items: [], total: null, warning: 'npm registry 检索失败或触发限流' };
      break;
    }
    if (fetched === 0) count = Number(result.total ?? 0);
    const objects = Array.isArray(result.objects) ? result.objects : [];
    if (objects.length === 0) break;
    for (const object of objects) {
      if (!hitsQueryText(object, terms)) continue;
      if (skip > 0) { skip -= 1; continue; }
      items.push(object);
      if (items.length >= perPage) break;
    }
    offset += objects.length;
  }

  return { items, total: terms.length === 0 ? count : null, warning: null };
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

    if (source === 'github' || (source === 'all' && items.length < perPage)) {
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
    const logoSource = (typeof descriptor?.logo === 'string' && descriptor.logo.trim())
      || (typeof manifest?.icon === 'string' && manifest.icon.trim())
      || null;
    const logoBase = `${RAW}/${repository ?? ''}/${readmeBranch ?? branch ?? 'main'}/`;
    const logoCandidate = logoSource && repository ? resolveAsset(logoSource, logoBase) : null;
    const logoUrl = logoCandidate && isAllowedImageUrl(logoCandidate) ? logoCandidate : null;

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

    // Review the declared entry points. Publishers place them in many shapes
    // (`main`, `module`, `exports`, or a plain conventional path), and a metadata-only
    // review is worth much less, so the candidate list is deliberately broad.
    //
    // The broad list is bounded three ways, because a missing path costs a full request
    // and a rate-limited host makes every one of them slow: candidates are capped, a
    // missing path is never retried, and a wall-clock deadline ends the search. Without
    // those bounds a user pressing install could wait minutes for the review to appear.
    const entryCandidates = [
      ...entryPathsOf(manifest),
      './index.js',
      './index.mjs',
      './lib/index.js',
      './lib/index.mjs',
      './dist/index.js',
      './dist/index.mjs',
      './src/index.js',
      './src/index.ts',
    ].slice(0, 6);
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
