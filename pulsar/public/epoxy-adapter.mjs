import EpoxyTransport, { epoxyInfo } from "./epoxy/index.mjs";

function toHeaderEntries(headers) {
	if (!headers) return [];
	if (headers instanceof Headers) return [...headers.entries()];
	if (typeof headers[Symbol.iterator] === "function") return headers;

	return Object.entries(headers).flatMap(([key, value]) => {
		if (Array.isArray(value)) return value.map((item) => [key, item]);
		return [[key, value]];
	});
}

function toBareHeaders(headers) {
	const entries =
		headers instanceof Headers
			? headers.entries()
			: typeof headers?.[Symbol.iterator] === "function"
				? headers
				: Object.entries(headers || {});
	const bareHeaders = {};

	for (const [rawKey, rawValue] of entries) {
		const key = String(rawKey).toLowerCase();
		const values = Array.isArray(rawValue) ? rawValue : [rawValue];

		for (const value of values) {
			if (value === undefined || value === null) continue;
			const nextValue = String(value);
			const currentValue = bareHeaders[key];

			if (currentValue === undefined) {
				bareHeaders[key] = nextValue;
			} else if (Array.isArray(currentValue)) {
				currentValue.push(nextValue);
			} else {
				bareHeaders[key] = [currentValue, nextValue];
			}
		}
	}

	return bareHeaders;
}

async function normalizeEpoxyBody(body) {
	if (body instanceof ReadableStream) {
		return new Response(body).arrayBuffer();
	}

	return body;
}

export { epoxyInfo };

export default class EpoxyAdapterTransport extends EpoxyTransport {
	async request(remote, method, body, headers, signal) {
		const response = await super.request(
			remote,
			method,
			await normalizeEpoxyBody(body),
			toHeaderEntries(headers),
			signal
		);

		return {
			...response,
			headers: toBareHeaders(response.headers),
		};
	}

	connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
		return super.connect(
			url,
			protocols,
			toHeaderEntries(requestHeaders),
			onopen,
			onmessage,
			onclose,
			onerror
		);
	}
}
