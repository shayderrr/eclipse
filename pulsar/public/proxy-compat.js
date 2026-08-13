(() => {
	"use strict";

	if (window.__pulsarPerformanceCompatInstalled) return;
	window.__pulsarPerformanceCompatInstalled = true;

	const nativeStartsWith = String.prototype.startsWith;
	try {
		Object.defineProperty(String.prototype, "startsWith", {
			configurable: true,
			enumerable: false,
			get() {
				return nativeStartsWith;
			},
			set() {},
		});
	} catch (err) {
		console.warn(
			`[pulsar-compat] failed to pin String.prototype.startsWith: ${
				err?.message || err
			}`
		);
	}

	function patchHistoryUrlArgument(method) {
		const native = window.history?.[method];
		if (typeof native !== "function") return;

		try {
			Object.defineProperty(window.history, method, {
				configurable: true,
				writable: true,
				value: function pulsarHistoryMethod(state, title, url) {
					if (arguments.length < 3 || url === undefined || url === null) {
						return native.call(this, state, title, "");
					}
					try {
						return native.call(this, state, title, url);
					} catch (err) {
						if (err && err.name === "SecurityError") return;
						throw err;
					}
				},
			});
		} catch (err) {
			console.warn(
				`[pulsar-compat] failed to patch history.${method}; SPA routing may 404 on two-arg ${method} calls: ${err?.message || err}`
			);
		}
	}

	patchHistoryUrlArgument("pushState");
	patchHistoryUrlArgument("replaceState");

	function restoreRemoteUrl(value) {
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
		if (markerIndex === -1) return decoded;
		const routed = decoded.slice(markerIndex + marker.length);
		const remoteIndex = routed.search(/https?:\/\//i);
		if (remoteIndex === -1) return decoded;
		return routed
			.slice(remoteIndex)
			.replace(/[?&]\$(?:mode|cred|io|rfp|dest|type|module)=[^#]*/i, "");
	}

	const wrappedEntries = new WeakMap();
	function wrapEntry(entry) {
		if (!entry || typeof entry !== "object") return entry;
		if (wrappedEntries.has(entry)) return wrappedEntries.get(entry);

		const wrapped = new Proxy(entry, {
			get(target, property) {
				if (property === "name") return restoreRemoteUrl(target.name);
				if (property === "toJSON") {
					return () => ({
						...target.toJSON(),
						name: restoreRemoteUrl(target.name),
					});
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		wrappedEntries.set(entry, wrapped);
		return wrapped;
	}

	const wrapEntries = (entries) => Array.from(entries, wrapEntry);
	const nativeGetEntries = performance.getEntries.bind(performance);
	const nativeGetEntriesByType = performance.getEntriesByType.bind(performance);

	Object.defineProperties(performance, {
		getEntries: {
			configurable: true,
			value: () => wrapEntries(nativeGetEntries()),
		},
		getEntriesByType: {
			configurable: true,
			value: (type) => wrapEntries(nativeGetEntriesByType(type)),
		},
		getEntriesByName: {
			configurable: true,
			value: (name, type) =>
				wrapEntries(nativeGetEntries()).filter(
					(entry) =>
						entry.name === name && (!type || entry.entryType === type)
				),
		},
	});

	const NativePerformanceObserver = window.PerformanceObserver;
	if (!NativePerformanceObserver) return;

	function wrapEntryList(list) {
		return new Proxy(list, {
			get(target, property) {
				if (property === "getEntries") {
					return () => wrapEntries(target.getEntries());
				}
				if (property === "getEntriesByType") {
					return (type) => wrapEntries(target.getEntriesByType(type));
				}
				if (property === "getEntriesByName") {
					return (name, type) =>
						wrapEntries(target.getEntries()).filter(
							(entry) =>
								entry.name === name && (!type || entry.entryType === type)
						);
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	class PulsarPerformanceObserver {
		static supportedEntryTypes = NativePerformanceObserver.supportedEntryTypes;

		constructor(callback) {
			this.observer = new NativePerformanceObserver((list) => {
				callback(wrapEntryList(list), this);
			});
		}

		observe(options) {
			return this.observer.observe(options);
		}

		disconnect() {
			return this.observer.disconnect();
		}

		takeRecords() {
			return wrapEntries(this.observer.takeRecords());
		}
	}

	window.PerformanceObserver = PulsarPerformanceObserver;
})();
