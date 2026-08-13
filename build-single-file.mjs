import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(packageDir, "pulsar", "public");
const distDir = join(packageDir, "..", "dist");

mkdirSync(distDir, { recursive: true });

const read = (relativePath) => readFileSync(join(packageDir, relativePath), "utf8").replaceAll("\r\n", "\n");
const readPublic = (relativePath) => readFileSync(join(publicDir, relativePath), "utf8").replaceAll("\r\n", "\n");
const readBinary = (relativePath) => readFileSync(join(publicDir, relativePath));
const json = (value) => JSON.stringify(value);
const dataUrl = (value, mime = "text/javascript") =>
	`data:${mime};base64,${Buffer.from(value).toString("base64")}`;
const binaryDataUrl = (value, mime) => dataUrl(value.toString("base64"), mime);
const scriptSafe = (value) => value.replaceAll(/<\/script/gi, "<\\/script");
const inlineScript = (value, attributes = "") =>
	`<script${attributes}>\n${scriptSafe(value)}\n</script>`;

function replaceOnce(source, oldValue, newValue, label) {
	if (!source.includes(oldValue)) throw new Error(`Could not replace ${label}.`);
	return source.replace(oldValue, newValue);
}

function embedAdblock(source, easylistUrl, easyprivacyUrl) {
	return source
		.replace(
			"const STANDARD_LIST_PATHS = [`${LIST_BASE}easylist.txt`];",
			`const STANDARD_LIST_PATHS = [${json(easylistUrl)}];`
		)
		.replace(
			"const AGGRESSIVE_LIST_PATHS = [\n\t\t...STANDARD_LIST_PATHS,\n\t\t`${LIST_BASE}easyprivacy.txt`,\n\t];",
			`const AGGRESSIVE_LIST_PATHS = [${json(easylistUrl)}, ${json(easyprivacyUrl)}];`
		);
}

const easylistUrl = binaryDataUrl(readBinary("adblxck/easylist.txt"), "text/plain");
const easyprivacyUrl = binaryDataUrl(readBinary("adblxck/easyprivacy.txt"), "text/plain");
const faviUrl = binaryDataUrl(readBinary("favi.png"), "image/png");

const rawAdblock = readPublic("adblxck/index.js");
const adblock = embedAdblock(rawAdblock, easylistUrl, easyprivacyUrl);
const proxyCompat = readPublic("proxy-compat.js");
const proxyPrivacy = readPublic("proxy-privacy.js");

const moduleSources = {
	scramjet: readPublic("scramjet/scramjet.mjs"),
	controller: readPublic("controller/controller-external.mjs"),
	libcurl: readPublic("libcurl/index.mjs"),
	tor: readPublic("tor-adapter.mjs"),
};
const moduleUrls = Object.fromEntries(
	Object.entries(moduleSources).map(([name, source]) => [name, dataUrl(source)])
);

let proxyApp = readPublic("index.js");
proxyApp = replaceOnce(
	proxyApp,
	'import { defaultConfig, versionInfo } from "./scramjet/scramjet.mjs";\nimport {\n\tController,\n\tManagedPlugin,\n} from "./controller/controller-external.mjs";\nimport LibcurlTransport from "./libcurl/index.mjs";\nimport EpoxyTransport from "./epoxy/index.mjs";\nimport createTorRoutingTransport from "./tor-adapter.mjs";\n',
	`import { defaultConfig, versionInfo } from ${json(moduleUrls.scramjet)};\nimport { Controller, ManagedPlugin } from ${json(moduleUrls.controller)};\nimport LibcurlTransport from ${json(moduleUrls.libcurl)};\nimport createTorRoutingTransport from ${json(moduleUrls.tor)};\nconst EpoxyTransport = null;\n`,
	"Pulsar module imports"
);
proxyApp = replaceOnce(
	proxyApp,
	'const appBasePath = new URL("./", document.baseURI || window.location.href).pathname;',
	'const appBasePath = new URL("./", document.baseURI).pathname;',
	"Pulsar base path"
);
proxyApp = replaceOnce(
	proxyApp,
	'const FAVICON_FALLBACK = "./favi.png";',
	`const FAVICON_FALLBACK = ${json(faviUrl)};`,
	"Pulsar favicon fallback"
);

