importScripts("./controller/controller.sw.js");
importScripts("./adblxck/index.js?v=stable-20260812-1");

const PULSAR_SW_VERSION = "scramjet-v2-20260812-mounted-route-v2";
const SERVICE_ROUTE_PREFIX = new URL("service/", self.registration.scope).pathname;
const SCRAMJET_ROUTE_PREFIX = new URL(
	"service/scramjet/",
	self.registration.scope
).pathname;
const MEDIA_DESTINATIONS = new Set(["audio", "track", "video"]);
const SHELL_CACHE_NAME = `pulsar-shell-${PULSAR_SW_VERSION}`;
const SHELL_PRECACHE_URLS = [
	"./",
	"./index.html",
	"./index.css",
	"./index.js",
	"./config.js",
];

const TRANSPORT_ERROR_PATTERNS = [
	"MuxTaskEnded",
	"Multiplexor task ended",
	"Wisp:",
	"UnexpectedEof",
	"tls handshake eof",
	"SSL connect error",
	"error code 35",
	"certificate",
	"hyper_util::client::legacy::Error(Connect",
	"Failed to fetch",
];
const DOCUMENT_DESTINATIONS = new Set([
	"document",
	"embed",
	"frame",
	"iframe",
	"object",
]);

const DEFAULT_PRIVACY_CONFIG = {
	shieldsEnabled: true,
	trackerMode: "standard",
	blockScripts: false,
	sendGpc: true,
	fingerprintingProtection: true,
	blockWebRtc: true,
	blockThirdPartyCookies: true,
	disabledHosts: [],
	enabledHosts: [],
	siteSettings: {},
};

const SHIELDS_OFF_HOSTS = [
	"now.gg",
	"nowgg.fun",
	"nowgg.com",
	"nvidia.com",
	"geforcenow.com",
	"nvidiagrid.net",
	"nvidia-services.net",
];
let privacyConfig = { ...DEFAULT_PRIVACY_CONFIG };

const PRIVACY_BLOCK_FLUSH_MS = 400;
const INTERNAL_ERROR_BODY_LIMIT = 4096;
const HEAD_SCAN_LIMIT = 65536;
const CHARSET_META_WINDOW = 1024;
const blockedBatch = new Map();
let blockedFlushTimer = null;

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(SHELL_CACHE_NAME)
			.then((cache) =>
				Promise.allSettled(
					SHELL_PRECACHE_URLS.map((url) =>
						cache.add(url).catch(() => {})
					)
				)
			)
			.catch(() => {})
	);
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key.startsWith("pulsar-shell-") && key !== SHELL_CACHE_NAME)
						.map((key) => caches.delete(key))
				)
			)
			.catch(() => {})
	);
	event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
	if (event.data?.type === "pulsar-privacy-config") {
		const nextConfig = event.data.config || {};
		privacyConfig = {
			...DEFAULT_PRIVACY_CONFIG,
			...nextConfig,
			disabledHosts: Array.isArray(nextConfig.disabledHosts)
				? nextConfig.disabledHosts
				: [],
			enabledHosts: Array.isArray(nextConfig.enabledHosts)
				? nextConfig.enabledHosts
				: [],
			siteSettings:
				nextConfig.siteSettings && typeof nextConfig.siteSettings === "object"
					? nextConfig.siteSettings
					: {},
		};
		return;
	}

	if (event.data?.type === "pulsar-sw-version-request") {
		const port = event.ports?.[0];
		port?.postMessage({
			type: "pulsar-sw-version",
			version: PULSAR_SW_VERSION,
		});
		return;
	}

	if (event.data?.type === "pulsar-sw-skip-waiting") {
		self.skipWaiting();
	}
});

function isRangeRequest(request) {
	return request.headers.has("range");
}

function shouldSkipAdblockInjection(request) {
	return isRangeRequest(request) || MEDIA_DESTINATIONS.has(request.destination);
}

function shouldSkipAdblockNetwork(request) {
	return (
		shouldSkipAdblockInjection(request) ||
		self.ScramjetAdblock?.shouldBypassRequest?.(request.url)
	);
}

function extractRemoteUrl(value) {
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
	return decoded;
}

