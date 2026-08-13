"use strict";
const swVersion = "scramjet-v2-20260812-mounted-route-v2";
const stockSW = `./sw.js?v=${swVersion}`;
const swReloadStorageKey = "pulsar-sw-control-reload";
const swUpdateReloadStorageKey = "pulsar-sw-update-reload";

const swAllowedHostnames = ["localhost", "127.0.0.1"];

function waitForServiceWorkerState(worker, state) {
	if (!worker || worker.state === state) return Promise.resolve();
	return new Promise((resolve) => {
		worker.addEventListener(
			"statechange",
			() => {
				if (worker.state === state) resolve();
			},
			{ once: false }
		);
	});
}

function waitForControllerChange(timeoutMs = 4000) {
	return Promise.race([
		new Promise((resolve) => {
			navigator.serviceWorker.addEventListener("controllerchange", resolve, {
				once: true,
			});
		}),
		new Promise((resolve) => setTimeout(resolve, timeoutMs)),
	]);
}

function getControllerVersion(timeoutMs = 800) {
	const controller = navigator.serviceWorker.controller;
	if (!controller) return Promise.resolve("");

	const channel = new MessageChannel();
	return Promise.race([
		new Promise((resolve) => {
			channel.port1.onmessage = (event) => {
				resolve(
					event.data?.type === "pulsar-sw-version"
						? event.data.version || ""
						: ""
				);
			};
			controller.postMessage(
				{
					type: "pulsar-sw-version-request",
				},
				[channel.port2]
			);
		}),
		new Promise((resolve) => setTimeout(() => resolve(""), timeoutMs)),
	]).finally(() => channel.port1.close());
}

async function activateUpdatedServiceWorker(registration) {
	if (registration.waiting) {
		registration.waiting.postMessage({ type: "pulsar-sw-skip-waiting" });
		await waitForControllerChange();
	}

	if (registration.installing) {
		await waitForServiceWorkerState(registration.installing, "activated");
		await waitForControllerChange();
	}
}

async function registerSW() {
	if (!navigator.serviceWorker) {
		if (
			location.protocol !== "https:" &&
			!swAllowedHostnames.includes(location.hostname)
		)
			throw new Error("Service workers cannot be registered without https.");

		throw new Error("Your browser doesn't support service workers.");
	}

	const registration = await navigator.serviceWorker.register(stockSW, {
		scope: "./",
		updateViaCache: "none",
	});
	await registration.update().catch(() => {});
	await activateUpdatedServiceWorker(registration);

	await navigator.serviceWorker.ready;

	if (navigator.serviceWorker.controller) {
		const activeVersion = await getControllerVersion();
		if (activeVersion !== swVersion) {
			await activateUpdatedServiceWorker(registration);
			const recheckedVersion = await getControllerVersion();
			if (
				recheckedVersion !== swVersion &&
				!sessionStorage.getItem(swUpdateReloadStorageKey)
			) {
				sessionStorage.setItem(swUpdateReloadStorageKey, "1");
				location.reload();
				await new Promise(() => {});
			}
		}
		sessionStorage.removeItem(swReloadStorageKey);
		sessionStorage.removeItem(swUpdateReloadStorageKey);
		return registration;
	}

	if (!sessionStorage.getItem(swReloadStorageKey)) {
		sessionStorage.setItem(swReloadStorageKey, "1");
		location.reload();
		await new Promise(() => {});
	}

	return registration;
}

async function registerSWFast() {
	if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
		return registerSW();
	}

	const activeVersion = await getControllerVersion();
	if (activeVersion !== swVersion) return registerSW();

	sessionStorage.removeItem(swReloadStorageKey);
	sessionStorage.removeItem(swUpdateReloadStorageKey);

	navigator.serviceWorker
		.register(stockSW, { scope: "./", updateViaCache: "none" })
		.then((registration) => registration.update())
		.catch(() => {});

	return navigator.serviceWorker.ready;
}