let proxyDocument = readPublic("index.html");
proxyDocument = replaceOnce(
	proxyDocument,
	'<meta charset="utf-8" />',
	'<meta charset="utf-8" />\n\t\t<base href="./" />',
	"Pulsar base element"
);
proxyDocument = replaceOnce(
	proxyDocument,
	'<link rel="shortcut icon" href="./favi.png" />',
	`<link rel="shortcut icon" href="${faviUrl}" />`,
	"Pulsar favicon"
);
proxyDocument = replaceOnce(
	proxyDocument,
	'<link rel="stylesheet" href="./index.css" />',
	`<style>\n${readPublic("index.css")}\n</style>`,
	"Pulsar stylesheet"
);

const bundledProxyConfig = `${readPublic("config.js")}
// Epoxy's standalone WASM file is not part of the single-file artifact.
// Use the self-contained libcurl transport for this build.
window.__PULSAR_CONFIG__.defaultTransport = "libcurl";
delete window.__PULSAR_CONFIG__.transports?.epoxy;
`;
const bundledRegisterSW = readPublic("register-sw.js").replace(
	"scramjet-v2-20260812-mounted-route-v2",
	"scramjet-v2-20260812-single-file-v3"
);

const proxyScripts = [
	["./config.js", inlineScript(bundledProxyConfig, " defer")],
	["./register-sw.js", inlineScript(bundledRegisterSW, " defer")],
	["./search.js", inlineScript(readPublic("search.js"), " defer")],
	["./adblxck/index.js", inlineScript(adblock, " defer")],
	["./scramjet/scramjet.js", inlineScript(readPublic("scramjet/scramjet.js"))],
	["./controller/controller.api.js", inlineScript(readPublic("controller/controller.api.js"))],
	["./index.js", inlineScript(proxyApp, ' type="module"')],
];
for (const [path, replacement] of proxyScripts) {
	const scriptPattern = new RegExp(
		`<script src="${path.replaceAll("/", "\\/")}"[^>]*><\\/script>`,
		"g"
	);
	const nextDocument = proxyDocument.replace(scriptPattern, () => replacement);
	if (nextDocument === proxyDocument) throw new Error(`Could not inline Pulsar script ${path}.`);
	proxyDocument = nextDocument;
}