function getHostname(value) {
	try {
		return new URL(extractRemoteUrl(value)).hostname
			.toLowerCase()
			.replace(/\.$/, "");
	} catch (_) {
		return "";
	}
}

function getRequestSiteHost(request) {
	return getHostname(request.referrer) || getHostname(request.url);
}

function hasShieldsOffHost(hostname) {
	const host = String(hostname || "")
		.toLowerCase()
		.replace(/^www\./, "");
	if (!host) return false;
	return SHIELDS_OFF_HOSTS.some(
		(entry) => host === entry || host.endsWith(`.${entry}`)
	);
}

function getEffectivePrivacyConfig(request) {
	const siteHost = getRequestSiteHost(request);
	const site = privacyConfig.siteSettings?.[siteHost] || {};
	const getBoolean = (key) =>
		typeof site[key] === "boolean" ? site[key] : privacyConfig[key];
	let shieldsEnabled = privacyConfig.shieldsEnabled !== false;
	if (typeof site.shieldsEnabled === "boolean") {
		shieldsEnabled = site.shieldsEnabled;
	}
	if (privacyConfig.disabledHosts.includes(siteHost)) shieldsEnabled = false;
	if (privacyConfig.enabledHosts.includes(siteHost)) shieldsEnabled = true;
	if (hasShieldsOffHost(siteHost)) shieldsEnabled = false;
	const trackerMode = ["aggressive", "standard", "off"].includes(
		site.trackerMode
	)
		? site.trackerMode
		: privacyConfig.trackerMode;
	return {
		...privacyConfig,
		siteHost,
		shieldsEnabled,
		trackerMode: shieldsEnabled ? trackerMode : "off",
		blockScripts: shieldsEnabled && getBoolean("blockScripts"),
		sendGpc: shieldsEnabled && getBoolean("sendGpc"),
		fingerprintingProtection:
			shieldsEnabled && getBoolean("fingerprintingProtection"),
		blockWebRtc: shieldsEnabled && getBoolean("blockWebRtc"),
		blockThirdPartyCookies:
			shieldsEnabled && getBoolean("blockThirdPartyCookies"),
	};
}

function isThirdPartyRequest(request, effectivePrivacy) {
	const requestHost = getHostname(request.url);
	const siteHost = effectivePrivacy.siteHost;
	if (!requestHost || !siteHost) return false;
	return (
		requestHost !== siteHost &&
		!requestHost.endsWith(`.${siteHost}`) &&
		!siteHost.endsWith(`.${requestHost}`)
	);
}

function notifyPrivacyBlocked(event, reason) {
	const siteHost = getRequestSiteHost(event.request);
	const key = `${siteHost}|${reason}|${event.request.destination}`;
	const existing = blockedBatch.get(key);
	if (existing) {
		existing.count += 1;
	} else {
		blockedBatch.set(key, {
			reason,
			siteHost,
			requestUrl: extractRemoteUrl(event.request.url),
			destination: event.request.destination,
			count: 1,
		});
	}
	if (blockedFlushTimer) return;
	blockedFlushTimer = setTimeout(() => {
		blockedFlushTimer = null;
		flushPrivacyBlocked().catch(() => {});
	}, PRIVACY_BLOCK_FLUSH_MS);
}

async function flushPrivacyBlocked() {
	if (!blockedBatch.size) return;
	const entries = [...blockedBatch.values()];
	blockedBatch.clear();
	const clients = await self.clients.matchAll({
		includeUncontrolled: true,
		type: "window",
	});
	for (const client of clients) {
		client.postMessage({
			type: "pulsar-privacy-blocked-batch",
			entries,
		});
	}
}

function createBlockedResponse(reason) {
	return new Response(null, {
		status: 204,
		statusText: `Blocked by Pulsar Shields: ${reason}`,
	});
}

function isTransportError(error) {
	const message = String(error?.message || error || "").toLowerCase();
	return TRANSPORT_ERROR_PATTERNS.some((pattern) =>
		message.includes(pattern.toLowerCase())
	);
}

async function notifyTransportError(error, event) {

	const clients = await self.clients.matchAll({
		includeUncontrolled: true,
		type: "window",
	});
	for (const client of clients) {
		client.postMessage({
			type: "pulsar-transport-error",
			message: String(error?.message || error || ""),
			url: event.request.url,
			destination: event.request.destination,
			mode: event.request.mode,
			isMedia: MEDIA_DESTINATIONS.has(event.request.destination),
		});
	}
}

