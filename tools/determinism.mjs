// Runs the scripted scenario on every available host and compares the
// fingerprints. A mismatch means the hosts would diverge in real play.
//
//   node tools/determinism.mjs [--seed 2026] [--ticks 600] [--edge http://localhost:5173] [--browsers chromium,firefox,webkit]
//
// Hosts:
//   native   target/release/native-server           (cargo build --release -p native-server)
//   node     apps/web/src/wasm/server.wasm in Node  (pnpm build:wasm)
//   workerd  the Durable Object behind --edge       (pnpm dev, development mode only)
//   browsers apps/web/src/wasm/server.wasm in Playwright (--browsers)
import { deepStrictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { hashToHex, SERVER_ABI_VERSION, ServerCore } from "../apps/web/src/shared/server-core.ts";

const browserEngines = new Map([
	["chromium", "V8"],
	["firefox", "SpiderMonkey"],
	["webkit", "JavaScriptCore"],
]);
const browserTimeout = 120_000;

function parseBrowsers(value) {
	const names = (value ?? "").split(",").map((name) => name.trim());
	if (names.includes("")) throw new Error("--browsers requires a comma-separated list of browser names");
	for (const name of names) {
		if (!browserEngines.has(name)) {
			throw new Error(`unknown browser "${name}" (use ${[...browserEngines.keys()].join(", ")})`);
		}
	}
	return names;
}

// Playwright serializes this function to run in the page, so keep it self-contained.
async function runRawWasm({ base64, seed, ticks, abiVersion }) {
	const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
	const { instance } = await WebAssembly.instantiate(bytes, {});
	const wasm = instance.exports;
	const abi = wasm.server_abi_version();
	if (abi !== abiVersion) {
		throw new Error(`server.wasm ABI ${abi}, host expects ${abiVersion}`);
	}
	const wasmSeed = BigInt.asIntN(64, BigInt(seed));
	return {
		hash: wasm.server_run_scenario(wasmSeed, ticks),
		noise: wasm.server_noise_fingerprint(wasmSeed),
		terrain: wasm.server_terrain_fingerprint(wasmSeed),
	};
}

function formatFingerprints({ hash, noise, terrain }) {
	return { hash: hashToHex(hash), noise: hashToHex(noise), terrain: hashToHex(terrain) };
}

async function runBrowser(browserType, name, input) {
	const start = performance.now();
	let browser;
	try {
		browser = await browserType.launch({ timeout: browserTimeout });
	} catch (err) {
		throw new Error(`browser launch failed. Install it with \`pnpm exec playwright install ${name}\`\n${err.message}`);
	}

	let timer;
	try {
		// page.evaluate has no Playwright timeout. Count launch time toward the same deadline.
		const remaining = Math.max(0, browserTimeout - (performance.now() - start));
		const deadline = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out after ${browserTimeout / 1000}s`)), remaining);
		});
		const evaluate = async () => {
			const page = await browser.newPage({ offline: true });
			return page.evaluate(runRawWasm, input);
		};
		const fingerprints = await Promise.race([evaluate(), deadline]);
		return {
			host: `${name} ${browser.version()} (${browserEngines.get(name)}, wasm)`,
			...formatFingerprints(fingerprints),
		};
	} finally {
		clearTimeout(timer);
		await browser.close();
	}
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const seed = arg("seed", "2026");
const ticks = Number(arg("ticks", "600"));
const edge = arg("edge", null);
let browsers = [];
if (process.argv.includes("--browsers")) {
	try {
		browsers = parseBrowsers(arg("browsers"));
	} catch (err) {
		console.error(err.message);
		process.exit(2);
	}
}

const results = [];
const run = promisify(execFile);

const native = join(root, "target/release/native-server");
if (existsSync(native)) {
	const [scenario, probe, terrainProbe] = await Promise.all([
		run(native, ["scenario", seed, String(ticks)], { encoding: "utf8" }),
		run(native, ["noise", seed], { encoding: "utf8" }),
		run(native, ["terrain", seed], { encoding: "utf8" }),
	]);
	const out = JSON.parse(scenario.stdout);
	const noise = probe.stdout.trim();
	results.push({ host: "native (x86-64)", hash: out.hash, noise, terrain: terrainProbe.stdout.trim() });
} else {
	console.warn("skipped native: build it with `cargo build --release -p native-server`");
}

const wasm = readFileSync(join(root, "apps/web/src/wasm/server.wasm"));
const core = ServerCore.fromModule(new WebAssembly.Module(wasm));
const nodeSeed = BigInt(seed);
const nodeFingerprints = {
	hash: core.runScenario(nodeSeed, ticks),
	noise: core.noiseFingerprint(nodeSeed),
	terrain: core.terrainFingerprint(nodeSeed),
};
results.push({ host: `node ${process.version} (wasm)`, ...nodeFingerprints });

if (edge) {
	const res = await fetch(`${edge}/api/debug/scenario?seed=${seed}&ticks=${ticks}`);
	if (!res.ok) throw new Error(`edge scenario failed: ${res.status} ${await res.text()}`);
	const out = await res.json();
	results.push({ host: "workerd Durable Object (wasm)", hash: out.hash, noise: out.noise, terrain: out.terrain });
}

if (browsers.length > 0) {
	const input = { base64: wasm.toString("base64"), seed, ticks, abiVersion: SERVER_ABI_VERSION };
	deepStrictEqual(formatFingerprints(await runRawWasm(input)), nodeFingerprints, "raw WASM fingerprints differ from ServerCore");
	const playwright = await import("playwright");
	for (const name of browsers) {
		try {
			results.push(await runBrowser(playwright[name], name, input));
		} catch (err) {
			console.error(`${name}: ${err.message}`);
			process.exit(2);
		}
	}
}

for (const r of results) console.log(`${r.hash}  noise=${r.noise}  terrain=${r.terrain}  ${r.host}`);
const distinct = new Set(results.map((r) => r.hash));
if (results.length < 2) {
	console.error("need at least two hosts to compare");
	process.exit(2);
}
const noiseDistinct = new Set(results.map((r) => r.noise));
const terrainDistinct = new Set(results.map((r) => r.terrain));
if (terrainDistinct.size !== 1 || results.some((r) => !/^[0-9a-f]{16}$/.test(r.terrain)) || distinct.size !== 1 || noiseDistinct.size !== 1 || results.some((r) => !/^[0-9a-f]{16}$/.test(r.noise))) {
	console.error(`MISMATCH: ${distinct.size} scenario / ${noiseDistinct.size} noise / ${terrainDistinct.size} terrain results for seed ${seed}, ${ticks} ticks`);
	process.exit(1);
}
console.log(`OK: ${results.length} hosts agree (seed ${seed}, ${ticks} ticks)`);