const standaloneServiceWorker = (() => {
	let source = readPublic("sw.js");
	source = source.replace(
		'importScripts("./controller/controller.sw.js");\nimportScripts("./adblxck/index.js?v=stable-20260812-1");\n\n',
		() => `${readPublic("controller/controller.sw.js")}\n${adblock}\n\n`
	);
	source = source.replace(
	'const PULSAR_SW_VERSION = "scramjet-v2-20260812-mounted-route-v2";',		'const PULSAR_SW_VERSION = "scramjet-v2-20260812-single-file-v3";'

	);
	const inlineAssets = {
		"/scramjet/scramjet.js": [readPublic("scramjet/scramjet.js"), "text/javascript"],
		"/controller/controller.inject.js": [readPublic("controller/controller.inject.js"), "text/javascript"],
		"/proxy-compat.js": [proxyCompat, "text/javascript"],
		"/proxy-privacy.js": [proxyPrivacy, "text/javascript"],
		"/adblxck/index.js": [adblock, "text/javascript"],
		"/scramjet/scramjet.wasm": [readBinary("scramjet/scramjet.wasm"), "application/wasm"],
	};
	const assetEntries = Object.entries(inlineAssets).map(([path, [value, mime]]) => {
		const encoded = Buffer.isBuffer(value)
			? value.toString("base64")
			: Buffer.from(value).toString("base64");
		return `${json(path)}: { mime: ${json(mime)}, body: ${json(encoded)} }`;
	});
	const assetBlock = `\nconst INLINE_SINGLE_FILE_ASSETS = {\n\t${assetEntries.join(",\n\t")}\n};\nfunction getInlineSingleFileAsset(request) {\n\tconst url = new URL(request.url);\n\tif (url.origin !== self.location.origin) return null;\n\tconst assetEntry = Object.entries(INLINE_SINGLE_FILE_ASSETS).find(([path]) =>\n\t\turl.pathname === path || url.pathname.endsWith(path)\n\t);\n\tconst asset = assetEntry?.[1];\n\tif (!asset) return null;\n\tconst bytes = Uint8Array.from(atob(asset.body), (char) => char.charCodeAt(0));\n\treturn new Response(bytes, { headers: { "content-type": asset.mime, "cache-control": "public, max-age=31536000, immutable" } });\n}\n`;
	source = source.replace("const MEDIA_DESTINATIONS", () => `${assetBlock}\nconst MEDIA_DESTINATIONS`);	const apiProxyBlock = `
const AI_API_UPSTREAM = "https://nova.notrexed.workers.dev";
const MUSIC_PROXY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function apiCorsHeaders(methods) {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": methods,
		"access-control-allow-headers": "Content-Type, Range",
		"access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
	};
}

async function proxyAiRequest(request) {
	const corsHeaders = apiCorsHeaders("POST, OPTIONS");
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...corsHeaders, "content-type": "text/plain; charset=utf-8" } });
	try {
		const upstream = await fetch(AI_API_UPSTREAM, {
			method: "POST",
			mode: "cors",
			headers: { "content-type": request.headers.get("content-type") || "application/json" },
			body: await request.arrayBuffer(),
		});
		const headers = new Headers(corsHeaders);
		headers.set("content-type", upstream.headers.get("content-type") || "application/json");
		return new Response(upstream.body, { status: upstream.status, headers });
	} catch (error) {
		return new Response(JSON.stringify({ error: { message: "Upstream error: " + (error?.message || error) } }), {
			status: 502,
			headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
		});
	}
}

async function proxyMusicRequest(request) {
	const corsHeaders = apiCorsHeaders("GET, HEAD, OPTIONS");
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
	if (!MUSIC_PROXY_METHODS.has(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...corsHeaders, "content-type": "text/plain; charset=utf-8" } });
	const targetValue = new URL(request.url).searchParams.get("url");
	let target;
	try {
		target = new URL(targetValue || "");
	} catch (_) {
		return new Response("Missing or invalid url parameter", { status: 400, headers: corsHeaders });
	}
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		return new Response("Only HTTP(S) music URLs are supported", { status: 400, headers: corsHeaders });
	}
	try {
		const headers = new Headers();
		for (const name of ["accept", "range", "content-type"]) {
			const value = request.headers.get(name);
			if (value) headers.set(name, value);
		}
		const upstream = await fetch(target, { method: request.method, headers });
		const responseHeaders = new Headers(corsHeaders);
		for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
			const value = upstream.headers.get(name);
			if (value) responseHeaders.set(name, value);
		}
		return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders });
	} catch (error) {
		return new Response(JSON.stringify({ error: error?.message || String(error) }), {
			status: 502,
			headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
		});
	}
}
`;
	source = source.replace(
		'self.addEventListener("fetch", (event) => {',
		() => `${apiProxyBlock}\nself.addEventListener("fetch", (event) => {`
	);
	source = source.replace(
		'\tif (event.request.method === "GET") {',
		() => '\tconst requestUrl = new URL(event.request.url);\n\tconst apiPath = requestUrl.pathname.replace(/\\/+$/, "");\n\tif (requestUrl.origin === self.location.origin && apiPath.endsWith("/api/ai")) {\n\t\tevent.respondWith(proxyAiRequest(event.request));\n\t\treturn;\n\t}\n\tif (requestUrl.origin === self.location.origin && apiPath.endsWith("/api/music")) {\n\t\tevent.respondWith(proxyMusicRequest(event.request));\n\t\treturn;\n\t}\n\tif (event.request.method === "GET") {\n\t\tconst inlineAsset = getInlineSingleFileAsset(event.request);\n\t\tif (inlineAsset) {\n\t\t\tevent.respondWith(Promise.resolve(inlineAsset));\n\t\t\treturn;\n\t\t}'
	);
	return source;
})();

const embeddedDocuments = {
	"eclipse-pulsar": proxyDocument,
	"eclipse-chat": read("chat.html"),
	"eclipse-player": read("player.html"),
};
const embeddedPayloads = Object.fromEntries(
	Object.entries(embeddedDocuments).map(([mode, document]) => [
		mode,
		Buffer.from(document, "utf8").toString("base64"),
	])
);
let rootDocument = read("index.html");
rootDocument = replaceOnce(
	rootDocument,
	'<iframe id="proxy-frame" src="./pulsar/public/index.html" allow="fullscreen"></iframe>',
	'<iframe id="proxy-frame" src="./index.html?eclipse-pulsar=1" allow="fullscreen"></iframe>',
	"Eclipse proxy frame"
);
rootDocument = replaceOnce(
	rootDocument,
	'const PROXY_SRC = new URL("./pulsar/public/index.html", document.baseURI).href;',
	'const PROXY_SRC = new URL("./index.html?eclipse-pulsar=1", document.baseURI).href;',
	"Eclipse proxy URL"
);
rootDocument = replaceOnce(
	rootDocument,
	"        frame.src = PROXY_SRC;",
	"        frame.src = PROXY_SRC;",
	"Eclipse proxy loader"
);

