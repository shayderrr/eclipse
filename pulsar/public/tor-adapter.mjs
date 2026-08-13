const STRIPPED_RESPONSE_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"content-encoding",
	"content-length",
]);

const STATUSES_WITHOUT_BODY = new Set([101, 204, 205, 304]);

export function isOnionHost(hostname) {
	const host = String(hostname || "")
		.toLowerCase()
		.replace(/\.$/, "");
	return host !== "onion" && host.endsWith(".onion");
}

function toHeaderPairs(headers) {
	if (!headers) return [];
	if (typeof Headers !== "undefined" && headers instanceof Headers) {
		return [...headers.entries()];
	}
	if (Array.isArray(headers)) {
		return headers
			.filter((entry) => Array.isArray(entry) && entry.length >= 2)
			.map(([key, value]) => [String(key), String(value)]);
	}
	if (typeof headers[Symbol.iterator] === "function") {
		return [...headers].map(([key, value]) => [String(key), String(value)]);
	}
	return Object.entries(headers).flatMap(([key, value]) => {
		if (value === undefined || value === null) return [];
		if (Array.isArray(value)) {
			return value.map((item) => [String(key), String(item)]);
		}
		return [[String(key), String(value)]];
	});
}

function toResponseHeaderPairs(pairs) {
	const result = [];
	for (const [rawKey, rawValue] of pairs) {
		const key = String(rawKey).toLowerCase();
		if (STRIPPED_RESPONSE_HEADERS.has(key)) continue;
		result.push([key, String(rawValue)]);
	}
	return result;
}

function readHeader(headers, name) {
	const wanted = name.toLowerCase();
	for (const [key, value] of toHeaderPairs(headers)) {
		if (String(key).toLowerCase() === wanted) return value;
	}
	return "";
}

function encodeBase64(bytes) {
	let binary = "";
	const CHUNK = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}
	return btoa(binary);
}

async function bodyToBase64(body) {
	if (body === undefined || body === null || body === "") return "";
	const buffer = await new Response(body).arrayBuffer();
	if (!buffer.byteLength) return "";
	return encodeBase64(new Uint8Array(buffer));
}

function errorResponse(status, message) {
	const html = `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Pulsar Tor</title>
		<style>
			body {
				margin: 0;
				min-height: 100vh;
				display: grid;
				place-items: center;
				background: #0b0d12;
				color: #f5f7fb;
				font: 15px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			}
			main { max-width: 34rem; padding: 1.5rem; text-align: center; }
			p { color: #aab3c5; }
		</style>
	</head>
	<body>
		<main>
			<h1>Onion request failed</h1>
			<p>${String(message).replace(
				/[<>&"]/g,
				(char) =>
					({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[char]
			)}</p>
		</main>
	</body>
</html>`;
	return {
		status,
		statusText: "Tor routing error",
		headers: [["content-type", "text/html; charset=utf-8"]],
		body: new TextEncoder().encode(html).buffer,
	};
}

class TorRouter {
	constructor(base, options = {}) {
		this.base = base;
		this.getEndpoint = options.getEndpoint || (() => "");
		this.onRouted = options.onRouted || (() => {});
		this.onFailure = options.onFailure || (() => {});
	}

	async request(remote, method, body, headers, signal) {
		let url;
		try {
			url = remote instanceof URL ? remote : new URL(String(remote));
		} catch (_) {
			return this.base.request(remote, method, body, headers, signal);
		}

		if (!isOnionHost(url.hostname)) {
			return this.base.request(remote, method, body, headers, signal);
		}

		const endpoint = this.getEndpoint();
		if (!endpoint) {
			return errorResponse(
				502,
				"No Tor server is configured. Add wisptor endpoints to torUrls in config.js, then pick one under Settings > Network."
			);
		}

		try {
			const response = await this.torFetch(
				endpoint,
				url,
				method,
				body,
				headers,
				signal
			);
			this.onRouted(endpoint, url);
			return response;
		} catch (error) {
			this.onFailure(endpoint, error);
			return errorResponse(
				502,
				`Tor server ${endpoint} could not fetch this onion address. ${
					error?.message || error || ""
				}`
			);
		}
	}

	async torFetch(endpoint, url, method, body, headers, signal) {
		const payload = {
			url: url.toString(),
			method: String(method || "GET").toUpperCase(),
			headers: toHeaderPairs(headers).filter(
				([key]) => !STRIPPED_RESPONSE_HEADERS.has(String(key).toLowerCase())
			),
			body: await bodyToBase64(body),
		};

		const tunneled = await this.base.request(
			new URL(endpoint),
			"POST",
			JSON.stringify(payload),
			[
				["content-type", "application/json"],
				["accept", "application/octet-stream"],
			],
			signal
		);

		if (!tunneled || tunneled.status >= 500) {
			throw new Error(
				`wisptor returned ${tunneled?.status || "no response"} for /tor-fetch`
			);
		}

		const realStatus = Number(readHeader(tunneled.headers, "x-real-status"));
		const realStatusText = readHeader(tunneled.headers, "x-real-status-text");
		const rawRealHeaders = readHeader(tunneled.headers, "x-real-headers");

		let realHeaders = [];
		if (rawRealHeaders) {
			try {
				const parsed = JSON.parse(rawRealHeaders);
				realHeaders = toHeaderPairs(parsed);
			} catch (_) {
				realHeaders = [];
			}
		}

		const status = Number.isFinite(realStatus) && realStatus ? realStatus : 200;
		return {
			status,
			statusText: realStatusText || "",
			headers: toResponseHeaderPairs(realHeaders),
			body: STATUSES_WITHOUT_BODY.has(status) ? undefined : tunneled.body,
		};
	}

	connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
		let parsed = null;
		try {
			parsed = url instanceof URL ? url : new URL(String(url));
		} catch (_) {}

		if (parsed && isOnionHost(parsed.hostname)) {

			setTimeout(
				() =>
					onerror(
						"Pulsar cannot open WebSocket connections to onion services over wisptor."
					),
				0
			);
			return [() => {}, () => {}];
		}

		return this.base.connect(
			url,
			protocols,
			requestHeaders,
			onopen,
			onmessage,
			onclose,
			onerror
		);
	}
}

export default function createTorRoutingTransport(base, options = {}) {
	const router = new TorRouter(base, options);
	const request = router.request.bind(router);
	const connect = router.connect.bind(router);

	return new Proxy(base, {
		get(target, property) {
			if (property === "request") return request;
			if (property === "connect") return connect;
			if (property === "__pulsarTorRouter") return router;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			target[property] = value;
			return true;
		},
	});
}
