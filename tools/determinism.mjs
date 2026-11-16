// Runs the scripted scenario on every available host and compares the
// fingerprints. A mismatch means the hosts would diverge in real play.
//
//   node tools/determinism.mjs [--seed 2026] [--ticks 600] [--edge http://localhost:5173]
//
// Hosts:
//   native   target/release/native-server           (cargo build --release -p native-server)
//   node     apps/web/src/wasm/server.wasm in Node  (pnpm build:wasm)
//   workerd  the Durable Object behind --edge       (pnpm dev, development mode only)
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ServerCore } from "../apps/web/src/shared/server-core.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const seed = arg("seed", "2026");
const ticks = Number(arg("ticks", "600"));
const edge = arg("edge", null);

const results = [];
const run = promisify(execFile);

const native = join(root, "target/release/native-server");
if (existsSync(native)) {
	const [scenario, probe] = await Promise.all([
		run(native, ["scenario", seed, String(ticks)], { encoding: "utf8" }),
		run(native, ["noise", seed], { encoding: "utf8" }),
	]);
	const out = JSON.parse(scenario.stdout);
	const noise = probe.stdout.trim();
	results.push({ host: "native (x86-64)", hash: out.hash, noise });
} else {
	console.warn("skipped native: build it with `cargo build --release -p native-server`");
}

const wasm = readFileSync(join(root, "apps/web/src/wasm/server.wasm"));
const core = ServerCore.fromModule(new WebAssembly.Module(wasm));
results.push({ host: `node ${process.version} (wasm)`, hash: core.runScenario(BigInt(seed), ticks), noise: core.noiseFingerprint(BigInt(seed)) });

if (edge) {
	const res = await fetch(`${edge}/api/debug/scenario?seed=${seed}&ticks=${ticks}`);
	if (!res.ok) throw new Error(`edge scenario failed: ${res.status} ${await res.text()}`);
	const out = await res.json();
	results.push({ host: "workerd Durable Object (wasm)", hash: out.hash, noise: out.noise });
}

for (const r of results) console.log(`${r.hash}  noise=${r.noise}  ${r.host}`);
const distinct = new Set(results.map((r) => r.hash));
if (results.length < 2) {
	console.error("need at least two hosts to compare");
	process.exit(2);
}
const noiseDistinct = new Set(results.map((r) => r.noise));
if (distinct.size !== 1 || noiseDistinct.size !== 1 || results.some((r) => !/^[0-9a-f]{16}$/.test(r.noise))) {
	console.error(`MISMATCH: ${distinct.size} scenario / ${noiseDistinct.size} noise results for seed ${seed}, ${ticks} ticks`);
	process.exit(1);
}
console.log(`OK: ${results.length} hosts agree (seed ${seed}, ${ticks} ticks)`);