const rootServiceWorkerBoot = `<script>\n(() => {\n  if (!('serviceWorker' in navigator)) return;\n  navigator.serviceWorker.register(new URL('./sw.js', document.baseURI), {\n    scope: new URL('./', document.baseURI).pathname,\n    updateViaCache: 'none'\n  }).catch(() => {});\n})();\n</script>\n`;
const proxyBoot = `<script>\n(() => {\n  const params = new URLSearchParams(location.search);\n  const embeddedDocuments = ${json(embeddedPayloads)};\n  const mode = Object.keys(embeddedDocuments).find((key) => params.has(key));\n  if (!mode) return;\n  const bytes = Uint8Array.from(atob(embeddedDocuments[mode]), (char) => char.charCodeAt(0));\n  const documentText = new TextDecoder().decode(bytes);\n  let rendered = false;\n  const renderEmbeddedDocument = () => {\n    if (rendered) return;\n    rendered = true;\n    document.open();\n    document.write(documentText);\n    document.close();\n  };\n  document.documentElement.style.visibility = "hidden";\n  if (document.readyState === "loading") {\n    document.addEventListener("DOMContentLoaded", renderEmbeddedDocument, { once: true });\n  } else {\n    renderEmbeddedDocument();\n  }\n})();\n</script>\n`;
rootDocument = rootDocument.replace("</head>", `${rootServiceWorkerBoot}${proxyBoot}</head>`);

writeFileSync(join(distDir, "index.html"), rootDocument);
writeFileSync(join(distDir, "sw.js"), standaloneServiceWorker);

// Build a copyable redistribution entrypoint. The SVG entrypoints and service
// worker (written below) keep everything on jsDelivr; the redist wrappers just
// iframe the jsDelivr SVG entrypoint.
const redistDir = join(packageDir, "redist");
mkdirSync(redistDir, { recursive: true });

// Publish HTML-compatible clones as SVG documents. jsDelivr serves SVG with
// image/svg+xml, but intentionally serves repository HTML as text/plain. Each
// clone registers the root service worker first: it re-serves same-origin
// .html documents as text/html, so the frame keeps a real document URL with
// working relative URLs, same-origin access, and the app's service worker.
const svgCdnBase = "https://cdn.jsdelivr.net/gh/shayderrr/eclipse@main/";
const svgHtmlBase = svgCdnBase;
const rootServiceWorker = `
const AI_API_UPSTREAM = "https://nova.notrexed.workers.dev";
const MUSIC_PROXY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function apiCorsHeaders(methods) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": methods,
    "access-control-allow-headers": "Content-Type, Range",
    "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
  };
}

async function proxyAi(request) {
  const cors = apiCorsHeaders("POST, OPTIONS");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...cors, "content-type": "text/plain; charset=utf-8" } });
  try {
    const upstream = await fetch(AI_API_UPSTREAM, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") || "application/json" },
      body: await request.arrayBuffer(),
    });
    const headers = new Headers(cors);
    headers.set("content-type", upstream.headers.get("content-type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: { message: "AI upstream error: " + (error?.message || error) } }), {
      status: 502,
      headers: { ...cors, "content-type": "application/json; charset=utf-8" },
    });
  }
}

async function proxyMusic(request) {
  const cors = apiCorsHeaders("GET, HEAD, OPTIONS");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!MUSIC_PROXY_METHODS.has(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...cors, "content-type": "text/plain; charset=utf-8" } });
  let target;
  try { target = new URL(new URL(request.url).searchParams.get("url") || ""); }
  catch (_) { return new Response("Missing or invalid url parameter", { status: 400, headers: cors }); }
  if (target.protocol !== "http:" && target.protocol !== "https:") return new Response("Only HTTP(S) URLs are supported", { status: 400, headers: cors });
  try {
    const headers = new Headers();
    for (const name of ["accept", "range", "content-type"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(target, { method: request.method, headers });
    const output = new Headers(cors);
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) output.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: output });
  } catch (error) {
    return new Response(JSON.stringify({ error: error?.message || String(error) }), {
      status: 502,
      headers: { ...cors, "content-type": "application/json; charset=utf-8" },
    });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname.replace(/\\/+$/, "");

  if (/\.html$/i.test(path)) {
    // jsDelivr serves repository .html as text/plain with nosniff, which would
    // render as raw text in frames. Re-serve it as a real HTML document so
    // relative URLs, same-origin access, and nested document loads keep a
    // normal document URL.
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        const headers = new Headers(response.headers);
        headers.set("content-type", "text/html; charset=utf-8");
        headers.delete("x-content-type-options");
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        return new Response(
          "Failed to load " + url.href + ": " + (error?.message || error),
          { status: 502, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }
    })());
    return;
  }

  if (path.endsWith("/api/ai")) {
    event.respondWith(proxyAi(event.request));
    return;
  }
  if (path.endsWith("/api/music")) {
    event.respondWith(proxyMusic(event.request));
  }
});
`;
const svgEscape = (value) => String(value)
	.replaceAll("&", "&amp;")
	.replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;")
	.replaceAll('"', "&quot;");

