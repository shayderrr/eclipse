(() => {
	"use strict";

	if (window.__pulsarPrivacyInstalled) {
		window.__pulsarApplyPrivacyConfig?.(window.__PULSAR_PRIVACY_CONFIG__ || {});
		return;
	}
	window.__pulsarPrivacyInstalled = true;

	let config = {
		shieldsEnabled: true,
		sendGpc: true,
		fingerprintingProtection: true,
		blockWebRtc: true,
		blockThirdPartyCookies: true,
		...(window.__PULSAR_PRIVACY_CONFIG__ || {}),
	};

	const nativeFetch = window.fetch?.bind(window);
	const nativeXhrOpen = window.XMLHttpRequest?.prototype.open;
	const nativeXhrSend = window.XMLHttpRequest?.prototype.send;
	const nativeGetParameter =
		window.WebGLRenderingContext?.prototype.getParameter;
	const nativeGetParameter2 =
		window.WebGL2RenderingContext?.prototype.getParameter;
	const nativeRtc = {
		RTCPeerConnection: window.RTCPeerConnection,
		webkitRTCPeerConnection: window.webkitRTCPeerConnection,
		mozRTCPeerConnection: window.mozRTCPeerConnection,
	};
	const nativeNavigator = {
		hardwareConcurrency: window.navigator.hardwareConcurrency,
		deviceMemory: window.navigator.deviceMemory,
		doNotTrack: window.navigator.doNotTrack,
		globalPrivacyControl: window.navigator.globalPrivacyControl,
	};

	function defineNavigatorSignal(name, getter) {
		try {
			Object.defineProperty(window.navigator, name, {
				configurable: true,
				get: getter,
			});
		} catch (_) {}
	}

	function isThirdParty(value) {
		if (!config.shieldsEnabled || !config.blockThirdPartyCookies) return false;
		try {
			const target = new URL(
				value instanceof Request ? value.url : String(value),
				window.location.href
			);
			const current = new URL(window.location.href);
			return (
				target.hostname !== current.hostname &&
				!target.hostname.endsWith(`.${current.hostname}`) &&
				!current.hostname.endsWith(`.${target.hostname}`)
			);
		} catch (_) {
			return false;
		}
	}

	function applyWebRtcProtection() {
		const blocked = config.shieldsEnabled && config.blockWebRtc;
		for (const [name, nativeValue] of Object.entries(nativeRtc)) {
			try {
				window[name] = blocked ? undefined : nativeValue;
			} catch (_) {}
		}
	}

	function installNavigatorProtections() {
		defineNavigatorSignal("globalPrivacyControl", () =>
			config.shieldsEnabled && config.sendGpc
				? true
				: nativeNavigator.globalPrivacyControl
		);
		defineNavigatorSignal("doNotTrack", () =>
			config.shieldsEnabled && config.sendGpc ? "1" : nativeNavigator.doNotTrack
		);
		defineNavigatorSignal("hardwareConcurrency", () =>
			config.shieldsEnabled && config.fingerprintingProtection
				? 4
				: nativeNavigator.hardwareConcurrency
		);
		defineNavigatorSignal("deviceMemory", () =>
			config.shieldsEnabled && config.fingerprintingProtection
				? 8
				: nativeNavigator.deviceMemory
		);
	}

	function installWebGlProtection(prototype, nativeMethod) {
		if (!prototype || !nativeMethod) return;
		prototype.getParameter = function pulsarGetParameter(parameter) {
			if (config.shieldsEnabled && config.fingerprintingProtection) {
				if (parameter === 37445) return "Pulsar";
				if (parameter === 37446) return "Privacy Renderer";
			}
			return nativeMethod.call(this, parameter);
		};
	}

	if (nativeFetch) {
		window.fetch = function pulsarPrivacyFetch(input, init = {}) {
			if (!isThirdParty(input)) return nativeFetch(input, init);
			if (input instanceof Request) {
				return nativeFetch(
					new Request(input, {
						...init,
						credentials: "omit",
					})
				);
			}
			return nativeFetch(input, {
				...init,
				credentials: "omit",
			});
		};
	}

	if (nativeXhrOpen && nativeXhrSend) {
		window.XMLHttpRequest.prototype.open = function pulsarPrivacyOpen(
			method,
			url,
			...rest
		) {
			this.__pulsarThirdParty = isThirdParty(url);
			return nativeXhrOpen.call(this, method, url, ...rest);
		};
		window.XMLHttpRequest.prototype.send = function pulsarPrivacySend(...args) {
			if (this.__pulsarThirdParty) {
				try {
					this.withCredentials = false;
				} catch (_) {}
			}
			return nativeXhrSend.apply(this, args);
		};
	}

	installWebGlProtection(
		window.WebGLRenderingContext?.prototype,
		nativeGetParameter
	);
	installWebGlProtection(
		window.WebGL2RenderingContext?.prototype,
		nativeGetParameter2
	);
	installNavigatorProtections();

	window.__pulsarApplyPrivacyConfig = (nextConfig = {}) => {
		config = {
			...config,
			...nextConfig,
		};
		applyWebRtcProtection();
	};

	window.__pulsarApplyPrivacyConfig(config);
})();