function createTransportRecoveryResponse(event, error) {
	if (!DOCUMENT_DESTINATIONS.has(event.request.destination)) {
		return new Response(null, {
			status: 204,
			statusText: "Proxy transport recovering",
		});
	}

	return new Response(
		`<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Pulsar</title>
		<style>
			body {
				margin: 0;
				min-height: 100vh;
				display: grid;
				place-items: center;
				background: #0b0d12;
			}
			.spinner {
				width: 30px;
				height: 30px;
				border: 3px solid #2b3446;
				border-top-color: #7aa2ff;
				border-radius: 50%;
				animation: pulsar-spin 0.8s linear infinite;
			}
			@keyframes pulsar-spin {
				to {
					transform: rotate(360deg);
				}
			}
		</style>
	</head>
	<body>
		<div class="spinner" aria-label="Retrying" role="status"></div>
		<script>
			(() => {
				var key = "pulsar-recovery-attempts:" + location.pathname;
				var attempts = 0;
				try {
					attempts = parseInt(sessionStorage.getItem(key) || "0", 10) || 0;
				} catch (_) {}
				try {
					sessionStorage.setItem(key, String(attempts + 1));
				} catch (_) {}
				setTimeout(function () {
					location.reload();
				}, 600 + Math.min(attempts, 12) * 800);
			})();
		</script>
	</body>
</html>`,
		{
			status: 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		}
	);
}

function couldBeInternalErrorBody(response) {
	const contentType = (response.headers.get("content-type") || "").toLowerCase();
	if (contentType.includes("text/html")) return false;
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > INTERNAL_ERROR_BODY_LIMIT)
		return false;
	return true;
}