function makeSvgClone({ title, sourcePath, serviceWorkerUrl }) {
	const sourceUrl = JSON.stringify(`${svgHtmlBase}${sourcePath}`);
	const swUrl = serviceWorkerUrl || `new URL("./sw.js", document.baseURI).href`;
	const runtime = `<script><![CDATA[
(() => {
  const SOURCE_URL = ${sourceUrl};
  const SW_URL = ${swUrl};
  const frame = document.getElementById("svg-html-frame");

  // jsDelivr serves repository .html as text/plain, which would render as raw
  // text in a frame. Register the root service worker first: it re-serves
  // same-origin .html documents as text/html, so the frame keeps a real
  // document URL with working relative URLs, same-origin access, and the
  // app's own service worker.
  let loaded = false;
  const load = () => {
    if (loaded || !frame) return;
    loaded = true;
    frame.src = SOURCE_URL;
  };

  if (frame && "serviceWorker" in navigator) {
    navigator.serviceWorker
      .register(SW_URL, { scope: "./", updateViaCache: "none" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        if (navigator.serviceWorker.controller) load();
        else navigator.serviceWorker.addEventListener("controllerchange", load, { once: true });
      })
      .catch(() => load());
  } else {
    load();
  }
})();
]]></script>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="100%" height="100%" preserveAspectRatio="none" style="display:block;overflow:hidden">
  <title>${svgEscape(title)}</title>
  <style>html, body, svg { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; } #svg-html-frame { display: block; width: 100%; height: 100%; border: 0; background: #000; }</style>
  <foreignObject x="0" y="0" width="100%" height="100%" style="overflow:hidden">
    <iframe id="svg-html-frame" xmlns="http://www.w3.org/1999/xhtml" title="${svgEscape(title)}" style="display:block;width:100%;height:100%;border:0"></iframe>
  </foreignObject>
  ${runtime}
</svg>
`;
}

const svgClones = [
	{
		output: join(packageDir, "index.svg"),
		title: "Eclipse",
		sourcePath: "index.html",
	},
	{
		output: join(packageDir, "chat.svg"),
		title: "Eclipse Chat",
		sourcePath: "chat.html",
	},
	{
		output: join(packageDir, "player.svg"),
		title: "Eclipse Player",
		sourcePath: "player.html",
	},
	{
		output: join(publicDir, "index.svg"),
		title: "Pulsar",
		sourcePath: "pulsar/public/index.html",
		serviceWorkerUrl: `new URL("../../sw.js", document.baseURI).href`,
	},
	{
		output: join(publicDir, "404.svg"),
		title: "Pulsar Not Found",
		sourcePath: "pulsar/public/404.html",
		serviceWorkerUrl: `new URL("../../sw.js", document.baseURI).href`,
	},
];
for (const clone of svgClones) writeFileSync(clone.output, makeSvgClone(clone));
writeFileSync(join(packageDir, "sw.js"), rootServiceWorker);
writeFileSync(
	join(redistDir, "index.html"),
	`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Eclipse</title>
  <style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#000}</style>
</head>
<body>
  <iframe title="Eclipse" src="${svgCdnBase}index.svg" allow="fullscreen"></iframe>
</body>
</html>
`
);
writeFileSync(
	join(packageDir, "redist.html"),
	`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Eclipse</title>
  <style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#000}</style>
</head>
<body>
  <iframe title="Eclipse" src="${svgCdnBase}index.svg" allow="fullscreen"></iframe>
</body>
</html>
`
);
console.log(`Built ${join(redistDir, "index.html")}`);
console.log(`Built ${join(distDir, "index.html")}`);
console.log(`Built ${join(distDir, "sw.js")}`);
console.log(`index.html bytes: ${Buffer.byteLength(rootDocument)}`);
console.log(`sw.js bytes: ${Buffer.byteLength(rootServiceWorker)}`);
