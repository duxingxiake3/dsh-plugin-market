/**
 * Plugin Market — Client half.
 *
 * Served to the browser as a CLASSIC script (no ESM, no JSX transform, no bundler),
 * so this file self-registers through the module loader and builds elements with
 * `react/jsx-runtime`. Only `react` and `react/jsx-runtime` are required: the module
 * table is closed, and Harness client packages are deliberately not imported.
 *
 * Registers three surfaces that all render the same body:
 *   - `sidebar.panellist` id `market`  → the sidebar button
 *   - `main`              key `market` → the full central page
 *   - `settings.plugins.tab` id `market` → a tab inside Settings → Plugins
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-market',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
		const { useCallback, useEffect, useMemo, useRef, useState } = React;

		/**
		 * Exact Fetch route registered by this package's Host half. It lives under the
		 * `/api` prefix, which the connection plugin already wraps in its Host/Origin
		 * fence and browser-cookie authentication, so the page's own session authorises
		 * every call.
		 */
		const ROUTE = '/api/dsh-plugin-market';
		/** Locale dictionary namespace owned by this plugin. */
		const NS = 'pluginMarket';
		/** Class-name prefix, unique to this plugin. */
		const P = 'dshmkt_';

		/** Browser-storage key for the description-language override. */
		const CONTENT_LANGUAGE_KEY = 'dsh-market:content-language';

		/* ---------------------------------------------------------------- *
		 * Styles: injected once through a tagged <style>, exactly like the
		 * shipped client packages do. Only theme tokens are used, so the
		 * plugin follows light/dark and any future retheme.
		 * ---------------------------------------------------------------- */

		/*
		 * Visual language copied from the shipped Plugins page: flat rows on the page
		 * background rather than bordered cards, a hairline icon tile per row, section
		 * headings carrying a count, filled badges with no border, an inverted (dark on
		 * light) primary pill, and a rounded hover wash on the whole row. Every colour is
		 * a theme token so both themes and any future retheme follow automatically.
		 */
		const CSS = `
.${P}root{width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px;padding:2px 0 28px}
.${P}head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.${P}headText{display:flex;flex-direction:column;gap:4px;min-width:0}
.${P}title{margin:0;font-size:26px;font-weight:600;line-height:34px}
.${P}intro{margin:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${P}headActions{display:flex;align-items:center;gap:8px;flex:none}
.${P}iconBtn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;padding:0;cursor:pointer;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary)}
.${P}iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.${P}iconBtn:disabled{opacity:.45;cursor:default}
.${P}iconBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.${P}btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;line-height:18px;cursor:pointer;border-radius:999px;padding:7px 14px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:nowrap}
.${P}btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.${P}btn:disabled{opacity:.45;cursor:default}
.${P}btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.${P}btnPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-label-primary));border-color:transparent;color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-bg-base))}
.${P}btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-label-primary));opacity:.9}
.${P}btnGhost{border-color:transparent;background:0 0;color:var(--dsw-alias-label-secondary)}
.${P}btnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.${P}btnDanger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:0 0}
.${P}field{box-sizing:border-box;font:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 12px}
.${P}field::placeholder{color:var(--dsw-alias-label-secondary)}
.${P}field:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
.${P}search{flex:1;min-width:200px}
.${P}section{display:flex;flex-direction:column;gap:8px}
.${P}sectionHead{display:flex;align-items:baseline;gap:8px;padding:0 2px}
.${P}blockTitle{margin:0;font-size:15px;font-weight:500;line-height:22px}
.${P}sectionCount{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.${P}rows{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.${P}card{position:relative;min-width:0}
.${P}row{display:flex;align-items:center;gap:14px;padding:10px 12px;border-radius:12px;box-sizing:border-box}
.${P}card:hover>.${P}row{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.${P}tile{flex:none;width:48px;height:48px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:inline-flex;align-items:center;justify-content:center;font-size:17px;font-weight:600}
.${P}mainCell{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.${P}nameRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.${P}name{position:relative;max-width:100%;margin:0;padding:0;border:0;background:0 0;font:inherit;font-size:16px;font-weight:500;line-height:22px;color:inherit;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}name::after{content:"";position:absolute;inset:-14px -14px -14px -14px;border-radius:12px}
.${P}name:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.${P}desc{margin:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.${P}note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.${P}end{position:relative;z-index:1;flex:none;display:inline-flex;align-items:center;gap:8px}
.${P}badge{font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;border:0;white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-secondary)}
.${P}badgeOfficial{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}
.${P}badgeThird{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}
.${P}badgeError{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.${P}pager{display:flex;align-items:center;gap:10px;justify-content:center;padding-top:4px}
.${P}kv{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;margin:0;font-size:13px;line-height:19px}
.${P}kvKey{color:var(--dsw-alias-label-secondary)}
.${P}kvVal{margin:0;min-width:0;word-break:break-word}
.${P}block{display:flex;flex-direction:column;gap:9px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}
.${P}blockTitle{margin:0;font-size:14px;font-weight:600;line-height:20px}
.${P}hero{display:flex;align-items:flex-start;gap:14px}
.${P}heroTile{flex:none;width:64px;height:64px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:inline-flex;align-items:center;justify-content:center;font-size:23px;font-weight:600;overflow:hidden}
.${P}heroLogo{width:40px;height:40px;object-fit:contain;display:block}
.${P}heroText{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}
.${P}heroTitle{margin:0;font-size:26px;font-weight:600;line-height:34px}
.${P}actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.${P}shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.${P}shot{margin:0;display:flex;flex-direction:column;gap:6px}
.${P}shotImg{width:100%;height:auto;border-radius:12px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:block}
.${P}shotCap{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.${P}pre{margin:0;max-height:320px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px}
.${P}overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}
.${P}dialog{width:100%;max-width:680px;max-height:84vh;overflow:auto;box-sizing:border-box;border-radius:16px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.28));padding:20px;display:flex;flex-direction:column;gap:14px}
.${P}dialogHead{display:flex;align-items:center;gap:10px;justify-content:space-between}
.${P}findings{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.${P}finding{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1)}
.${P}findingHead{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.${P}findingBody{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.${P}notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${P}noticeError{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.${P}inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.${P}spacer{flex:1}
.${P}spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);display:inline-block;animation:${P}spin .8s linear infinite}
@keyframes ${P}spin{to{transform:rotate(360deg)}}
.${P}shotBtn{display:block;width:100%;padding:0;border:0;background:0 0;cursor:zoom-in;border-radius:12px;text-align:left}
.${P}shotBtn:hover .${P}shotImg{opacity:.92}
.${P}shotBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.${P}lightbox{position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px;box-sizing:border-box;background:rgba(0,0,0,.78)}
.${P}lightboxBar{display:flex;align-items:center;gap:8px;flex:none;max-width:94vw;padding:6px 10px;border-radius:999px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.28))}
.${P}lightboxCaption{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:42ch}
.${P}lightboxCount{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);flex:none}
.${P}lightboxStage{flex:1;min-height:0;width:100%;display:flex;align-items:center;justify-content:center;overflow:auto}
.${P}lightboxImg{width:auto;height:auto;max-width:94vw;max-height:100%;object-fit:contain;border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.${P}lightboxImg[data-actual=true]{max-width:none;max-height:none}
`;

		const STYLE_TAG_ID = 'dsh-plugin-market/market.css';
		if (typeof document !== 'undefined'
			&& document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-plugin-market';
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/* ---------------------------------------------------------------- *
		 * Locale dictionary
		 * ---------------------------------------------------------------- */

		const zh = {
			nav: '插件市场',
			tab: '市场',
			title: '插件市场',
			intro: '从 npm 与 GitHub 检索 DSH 插件；安装前会先做安全审查。',
			search: '搜索插件名称、功能或关键词',
			source: '来源',
			sourceOfficial: '官方内置（本机）',
			sourceNpm: 'npm 注册表',
			sourceGithub: 'GitHub 仓库',
			sourceAll: '全部（官方 + 第三方）',
			refresh: '刷新',
			empty: '没有匹配的插件。换个关键词，或把来源换成“全部”试试。',
			loading: '正在检索…',
			detail: '详情',
			back: '返回列表',
			install: '安装',
			installed: '已安装',
			official: '官方',
			thirdParty: '第三方',
			groupOfficial: '官方',
			groupThird: '第三方',
			machineTranslated: '机翻',
			translatedHint: '由模型翻译，原文：{text}',
			zoomHint: '点击放大',
			fitWindow: '适应窗口',
			actualSize: '原始大小',
			openOriginal: '打开原图',
			close: '关闭',
			shotCounter: '第 {index} / {total} 张',
			contentLanguage: '介绍语言',
			manageInPlugins: '在插件页管理',
			langAuto: '跟随系统',
			prev: '上一页',
			next: '下一页',
			pageInfo: '第 {page} 页 · 共约 {total} 个结果',
			developer: '开发者',
			version: '版本',
			license: '许可',
			repository: '仓库',
			homepage: '主页',
			stars: '星标',
			updated: '最近更新',
			compatibility: '版本适配',
			capabilities: '能力',
			capBundle: 'Host 插件',
			capClient: '界面插件',
			screenshots: '界面与功能展示',
			noScreenshots: '未能从该插件的 README 中找到可用的界面截图。',
			screenshotsLoading: '正在查找界面截图…',
			readme: 'README',
			showReadme: '展开 README',
			hideReadme: '收起 README',
			checking: '正在进行安全审查…',
			checkingHint: '读取包清单与入口代码，交由模型评估权限与风险。',
			reportTitle: '安装前安全审查',
			risk: '风险等级',
			riskLow: '低',
			riskMedium: '中',
			riskHigh: '高',
			riskUnknown: '未能判定',
			deterministic: '规则扫描发现',
			modelFindings: '模型审查发现',
			permissions: '该插件将获得的权限',
			dataAccess: '可接触的隐私数据',
			noFindings: '未发现明显风险项。',
			evidenceNote: '审查基于 {bytes} 字节公开证据（包清单与入口代码）。',
			evidenceTruncated: '（内容过长已截断，可能遗漏风险）',
			modelNote: '审查模型：{model}',
			modelMissing: '模型审查不可用：{error}',
			confirmInstall: '确认安装',
			cancel: '取消',
			oneClickInstall: '一键安装',
			installing: '正在安装…',
			installDone: '安装完成：{state}',
			stateApplied: '已生效',
			stateRestart: '需要重启 DSH 才能加载新的 JavaScript 模块',
			stateOverridden: '被更高优先级的配置层覆盖',
			stateFailed: '失败',
			stateCancelled: '已取消',
			buildBlocked: 'pnpm 阻止了依赖构建脚本，安装未能完成。这些脚本会以你的用户权限执行：',
			approveBuilds: '允许这些脚本并重试',
			buildsNote: '仅在你确认信任该插件时才允许。',
			logPath: '完整日志：{path}',
			compatCompatible: '适配当前版本',
			compatIncompatible: '不适配当前版本',
			compatPrerelease: '当前为预发布版，需自行确认',
			compatUndeclared: '作者未声明',
			compatUnknown: '无法判定',
			runtime: '当前 DSH {version}',
			githubTokenOn: '已检测到 GitHub Token，检索配额提升。',
			githubTokenOff: '未配置 GitHub Token，GitHub 检索受未认证配额限制（10 次/分钟）。',
			retry: '重试',
			openExternal: '在浏览器打开',
		};

		const en = {
			nav: 'Plugin Market',
			tab: 'Market',
			title: 'Plugin Market',
			intro: 'Discover DSH plugins across npm and GitHub, with a security review before install.',
			search: 'Search by name, feature, or keyword',
			source: 'Source',
			sourceOfficial: 'Official (installed)',
			sourceNpm: 'npm registry',
			sourceGithub: 'GitHub repos',
			sourceAll: 'All (official + third-party)',
			refresh: 'Refresh',
			empty: 'No matching plugin. Try another keyword, or switch the source to “All”.',
			loading: 'Searching…',
			detail: 'Details',
			back: 'Back to list',
			install: 'Install',
			installed: 'Installed',
			official: 'Official',
			thirdParty: 'Third-party',
			groupOfficial: 'Official',
			groupThird: 'Third-party',
			machineTranslated: 'MT',
			translatedHint: 'Machine-translated. Original: {text}',
			zoomHint: 'Click to enlarge',
			fitWindow: 'Fit',
			actualSize: 'Actual size',
			openOriginal: 'Open original',
			close: 'Close',
			shotCounter: '{index} of {total}',
			contentLanguage: 'Description language',
			manageInPlugins: 'Manage in Plugins',
			langAuto: 'Follow system',
			prev: 'Previous',
			next: 'Next',
			pageInfo: 'Page {page} · about {total} results',
			developer: 'Developer',
			version: 'Version',
			license: 'License',
			repository: 'Repository',
			homepage: 'Homepage',
			stars: 'Stars',
			updated: 'Updated',
			compatibility: 'Compatibility',
			capabilities: 'Capabilities',
			capBundle: 'Host plugin',
			capClient: 'UI plugin',
			screenshots: 'Screenshots',
			noScreenshots: 'No usable screenshot was found in this plugin\'s README.',
			screenshotsLoading: 'Looking for screenshots…',
			readme: 'README',
			showReadme: 'Show README',
			hideReadme: 'Hide README',
			checking: 'Running the security review…',
			checkingHint: 'Reading the package manifest and entry code, then asking the model to judge permissions and risk.',
			reportTitle: 'Pre-install security review',
			risk: 'Risk',
			riskLow: 'Low',
			riskMedium: 'Medium',
			riskHigh: 'High',
			riskUnknown: 'Undetermined',
			deterministic: 'Rule scan findings',
			modelFindings: 'Model review findings',
			permissions: 'Permissions this plugin would gain',
			dataAccess: 'Private data it could reach',
			noFindings: 'No notable risk found.',
			evidenceNote: 'Reviewed {bytes} bytes of public evidence (manifest and entry code).',
			evidenceTruncated: ' (content truncated; risk may be missed)',
			modelNote: 'Review model: {model}',
			modelMissing: 'Model review unavailable: {error}',
			confirmInstall: 'Confirm install',
			cancel: 'Cancel',
			oneClickInstall: 'Install now',
			installing: 'Installing…',
			installDone: 'Install finished: {state}',
			stateApplied: 'applied',
			stateRestart: 'restart DSH to load the new JavaScript module',
			stateOverridden: 'overridden by a higher-priority layer',
			stateFailed: 'failed',
			stateCancelled: 'cancelled',
			buildBlocked: 'pnpm blocked dependency build scripts, so the install did not complete. These scripts run with your user permissions:',
			approveBuilds: 'Allow these scripts and retry',
			buildsNote: 'Allow only if you trust this plugin.',
			logPath: 'Full log: {path}',
			compatCompatible: 'Matches this version',
			compatIncompatible: 'Not compatible',
			compatPrerelease: 'Pre-release runtime; verify manually',
			compatUndeclared: 'Not declared',
			compatUnknown: 'Undetermined',
			runtime: 'DSH {version}',
			githubTokenOn: 'GitHub token detected; higher rate limits.',
			githubTokenOff: 'No GitHub token; GitHub search is rate limited (10/min unauthenticated).',
			retry: 'Retry',
			openExternal: 'Open in browser',
		};

		/* ---------------------------------------------------------------- *
		 * Helpers
		 * ---------------------------------------------------------------- */

		/** Interpolate {name} placeholders. */
		function fmt(template, values) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) => (
				values && key in values ? String(values[key]) : match
			));
		}

		/**
		 * Merge the local official catalogue with registry results for the mixed source.
		 *
		 * Official bundles carry no npm keywords, so a registry query can never surface
		 * them. Without this merge no view would show the official and third-party tags
		 * side by side, which is the whole point of the colour coding. Official entries
		 * are prepended on the first page only: they are a short local list, not a paged
		 * feed, and repeating them on every page would be noise.
		 *
		 * @param {any} official official-source payload.
		 * @param {any} third npm-source payload.
		 * @param {number} page zero-based page index.
		 */
		function mergeSources(official, third, page) {
			const officialItems = page === 0 ? (official?.items ?? []) : [];
			const thirdItems = third?.items ?? [];
			const seen = new Set(officialItems.map((item) => item.name));
			return {
				items: officialItems.concat(thirdItems.filter((item) => !seen.has(item.name))),
				total: (official?.total ?? 0) + (third?.total ?? 0),
				warnings: third?.warnings ?? [],
			};
		}

		/**
		 * POST one request to the Host half. The Host answers with the
		 * `{ ok, value | error }` envelope; a failure is raised as an Error so callers
		 * can show it directly.
		 */
		async function post(endpoint, payload) {
			const response = await fetch(ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ endpoint, payload }),
			});
			if (!response.ok) throw new Error(`宿主通道返回 HTTP ${response.status}`);
			const result = await response.json();
			if (result && typeof result === 'object' && 'ok' in result) {
				if (result.ok) return result.value;
				const error = result.error || {};
				const suffix = error.code ? ` (${error.code})` : '';
				throw new Error(`${error.message || '请求失败'}${suffix}`);
			}
			return result;
		}

		function riskLabel(t, risk) {
			if (risk === 'low') return t('riskLow');
			if (risk === 'medium') return t('riskMedium');
			if (risk === 'high') return t('riskHigh');
			return t('riskUnknown');
		}

		function compatLabel(t, status) {
			if (status === 'compatible') return t('compatCompatible');
			if (status === 'incompatible') return t('compatIncompatible');
			if (status === 'prerelease') return t('compatPrerelease');
			if (status === 'undeclared') return t('compatUndeclared');
			return t('compatUnknown');
		}

		/** Class list for a risk tone badge. */
		function riskTone(risk) {
			if (risk === 'high') return `${P}badge ${P}badgeError`;
			if (risk === 'medium') return `${P}badge ${P}badgeThird`;
			return `${P}badge`;
		}

		/** Class list for a compatibility tone badge. */
		function compatTone(status) {
			if (status === 'compatible') return `${P}badge ${P}badgeOfficial`;
			if (status === 'incompatible') return `${P}badge ${P}badgeError`;
			return `${P}badge`;
		}

		/**
		 * Icon-tile colour. Tying it to provenance rather than hashing the name keeps the
		 * green/orange coding readable at a glance, before the badge itself is read.
		 */
		function tileTint(item) {
			return item?.official
				? 'var(--dsw-alias-state-success-primary)'
				: 'var(--dsw-alias-state-warn-primary)';
		}

		function shortDate(value) {
			if (!value) return null;
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return null;
			return date.toLocaleDateString();
		}

		function initialOf(item) {
			const source = String(item?.title || item?.name || '?').replace(/^@[^/]+\//, '');
			return source.slice(0, 1).toUpperCase();
		}

		/** Small inline icon set, drawn with theme `currentColor`. */
		function Glyph({ name, size = 16 }) {
			const common = {
				width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
				'aria-hidden': 'true', focusable: 'false',
			};
			if (name === 'store') {
				return jsxs('svg', { ...common, children: [
					jsx('path', { d: 'M3.5 9.5 5 4.2h14L20.5 9.5' }),
					jsx('path', { d: 'M3.5 9.5a2.4 2.4 0 0 0 4.1 1.6 2.4 2.4 0 0 0 4.4 0 2.4 2.4 0 0 0 4.4 0 2.4 2.4 0 0 0 4.1-1.6' }),
					jsx('path', { d: 'M5 12.2v6.3a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-6.3' }),
				] });
			}
			if (name === 'shield') {
				return jsxs('svg', { ...common, children: [
					jsx('path', { d: 'M12 3.5 5 6.2v5.1c0 4.2 2.9 7.4 7 9.2 4.1-1.8 7-5 7-9.2V6.2Z' }),
					jsx('path', { d: 'm9 12 2.2 2.2L15.4 10' }),
				] });
			}
			if (name === 'refresh') {
				return jsxs('svg', { ...common, children: [
					jsx('path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
					jsx('path', { d: 'M20 4.5V10h-5.5' }),
				] });
			}
			return jsx('svg', { ...common, children: jsx('circle', { cx: 12, cy: 12, r: 8 }) });
		}

		/* ---------------------------------------------------------------- *
		 * Risk dialog
		 * ---------------------------------------------------------------- */

		function RiskDialog({ t, report, busy, onCancel, onConfirm }) {
			const ref = useRef(null);
			useEffect(() => {
				const onKey = (event) => { if (event.key === 'Escape' && !busy) onCancel(); };
				document.addEventListener('keydown', onKey);
				if (ref.current) ref.current.focus();
				return () => document.removeEventListener('keydown', onKey);
			}, [busy, onCancel]);

			const deterministic = report?.deterministic?.findings ?? [];
			const modeled = report?.model?.findings ?? [];
			const tone = riskTone(report?.risk);

			const renderFinding = (finding, index) => jsxs('li', { className: `${P}finding`, children: [
				jsxs('div', { className: `${P}findingHead`, children: [
					jsx('span', { className: `${P}badge`, children: finding.category }),
					jsx('span', { className: `${P}badge`, children: finding.severity }),
				] }),
				finding.evidence ? jsx('div', { className: `${P}findingBody`, children: finding.evidence }) : null,
				finding.explanation ? jsx('div', { className: `${P}findingBody`, children: finding.explanation }) : null,
			] }, `f${index}`);

			return jsx('div', {
				className: `${P}overlay`,
				role: 'presentation',
				onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onCancel(); },
				children: jsxs('div', {
					className: `${P}dialog`, role: 'dialog', 'aria-modal': 'true',
					'aria-label': t('reportTitle'), tabIndex: -1, ref,
					children: [
						jsxs('div', { className: `${P}dialogHead`, children: [
							jsx('h3', { className: `${P}blockTitle`, children: t('reportTitle') }),
							jsxs('div', { className: `${P}inline`, children: [
								jsx('span', { className: `${P}kvKey`, children: t('risk') }),
								jsx('span', { className: tone, children: riskLabel(t, report?.risk) }),
							] }),
						] }),
						report?.model?.summary
							? jsx('p', { className: `${P}intro`, children: report.model.summary })
							: null,
						report?.modelError
							? jsx('p', { className: `${P}noticeError`, children: fmt(t('modelMissing'), { error: report.modelError }) })
							: null,
						report?.modelUsed
							? jsx('p', { className: `${P}notice`, children: fmt(t('modelNote'), { model: report.modelUsed }) })
							: null,
						jsxs('div', { className: `${P}block`, children: [
							jsx('h4', { className: `${P}blockTitle`, children: t('deterministic') }),
							deterministic.length
								? jsx('ul', { className: `${P}findings`, children: deterministic.map(renderFinding) })
								: jsx('p', { className: `${P}notice`, children: t('noFindings') }),
						] }),
						modeled.length
							? jsxs('div', { className: `${P}block`, children: [
								jsx('h4', { className: `${P}blockTitle`, children: t('modelFindings') }),
								jsx('ul', { className: `${P}findings`, children: modeled.map(renderFinding) }),
							] })
							: null,
						(report?.model?.permissions?.length ?? 0) > 0
							? jsxs('div', { className: `${P}block`, children: [
								jsx('h4', { className: `${P}blockTitle`, children: t('permissions') }),
								jsx('ul', { className: `${P}findings`, children: report.model.permissions.map((entry, index) => (
									jsx('li', { className: `${P}findingBody`, children: `• ${entry}` }, `p${index}`)
								)) }),
							] })
							: null,
						(report?.model?.dataAccess?.length ?? 0) > 0
							? jsxs('div', { className: `${P}block`, children: [
								jsx('h4', { className: `${P}blockTitle`, children: t('dataAccess') }),
								jsx('ul', { className: `${P}findings`, children: report.model.dataAccess.map((entry, index) => (
									jsx('li', { className: `${P}findingBody`, children: `• ${entry}` }, `d${index}`)
								)) }),
							] })
							: null,
						jsx('p', { className: `${P}notice`, children: fmt(t('evidenceNote'), { bytes: report?.evidence?.bytes ?? 0 })
							+ (report?.evidence?.truncated ? t('evidenceTruncated') : '') }),
						jsxs('div', { className: `${P}inline`, children: [
							jsx('span', { className: `${P}spacer` }),
							jsx('button', {
								type: 'button', className: `${P}btn`, onClick: onCancel, disabled: busy,
								children: t('cancel'),
							}),
							jsx('button', {
								type: 'button',
								className: `${P}btn ${P}btnPrimary`,
								onClick: onConfirm,
								disabled: busy,
								children: busy ? t('installing') : t('confirmInstall'),
							}),
						] }),
					],
				}),
			});
		}

		/* ---------------------------------------------------------------- *
		 * Install result banner
		 * ---------------------------------------------------------------- */

		function InstallResult({ t, outcome, onApproveBuilds, busy }) {
			if (!outcome) return null;
			if (outcome.kind === 'error') {
				return jsx('p', { className: `${P}noticeError`, children: outcome.message });
			}
			const result = outcome.result ?? {};
			const application = result.application ?? 'failed';
			const stateText = application === 'applied' ? t('stateApplied')
				: application === 'restart-required' ? t('stateRestart')
					: application === 'overridden' ? t('stateOverridden')
						: application === 'cancelled' ? t('stateCancelled') : t('stateFailed');
			const pending = Array.isArray(result.pendingBuilds) ? result.pendingBuilds : [];
			const logPath = result.packageResult?.logPath;
			return jsxs('div', { className: `${P}block`, children: [
				jsx('p', {
					className: application === 'failed' ? `${P}noticeError` : `${P}notice`,
					children: fmt(t('installDone'), { state: stateText }),
				}),
				result.error?.message
					? jsx('p', { className: `${P}noticeError`, children: String(result.error.message) }) : null,
				pending.length
					? jsxs(Fragment, { children: [
						jsx('p', { className: `${P}noticeError`, children: t('buildBlocked') }),
						jsx('pre', { className: `${P}pre`, children: pending.join('\n') }),
						jsx('p', { className: `${P}notice`, children: t('buildsNote') }),
						jsx('div', { className: `${P}inline`, children: jsx('button', {
							type: 'button', className: `${P}btn`, disabled: busy,
							onClick: () => onApproveBuilds(pending), children: t('approveBuilds'),
						}) }),
					] })
					: null,
				result.packageResult?.output
					? jsx('pre', { className: `${P}pre`, children: String(result.packageResult.output).slice(-4000) }) : null,
				logPath ? jsx('p', { className: `${P}notice`, children: fmt(t('logPath'), { path: logPath }) }) : null,
			] });
		}

		/**
		 * Full-screen viewer for one screenshot.
		 *
		 * A README screenshot is often a 3840px-wide dashboard; rendered as a thumbnail it is
		 * unreadable. The viewer fits the image to the viewport by default and toggles to
		 * actual size, where the stage scrolls, so fine text can actually be read. It is a
		 * light box rather than a new tab so the user keeps their place in the list.
		 */
		function ShotLightbox({ t, shots, index, onIndex, onClose }) {
			const [actual, setActual] = useState(false);
			const shot = shots[index];
			const ref = useRef(null);

			useEffect(() => {
				const onKey = (event) => {
					if (event.key === 'Escape') onClose();
					else if (event.key === 'ArrowLeft') onIndex((index - 1 + shots.length) % shots.length);
					else if (event.key === 'ArrowRight') onIndex((index + 1) % shots.length);
				};
				document.addEventListener('keydown', onKey);
				if (ref.current) ref.current.focus();
				return () => document.removeEventListener('keydown', onKey);
			}, [index, shots.length, onClose, onIndex]);

			if (!shot) return null;
			const caption = shot.captionTranslated || shot.caption;
			return jsx('div', {
				className: `${P}lightbox`,
				role: 'dialog',
				'aria-modal': 'true',
				'aria-label': caption || t('screenshots'),
				onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); },
				children: jsxs(Fragment, { children: [
					jsxs('div', { className: `${P}lightboxBar`, children: [
						jsx('span', {
							className: `${P}lightboxCaption`,
							title: shot.captionTranslated ? fmt(t('translatedHint'), { text: shot.caption }) : undefined,
							children: caption || t('screenshots'),
						}),
						jsx('span', { className: `${P}lightboxCount`, children: `${shot.width}×${shot.height}` }),
						shots.length > 1
							? jsx('span', { className: `${P}lightboxCount`, children: fmt(t('shotCounter'), { index: index + 1, total: shots.length }) })
							: null,
						jsx('span', { className: `${P}spacer` }),
						shots.length > 1
							? jsxs(Fragment, { children: [
								jsx('button', {
									type: 'button', className: `${P}btn ${P}btnGhost`, 'aria-label': t('prev'),
									onClick: () => onIndex((index - 1 + shots.length) % shots.length), children: '←',
								}),
								jsx('button', {
									type: 'button', className: `${P}btn ${P}btnGhost`, 'aria-label': t('next'),
									onClick: () => onIndex((index + 1) % shots.length), children: '→',
								}),
							] })
							: null,
						jsx('button', {
							type: 'button', className: `${P}btn ${P}btnGhost`,
							onClick: () => setActual((value) => !value),
							children: actual ? t('fitWindow') : t('actualSize'),
						}),
						jsx('a', {
							className: `${P}btn ${P}btnGhost`, href: shot.url, target: '_blank', rel: 'noreferrer noopener',
							children: t('openOriginal'),
						}),
						jsx('button', {
							type: 'button', className: `${P}btn`, onClick: onClose, children: t('close'),
						}),
					] }),
					jsx('div', {
						className: `${P}lightboxStage`,
						onMouseDown: (event) => event.stopPropagation(),
						children: jsx('img', {
							ref,
							className: `${P}lightboxImg`,
							src: shot.url,
							alt: caption || t('screenshots'),
							'data-actual': actual ? 'true' : 'false',
							tabIndex: -1,
							onClick: () => setActual((value) => !value),
						}),
					}),
				] }),
			});
		}

		/* ---------------------------------------------------------------- *
		 * Detail view
		 * ---------------------------------------------------------------- */

		function MarketDetail({ t, detail, busy, shotsBusy, onBack, onReview, installOutcome, onApproveBuilds, onManage }) {
			const [showReadme, setShowReadme] = useState(false);
			const [lightbox, setLightbox] = useState(null);
			// A logo the author shipped is shown only once it actually loads; a dead or
			// disallowed URL leaves the letter tile exactly as it was.
			const [logoBroken, setLogoBroken] = useState(false);
			if (!detail) return null;
			const compatibility = detail.compatibility ?? { status: 'unknown', detail: '' };
			const showLogo = Boolean(detail.logoUrl) && !logoBroken;

			const metaRow = (key, value) => (value === null || value === undefined || value === ''
				? null
				: jsxs(Fragment, { children: [
					jsx('span', { className: `${P}kvKey`, children: key }),
					jsx('span', { className: `${P}kvVal`, children: value }),
				] }));

			const capabilities = [
				detail.capabilities?.bundle ? t('capBundle') : null,
				detail.capabilities?.client ? t('capClient') : null,
			].filter(Boolean).join(' · ');

			return jsxs('div', { className: `${P}root`, children: [
				jsxs('div', { className: `${P}inline`, children: [
					jsx('button', { type: 'button', className: `${P}btn ${P}btnGhost`, onClick: onBack, children: `← ${t('back')}` }),
					jsx('span', { className: `${P}spacer` }),
				] }),
				jsxs('div', { className: `${P}hero`, children: [
					jsx('span', { className: `${P}heroTile`, 'aria-hidden': 'true', style: { color: tileTint(detail) }, children: showLogo
						? jsx('img', {
							className: `${P}heroLogo`,
							src: detail.logoUrl,
							alt: '',
							loading: 'lazy',
							referrerPolicy: 'no-referrer',
							onError: () => setLogoBroken(true),
						})
						: initialOf(detail) }),
					jsxs('div', { className: `${P}heroText`, children: [
						jsxs('div', { className: `${P}nameRow`, children: [
							jsx('h2', { className: `${P}heroTitle`, children: detail.title || detail.name }),
							jsx('span', {
								className: detail.official ? `${P}badge ${P}badgeOfficial` : `${P}badge ${P}badgeThird`,
								children: detail.official ? t('official') : t('thirdParty'),
							}),
							jsx('span', { className: compatTone(compatibility.status), children: compatLabel(t, compatibility.status) }),
							detail.archived ? jsx('span', { className: `${P}badge`, children: 'archived' }) : null,
						] }),
						detail.summary || detail.summaryTranslated
							? jsxs('p', {
								className: `${P}intro`,
								title: detail.summaryTranslated ? fmt(t('translatedHint'), { text: detail.summary }) : undefined,
								children: [
									detail.summaryTranslated || detail.summary,
									detail.summaryTranslated ? ' ' : null,
									detail.summaryTranslated ? jsx('span', { className: `${P}badge`, children: t('machineTranslated') }) : null,
								],
							})
							: null,
						jsx('p', { className: `${P}notice`, children: compatibility.detail }),
						jsxs('div', { className: `${P}actions`, children: [
							jsx('button', {
								type: 'button',
								className: `${P}btn ${P}btnPrimary`,
								onClick: onReview,
								disabled: busy || detail.installedAlready,
								children: busy ? t('checking') : (detail.installedAlready ? t('installed') : t('oneClickInstall')),
							}),
							// Once installed, the shipped Plugins page owns the plugin: enabling,
							// configuring and removing it all live there, and duplicating those
							// controls here would only create two places to get it wrong.
							detail.installedAlready && onManage
								? jsx('button', {
									type: 'button', className: `${P}btn`, onClick: onManage,
									children: t('manageInPlugins'),
								})
								: null,
							detail.repository
								? jsx('a', {
									className: `${P}btn`, href: detail.repository, target: '_blank', rel: 'noreferrer noopener',
									children: t('repository'),
								}) : null,
						] }),
					] }),
				] }),
				jsxs('div', { className: `${P}block`, children: [
					jsx('h3', { className: `${P}blockTitle`, children: t('compatibility') }),
					jsxs('dl', { className: `${P}kv`, children: [
						metaRow(t('developer'), detail.developer?.name
							? (detail.developer.url
								? jsx('a', { href: detail.developer.url, target: '_blank', rel: 'noreferrer noopener', children: detail.developer.name })
								: detail.developer.name)
							: null),
						metaRow(t('version'), detail.version),
						metaRow(t('license'), detail.license),
						metaRow(t('stars'), detail.stars === null ? null : String(detail.stars)),
						metaRow(t('updated'), shortDate(detail.pushedAt)),
						metaRow(t('capabilities'), capabilities || null),
						metaRow(t('homepage'), detail.homepage
							? jsx('a', { href: detail.homepage, target: '_blank', rel: 'noreferrer noopener', children: detail.homepage })
							: null),
					] }),
				] }),
				installOutcome ? jsx(InstallResult, { t, outcome: installOutcome, onApproveBuilds, busy }) : null,
				jsxs('div', { className: `${P}block`, children: [
					jsx('h3', { className: `${P}blockTitle`, children: t('screenshots') }),
					shotsBusy && !detail.screenshots?.length
						? jsxs('div', { className: `${P}inline`, children: [
							jsx('span', { className: `${P}spinner` }),
							jsx('span', { className: `${P}notice`, children: t('screenshotsLoading') }),
						] })
						: null,
					detail.screenshots?.length
						? jsx('div', { className: `${P}shots`, children: detail.screenshots.map((shot, index) => (
							jsxs('figure', { className: `${P}shot`, children: [
								jsx('button', {
									type: 'button', className: `${P}shotBtn`,
									'aria-label': `${t('zoomHint')}: ${shot.captionTranslated || shot.caption || detail.title}`,
									onClick: () => setLightbox(index),
									children: jsx('img', {
										className: `${P}shotImg`, src: shot.url, alt: shot.captionTranslated || shot.caption || detail.title,
										loading: 'lazy', referrerPolicy: 'no-referrer',
										onError: (event) => { event.currentTarget.style.display = 'none'; },
									}),
								}),
								shot.caption || shot.captionTranslated
									? jsx('figcaption', {
										className: `${P}shotCap`,
										title: shot.captionTranslated ? fmt(t('translatedHint'), { text: shot.caption }) : undefined,
										children: shot.captionTranslated || shot.caption,
									})
									: null,
							] }, `s${index}`)
						)) })
						: shotsBusy ? null : jsx('p', { className: `${P}notice`, children: t('noScreenshots') }),
				] }),
				// A README is the author's own document, so it is shown as written; only the
				// short display fields get the translated copy alongside.
				detail.description || detail.descriptionTranslated
					? jsxs('div', { className: `${P}block`, children: [
						jsxs('div', { className: `${P}inline`, children: [
							jsx('h3', { className: `${P}blockTitle`, children: t('title') }),
							detail.descriptionTranslated ? jsx('span', { className: `${P}badge`, children: t('machineTranslated') }) : null,
						] }),
						jsx('pre', {
							className: `${P}pre`,
							title: detail.descriptionTranslated ? fmt(t('translatedHint'), { text: detail.description }) : undefined,
							children: detail.descriptionTranslated || detail.description,
						}),
					] })
					: null,
				Object.keys(detail.installScripts ?? {}).length > 0
					? jsxs('div', { className: `${P}block`, children: [
						jsx('h3', { className: `${P}blockTitle`, children: 'install scripts' }),
						jsx('pre', { className: `${P}pre`, children: Object.entries(detail.installScripts).map(([k, v]) => `${k}: ${v}`).join('\n') }),
					] })
					: null,
				detail.readme
					? jsxs('div', { className: `${P}block`, children: [
						jsxs('div', { className: `${P}inline`, children: [
							jsx('h3', { className: `${P}blockTitle`, children: t('readme') }),
							jsx('button', {
								type: 'button', className: `${P}btn ${P}btnGhost`,
								onClick: () => setShowReadme((value) => !value),
								children: showReadme ? t('hideReadme') : t('showReadme'),
							}),
						] }),
						showReadme ? jsx('pre', { className: `${P}pre`, children: detail.readme }) : null,
					] })
					: null,
				lightbox !== null && detail.screenshots?.length
					? jsx(ShotLightbox, {
						t,
						shots: detail.screenshots,
						index: Math.min(lightbox, detail.screenshots.length - 1),
						onIndex: setLightbox,
						onClose: () => setLightbox(null),
					})
					: null,
			] });
		}

		/* ---------------------------------------------------------------- *
		 * List view
		 * ---------------------------------------------------------------- */

		/**
		 * One catalogue row, built like a shipped Plugins row: a hairline icon tile, the
		 * title as a button whose `::after` covers the whole row (the shipped page's
		 * whole-row hit target), and a trailing control kept above that overlay so it
		 * stays independently clickable.
		 */
		function MarketRow({ t, item, onDetail }) {
			const badges = [
				jsx('span', {
					className: item.official ? `${P}badge ${P}badgeOfficial` : `${P}badge ${P}badgeThird`,
					children: item.official ? t('official') : t('thirdParty'),
				}, 'provenance'),
			];
			if (item.installedAlready) {
				badges.push(jsx('span', { className: `${P}badge`, children: t('installed') }, 'installed'));
			}
			if (item.compatibility && item.compatibility.status !== 'undeclared') {
				badges.push(jsx('span', {
					className: compatTone(item.compatibility.status),
					title: item.compatibility.detail,
					children: compatLabel(t, item.compatibility.status),
				}, 'compat'));
			}

			const meta = [
				item.version ? `v${item.version}` : null,
				item.author || null,
				item.stars !== null && item.stars !== undefined ? `★${item.stars}` : null,
				item.summaryTranslated ? t('machineTranslated') : null,
			].filter(Boolean).join(' · ');

			return jsx('li', { className: `${P}card`, children: jsxs('div', { className: `${P}row`, children: [
				jsx('span', {
					className: `${P}tile`, 'aria-hidden': 'true',
					style: { color: tileTint(item) },
					children: initialOf(item),
				}),
				jsxs('div', { className: `${P}mainCell`, children: [
					jsxs('div', { className: `${P}nameRow`, children: [
						jsx('button', {
							type: 'button', className: `${P}name`, title: item.name,
							onClick: () => onDetail(item),
							children: item.title || item.name,
						}),
						...badges,
					] }),
					// The author's own words are never overwritten: the translated string rides
					// alongside, the original stays in the tooltip, and the meta line says so.
					item.summary || item.summaryTranslated
						? jsx('span', {
							className: `${P}desc`,
							title: item.summaryTranslated ? fmt(t('translatedHint'), { text: item.summary }) : undefined,
							children: item.summaryTranslated || item.summary,
						})
						: null,
					meta ? jsx('span', { className: `${P}note`, children: meta }) : null,
				] }),
				jsx('div', { className: `${P}end`, children: jsx('button', {
					type: 'button', className: `${P}btn ${P}btnGhost`, onClick: () => onDetail(item),
					children: t('detail'),
				}) }),
			] }) });
		}

		/* ---------------------------------------------------------------- *
		 * Shared body
		 * ---------------------------------------------------------------- */

		function MarketBody({ t, api, manage, locale }) {
			const [query, setQuery] = useState('');
			const [applied, setApplied] = useState('');
			const [source, setSource] = useState('all');
			const [page, setPage] = useState(0);
			const [state, setState] = useState({ status: 'loading', items: [], total: 0, warnings: [] });
			const [meta, setMeta] = useState(null);
			const [detail, setDetail] = useState(null);
			const [detailBusy, setDetailBusy] = useState(false);
			const [report, setReport] = useState(null);
			const [reviewBusy, setReviewBusy] = useState(false);
			const [installBusy, setInstallBusy] = useState(false);
			const [outcome, setOutcome] = useState(null);
			const [activeId, setActiveId] = useState(null);

			/**
			 * Which language plugin descriptions are shown in.
			 *
			 * `auto` follows the DSH system language. An override exists because the two are
			 * genuinely independent choices: a reader may keep an English UI while wanting
			 * Chinese descriptions, or keep a Chinese UI but read the author's exact wording.
			 * The override is a display preference, so it lives in browser storage and never
			 * touches the system setting.
			 */
			const [contentLanguage, setContentLanguage] = useState(() => {
				try {
					const stored = window.localStorage?.getItem(CONTENT_LANGUAGE_KEY);
					return stored === 'zh' || stored === 'en' ? stored : 'auto';
				} catch {
					return 'auto';
				}
			});
			const contentLocale = contentLanguage === 'auto' ? locale : contentLanguage;

			const chooseContentLanguage = useCallback((next) => {
				setContentLanguage(next);
				try {
					window.localStorage?.setItem(CONTENT_LANGUAGE_KEY, next);
				} catch {
					// Private mode or a blocked store: the choice simply does not survive a reload.
				}
			}, []);

			const call = useCallback(
				(endpoint, payload) => api.post(endpoint, { locale: contentLocale, ...payload }),
				[api, contentLocale],
			);

			/**
			 * Load one page for a source. `all` mixes the vendor's own bundles with
			 * registry plugins so both provenance tags appear together.
			 */
			const loadPage = useCallback(async (source, query, page) => {
				const perPage = 20;
				if (source !== 'all') {
					return call('catalog/search', { source, query, page, perPage });
				}
				const [official, third] = await Promise.all([
					call('catalog/search', { source: 'official', query }),
					call('catalog/search', { source: 'npm', query, page, perPage }),
				]);
				return mergeSources(official, third, page);
			}, [call]);

			useEffect(() => {
				let cancelled = false;
				call('meta', {}).then((value) => { if (!cancelled) setMeta(value); }).catch(() => {});
				return () => { cancelled = true; };
			}, [call]);

			// Debounce the free-text query so typing does not spam the registry.
			useEffect(() => {
				const timer = setTimeout(() => { setApplied(query.trim()); setPage(0); }, 420);
				return () => clearTimeout(timer);
			}, [query]);

			useEffect(() => {
				let cancelled = false;
				setState((previous) => ({ ...previous, status: 'loading' }));
				loadPage(source, applied, page)
					.then((value) => {
						if (cancelled) return;
						setState({ status: 'ready', items: value.items ?? [], total: value.total ?? 0, warnings: value.warnings ?? [] });
					})
					.catch((error) => {
						if (cancelled) return;
						setState({ status: 'error', items: [], total: 0, warnings: [], error: String(error.message ?? error) });
					});
				return () => { cancelled = true; };
			}, [loadPage, applied, source, page]);

			// Two phases on purpose: the page renders as soon as metadata lands, then
			// screenshots and their captions arrive from `catalog/enrich`. Verifying images
			// costs a fetch each, and a slow image host must not hold up the page.
			const [shotsBusy, setShotsBusy] = useState(false);

			const openDetail = useCallback((item) => {
				setActiveId(item.id);
				setDetail(null);
				setOutcome(null);
				setDetailBusy(true);
				setShotsBusy(false);
				call('catalog/detail', { id: item.id })
					.then((value) => {
						setDetail(value);
						setDetailBusy(false);
						if (value?.official) return;
						setShotsBusy(true);
						return call('catalog/enrich', { id: item.id })
							.then((extra) => {
								setDetail((current) => (current && current.id === value.id
									? { ...current, screenshots: extra?.screenshots ?? current.screenshots }
									: current));
							})
							// A failed enrich pass costs pictures, never the page.
							.catch(() => {})
							.finally(() => setShotsBusy(false));
					})
					.catch((error) => {
						setOutcome({ kind: 'error', message: String(error.message ?? error) });
						setDetailBusy(false);
					});
			}, [call]);

			// Switching the description language re-fetches the open detail, so the new
			// language appears immediately rather than after navigating away and back.
			// `openDetail` changes identity exactly when `call` does, which is exactly when
			// the language changed, so this cannot loop.
			useEffect(() => {
				if (activeId) openDetail({ id: activeId });
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [openDetail]);

			const closeDetail = useCallback(() => { setActiveId(null); setDetail(null); setReport(null); setOutcome(null); }, []);

			const startReview = useCallback(() => {
				if (!activeId) return;
				setReviewBusy(true);
				setOutcome(null);
				call('risk/review', { id: activeId })
					.then((value) => setReport(value))
					.catch((error) => setOutcome({ kind: 'error', message: String(error.message ?? error) }))
					.finally(() => setReviewBusy(false));
			}, [activeId, call]);

			const runInstall = useCallback((approvedBuilds) => {
				if (!report || !activeId) return;
				setInstallBusy(true);
				call('install/run', {
					id: activeId,
					reportId: report.reportId,
					confirmed: true,
					...(approvedBuilds ? { approvedBuilds } : {}),
				})
					.then((value) => {
						setReport(null);
						setOutcome({ kind: 'ok', result: value.result, installSpec: value.installSpec });
						if (value?.result?.application === 'applied') {
							// Reflect the new state without another round trip.
							setDetail((current) => (current ? { ...current, installedAlready: true } : current));
							setState((previous) => ({
								...previous,
								items: previous.items.map((item) => (item.id === activeId ? { ...item, installedAlready: true } : item)),
							}));
						}
					})
					.catch((error) => {
						setReport(null);
						setOutcome({ kind: 'error', message: String(error.message ?? error) });
					})
					.finally(() => setInstallBusy(false));
			}, [activeId, call, report]);

			if (activeId) {
				if (detailBusy && !detail) {
					return jsxs('div', { className: `${P}root`, children: [
						jsxs('div', { className: `${P}inline`, children: [
							jsx('span', { className: `${P}spinner` }),
							jsx('span', { className: `${P}notice`, children: t('loading') }),
						] }),
					] });
				}
				return jsxs(Fragment, { children: [
					jsx(MarketDetail, {
						t, detail, busy: reviewBusy || installBusy, shotsBusy,
						onBack: closeDetail, onReview: startReview,
						installOutcome: outcome, onApproveBuilds: runInstall,
						onManage: manage,
					}),
					report ? jsx(RiskDialog, {
						t, report, busy: installBusy,
						onCancel: () => setReport(null),
						onConfirm: () => runInstall(null),
					}) : null,
				] });
			}

			const notices = [];
			if (meta?.runtimeVersion) notices.push(fmt(t('runtime'), { version: meta.runtimeVersion }));
			notices.push(meta?.githubToken ? t('githubTokenOn') : t('githubTokenOff'));
			if (state.warnings?.length) notices.push(...state.warnings);

			// Grouped the way the shipped page groups its own list: a section heading with a
			// count, so provenance is legible from the structure and not only from the badge.
			const groups = [];
			const officialItems = state.items.filter((item) => item.official);
			const thirdItems = state.items.filter((item) => !item.official);
			if (officialItems.length) groups.push({ key: 'official', label: t('groupOfficial'), items: officialItems });
			if (thirdItems.length) groups.push({ key: 'third', label: t('groupThird'), items: thirdItems });

			return jsxs('div', { className: `${P}root`, children: [
				jsxs('div', { className: `${P}head`, children: [
					jsxs('div', { className: `${P}headText`, children: [
						jsx('h2', { className: `${P}title`, children: t('title') }),
						jsx('p', { className: `${P}intro`, children: t('intro') }),
					] }),
					jsxs('div', { className: `${P}headActions`, children: [
						jsx('button', {
							type: 'button', className: `${P}iconBtn`, 'aria-label': t('refresh'), title: t('refresh'),
							disabled: state.status === 'loading',
							onClick: () => { setPage(0); setApplied(query.trim()); setState((p) => ({ ...p, status: 'loading' })); },
							children: jsx(Glyph, { name: 'refresh', size: 17 }),
						}),
						jsxs('select', {
							className: `${P}field`, value: source, 'aria-label': t('source'),
							onChange: (event) => { setSource(event.target.value); setPage(0); },
							children: [
								jsx('option', { value: 'all', children: t('sourceAll') }),
								jsx('option', { value: 'official', children: t('sourceOfficial') }),
								jsx('option', { value: 'npm', children: t('sourceNpm') }),
								jsx('option', { value: 'github', children: t('sourceGithub') }),
							],
						}),
						jsxs('select', {
							className: `${P}field`, value: contentLanguage, 'aria-label': t('contentLanguage'),
							title: `${t('contentLanguage')}${contentLanguage === 'auto' ? ` (${locale})` : ''}`,
							onChange: (event) => chooseContentLanguage(event.target.value),
							children: [
								jsx('option', { value: 'auto', children: `${t('langAuto')} · ${locale}` }),
								jsx('option', { value: 'zh', children: '中文' }),
								jsx('option', { value: 'en', children: 'English' }),
							],
						}),
					] }),
				] }),
				jsx('input', {
					className: `${P}field ${P}search`, type: 'search', value: query,
					placeholder: t('search'), 'aria-label': t('search'),
					onChange: (event) => setQuery(event.target.value),
				}),
				notices.map((notice, index) => jsx('p', { className: `${P}notice`, children: notice }, `n${index}`)),
				state.status === 'loading'
					? jsxs('div', { className: `${P}inline`, children: [
						jsx('span', { className: `${P}spinner` }),
						jsx('span', { className: `${P}notice`, children: t('loading') }),
					] })
					: null,
				state.status === 'error'
					? jsxs('div', { className: `${P}inline`, children: [
						jsx('p', { className: `${P}noticeError`, children: state.error }),
						jsx('button', { type: 'button', className: `${P}btn`, onClick: () => setPage((p) => p), children: t('retry') }),
					] })
					: null,
				state.status === 'ready' && state.items.length === 0
					? jsx('p', { className: `${P}notice`, children: t('empty') })
					: null,
				groups.map((group) => jsxs('section', { className: `${P}section`, children: [
					jsxs('div', { className: `${P}sectionHead`, children: [
						jsx('h3', { className: `${P}sectionTitle`, children: group.label }),
						jsx('span', { className: `${P}sectionCount`, children: group.items.length }),
					] }),
					jsx('ul', { className: `${P}rows`, children: group.items.map((item) => (
						jsx(MarketRow, { t, item, onDetail: openDetail }, item.id)
					)) }),
				] }, group.key)),
				state.items.length && state.status === 'ready'
					? jsxs('div', { className: `${P}pager`, children: [
						jsx('button', {
							type: 'button', className: `${P}btn`, disabled: page === 0,
							onClick: () => setPage((value) => Math.max(0, value - 1)), children: t('prev'),
						}),
						jsx('span', {
							className: `${P}notice`,
							children: fmt(t('pageInfo'), { page: page + 1, total: state.total }),
						}),
						jsx('button', {
							type: 'button', className: `${P}btn`,
							disabled: state.items.length < 20,
							onClick: () => setPage((value) => value + 1), children: t('next'),
						}),
					] })
					: null,
				jsx('p', { className: `${P}notice`, children: jsxs(Fragment, { children: [
					jsx(Glyph, { name: 'shield', size: 13 }),
					' ',
					t('checkingHint'),
				] }) }),
			] });
		}

		/**
		 * Full-page surface for the sidebar `main` panel. Padding matches the shipped
		 * Plugins page (its own scroll container, generous gutters, rows spanning the
		 * content width) rather than a narrow centred column.
		 */
		function MarketPage(props) {
			return jsx('div', {
				style: { padding: '22px 30px 28px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' },
				children: jsx(MarketBody, props),
			});
		}

		/** Same body, sized for the Settings → Plugins tab panel. */
		function MarketTab(props) {
			return jsx(MarketBody, props);
		}

		/** Sidebar button icon. Owner props: { size, active }. */
		function MarketIcon({ size = 18 }) {
			return jsx(Glyph, { name: 'store', size });
		}

		/* ---------------------------------------------------------------- *
		 * Registration
		 * ---------------------------------------------------------------- */

		const inject = ['slots', 'locale'];

		/**
		 * Read the active locale id.
		 *
		 * `LocaleSnapshot` carries the id in `active`; there is no `locale` or `language`
		 * field, and reading a field that does not exist silently pins every user to one
		 * language. The fallback is English because that is the locale the shipped UI opens
		 * in when the browser names no registered language, and because showing English to
		 * a Chinese reader is a far smaller failure than the reverse.
		 */
		function readLocaleId(ctx) {
			try {
				const snapshot = ctx.locale.getSnapshot?.();
				const value = snapshot?.active;
				return typeof value === 'string' && value ? value.toLowerCase() : 'en';
			} catch {
				return 'en';
			}
		}

		/**
		 * The active locale id, re-read whenever the locale revision changes.
		 *
		 * The revision is a number, so `useSyncExternalStore` gets a stable comparison;
		 * returning the snapshot object itself would risk a render loop. Subscribing is
		 * what makes a language switch repaint this plugin and refetch its copy.
		 */
		function useLocaleId(ctx) {
			const revision = React.useSyncExternalStore(
				(listener) => ctx.locale.subscribe(listener),
				() => ctx.locale.getSnapshot?.().revision ?? 0,
				() => 0,
			);
			return useMemo(() => readLocaleId(ctx), [ctx, revision]);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-market: dictionaries');
			const t = ctx.locale.bind(NS);

			/**
			 * Hand the user to the shipped Plugins page, which owns a plugin once it is
			 * installed. `ctx.layout` is the shipped panel-selection face; it is read at click
			 * time and treated as optional, so a composition without it simply has no button
			 * rather than a plugin that fails to activate.
			 */
			const openPluginsPanel = () => {
				try {
					ctx.get('layout')?.selectPanel?.('plugins');
				} catch {
					// The panel is not registered in this composition.
				}
			};

			// `t` is handed to each surface explicitly: the `main` and `sidebar.panellist`
			// registrations declare no locale namespace, so the renderer would not
			// synthesize the `t` seat for them. `locale` rides the locale revision, so a
			// language switch repaints and refetches instead of waiting for a reload.
			const bind = (Component) => function Bound(props) {
				const locale = useLocaleId(ctx);
				return jsx(Component, {
					...props,
					t,
					api: { post },
					manage: openPluginsPanel,
					locale,
				});
			};
			const Page = bind(MarketPage);
			const Tab = bind(MarketTab);

			// Order 20 sits after the shipped Plugins button and leaves room for other
			// panel entries between them.
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
				name: 'sidebar.panellist',
				id: 'market',
				order: 20,
				label: () => t('nav'),
			}, MarketIcon));

			ctx.slots.inject('main', () => ctx.slots.register({
				name: 'main',
				key: 'market',
			}, Page));

			ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
				name: 'settings.plugins.tab',
				id: 'market',
				order: 20,
				label: () => t('tab'),
				locale: NS,
			}, Tab));
		}

		exports.apply = apply;
		exports.inject = inject;
		// Exposed for verification only; the module loader uses `apply` and `inject`.
		exports.__internals = { MarketBody, MarketDetail, MarketRow, RiskDialog, MarketIcon, ShotLightbox, MarketPage, MarketTab, Glyph, mergeSources, readLocaleId, zh, en };
		return module.exports;
	},
});
