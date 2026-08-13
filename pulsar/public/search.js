"use strict";

function search(input, template) {
	const asSearchQuery = () => template.replace("%s", encodeURIComponent(input));
	const hasExplicitProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input);

	if (hasExplicitProtocol) {
		try {

			return new URL(input).toString();
		} catch (err) {

			console.warn(
				`[pulsar-search] "${input}" looked like a URL (has a scheme) but failed to parse: ${err?.message || err}. Falling back to a search query.`
			);
			return asSearchQuery();
		}
	}

	if (!/\s/.test(input)) {
		try {

			const url = new URL(`https://${input}`);
			if (isProbablyHostname(url.hostname)) return url.toString();
		} catch (_) {

		}
	}

	return asSearchQuery();
}

function isProbablyHostname(hostname) {
	const host = hostname.toLowerCase();
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
		return host.split(".").every((part) => Number(part) <= 255);
	}
	if (!host.includes(".") || host.includes("..")) return false;
	const labels = host.split(".");
	const tld = labels[labels.length - 1];
	if (tld.length < 2 || !/[a-z]/.test(tld)) return false;
	return labels.every(
		(label) =>
			label.length > 0 &&
			label.length <= 63 &&
			/^[a-z0-9-]+$/.test(label) &&
			!label.startsWith("-") &&
			!label.endsWith("-")
	);
}