const SCRAMJET_ROUTE_RE =
	/^([^/]+)\/([^/]+)\/(https?%3A%2F%2F[^?#]*)(.*)$/i;

async function rebuildLeakedRequest(event) {
	let requestUrl;
	try {
		requestUrl = new URL(event.request.url);
	} catch (_) {
		return null;
	}
	if (requestUrl.origin !== self.location.origin) return null;
	if (!requestUrl.pathname.startsWith(SCRAMJET_ROUTE_PREFIX)) return null;
	const routeMatch = requestUrl.pathname
		.slice(SCRAMJET_ROUTE_PREFIX.length)
		.match(SCRAMJET_ROUTE_RE);
	if (!routeMatch) return null;

	let innerUrl;
	try {
		innerUrl = new URL(decodeURIComponent(routeMatch[3]));
	} catch (_) {
		console.log("[leak-fix] inner URL parse failed", routeMatch[3]);
		return null;
	}
	if (innerUrl.origin !== self.location.origin) return null;

	const cid = event.clientId || event.resultingClientId;
	const client = cid ? await self.clients.get(cid) : null;
	const clientUrl = client && client.url;
	console.log("[leak-fix] leak detected", {
		req: event.request.url,
		clientId: cid,
		clientUrl,
	});
	if (!clientUrl) return null;
	const clientMatch = clientUrl.match(/\/(https?%3A%2F%2F[^/?#]+)/i);
	if (!clientMatch) return null;
	let remoteOrigin;
	try {
		remoteOrigin = new URL(decodeURIComponent(clientMatch[1])).origin;
	} catch (_) {
		return null;
	}
	if (new URL(remoteOrigin).origin === self.location.origin) return null;

	const remoteParsed = new URL(remoteOrigin);
	innerUrl.protocol = remoteParsed.protocol;
	innerUrl.hostname = remoteParsed.hostname;
	innerUrl.port = remoteParsed.port;
	innerUrl.username = "";
	innerUrl.password = "";
	const encoded = encodeURIComponent(innerUrl.toString());
	requestUrl.pathname =
		`${SCRAMJET_ROUTE_PREFIX}${routeMatch[1]}/${routeMatch[2]}/${encoded}${routeMatch[4] || ""}`;
	console.log("[leak-fix] rewriting to", requestUrl.toString());
	return new Request(requestUrl.toString(), event.request);
}

async function routeRequest(event) {
	try {
		const rebuilt = await rebuildLeakedRequest(event).catch(() => null);
		const routingEvent = rebuilt
			? {
					request: rebuilt,
					clientId: event.clientId,
					resultingClientId: event.resultingClientId,
					respondWith: () => {},
					waitUntil: (p) => event.waitUntil?.(p),
				}
			: event;
		const response = await self.$scramjetController.route(routingEvent);
		if (response.status === 500 && couldBeInternalErrorBody(response)) {
			const message = await response
				.clone()
				.text()
				.catch(() => "");
			if (
				message.length <= INTERNAL_ERROR_BODY_LIMIT &&
				isTransportError(message)
			) {
				await notifyTransportError(message, event);
				if (
					event.request.mode === "navigate" ||
					DOCUMENT_DESTINATIONS.has(event.request.destination)
				) {
					return createTransportRecoveryResponse(event, message);
				}
			}
		}
		return response;
	} catch (error) {
		if (!isTransportError(error)) throw error;
		await notifyTransportError(error, event);
		return createTransportRecoveryResponse(event, error);
	}
}

function buildInjectionMarkup(includeAdblock, effectivePrivacy) {
	const compatPath = new URL("./proxy-compat.js", self.location.href).pathname;
	const adblockPath = new URL("./adblxck/index.js", self.location.href)
		.pathname;
	const privacyPath = new URL("./proxy-privacy.js", self.location.href)
		.pathname;
	const serializedPrivacy = JSON.stringify(effectivePrivacy).replace(
		/</g,
		"\\u003c"
	);
	return [
		`<script data-sj-privacy-config>window.__PULSAR_PRIVACY_CONFIG__=${serializedPrivacy};<\/script>`,
		`<script src="${privacyPath}" data-sj-privacy-keep><\/script>`,
		`<script src="${compatPath}" data-sj-compat-keep><\/script>`,
		includeAdblock
			? `<script src="${adblockPath}" data-sj-adblock-keep><\/script>`
			: "",
	].join("");
}

function concatBytes(left, right) {
	if (!left) return right;
	const merged = new Uint8Array(left.length + right.length);
	merged.set(left, 0);
	merged.set(right, left.length);
	return merged;
}

function findInjectionOffset(text) {
	const head = /<head\b[^>]*>/i.exec(text);
	if (!head) return -1;
	const headEnd = head.index + head[0].length;
	const charsetPattern = /<meta\b[^>]*charset[^>]*>/gi;
	let match;
	while ((match = charsetPattern.exec(text)) !== null) {
		if (match.index < headEnd) continue;
		if (match.index > Math.max(CHARSET_META_WINDOW, headEnd)) break;
		return match.index + match[0].length;
	}
	return headEnd;
}

function createHeadInjector(markup) {
	const payload = new TextEncoder().encode(markup);
	let pending = null;
	let injected = false;

	const emit = (controller, bytes, offset) => {
		if (offset > 0) controller.enqueue(bytes.subarray(0, offset));
		controller.enqueue(payload);
		if (offset < bytes.length) controller.enqueue(bytes.subarray(offset));
		injected = true;
		pending = null;
	};

	return new TransformStream({
		transform(chunk, controller) {
			if (injected) {
				controller.enqueue(chunk);
				return;
			}
			pending = concatBytes(pending, new Uint8Array(chunk));
			const text = new TextDecoder("latin1").decode(pending);
			const offset = findInjectionOffset(text);
			if (offset !== -1) {
				emit(controller, pending, offset);
				return;
			}
			if (pending.length >= HEAD_SCAN_LIMIT) {

				emit(controller, pending, 0);
			}
		},
		flush(controller) {
			if (injected) return;
			const bytes = pending || new Uint8Array(0);
			const text = new TextDecoder("latin1").decode(bytes);
			const offset = findInjectionOffset(text);
			emit(controller, bytes, offset === -1 ? 0 : offset);
		},
	});
}

function injectPageScripts(response, includeAdblock, effectivePrivacy) {
	const contentType = response.headers.get("content-type") || "";
	if (!contentType.includes("text/html") || !response.body) return response;

	const markup = buildInjectionMarkup(includeAdblock, effectivePrivacy);
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	try {
		return new Response(response.body.pipeThrough(createHeadInjector(markup)), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	} catch (_) {
		return response;
	}
}

function stripThirdPartyCookieHeaders(response, request, effectivePrivacy) {
	if (
		!effectivePrivacy.blockThirdPartyCookies ||
		!isThirdPartyRequest(request, effectivePrivacy) ||
		!response.headers.has("set-cookie")
	) {
		return response;
	}
	const headers = new Headers(response.headers);
	headers.delete("set-cookie");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function handleRequest(event) {
	const effectivePrivacy = getEffectivePrivacyConfig(event.request);
	if (effectivePrivacy.blockScripts && event.request.destination === "script") {
		notifyPrivacyBlocked(event, "script");
		return createBlockedResponse("script");
	}

	if (
		self.ScramjetAdblock &&
		effectivePrivacy.shieldsEnabled &&
		effectivePrivacy.trackerMode !== "off" &&
		!shouldSkipAdblockNetwork(event.request) &&
		self.ScramjetAdblock.shouldBlockRequest(
			event.request.url,
			effectivePrivacy.trackerMode
		)
	) {
		notifyPrivacyBlocked(event, "tracker");
		return createBlockedResponse("tracker");
	}

	const routedResponse = await routeRequest(event);
	const response = stripThirdPartyCookieHeaders(
		routedResponse,
		event.request,
		effectivePrivacy
	);
	const includeAdblock = Boolean(
		self.ScramjetAdblock &&
		effectivePrivacy.shieldsEnabled &&
		effectivePrivacy.trackerMode !== "off" &&
		!shouldSkipAdblockInjection(event.request) &&
		self.ScramjetAdblock.isEnabled()
	);
	return injectPageScripts(response, includeAdblock, effectivePrivacy);
}

// jsDelivr serves repository .html as text/plain with nosniff. The shell
// responses this worker hands out must be real HTML documents, so re-serve
// same-origin .html responses with an HTML content type.
function serveShellHtml(request, response) {
	if (!response || !response.ok) return response;
	let requestUrl;
	try {
		requestUrl = new URL(request.url);
	} catch (_) {
		requestUrl = null;
	}
	if (!requestUrl || !/\.html$/i.test(requestUrl.pathname)) return response;
	const headers = new Headers(response.headers);
	headers.set("content-type", "text/html; charset=utf-8");
	headers.delete("x-content-type-options");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function refreshShellCache(request) {
	try {
		const response = await fetch(request);
		if (response && response.ok) {
			const cache = await caches.open(SHELL_CACHE_NAME);
			await cache.put(request, response);
		}
	} catch (_) {}
}

async function cacheFirstShell(request) {
	const cache = await caches.open(SHELL_CACHE_NAME);
	const cached = await cache.match(request, { ignoreVary: true });
	if (cached) {
		refreshShellCache(request);
		return serveShellHtml(request, cached);
	}
	const response = await fetch(request);
	if (response && response.ok) {
		const copy = response.clone();
		cache.put(request, copy).catch(() => {});
	}
	return serveShellHtml(request, response);
}

async function networkFirstShell(request) {
	const cache = await caches.open(SHELL_CACHE_NAME);
	try {
		const response = await fetch(request);
		if (response && response.ok) {
			const copy = response.clone();
			cache.put(request, copy).catch(() => {});
		}
		return serveShellHtml(request, response);
	} catch (_) {
		const cached = await cache.match(request, { ignoreVary: true });
		return cached ? serveShellHtml(request, cached) : Response.error();
	}
}

self.addEventListener("fetch", (event) => {
	if (event.request.method === "GET") {
		let requestUrl;
		try {
			requestUrl = new URL(event.request.url);
		} catch (_) {
			requestUrl = null;
		}
		if (
			requestUrl &&
			requestUrl.origin === self.location.origin &&
			!requestUrl.pathname.startsWith(SERVICE_ROUTE_PREFIX) &&
			!event.request.headers.has("range")
		) {
			if (event.request.mode === "navigate") {
				event.respondWith(networkFirstShell(event.request));
				return;
			}
			event.respondWith(cacheFirstShell(event.request));
			return;
		}
	}

	let shouldRoute = false;
	try {
		shouldRoute = Boolean(self.$scramjetController?.shouldRoute?.(event));
	} catch (_) {
		shouldRoute = false;
	}
	if (shouldRoute) event.respondWith(handleRequest(event));
});
