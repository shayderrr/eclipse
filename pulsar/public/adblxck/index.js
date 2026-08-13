(() => {
	"use strict";

	const STORAGE_KEY = "adblxckenabld";
	const MODE_STORAGE_KEY = "pulsar-tracker-mode";
	const CONFIG_EVENT = "adblxckconfig";
	const CACHE_NAME = "adblxcklists";
	const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
	const CACHE_TS_KEY = "qblocker-fetched-at";
	// Keep malformed or pathological filter entries from making the browser's
	// regexp compiler abort the whole proxy page (V8 reports this as
	// "regexp too big"). Long rules are not useful enough to justify taking
	// down the transport startup path.
	const MAX_FILTER_RULE_LENGTH = 4096;
	const MAX_REGEX_RULE_LENGTH = 2048;

	const BLOCKED_RESPONSE = new Response(null, {
		status: 204,
		statusText: "Blocked by qBlocker",
	});

	function getListBase() {
		if (typeof document !== "undefined") {
			const el =
				document.currentScript ||
				document.querySelector('script[src*="adblxck"]');
			const scriptSrc = el?.getAttribute("src") || el?.src;
			if (scriptSrc) {
				try {
					return new URL(".", scriptSrc).pathname;
				} catch (_) {
					if (scriptSrc.startsWith("/")) {
						return scriptSrc.slice(0, scriptSrc.lastIndexOf("/") + 1);
					}
				}
			}
			// When Pulsar is mounted below a parent app (for example
			// /pulsar/public/), resolve from the document URL instead of the
			// origin root so the bundled lists are found.
			try {
				return new URL("./adblxck/", document.baseURI || location.href).pathname;
			} catch (_) {
				return `${location.origin}/adblxck/`;
			}
		}
		return new URL("./adblxck/", self.location.href).pathname;
	}

	const LIST_BASE = getListBase();
	const IS_INJECTED_PROXY_PAGE =
		typeof document !== "undefined" &&
		Boolean(document.currentScript?.hasAttribute("data-sj-adblock-keep"));

	const STANDARD_LIST_PATHS = [`${LIST_BASE}easylist.txt`];
	const AGGRESSIVE_LIST_PATHS = [
		...STANDARD_LIST_PATHS,
		`${LIST_BASE}easyprivacy.txt`,
	];
	const COMPATIBILITY_FIRST_PARTY_HOSTS = [
		"now.gg",
		"nowgg.fun",
		"nowgg.com",
		"nvidia.com",
		"geforcenow.com",
		"nvidiagrid.net",
		"nvidia-services.net",
		"speed.cloudflare.com",
		"fast.com",
		"netflix.com",
		"speedtest.net",
		"ookla.com",
	];

	const WHITELIST_FILTERS = `
@@||cdn.example.com^
@@||fonts.googleapis.com^
@@||fonts.gstatic.com^
@@||ajax.googleapis.com^
@@||cdnjs.cloudflare.com^
@@||unpkg.com^
@@||jsdelivr.net^
@@||github.com^
@@||githubusercontent.com^
@@||raw.githubusercontent.com^
@@||stackoverflow.com^
@@||wikipedia.org^

@@||npmjs.com^
@@||registry.npmjs.org^
@@||nodejs.org^
@@||deno.land^
@@||esm.sh^
@@||skypack.dev^

@@||gitlab.com^
@@||bitbucket.org^

@@||sourceforge.net^
@@||archive.org^

@@||developer.mozilla.org^
@@||w3schools.com^
@@||caniuse.com^

@@||cloudflare.com^
@@||cloudfront.net^

@@||googleapis.com^
@@||gstatic.com^

@@||reddit.com^
@@||redditstatic.com^

@@||twitter.com^
@@||x.com^

@@||discord.com^
@@||discordapp.com^

@@||microsoft.com^
@@||windows.net^
@@||azureedge.net^

@@||amazonaws.com^
@@||awsstatic.com^

@@||imgur.com^
@@||i.imgur.com^

@@||openai.com^
@@||platform.openai.com^

@@||vercel.app^
@@||netlify.app^
@@||herokuapp.com^

@@||stackexchange.com^
@@||superuser.com^
@@||askubuntu.com^
`.trim();

	const COSMETIC_SELECTORS = [
		"ins.adsbygoogle",
		"ins.adsbygoogle[data-ad-status='unfilled']",
		"iframe[src*='doubleclick.net']",
		"iframe[src*='googlesyndication.com']",
		"iframe[id^='google_ads_iframe']",
		"iframe[id^='aswift_']",
		"div[id^='google_ads_iframe']",
		"div[id^='div-gpt-ad']",
		"[id^='div-ad-']",
		"div[id*='google_ad']",
		"div[data-ad-client]",
		"div[data-ad-slot]",
		"div[data-adunit]",
		"[data-google-query-id]",
		"#google_image_div",
		"#ad_text",
		"iframe[scramjet-attr-src*='doubleclick.net']",
		"iframe[scramjet-attr-src*='googlesyndication.com']",
		"iframe[scramjet-attr-src*='adnxs.com']",
		"img[scramjet-attr-src*='2mdn.net']",
		"img[scramjet-attr-src*='googlesyndication.com']",
		"a[scramjet-attr-href*='doubleclick.net']",
		"a[scramjet-attr-href*='googlesyndication.com']",
		"div[id^='div-gpt-']",
		"div[id^='dfp-ad-']",
		"div[id^='dfp_ad_']",
		"div[class^='dfp-ad']",
		"div[id*='dfp-slot']",
		"div[id*='adsense']",
		"div[id*='adSense']",
		"iframe[src*='adnxs.com']",
		"div[id*='appnexus']",
		"div[id^='taboola-']",
		"div[class^='trc_related_container']",
		"div[id*='taboola']",
		"div[class*='taboola']",
		"a[href*='taboola.com/policies/cookie']",
		"div[id^='outbrain_widget']",
		"div[data-widget-id^='MB_']",
		"div[class^='OUTBRAIN']",
		"div[id^='outbrain-']",
		"iframe[src*='amazon-adsystem.com']",
		"div[class*='amazon-native-ad']",
		"div[id^='cto_']",
		"div[id*='criteo']",
		"iframe[id*='criteo']",
		"div[id^='div-oas-ad']",
		"div[id*='medianet']",
		"div[id^='mn_']",
		"iframe[src*='openx.net']",
		"iframe[src*='openx.com']",
		"iframe[src*='rubiconproject.com']",
		"iframe[src*='pubmatic.com']",
		"iframe[src*='adnxs.com']",
		"iframe[src*='adsrvr.org']",
		"iframe[src*='taboola.com']",
		"iframe[src*='outbrain.com']",
		"iframe[src*='revcontent.com']",
		"iframe[src*='mgid.com']",
		"iframe[src*='media.net']",
		"iframe[src*='criteo.com']",
		"iframe[src*='criteo.net']",
		"iframe[src*='casalemedia.com']",
		"iframe[src*='contextweb.com']",
		"div[data-ad-type]",
		"div[data-ad-format]",
		"div[data-ad-rendering-status]",
		"div[data-adzerk]",
		"div[id*='outstream']",
		"div[id*='prebid']",
		"script[src*='pagead2.googlesyndication.com']",
		"script[src*='securepubads.g.doubleclick.net']",
		"script[src*='cdn.krxd.net']",
		"script[src*='cdn.taboola.com']",
		"script[src*='cdn.outbrain.com']",
		"script[src*='js.adscale.de']",
		"script[src*='assets.revcontent.com']",
		"script[src*='s.adroll.com']",
		"ytd-ad-slot-renderer",
		"ytd-display-ad-renderer",
		"ytd-promoted-sparkles-web-renderer",
		"ytd-promoted-video-renderer",
		"ytd-in-feed-ad-layout-renderer",
		"ytd-banner-promo-renderer",
		"ytm-companion-ad-renderer",
		"#masthead-ad",
		"#player-ads",
		".video-ads",
		".ytp-ad-module",
		".ytp-ad-overlay-container",
		".ytp-ad-player-overlay",
		".ytp-ad-image-overlay",
		".ytp-ad-text-overlay",
		".ytp-ad-survey",
		".ytp-ad-progress-list",
	];

	function parseNetworkFilters(raw) {
		const blockRules = [];
		const exceptionRules = [];

		for (const rawLine of raw.split("\n")) {
			const line = rawLine.trim();
			if (
				!line ||
				line.length > MAX_FILTER_RULE_LENGTH ||
				line.startsWith("!") ||
				line.startsWith("[")
			)
				continue;

			if (line.includes("##") || line.includes("#@#") || line.includes("#?#"))
				continue;
			const lowerLine = line.toLowerCase();
			if (
				lowerLine.includes("$generichide") ||
				lowerLine.includes("$elemhide") ||
				lowerLine.includes("$genericblock") ||
				/\$[^$]*\bdomain=/i.test(line)
			) {
				continue;
			}

			const isException = line.startsWith("@@");
			const rule = isException ? line.slice(2) : line;
			const matcher = compileMatcher(rule);
			if (matcher) (isException ? exceptionRules : blockRules).push(matcher);
		}

		return { blockRules, exceptionRules };
	}

	function compileMatcher(rule) {
		rule = stripFilterOptions(rule).trim();
		if (!rule || rule.length > MAX_FILTER_RULE_LENGTH) return null;
		if (rule.startsWith("/") && rule.endsWith("/") && rule.length > 2) {
			const pattern = rule.slice(1, -1);
			if (pattern.length > MAX_REGEX_RULE_LENGTH) return null;
			try {
				const rx = new RegExp(pattern, "i");
				return (url) => {
					try {
						return rx.test(url);
					} catch (_) {
						return false;
					}
				};
			} catch (_) {
				return null;
			}
		}
		const domainAnchor = rule.startsWith("||");
		const startAnchor = !domainAnchor && rule.startsWith("|");
		const endAnchor = rule.endsWith("|");
		if (domainAnchor) rule = rule.slice(2);
		else if (startAnchor) rule = rule.slice(1);
		if (endAnchor) rule = rule.slice(0, -1);
		if (!rule) return null;
		const indexedDomain = domainAnchor
			? rule.match(/^([^/^*|]+)/)?.[1]?.toLowerCase() || ""
			: "";
		const escaped = escapeRegex(rule)
			.replace(/\\\*/g, ".*")
			.replace(/\\\^/g, "(?:[^a-z0-9_.%-]|$)");
		const prefix = domainAnchor ? "(?:^|[./])" : startAnchor ? "^" : "";
		const suffix = endAnchor ? "$" : "";
		if (escaped.length > MAX_REGEX_RULE_LENGTH) return null;
		try {
			const rx = new RegExp(`${prefix}${escaped}${suffix}`, "i");
			const matcher = (url) => {
				try {
					return rx.test(domainAnchor ? stripScheme(url) : url);
				} catch (_) {
					return false;
				}
			};
			if (indexedDomain) matcher.domain = indexedDomain;
			return matcher;
		} catch (_) {
			return null;
		}
	}

	function stripFilterOptions(rule) {
		if (rule.startsWith("/")) {
			const closingSlash = findRegexClosingSlash(rule);
			if (
				closingSlash > 0 &&
				(closingSlash === rule.length - 1 || rule[closingSlash + 1] === "$")
			) {
				return rule.slice(0, closingSlash + 1);
			}
		}
		const optionIndex = rule.indexOf("$");
		return optionIndex === -1 ? rule : rule.slice(0, optionIndex);
	}

	function findRegexClosingSlash(rule) {
		for (let index = rule.length - 1; index > 0; index--) {
			if (rule[index] === "/" && rule[index - 1] !== "\\") return index;
		}
		return -1;
	}

	function escapeRegex(str) {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function stripScheme(url) {
		return url.replace(/^[a-z]+:\/\//, "");
	}

	let enabled = true;
	let mode = "standard";
	let standardBlockRules = [];
	let aggressiveBlockRules = [];
	let exceptionRules = [];
	let standardBlockIndex = buildRuleIndex([]);
	let aggressiveBlockIndex = buildRuleIndex([]);
	let exceptionRuleIndex = buildRuleIndex([]);
	let listsReady = false;

	async function getCachedText(url) {
		try {
			const cache = await caches.open(CACHE_NAME);
			const cached = await cache.match(url);
			if (cached) return cached.text();
		} catch (_) {}
		return null;
	}

	async function cacheText(url, text) {
		try {
			const cache = await caches.open(CACHE_NAME);
			await cache.put(
				url,
				new Response(text, { headers: { "Content-Type": "text/plain" } })
			);
		} catch (_) {}
	}

	function getCacheFetchedAt() {
		try {
			const raw = localStorage.getItem(CACHE_TS_KEY);
			return raw ? Number(raw) : 0;
		} catch (_) {
			return 0;
		}
	}

	function setCacheFetchedAt() {
		try {
			localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
		} catch (_) {}
	}

	function isCacheStale() {
		return Date.now() - getCacheFetchedAt() > CACHE_TTL_MS;
	}

	async function loadListTexts() {
		const stale = isCacheStale();

		const texts = await Promise.all(
			AGGRESSIVE_LIST_PATHS.map(async (path) => {
				if (!stale) {
					const cached = await getCachedText(path);
					if (cached) return cached;
				}
				try {
					const res = await fetch(path);
					if (!res.ok) throw new Error(`${res.status}`);
					const text = await res.text();
					await cacheText(path, text);
					return text;
				} catch (err) {
					console.warn(`[qBlocker] Failed to fetch ${path}:`, err);
					const cached = await getCachedText(path);
					return cached ?? "";
				}
			})
		);

		if (stale) setCacheFetchedAt();
		return texts;
	}

	async function init() {
		const whitelist = parseNetworkFilters(WHITELIST_FILTERS);
		exceptionRules = whitelist.exceptionRules;
		const texts = await loadListTexts();
		const standardParsed = parseNetworkFilters(texts[0] || "");
		const aggressiveParsed = parseNetworkFilters(texts.join("\n"));

		standardBlockRules = standardParsed.blockRules;
		aggressiveBlockRules = aggressiveParsed.blockRules;
		exceptionRules = [
			...whitelist.exceptionRules,
			...aggressiveParsed.exceptionRules,
		];
		standardBlockIndex = buildRuleIndex(standardBlockRules);
		aggressiveBlockIndex = buildRuleIndex(aggressiveBlockRules);
		exceptionRuleIndex = buildRuleIndex(exceptionRules);
		listsReady = true;

		console.log(
			`[qBlocker] Loaded ${standardBlockRules.length} standard rules, ${aggressiveBlockRules.length} aggressive rules`
		);
	}

	function loadEnabled() {
		try {
			return localStorage.getItem(STORAGE_KEY) !== "false";
		} catch (_) {
			return true;
		}
	}

	function storeEnabled(nextEnabled) {
		enabled = Boolean(nextEnabled);
		if (!enabled) mode = "off";
		else if (mode === "off") mode = "standard";
		try {
			localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
			localStorage.setItem(MODE_STORAGE_KEY, mode);
		} catch (_) {}
		postConfigToServiceWorker();
		if (enabled) runCosmeticFilter();
	}

	function loadMode() {
		try {
			const stored = localStorage.getItem(MODE_STORAGE_KEY);
			if (["aggressive", "standard", "off"].includes(stored)) return stored;
		} catch (_) {}
		return loadEnabled() ? "standard" : "off";
	}

	function storeMode(nextMode) {
		if (!["aggressive", "standard", "off"].includes(nextMode)) return;
		mode = nextMode;
		enabled = mode !== "off";
		try {
			localStorage.setItem(MODE_STORAGE_KEY, mode);
			localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
		} catch (_) {}
		postConfigToServiceWorker();
		if (enabled) runCosmeticFilter();
	}

	function shouldBlockRequest(url, requestedMode = mode) {
		if (
			!enabled ||
			!listsReady ||
			!["aggressive", "standard"].includes(requestedMode)
		)
			return false;
		if (shouldBypassRequest(url)) return false;
		const urlStr = getMatchUrl(url);
		if (!urlStr) return false;
		if (matchesIndexedRules(exceptionRuleIndex, urlStr)) return false;
		const ruleIndex =
			requestedMode === "standard"
				? standardBlockIndex
				: aggressiveBlockIndex;
		return matchesIndexedRules(ruleIndex, urlStr);
	}

	function buildRuleIndex(rules) {
		const domainRules = new Map();
		const genericRules = [];
		for (const matcher of rules) {
			if (!matcher.domain) {
				genericRules.push(matcher);
				continue;
			}
			const current = domainRules.get(matcher.domain) || [];
			current.push(matcher);
			domainRules.set(matcher.domain, current);
		}
		return { domainRules, genericRules };
	}

	function matchesIndexedRules(index, url) {
		for (const matcher of index.genericRules) {
			if (matcher(url)) return true;
		}
		let hostname = "";
		try {
			hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
		} catch (_) {}
		if (!hostname) return false;
		const parts = hostname.split(".");
		for (let offset = 0; offset < parts.length; offset++) {
			const candidates = index.domainRules.get(parts.slice(offset).join("."));
			if (!candidates) continue;
			for (const matcher of candidates) {
				if (matcher(url)) return true;
			}
		}
		return false;
	}

	function getMatchUrl(value) {
		let decoded = String(value || "");
		for (let pass = 0; pass < 3; pass++) {
			try {
				const next = decodeURIComponent(decoded);
				if (next === decoded) break;
				decoded = next;
			} catch (_) {
				break;
			}
		}

		const marker = "/service/scramjet/";
		const markerIndex = decoded.indexOf(marker);
		if (markerIndex !== -1) {
			const routed = decoded.slice(markerIndex + marker.length);
			const remoteIndex = routed.search(/https?:\/\//i);
			if (remoteIndex !== -1) decoded = routed.slice(remoteIndex);
		}
		return decoded.toLowerCase();
	}

	function shouldBypassRequest(url) {
		const matchUrl = getMatchUrl(url);
		try {
			const hostname = new URL(matchUrl).hostname
				.toLowerCase()
				.replace(/^www\./, "");
			return COMPATIBILITY_FIRST_PARTY_HOSTS.some(
				(host) => hostname === host || hostname.endsWith(`.${host}`)
			);
		} catch (_) {
			return false;
		}
	}

	function removeAdElement(element) {
		if (!(element instanceof Element)) return;
		if (element.closest("[data-sj-adblock-keep]")) return;
		if (element.tagName === "SCRIPT") {
			element.type = "text/plain";
		}
		element.remove();
	}

	function runCosmeticFilter(root = document) {
		if (!enabled || !root.querySelectorAll) return;
		for (const selector of COSMETIC_SELECTORS) {
			try {
				root.querySelectorAll(selector).forEach(removeAdElement);
			} catch (_) {}
		}
		for (const element of root.querySelectorAll("span, p, h1, h2, h3, h4")) {
			if (element.children.length) continue;
			if (element.textContent?.trim() === "Ads help keep now.gg Free!") {
				removeAdElement(element);
			}
		}
		skipYouTubeAd(root);
	}

	function skipYouTubeAd(root = document) {
		if (!enabled || !root.querySelector) return;
		const skipButton = root.querySelector(
			".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern"
		);
		if (skipButton instanceof HTMLElement) skipButton.click();

		const player = root.querySelector("#movie_player");
		const video = root.querySelector("video");
		if (
			player?.classList?.contains("ad-showing") &&
			video instanceof HTMLVideoElement &&
			Number.isFinite(video.duration) &&
			video.duration > 0
		) {
			try {
				video.currentTime = Math.max(0, video.duration - 0.05);
			} catch (_) {}
		}

		const playerResponses = [
			window.ytInitialPlayerResponse,
			typeof player?.getPlayerResponse === "function"
				? player.getPlayerResponse()
				: null,
		];
		for (const response of playerResponses) {
			if (!response || typeof response !== "object") continue;
			delete response.adPlacements;
			delete response.playerAds;
			delete response.adSlots;
			delete response.adBreakHeartbeatParams;
			delete response.adBreakParams;
		}
	}

	function installMutationObserver() {
		if (typeof MutationObserver === "undefined") return;
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.type === "attributes") {
					runCosmeticFilter(mutation.target);
					continue;
				}
				for (const node of mutation.addedNodes) {
					if (node.nodeType !== Node.ELEMENT_NODE) continue;
					runCosmeticFilter(node);
				}
			}
		});
		observer.observe(document.documentElement || document, {
			attributes: true,
			attributeFilter: ["class"],
			childList: true,
			subtree: true,
		});
	}

	function installNetworkGuards() {
		const nativeFetch = window.fetch;
		if (typeof nativeFetch === "function") {
			window.fetch = function guardedFetch(input, init) {
				const url = input instanceof Request ? input.url : String(input);
				if (shouldBlockRequest(url)) {
					return Promise.resolve(BLOCKED_RESPONSE.clone());
				}
				return nativeFetch.call(this, input, init);
			};
		}

		const nativeOpen = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function guardedOpen(method, url, ...rest) {
			this.__sj_blocked = shouldBlockRequest(url);
			return nativeOpen.call(this, method, url, ...rest);
		};

		const nativeSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.send = function guardedSend(...args) {
			if (this.__sj_blocked) {
				this.onload = null;
				this.onerror = null;
				this.onreadystatechange = null;
				this.abort();
				return;
			}
			return nativeSend.apply(this, args);
		};
	}

	function injectIntoHtml(response) {
		const contentType = response.headers.get("content-type") || "";
		if (!enabled || !contentType.includes("text/html")) {
			return Promise.resolve(response.clone());
		}
		return response.text().then((html) => {
			const scriptPath = new URL("./adblxck/index.js", self.location.href)
				.pathname;
			const script = `<script src="${scriptPath}" data-sj-adblock-keep><\/script>`;
			const nextHtml = html.includes("</head>")
				? html.replace("</head>", `${script}</head>`)
				: `${script}${html}`;
			const headers = new Headers(response.headers);
			headers.delete("content-length");
			return new Response(nextHtml, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		});
	}

	function postConfigToServiceWorker() {
		if (!("serviceWorker" in navigator)) return;
		const send = (worker) => {
			if (worker) worker.postMessage({ type: CONFIG_EVENT, enabled, mode });
		};
		send(navigator.serviceWorker.controller);
		navigator.serviceWorker.ready
			.then((reg) => send(reg.active))
			.catch(() => {});
	}

	function installWindowAdblock() {
		mode = loadMode();
		enabled = mode !== "off" && loadEnabled();
		if (!IS_INJECTED_PROXY_PAGE) installNetworkGuards();
		if (!IS_INJECTED_PROXY_PAGE) {

			const startLists = () => init().catch(console.error);
			if (typeof requestIdleCallback === "function") {
				requestIdleCallback(startLists, { timeout: 5000 });
			} else {
				setTimeout(startLists, 2500);
			}
		}

		const run = () => {
			runCosmeticFilter();
			installMutationObserver();
			postConfigToServiceWorker();
		};

		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", run);
		} else {
			run();
		}
	}

	function installServiceWorkerAdblock(scope) {
		// Do not parse the multi-megabyte filter lists during Service Worker
		// startup. Scramjet can begin serving the first document immediately;
		// shields become active once the browser is idle.
		setTimeout(() => init().catch(console.error), 2500);
		scope.addEventListener("message", (event) => {
			if (!event.data || event.data.type !== CONFIG_EVENT) return;
			enabled = event.data.enabled !== false;
			if (["aggressive", "standard", "off"].includes(event.data.mode)) {
				mode = event.data.mode;
			}
		});
	}

	const api = {
		STORAGE_KEY,
		MODE_STORAGE_KEY,
		COSMETIC_SELECTORS,
		shouldBlockRequest,
		shouldBypassRequest,
		injectIntoHtml,
		runCosmeticFilter,
		setEnabled: storeEnabled,
		setMode: storeMode,
		isEnabled: () => enabled,
		getMode: () => mode,
		isReady: () => listsReady,
	};

	if (typeof window !== "undefined" && typeof document !== "undefined") {
		window.ScramjetAdblock = api;
		installWindowAdblock();
	} else if (typeof self !== "undefined") {
		self.ScramjetAdblock = api;
		installServiceWorkerAdblock(self);
	}
})();
