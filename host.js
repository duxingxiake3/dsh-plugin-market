/**
 * Plugin Market — Host half.
 *
 * Answers one exact Fetch route on the authenticated `/api` channel, driven by the
 * browser half:
 *
 *   catalog/search   browse the catalogue (official bundles, npm registry, GitHub)
 *   catalog/detail   one plugin's full detail page payload
 *   risk/review      deterministic scan + model review, and the install ticket
 *   install/run      install a package, only with a ticket from risk/review
 *   meta             runtime facts the UI needs (DSH version, model, capabilities)
 *
 * The install path is deliberately two-step. `install/run` refuses any request that
 * does not carry a ticket previously issued by `risk/review`, so the review cannot be
 * skipped by calling the route directly. Build scripts are never auto-approved:
 * when pnpm blocks them the pending names are returned for a separate confirmation.
 */

import { randomUUID } from 'node:crypto';

import { collectEvidence, loadDetail, officialCatalog, officialDetail, searchCatalog, MARKET_KEYWORD } from './lib/catalogue.mjs';
import { ENRICH_BUDGET_MS, TranslationStore, targetLanguage, translateBatch, translateDetail, translateItems } from './lib/enrich.mjs';
import { combineRisk, modelReview, prescan } from './lib/review.mjs';

/**
 * Exact Fetch route on the authenticated `/api` channel. The segment after `/api`
 * must match `/^[A-Za-z0-9_$.-]+$/`, and the connection plugin rejects any path that
 * does not resolve to one.
 */
const ROUTE = '/api/dsh-plugin-market';

/** How long a risk report remains usable as an install ticket. */
const TICKET_TTL_MS = 30 * 60_000;

/** @type {Map<string, { id: string, risk: string, at: number }>} */
const tickets = new Map();

/** Optional GitHub token, which lifts the unauthenticated 10 searches/minute limit. */
function githubToken() {
  const value = process.env.DSH_MARKET_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Bundle names this profile already has installed, used to mark cards.
 *
 * @param {any} pluginManager
 * @returns {Promise<Set<string>>}
 */
async function installedNames(pluginManager) {
  try {
    const bundles = await pluginManager.listBundles();
    return new Set((Array.isArray(bundles) ? bundles : []).map((bundle) => bundle?.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * The running DSH version, read from the bundles the installation itself supplies.
 *
 * @param {any} pluginManager
 * @returns {Promise<string | null>}
 */
async function runtimeVersion(pluginManager) {
  try {
    const bundles = await pluginManager.listBundles();
    const list = Array.isArray(bundles) ? bundles : [];
    const preferred = list.find((bundle) => bundle?.name === '@deepseek-ai/dsh-base')
      ?? list.find((bundle) => typeof bundle?.name === 'string' && bundle.name.startsWith('@deepseek-ai/dsh'));
    return preferred?.version ? String(preferred.version) : null;
  } catch {
    return null;
  }
}

/** The model used for the security review, falling back to the configured default. */
function reviewSelection(ctx) {
  const service = ctx.get('agentDefaultModel');
  try {
    const selection = service?.currentSelection?.();
    if (selection?.provider && selection?.model) {
      return {
        provider: String(selection.provider),
        model: String(selection.model),
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
    }
  } catch {
    // fall through to the unset selection, reported to the UI as a capability gap
  }
  return { provider: '', model: '' };
}

/** Issue an install ticket after a completed review. */
function issueTicket(id, risk) {
  const reportId = randomUUID();
  tickets.set(reportId, { id, risk, at: Date.now() });
  for (const [key, value] of tickets) {
    if (Date.now() - value.at > TICKET_TTL_MS) tickets.delete(key);
  }
  return reportId;
}

/**
 * Host plugin body.
 *
 * The browser half reaches these endpoints through `connection.fetch.register`,
 * mounted under the `/api` prefix that the connection plugin already wraps in its
 * Host/Origin fence and browser-cookie authentication. `connection.rpc.handle` was the
 * obvious first choice but is unusable from a feature plugin here: it registers its
 * route on the connection service's own context, which injects `webRuntime` rather
 * than `webServer`, so the registration throws "cannot get property webServer without
 * inject" before the plugin ever activates.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // One durable cache for machine translations, shared by every request. It is keyed by a
  // hash of the source string, so an author editing their description is what triggers a
  // fresh model call — nothing else does.
  const translations = new TranslationStore();
  ctx.effect(() => {
    translations.load();
    return () => {};
  }, 'plugin-market: translation cache');

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let envelope = null;
      try {
        envelope = await request.json();
      } catch {
        envelope = null;
      }
      const endpoint = typeof envelope?.endpoint === 'string' ? envelope.endpoint : '';
      const result = await dispatch(ctx, endpoint, envelope?.payload, request.signal, translations);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    },
  }), 'plugin-market: catalogue route');
}

/**
 * Route one request to its handler. Always resolves to the `{ ok, value | error }`
 * envelope the browser half unwraps.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} endpoint
 * @param {unknown} payload
 * @param {AbortSignal} [signal] ends a long review when the page goes away.
 * @param {TranslationStore} translations durable cache of machine translations.
 * @returns {Promise<Record<string, unknown>>}
 */
async function dispatch(ctx, endpoint, payload, signal, translations) {
  const manager = ctx.get('pluginManager');
  const input = payload && typeof payload === 'object' ? payload : {};
  const locale = input.locale === 'en' ? 'en' : 'zh';

  try {
    if (!manager) {
      return {
        ok: false,
        error: { code: 'market/unavailable', message: '当前 profile 没有 pluginManager 服务', details: {} },
      };
    }

      switch (endpoint) {
        case 'meta': {
          const selection = reviewSelection(ctx);
          await translations.load();
          return {
            ok: true,
            value: {
              runtimeVersion: await runtimeVersion(manager),
              keyword: MARKET_KEYWORD,
              model: selection.model || null,
              provider: selection.provider || null,
              githubToken: Boolean(githubToken()),
              locale,
              // Whether translations can be produced at all, and how many strings are
              // already cached, so the UI can be honest about English-only cards.
              translationAvailable: Boolean(selection.model && selection.provider),
              translationTarget: targetLanguage(locale),
              translationCached: translations.entries.size,
              translationPersisted: Boolean(translations.file),
            },
          };
        }

        case 'catalog/search': {
          const version = await runtimeVersion(manager);
          const installed = await installedNames(manager);
          const source = ['npm', 'github', 'all', 'official'].includes(input.source) ? input.source : 'npm';

          // Official plugins never appear in a registry keyword search, so they are
          // read from the installation itself rather than the network.
          if (source === 'official') {
            const items = await officialCatalog(manager, { locale, runtimeVersion: version });
            const needle = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
            const filtered = needle
              ? items.filter((item) => `${item.title} ${item.name} ${item.summary}`.toLowerCase().includes(needle))
              : items;
            return { ok: true, value: { items: filtered, total: filtered.length, page: 0, perPage: filtered.length, warnings: [], runtimeVersion: version } };
          }

          const result = await searchCatalog({
            query: typeof input.query === 'string' ? input.query : '',
            source,
            page: Number.isFinite(input.page) ? Math.max(0, Number(input.page)) : 0,
            perPage: Number.isFinite(input.perPage) ? Math.min(40, Math.max(4, Number(input.perPage))) : 20,
            locale,
            runtimeVersion: version,
            installed,
          });

          // Authors publish in English and will not write Chinese copy, so the visible
          // page is translated once and cached; cached strings cost nothing on later views.
          const selection = reviewSelection(ctx);
          const enriched = await translateItems({
            ctx,
            selection,
            items: result.items,
            store: translations,
            locale,
            deadline: Date.now() + ENRICH_BUDGET_MS,
          });
          return {
            ok: true,
            value: {
              ...result,
              items: enriched.items,
              runtimeVersion: version,
              translation: enriched.meta,
            },
          };
        }

        case 'catalog/detail': {
          if (typeof input.id !== 'string' || !input.id) {
            return { ok: false, error: { code: 'market/bad-request', message: '缺少 id', details: {} } };
          }
          const version = await runtimeVersion(manager);
          if (input.id.startsWith('official:')) {
            const detail = await officialDetail(manager, input.id.slice('official:'.length), { locale, runtimeVersion: version });
            return { ok: true, value: detail };
          }
          const installed = await installedNames(manager);
          // Phase one: metadata only. Pictures are verified in `catalog/enrich`, so a slow
          // image host cannot delay the page the user is waiting for.
          const detail = await loadDetail({
            id: input.id,
            locale,
            runtimeVersion: version,
            withScreenshots: false,
            deadline: Date.now() + ENRICH_BUDGET_MS,
          });
          const selection = reviewSelection(ctx);
          const enriched = await translateDetail({
            ctx,
            selection,
            detail,
            store: translations,
            locale,
            deadline: Date.now() + ENRICH_BUDGET_MS,
          });
          return {
            ok: true,
            value: { ...enriched.detail, installedAlready: installed.has(enriched.detail.name), translation: enriched.meta },
          };
        }

        case 'catalog/enrich': {
          // Phase two: screenshots, plus translated captions for them.
          if (typeof input.id !== 'string' || !input.id) {
            return { ok: false, error: { code: 'market/bad-request', message: '缺少 id', details: {} } };
          }
          if (input.id.startsWith('official:')) {
            return { ok: true, value: { screenshots: [], translation: { skipped: true } } };
          }
          const version = await runtimeVersion(manager);
          const detail = await loadDetail({
            id: input.id,
            locale,
            runtimeVersion: version,
            withScreenshots: true,
            deadline: Date.now() + ENRICH_BUDGET_MS,
          });
          let screenshots = detail.screenshots ?? [];
          let translation = { target: targetLanguage(locale), translated: 0, cached: 0 };
          const target = targetLanguage(locale);
          const entries = screenshots
            .map((shot, index) => ({ id: `cap${index}`, text: shot.caption }))
            .filter((entry) => entry.text);
          if (target && entries.length > 0) {
            const result = await translateBatch({
              ctx,
              selection: reviewSelection(ctx),
              entries,
              store: translations,
              target,
              deadline: Date.now() + 10_000,
            });
            translation = {
              target,
              translated: result.translated,
              cached: result.cached,
              skipped: result.skipped,
              error: result.error,
            };
            screenshots = screenshots.map((shot, index) => {
              const caption = result.translations.get(`cap${index}`);
              return caption ? { ...shot, captionTranslated: caption } : shot;
            });
          }
          return { ok: true, value: { screenshots, translation } };
        }

        case 'risk/review': {
          if (typeof input.id !== 'string' || !input.id) {
            return { ok: false, error: { code: 'market/bad-request', message: '缺少 id', details: {} } };
          }
          if (input.id.startsWith('official:')) {
            return {
              ok: false,
              error: { code: 'market/already-present', message: '官方插件随 DSH 一同提供，无需安装', details: {} },
            };
          }
          const version = await runtimeVersion(manager);
          const gathered = await collectEvidence({ id: input.id, runtimeVersion: version });
          const deterministic = prescan(gathered.metadata, gathered.code);
          const selection = reviewSelection(ctx);
          const reviewed = await modelReview({
            ctx, selection, subject: gathered.subject, evidence: gathered.evidence, signal,
          });
          const risk = combineRisk(deterministic.ceiling, reviewed.verdict);
          const reportId = issueTicket(input.id, risk);
          return {
            ok: true,
            value: {
              reportId,
              subject: gathered.subject,
              risk,
              deterministic,
              model: reviewed.verdict,
              modelError: reviewed.error,
              modelUsed: selection.model || null,
              evidence: {
                bytes: gathered.evidence.length,
                sources: gathered.sources,
                truncated: gathered.truncated,
              },
              requireConfirmation: true,
            },
          };
        }

        case 'install/run': {
          const reportId = typeof input.reportId === 'string' ? input.reportId : '';
          const ticket = tickets.get(reportId);
          if (!ticket || Date.now() - ticket.at > TICKET_TTL_MS) {
            return {
              ok: false,
              error: {
                code: 'market/no-ticket',
                message: '没有有效的风险审查凭据，请先执行风险检查',
                details: {},
              },
            };
          }
          if (ticket.id !== input.id) {
            return {
              ok: false,
              error: { code: 'market/ticket-mismatch', message: '凭据与插件不匹配', details: {} },
            };
          }
          if (input.confirmed !== true) {
            return {
              ok: false,
              error: { code: 'market/not-confirmed', message: '缺少用户确认', details: {} },
            };
          }
          const detail = await loadDetail({ id: input.id, locale, runtimeVersion: await runtimeVersion(manager) });
          const approvedBuilds = Array.isArray(input.approvedBuilds)
            ? input.approvedBuilds.filter((value) => typeof value === 'string')
            : [];
          const result = await manager.installBundle(detail.installSpec, {
            enabled: true,
            ...(approvedBuilds.length ? { approvedBuilds } : {}),
          });
          // A ticket is single-use: a retry must go through review again.
          tickets.delete(reportId);
          return { ok: true, value: { installSpec: detail.installSpec, result } };
        }

        case 'install/status': {
          // Lets the UI describe a plugin already present without re-installing it.
          const bundles = await manager.listBundles().catch(() => []);
          return { ok: true, value: { bundles } };
        }

        default:
          return {
            ok: false,
            error: { code: 'market/unknown-endpoint', message: `未知端点 ${endpoint}`, details: {} },
          };
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'market/failed',
          message: String(error?.message ?? error),
          details: {},
        },
      };
    }
}

/** Services this plugin cannot work without. */
export const inject = ['connection', 'pluginManager'];
