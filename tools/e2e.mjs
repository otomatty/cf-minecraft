// Drives the real client in headless Chrome against a running dev server.
//
//   node tools/e2e.mjs [--edge http://localhost:5173] [--shots /tmp/shots]
//
// Checks, in single player and against the Durable Object:
//   * a WebGPU device is created and the world around the spawn is meshed and drawn
//   * the frame is not blank (several distinct colours, terrain and sky)
//   * the scenario fingerprint computed in the browser equals Node's
//   * a placed block is confirmed by the server and survives a page reload
//
// Chrome runs with a window, because headless Chrome loses the WebGPU device
// as soon as a canvas is presented when only a software rasterizer is
// available. On a machine without a display, wrap the command:
//   xvfb-run -a -s "-screen 0 1280x720x24" node tools/e2e.mjs
// On such a machine the frame rate says nothing about real hardware.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

import { ServerCore } from "../apps/web/src/shared/server-core.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const edge = arg("edge", "http://localhost:5173");
const shots = arg("shots", "/tmp/shots");
const chrome = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
mkdirSync(shots, { recursive: true });

const run = Date.now().toString(36);
const failures = [];
const check = (ok, label, detail = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
	if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
	executablePath: chrome,
	headless: false,
	args: ["--no-sandbox", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--window-size=1280,720"],
	defaultViewport: { width: 1280, height: 720 },
});

async function open(query) {
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	await page.goto(`${edge}/play.html?${query}`, { waitUntil: "load" });
	// Pointer lock is only granted to the focused tab.
	await page.bringToFront();
	return { page, errors };
}

/** Chunks the server keeps loaded around a player: a square of side 2 * view + 1. */
const chunksInView = (view) => (2 * view + 1) ** 2;

/**
 * Waits until the world is joined, every chunk in view has arrived, and every received section has been meshed.
 * The server sends a few chunks per tick, so an empty mesh queue alone can be seen between two batches.
 */
async function settle(page, label, chunks) {
	let settled;
	try {
		settled = await page.waitForFunction(
			(chunks) => {
				if (window.__mc.error) throw new Error(window.__mc.error);
				const s = window.__mc.stats();
				const autopilot = new URLSearchParams(location.search).get("autopilot") === "1";
				return s.joined && typeof s.server?.biome === "string" && s.server.biome.length > 0 && (!autopilot || s.autopilotStarted) && s.chunks >= chunks && s.sections > 0 && s.meshQueue === 0 && s.lightQueue === 0 && window.__mc.frames > 5 ? s : false;
			},
			{ timeout: 120000, polling: 250 },
			chunks,
		);
	} catch (err) {
		const state = await page.evaluate(() => ({ error: window.__mc?.error, stats: window.__mc?.stats?.() }));
		throw new Error(`${label}: world did not settle: ${err.message} ${JSON.stringify(state)}`);
	}
	// The stats the wait accepted, not a later reading: the world keeps changing.
	return settled.jsonValue();
}

/** Number of distinct colours on a coarse grid of the screenshot: a blank frame has one. */
async function distinctColours(page, file, measureBrightness = false) {
	await page.screenshot({ path: file });
	return page.evaluate(async ({ dataUrl, measureBrightness }) => {
		const img = new Image();
		img.src = dataUrl;
		await img.decode();
		const c = new OffscreenCanvas(img.width, img.height);
		const g = c.getContext("2d");
		g.drawImage(img, 0, 0);
		const seen = new Set();
		let luminance = 0;
		let samples = 0;
		for (let y = 40; y < img.height; y += 24) {
			for (let x = 12; x < img.width; x += 24) {
				const [r, gr, b] = g.getImageData(x, y, 1, 1).data;
				seen.add((r >> 3) << 10 | (gr >> 3) << 5 | (b >> 3));
				luminance += 0.2126 * r + 0.7152 * gr + 0.0722 * b;
				samples++;
			}
		}
		return measureBrightness ? luminance / samples : seen.size;
	}, { dataUrl: `data:image/png;base64,${readFileSync(file).toString("base64")}`, measureBrightness });
}

/** Identical seed, fixed camera, and the same screenshot grid used by the blank-frame check. */
async function dayNight() {
	const measurements = [];
	for (const time of [6000, 18000]) {
		const { page, errors } = await open(`server=local&world=e2e-sky-${time}-${run}&seed=2026&view=5&time=${time}`);
		try {
			const stats = await settle(page, `sky ${time}`, chunksInView(5));
			await page.evaluate((spawn) => {
				document.getElementById("overlay").hidden = true;
				window.__mc.setCamera(spawn[0], spawn[1] + 16, spawn[2], 0, 15);
			}, stats.spawn);
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			const brightness = await distinctColours(page, join(shots, `sky-${time}.png`), true);
			const sky = await page.evaluate(() => window.__mc.stats().skyBrightness);
			measurements.push({ brightness, sky });
			check(errors.length === 0, `sky ${time}: no page errors`, errors.slice(0, 3).join(" | "));
		} finally {
			await page.close();
		}
	}
	const [day, night] = measurements;
	check(day.sky > 0.9 && night.sky < 0.1, "sky: clock selects noon and midnight", `${day.sky} / ${night.sky}`);
	check(night.brightness < day.brightness * 0.65, "sky: midnight frame is darker than noon", `${night.brightness.toFixed(1)} / ${day.brightness.toFixed(1)}`);
}

/** A sealed underground chamber removes all sky paths; the lamp must relight it. */
async function undergroundLighting() {
	const { page, errors } = await open(`server=local&world=e2e-light-${run}&seed=2026&view=3&time=6000`);
	try {
		const stats = await settle(page, "lighting surface", chunksInView(3));
		await page.evaluate(spawn => {
			document.getElementById("overlay").hidden = true;
			window.__mc.setCamera(spawn[0], spawn[1]+3, spawn[2], 0, 65);
		}, stats.spawn);
		const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		await frames();
		const surface = await distinctColours(page, join(shots,"lighting-surface.png"), true);
		const center = [Math.floor(stats.spawn[0]), -48, Math.floor(stats.spawn[2])];
		await page.evaluate(([cx,cy,cz]) => {
			window.__mc.setCamera(cx+0.5, cy+0.5, cz+0.5, 0, 10);
			for (let dy=-2;dy<=2;dy++) for (let dz=-2;dz<=2;dz++) for (let dx=-2;dx<=2;dx++) {
				const shell = Math.abs(dx)===2 || Math.abs(dy)===2 || Math.abs(dz)===2;
				window.__mc.setBlock(cx+dx,cy+dy,cz+dz,shell ? 1 : 0);
			}
		}, center);
		// Give server confirmations a turn before waiting for the final mesh.
		await new Promise(resolve => setTimeout(resolve,500));
		await settle(page,"lighting underground",chunksInView(3));
		await frames();
		const dark = await distinctColours(page, join(shots,"lighting-dark.png"), true);
		await page.evaluate(([x,y,z]) => window.__mc.setBlock(x+1,y-1,z,10),center); // registry: lamp_block
		await new Promise(resolve => setTimeout(resolve,500));
		await settle(page,"lighting lamp",chunksInView(3));
		await frames();
		const lit = await distinctColours(page, join(shots,"lighting-lamp.png"), true);
		const placed = await page.evaluate(([x,y,z]) => window.__mc.getBlock(x+1,y-1,z),center);
		check(placed===10,"lighting: lamp placement confirmed");
		check(dark < surface*0.5,"lighting: underground darker than surface",`${dark.toFixed(1)} / ${surface.toFixed(1)}`);
		check(lit > dark*2,"lighting: lamp brightens underground",`${lit.toFixed(1)} / ${dark.toFixed(1)}`);
		check(errors.length===0,"lighting: no page errors",errors.slice(0,3).join(" | "));
	} finally { await page.close(); }
}

/** Change actual terrain behind each material: sky/black or opaque output cannot track that change. */
async function transparentMaterials() {
	const { page, errors } = await open(`server=local&world=e2e-materials-${run}&seed=2026&view=3&time=6000`);
	try {
		const stats = await settle(page, "materials surface", chunksInView(3));
		const center = [Math.floor(stats.spawn[0]), Math.floor(stats.spawn[1]) + 8, Math.floor(stats.spawn[2])];
		await page.evaluate(() => { document.getElementById("overlay").hidden = true; });
		const capture = async label => {
			await new Promise(resolve => setTimeout(resolve, 500));
			await settle(page, label, chunksInView(3));
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			const file = join(shots, `${label}.png`);
			await page.screenshot({ path: file });
			return page.evaluate(async dataUrl => {
				const img = new Image(); img.src = dataUrl; await img.decode();
				const canvas = new OffscreenCanvas(img.width, img.height), g = canvas.getContext("2d");
				g.drawImage(img, 0, 0);
				const samples = [];
				for (let y = -80; y < 80; y += 4) for (let x = -80; x < 80; x += 4) {
					if (Math.abs(x) < 16 && Math.abs(y) < 16) continue; // crosshair
					samples.push(...g.getImageData(img.width / 2 + x, img.height / 2 + y, 1, 1).data.slice(0, 3));
				}
				return samples;
			}, `data:image/png;base64,${readFileSync(file).toString("base64")}`);
		};
		const difference = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
		for (const [name, material] of [["glass", 11], ["water", 13]]) {
			await page.evaluate(({ center: [cx, cy, cz], name }) => {
				window.__mc.setCamera(cx + 0.5, cy + 0.5, cz + 0.5, 0, name === "water" ? 90 : 0);
				for (let y = -3; y <= 3; y++) for (let z = -3; z <= 5; z++) for (let x = -3; x <= 3; x++) {
					window.__mc.setBlock(cx + x, cy + y, cz + z, 0);
				}
			}, { center, name });
			const terrain = async block => page.evaluate(({ center: [cx, cy, cz], name, block }) => {
				for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
					const [x, y, z] = name === "water" ? [cx + a, cy - 2, cz + b] : [cx + a, cy + b, cz + 4];
					window.__mc.setBlock(x, y, z, block);
				}
			}, { center, name, block });
			await terrain(5); // oak planks: warm, patterned reference terrain
			const bare = await capture(`${name}-bare`);
			await page.evaluate(({ center: [cx, cy, cz], name, material }) => {
				for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
					const [x, y, z] = name === "water" ? [cx + a, cy - 1, cz + b] : [cx + a, cy + b, cz + 2];
					window.__mc.setBlock(x, y, z, material);
				}
			}, { center, name, material });
			const warm = await capture(`${name}-warm`);
			const placed = await page.evaluate(({ center: [x, y, z], name }) =>
				name === "water" ? window.__mc.getBlock(x, y - 1, z) : window.__mc.getBlock(x, y, z + 2), { center, name });
			check(placed === material, `${name}: material placement confirmed`);
			await terrain(4); // gray cobblestone behind the unchanged material
			const gray = await capture(`${name}-gray`);
			const delta = difference(warm, gray);
			check(delta > 3, `${name}: terrain ${name === "water" ? "below" : "behind"} remains visible`, `terrain change ${delta.toFixed(1)}`);
			if (name === "glass") {
				const matching = warm.filter((v, i) => Math.abs(v - bare[i]) < 4).length / warm.length;
				check(matching > 0.35, "glass: clear pixels retain terrain colour", `${(matching * 100).toFixed(1)}%`);
				// The 16x16 glass has an opaque border and a five-texel diagonal accent
				// crossing this central sample area. Their pale blue differs strongly from
				// the warm planks: require a >=24 change in any RGB channel for only 2%
				// of pixels, leaving margin for sampling. Undrawn glass changes 0%.
				let changedPixels = 0;
				for (let i = 0; i < warm.length; i += 3) {
					if (Math.max(...warm.slice(i, i + 3).map((v, c) => Math.abs(v - bare[i + c]))) >= 24) changedPixels++;
				}
				const changed = changedPixels / (warm.length / 3);
				check(changed >= 0.02, "glass: opaque markings are rendered", `${(changed * 100).toFixed(1)}% changed pixels`);
			} else {
				check(difference(warm, bare) > 5, "water: translucent colour is rendered");
			}
		}
		check(errors.length === 0, "materials: no page errors", errors.slice(0, 3).join(" | "));
	} finally { await page.close(); }
}

/**
 * Server tick rate as the page sees it, from the arrival of TimeUpdate packets.
 *
 * The client's game time only moves when a TimeUpdate is handled: 20 ticks at
 * once, once per second. Reading it at two arbitrary moments counts those
 * steps, and one step more or less in a 4 s window reads as 25 or 15 TPS. This
 * times the steps themselves: ticks advanced divided by the time between the
 * first and the last step kept. The first step seen is dropped, because a
 * packet that waited while the page was busy is handled late.
 */
async function tickRate(page, intervals = 4) {
	const steps = await page.evaluate(
		(count) =>
			new Promise((resolve) => {
				const seen = [];
				let last = window.__mc.stats().gameTime;
				const finish = () => {
					clearInterval(poll);
					clearTimeout(giveUp);
					resolve(seen);
				};
				const poll = setInterval(() => {
					const now = window.__mc.stats().gameTime;
					if (now === last) return;
					last = now;
					seen.push([performance.now(), now]);
					if (seen.length === count) finish();
				}, 5);
				// A stopped clock must fail the check, not hang the run.
				const giveUp = setTimeout(finish, 15000);
			}),
		intervals + 2,
	);
	const kept = steps.slice(1);
	if (kept.length < intervals + 1) return { tps: 0, packets: kept.length };
	const [t0, g0] = kept[0];
	const [t1, g1] = kept[kept.length - 1];
	return { tps: ((g1 - g0) / (t1 - t0)) * 1000, packets: kept.length };
}

/** One full session against the given server kind: load, draw, tick rate, place a block, reload and find it again. */
async function playthrough(kind) {
	const view = 5;
	const world = `e2e-${kind}-${run}`;
	const query = `server=${kind}&world=${world}&view=${view}&autopilot=1${kind === "local" ? "&seed=2026" : ""}`;
	const { page, errors } = await open(query);
	const stats = await settle(page, kind, chunksInView(view));
	await page.waitForFunction(() => window.__mc.stats().server?.generation?.delivered > 0, { timeout: 15000 });
	const generation = await page.evaluate(() => window.__mc.stats().server.generation);
	check(generation.delivered > 0, `${kind}: external generation delivered chunks`, JSON.stringify(generation));
	check(stats.sections > 20, `${kind}: terrain meshed`, `${stats.sections} sections, ${stats.chunks} chunks, adapter ${stats.adapter}`);
	check(stats.chunks === chunksInView(view), `${kind}: all ${chunksInView(view)} chunks in view arrived`, `${stats.chunks}`);

	// Let the orbiting camera draw a few frames, then look at what is on screen.
	await new Promise((r) => setTimeout(r, 1500));
	const drawn = await page.evaluate(() => window.__mc.stats());
	check(Math.hypot(drawn.camera.x - stats.camera.x, drawn.camera.z - stats.camera.z) > 0.1, `${kind}: Terrain autopilot moves the camera`);
	check(drawn.drawn > 0 && drawn.quads > 1000, `${kind}: sections drawn`, `${drawn.drawn} sections, ${drawn.quads} quads`);
	// Server clock is advancing at 20 ticks per second. Measured before the
	// screenshot below, which blocks the page for more than a second.
	const rate = await tickRate(page);
	check(Math.abs(rate.tps - 20) < 1.5, `${kind}: server ticks at 20 TPS`, `${rate.tps.toFixed(2)} measured between ${rate.packets} time packets`);
	const colours = await distinctColours(page, join(shots, `${kind}.png`));
	check(colours >= 12, `${kind}: frame is not blank`, `${colours} distinct colours`);

	// Place a block through the same path a mouse click takes.
	const [sx, sy, sz] = drawn.spawn.map(Math.floor);
	check(typeof drawn.server?.biome === "string" && drawn.server.biome.length > 0, `${kind}: server stats include the player biome`, drawn.server?.biome);
	check(drawn.generator === 2, `${kind}: new world uses Terrain`, `${drawn.generatorName}`);
	const ground = await page.evaluate(([x, y, z]) => ({
		foot: window.__mc.stateName(window.__mc.getBlock(x, y - 1, z)),
		body: window.__mc.getBlock(x, y, z),
		head: window.__mc.getBlock(x, y + 1, z),
	}), [sx, sy, sz]);
	// Terrain uses only air/water as non-solid blocks; every surface recipe is solid.
	check(sy > 57 && ground.foot !== "air" && ground.foot !== "water" && ground.foot !== "?" && ground.body === 0 && ground.head === 0,
		`${kind}: spawn is dry land above sea level with headroom`, JSON.stringify({spawn: drawn.spawn, ...ground}));
	const pos = await page.evaluate(([x, y, z]) => {
		// Trees can overhang a spawn column even when its first two blocks are air.
		while (window.__mc.getBlock(x, y, z) !== 0 && y < 319) y++;
		return [x, y, z];
	}, [sx, sy + 4, sz]);
	const before = await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), pos);
	await page.evaluate(([x, y, z], spawn) => {
		window.__mc.setCamera(spawn[0], spawn[1] + 3, spawn[2], 0, 0);
		return window.__mc.setBlock(x, y, z, 9);
	}, pos, drawn.spawn);
	await new Promise((r) => setTimeout(r, 500));
	const placed = await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), pos);
	check(before === 0 && placed === 9, `${kind}: block placed`, `${before} -> ${placed} at ${pos.join(",")}`);

	// Prediction happens synchronously; sample it before a server tick can correct it.
	const distant = await page.evaluate((spawn) => {
		const x = Math.floor(spawn[0]) + 20;
		const z = Math.floor(spawn[2]);
		let y = Math.floor(spawn[1] + 3);
		const maxY = y + 96;
		while (window.__mc.getBlock(x, y, z) !== 0 && y < maxY) y++;
		const before = window.__mc.getBlock(x, y, z);
		window.__mc.setCamera(spawn[0], spawn[1] + 3, spawn[2], 0, 0);
		window.__mc.setBlock(x, y, z, 9);
		return { pos: [x, y, z], before, predicted: window.__mc.getBlock(x, y, z) };
	}, drawn.spawn);
	check(distant.before === 0, `${kind}: distant edit starts in air`, `${distant.before} at ${distant.pos.join(",")}`);
	check(distant.predicted === 9, `${kind}: distant edit predicted`, `${distant.predicted}`);
	await new Promise((r) => setTimeout(r, 1000));
	const corrected = await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), distant.pos);
	check(corrected === 0, `${kind}: rejected edit rolled back`, `${corrected}`);

	// Wait past one autosave (5 s), then reload. Local restores from storage;
	// ws rejoins the live core (storage restoration is checked by evict below).
	const timeBefore = await page.evaluate(() => {
		window.__mc.flush();
		return window.__mc.stats().gameTime;
	});
	await new Promise((r) => setTimeout(r, 6500));
	const seedBefore = drawn.seed;
	await page.reload({ waitUntil: "load" });
	const after = await settle(page, `${kind} after reload`, chunksInView(view));
	const kept = await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), pos);
	check(after.generator === drawn.generator, `${kind}: generator kept across reload`);
	check(after.seed === seedBefore, `${kind}: seed kept across reload`, after.seed);
	check(kept === 9, `${kind}: placed block survived reload`, `block ${kept}`);
	check(after.joinedGameTime >= timeBefore && timeBefore > 0, `${kind}: clock continued instead of restarting`, `tick ${timeBefore} -> ${after.joinedGameTime}`);

	if (kind === "local") {
		const importedWorld = `e2e-import-${run}`;
		const archive = await page.evaluate(async (name) => {
			const bytes = await window.__mc.exportWorld();
			const magic = new TextDecoder().decode(bytes.subarray(0, 7));
			await window.__mc.importWorld(name, bytes);
			let duplicateRejected = false;
			try { await window.__mc.importWorld(name, bytes); } catch { duplicateRejected = true; }
			return { magic, size: bytes.length, duplicateRejected };
		}, importedWorld);
		check(archive.magic === "MCWORLD" && archive.size > 12, "local: world exported", `${archive.size} bytes`);
		check(archive.duplicateRejected, "local: world imported", "duplicate import rejected");
		const url = new URL(page.url());
		url.searchParams.set("world", importedWorld);
		url.searchParams.delete("seed");
        url.searchParams.set("gen", "flat"); // Existing/imported metadata must override URL choices.
		await page.goto(url.href, { waitUntil: "load" });
		const imported = await settle(page, "local imported world", chunksInView(view));
		const importedBlock = await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), pos);
		check(imported.generator === drawn.generator, "local: archive preserves generator and ignores URL override");
		check(importedBlock === 9 && imported.seed === seedBefore, "local: imported world kept the block and seed", `block ${importedBlock}, seed ${imported.seed}`);
	}

	if (kind === "ws") {
		const corrections = await page.evaluate(() => {
			const before = window.__mc.stats().positionsCorrected;
			window.__mc.sendRawPosition(100000, 200, 100000);
			return before;
		});
		await page.waitForFunction(before => window.__mc.stats().positionsCorrected > before, { timeout: 10000 }, corrections);
		const corrected = await page.evaluate(() => window.__mc.stats());
		check(Math.abs(corrected.camera.x - drawn.spawn[0]) < 1000 && Math.abs(corrected.camera.z - drawn.spawn[2]) < 1000, "ws: raw distant position is corrected without teleport");
		const response = await fetch(`${edge}/api/debug/disconnect?world=${encodeURIComponent(world)}`, { method: "POST" });
		check(response.ok, "ws: debug disconnect accepted");
		const deadline = Date.now() + 15000;
		await page.waitForFunction(() => window.__mc.stats().connection === "reconnecting", { timeout: 15000, polling: 10 });
		await page.waitForFunction(() => {
			const s = window.__mc.stats();
			return s.connection === "open" && s.reconnects === 1;
		}, { timeout: Math.max(1, deadline - Date.now()), polling: 10 });
		const reconnected = await settle(page, "ws after reconnect", chunksInView(view));
		check(reconnected.connection === "open" && reconnected.reconnects === 1, "ws: reconnected after a dropped connection");
		const keptAfterReconnect = await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), pos);
		check(keptAfterReconnect === 9, "ws: placed block survived reconnect", `block ${keptAfterReconnect}`);

		const beforeEvict = await page.evaluate(() => window.__mc.stats());
		const evicted = await fetch(`${edge}/api/debug/evict?world=${encodeURIComponent(world)}`, { method: "POST" });
		check(evicted.ok, "ws: debug evict accepted");
		await page.waitForFunction((reconnects) => {
			const s = window.__mc.stats();
			return s.connection === "open" && s.reconnects > reconnects;
		}, { timeout: 15000, polling: 10 }, beforeEvict.reconnects);
		const restored = await settle(page, "ws after evict", chunksInView(view));
		check(restored.joinedGameTime >= beforeEvict.gameTime && restored.joinedGameTime > 0, "ws: clock restored from storage", `tick ${beforeEvict.gameTime} -> ${restored.joinedGameTime}`);
		const keptAfterEvict = await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), pos);
		check(keptAfterEvict === 9, "ws: placed block survived evict", `block ${keptAfterEvict}`);
	}

	check(errors.length === 0, `${kind}: no page errors`, errors.slice(0, 3).join(" | "));
	return page;
}

/** Real input events: pointer lock, keyboard movement, mouse look, break and place by clicking. */
async function inputs() {
	const view = 3;
	const { page, errors } = await open(`world=e2e-input-${run}&view=${view}&seed=7`);
	const stats = await settle(page, "input", chunksInView(view));
	const [sx, sy, sz] = stats.spawn.map(Math.floor);

	await page.mouse.click(640, 360);
	// The lock is granted first; the page reacts to it in a later event.
	await page
		.waitForFunction(() => document.pointerLockElement !== null && document.getElementById("overlay").hidden, { timeout: 5000 })
		.catch(() => {});
	const locked = await page.evaluate(() => document.pointerLockElement?.id === "view" && document.getElementById("overlay").hidden);
	const lockState = await page.evaluate(() => JSON.stringify({ el: document.pointerLockElement?.id ?? null, hidden: document.getElementById("overlay").hidden, focus: document.hasFocus(), status: document.getElementById("status").textContent, vis: document.visibilityState }));
	check(locked, "input: click captures the pointer and hides the menu", lockState);
	if (!locked) return page.close();

	// Stand above the spawn column and look straight down at it.
	await page.evaluate((s) => window.__mc.setCamera(s[0], s[1] + 3, s[2], 0, 90), stats.spawn);
	const checkTarget = async (expected, label) => {
		try {
			await page.waitForFunction(
				expected => document.getElementById("hud")?.textContent.split("\n").find(l => l.startsWith("Target")) === expected,
				{ timeout: 5000 },
				expected,
			);
		} catch (err) {
			if (err.name !== "TimeoutError") throw err;
			const actual = await page.evaluate(() => document.getElementById("hud")?.textContent.split("\n").find(l => l.startsWith("Target")));
			check(false, label, `expected ${expected}; got ${actual ?? "<missing Target line>"}`);
			return;
		}
		check(true, label);
	};
	const top = sy - 1;
	const [topName, underName] = await page.evaluate(([x, y, z]) => {
		return [window.__mc.stateName(window.__mc.getBlock(x, y, z)), window.__mc.stateName(window.__mc.getBlock(x, y - 1, z))];
	}, [sx, top, sz]);
	check(stats.generator === 2, "input: movement and mouse placement run on Terrain");
	await checkTarget(`Target: ${sx} ${top} ${sz}  ${topName}`, "input: crosshair targets the block below");

	await page.mouse.down({ button: "left" });
	await page.mouse.up({ button: "left" });
	await new Promise((r) => setTimeout(r, 300));
	check((await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), [sx, top, sz])) === 0, "input: left click breaks the targeted block");
	await checkTarget(`Target: ${sx} ${top - 1} ${sz}  ${underName}`, "input: the block underneath is targeted next");

	await page.keyboard.press("Digit3");
	await page.mouse.down({ button: "right" });
	await page.mouse.up({ button: "right" });
	await new Promise((r) => setTimeout(r, 300));
	check((await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), [sx, top, sz])) === 5, "input: right click places the selected block (oak planks)");

	// Mouse look: 200 px to the right is 30 degrees of yaw at the default sensitivity.
	await page.evaluate((s) => window.__mc.setCamera(s[0], s[1] + 20, s[2], 0, 0), stats.spawn);
	await page.mouse.move(840, 360);
	await new Promise((r) => setTimeout(r, 200));
	const yaw = await page.evaluate(() => window.__mc.stats().camera.yaw);
	check(Math.abs(yaw - 30) < 0.01, "input: mouse look turns 0.15 degrees per pixel", `yaw ${yaw.toFixed(2)}`);

	// Flight from rest: acceleration 0.05/tick (input scaled by 0.98), drag 0.91.
	// 15–25 ticks travel about 4.0–8.6 blocks; allow a small timing/interpolation margin.
	// W for one second at yaw 30 moves along the view direction.
	const from = await page.evaluate(() => window.__mc.stats().camera);
	await page.keyboard.down("KeyW");
	await new Promise((r) => setTimeout(r, 1000));
	await page.keyboard.up("KeyW");
	const to = await page.evaluate(() => window.__mc.stats().camera);
	const [dx, dz] = [to.x - from.x, to.z - from.z];
	const dist = Math.hypot(dx, dz);
	const heading = (Math.atan2(-dx, dz) * 180) / Math.PI;
	check(dist > 3.9 && dist < 9 && Math.abs(heading - 30) < 1, "input: W flies forward along the view direction", `${dist.toFixed(1)} blocks, heading ${heading.toFixed(1)}`);

	check(errors.length === 0, "input: no page errors", errors.slice(0, 3).join(" | "));
	await page.close();
}

/** Real placement/UI input plus resolved physics; debug edits prepare and clear fixtures. */
async function partialModels() {
	const view = 3;
	const { page, errors } = await open(`world=e2e-models-${run}&view=${view}&seed=2026&time=6000`);
	const waitFor = async (label, predicate, options = {}, ...args) => {
		try { return await page.waitForFunction(predicate, options, ...args); }
		catch (error) { throw new Error(`models ${label}: ${error.message}`, { cause: error }); }
	};
	try {
		const stats = await settle(page, "models", chunksInView(view));
		const center = [Math.floor(stats.spawn[0]), Math.floor(stats.spawn[1]) + 8, Math.floor(stats.spawn[2])];
		await page.evaluate(([x, y, z]) => {
			window.__mc.setCamera(x + 0.5, y + 2, z + 0.5, 0, 90);
			for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
				window.__mc.setBlock(x + dx, y - 1, z + dz, window.__mc.stateId("stone"));
				for (let dy = 0; dy <= 3; dy++) window.__mc.setBlock(x + dx, y + dy, z + dz, window.__mc.stateId("air"));
			}
		}, center);
		await new Promise(resolve => setTimeout(resolve, 500));
		await settle(page, "models platform", chunksInView(view));
		await page.mouse.click(640, 360);
		await waitFor("initial pointer lock", () => document.pointerLockElement?.id === "view");
		await page.keyboard.press("Digit4"); // Default fourth slot: oak slab.
		await page.mouse.click(640, 360, { button: "right" });
		await waitFor("bottom slab placement", ([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("oak_slab[type=bottom]"), {}, center);
		await new Promise(resolve => setTimeout(resolve, 300));
		check(await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("oak_slab[type=bottom]"), center), "models: right click places a bottom slab");
		await waitFor("bottom slab target HUD", () => document.getElementById("hud").textContent.includes("oak_slab[type=bottom]"));

		await page.evaluate(([x, y, z]) => {
			window.__mc.setCamera(x - 0.5, y + 1.62, z + 0.5, 0, 0);
			window.__mc.toggleFlight();
		}, center);
		await page.keyboard.down("KeyA"); // At yaw 0, left moves toward +X.
		let stepped;
		try {
			const result = await waitFor("step onto slab", ([x, y]) => {
				const p = window.__mc.playerPosition();
				return p[0] > x + 0.1 && Math.abs(p[1] - y - 0.5) < 0.001 ? p : false;
			}, { timeout: 5000 }, center);
			stepped = await result.jsonValue();
		} finally { await page.keyboard.up("KeyA"); }
		check(!!stepped, "models: walking steps onto the slab", JSON.stringify(stepped));

		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 3, z + 0.5, 0, 90), center);
		await page.mouse.click(640, 360, { button: "right" });
		await waitFor("double slab placement", ([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("oak_slab[type=double]"), {}, center);
		await new Promise(resolve => setTimeout(resolve, 300));
		check(await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("oak_slab[type=double]"), center), "models: clicking the empty half makes a double slab");
		await page.mouse.click(640, 360, { button: "middle" });
		check(await page.$eval("#hotbar canvas.selected", c => c.title === "oak_slab"), "models: middle click picks the block default");

		await page.keyboard.press("KeyE");
		await waitFor("picker opened and pointer released", () => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
		const names = await page.$$eval("#block-grid [data-block]", buttons => buttons.map(b => b.dataset.block));
		check(names.includes("red_flower") && names.filter(n => n === "oak_slab").length === 1 && !names.includes("air"), "models: E opens one entry per placeable block");
		check(["oak_stairs", "cobblestone_stairs", "oak_fence"].every(name => names.filter(n => n === name).length === 1), "models: picker includes both stairs and fence once");
		const toolNames = ["wooden", "stone", "copper", "iron"].flatMap(tier => ["pickaxe", "axe", "shovel"].map(kind => `${tier}_${kind}`));
		check(toolNames.every(name => names.filter(n => n === name).length === 1), "tools: picker includes all twelve tools once");
		for (const name of toolNames) {
			await page.click(`#block-grid [data-block="${name}"]`);
			await waitFor(`authoritative tool slot ${name}`, name => document.querySelector("#hotbar canvas.selected")?.title === name, {}, name);
			check(await page.$eval("#hotbar canvas.selected", (canvas, name) => {
				const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
				return canvas.title === name && canvas.dataset.count === "1"
					&& pixels.some((v, i) => i % 4 === 3 && v === 255)
					&& pixels.some((v, i) => i % 4 === 3 && v === 0);
			}, name), `tools: ${name} is selected and its transparent icon is drawn`);
		}
		await page.click('#block-grid [data-block="red_flower"]');
		await waitFor("authoritative red flower slot", () => document.querySelector("#hotbar canvas.selected")?.title === "red_flower");
		check(await page.$eval("#hotbar canvas.selected", c => c.title === "red_flower"), "models: picker replaces the selected hotbar slot");
		await page.keyboard.press("KeyE");
		await waitFor("picker closed with inventory key", () => document.getElementById("block-picker").hidden);
		const resume = async label => {
			for (let attempt = 1; attempt <= 5; attempt++) {
				if (await page.evaluate(() => document.pointerLockElement?.id === "view")) return;
				try {
					await waitFor(`${label}, attempt ${attempt}: overlay visible`, () => !document.getElementById("overlay").hidden, { timeout: 1500 });
					await page.click("#overlay", { offset: { x: 10, y: 10 } });
					await waitFor(`${label}, attempt ${attempt}: pointer lock`, () => document.pointerLockElement?.id === "view", { timeout: 1500 });
					return;
				} catch (error) {
					// Lock can arrive between the visibility check and the click.
					if (await page.evaluate(() => document.pointerLockElement?.id === "view")) return;
					if (attempt === 5) throw new Error(`models ${label}: resume failed after ${attempt} attempts: ${error.message}`, { cause: error });
				}
			}
		};
		await resume("resume after inventory key");
		await page.keyboard.press("KeyE");
		await waitFor("picker reopened before Escape", () => !document.getElementById("block-picker").hidden);
		await page.keyboard.press("Escape");
		await waitFor("picker closed with Escape into game menu", () => document.getElementById("block-picker").hidden
			&& !document.getElementById("overlay").hidden && !document.pointerLockElement
			&& !document.getElementById("game-menu").hidden);
		await resume("resume after Escape");

		// Break the slab, then place a flower on the supporting full cube.
		await page.mouse.click(640, 360, { button: "left" });
		await waitFor("slab destruction", ([x, y, z]) => window.__mc.getBlock(x, y, z) === 0, {}, center);
		await page.mouse.click(640, 360, { button: "right" });
		await waitFor("flower placement", ([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("red_flower"), {}, center);
		await new Promise(resolve => setTimeout(resolve, 300));
		check(await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("red_flower"), center), "models: flower placement is confirmed");
		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 1.2, z - 1.5, 0, 20), center);
		await settle(page, "models flower", chunksInView(view));
		const flowerImage = join(shots, "models-flower.png");
		await page.screenshot({ path: flowerImage });
		const redPixels = await page.evaluate(async dataUrl => {
			const img = new Image(); img.src = dataUrl; await img.decode();
			const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d");
			g.drawImage(img, 0, 0);
			const pixels = g.getImageData(520, 240, 240, 240).data;
			let red = 0;
			for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > pixels[i + 1] * 1.8 && pixels[i] > pixels[i + 2] * 1.8 && pixels[i] > 60) red++;
			return red;
		}, `data:image/png;base64,${readFileSync(flowerImage).toString("base64")}`);
		check(redPixels > 10, "models: flower cutout is visibly rendered", `${redPixels} red pixels`);
		await page.evaluate(([x, y, z]) => {
			window.__mc.setCamera(x - 0.5, y + 1.62, z + 0.5, 0, 0);
			window.__mc.toggleFlight();
		}, center);
		await page.keyboard.down("KeyA");
		try { await waitFor("walk through flower", ([x, y]) => {
			const p = window.__mc.playerPosition();
			return p[0] > x + 1.2 && Math.abs(p[1] - y) < 0.001;
		}, { timeout: 5000 }, center); }
		finally { await page.keyboard.up("KeyA"); }
		check(true, "models: player walks through the flower");

		const pickBlock = async name => {
			await page.keyboard.press("KeyE");
			await waitFor(`picker for ${name}`, () => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
			await page.click(`#block-grid [data-block="${name}"]`);
			await waitFor(`authoritative slot for ${name}`, name => document.querySelector("#hotbar canvas.selected")?.title === name, {}, name);
			check(await page.$eval("#hotbar canvas.selected", (c, name) => c.title === name, name), `models: picker selects ${name}`);
			// Recenter while unlocked so the next canvas click cannot rotate yaw.
			await page.mouse.move(640, 360);
			await page.keyboard.press("KeyE");
			await waitFor(`picker closed after ${name}`, () => document.getElementById("block-picker").hidden);
			await resume(`resume after selecting ${name}`);
		};

		// Replace the flower through real interaction. Looking down retains yaw:
		// 270 degrees places the high side east, ready to walk up from the west.
		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 3, z + 0.5, 270, 90), center);
		await page.mouse.click(640, 360, { button: "left" });
		await waitFor("flower cleared for stairs", ([x, y, z]) => window.__mc.getBlock(x, y, z) === 0, {}, center);
		await pickBlock("oak_stairs");
		await page.mouse.click(640, 360, { button: "right" });
		await waitFor("east bottom stairs placement", ([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("oak_stairs[facing=east,half=bottom]"), {}, center);
		await new Promise(resolve => setTimeout(resolve, 300));
		check(await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("oak_stairs[facing=east,half=bottom]"), center), "models: yaw places east-facing bottom stairs");
		const straight = await page.evaluate(([x, y, z]) => window.__mc.raycast([x + 0.75, y + 2, z + 0.75], [0, -1, 0], 3), center);
		check(straight?.hitY === 1 && straight.max[1] === 1, "models: straight stair upper half is selectable", JSON.stringify(straight));

		await page.evaluate(([x, y, z]) => {
			window.__mc.setCamera(x - 0.5, y + 1.62, z + 0.5, 270, 0);
			window.__mc.toggleFlight();
		}, center);
		await page.keyboard.down("KeyW");
		try {
			const result = await waitFor("walk up stairs without jumping", ([x, y]) => {
				const p = window.__mc.playerPosition();
				return p[0] > x + 0.6 && Math.abs(p[1] - y - 1) < 0.001 ? p : false;
			}, { timeout: 5000 }, center);
			check(true, "models: walking climbs both stair halves", JSON.stringify(await result.jsonValue()));
		} finally { await page.keyboard.up("KeyW"); }

		// A perpendicular stair in front cuts the original step to a quarter.
		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 1.5, y + 3, z + 0.5, 180, 90), center);
		await pickBlock("cobblestone_stairs");
		await page.mouse.click(640, 360, { button: "right" });
		await waitFor("perpendicular stair placement", ([x, y, z]) => window.__mc.getBlock(x + 1, y, z) === window.__mc.stateId("cobblestone_stairs[facing=north,half=bottom]"), {}, center);
		await new Promise(resolve => setTimeout(resolve, 300));
		const corner = await page.evaluate(([x, y, z]) => ({
			state: window.__mc.getBlock(x, y, z),
			expected: window.__mc.stateId("oak_stairs[facing=east,half=bottom]"),
			neighbor: window.__mc.getBlock(x + 1, y, z),
			expectedNeighbor: window.__mc.stateId("cobblestone_stairs[facing=north,half=bottom]"),
			hit: window.__mc.raycast([x + 0.75, y + 2, z + 0.75], [0, -1, 0], 3),
		}), center);
		check(corner.state === corner.expected && corner.neighbor === corner.expectedNeighbor && corner.hit?.x === center[0]
			&& corner.hit.y === center[1] && corner.hit.z === center[2] && corner.hit.hitY === 0.5 && corner.hit.max[1] === 0.5,
			"models: perpendicular stairs change the selection shape without changing the original state", JSON.stringify(corner));

		// Clear the stair fixture, then place the fence through right click.
		await page.evaluate(([x, y, z]) => {
			window.__mc.setCamera(x + 0.5, y + 3, z + 0.5, 270, 90);
			window.__mc.setBlock(x, y, z, 0);
			window.__mc.setBlock(x + 1, y, z, 0);
		}, center);
		await new Promise(resolve => setTimeout(resolve, 300));
		await waitFor("stair fixture cleared", ([x, y, z]) => window.__mc.getBlock(x, y, z) === 0 && window.__mc.getBlock(x + 1, y, z) === 0, {}, center);
		await pickBlock("oak_fence");
		await page.mouse.click(640, 360, { button: "right" });
		await waitFor("fence placement", ([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("oak_fence"), {}, center);
		await new Promise(resolve => setTimeout(resolve, 300));
		check(await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z) === window.__mc.stateId("oak_fence"), center), "models: right click places a fence");
		await page.evaluate(([x, y, z]) => {
			window.__mc.setCamera(x - 0.5, y + 1.62, z + 0.5, 270, 0);
			window.__mc.toggleFlight();
		}, center);
		await page.keyboard.down("KeyW");
		await page.keyboard.down("Space"); // One held press jumps repeatedly without toggling flight.
		let fenceMotion;
		try {
			fenceMotion = await page.evaluate(async () => {
				const start = performance.now();
				let maxX = -Infinity, maxY = -Infinity;
				while (performance.now() - start < 2000) {
					const p = window.__mc.playerPosition();
					maxX = Math.max(maxX, p[0]);
					maxY = Math.max(maxY, p[1]);
					await new Promise(resolve => requestAnimationFrame(resolve));
				}
				return { maxX, maxY, end: window.__mc.playerPosition() };
			});
		} finally {
			await page.keyboard.up("Space");
			await page.keyboard.up("KeyW");
		}
		check(fenceMotion.maxY > center[1] + 1.2 && fenceMotion.maxY < center[1] + 1.5,
			"models: fence attempt uses a normal physics jump", JSON.stringify(fenceMotion));
		check(fenceMotion.maxX <= center[0] + 0.076 && fenceMotion.end[0] <= center[0] + 0.076,
			"models: jumping cannot cross the fence", JSON.stringify(fenceMotion));
		// Preserve the existing fourth-slot persistence check after these fixtures.
		await pickBlock("red_flower");
		await page.evaluate(async () => { await window.__mc.exportWorld(); });
		await page.reload({ waitUntil: "load" });
		await settle(page, "models reload", chunksInView(view));
		check(await page.$eval("#hotbar canvas:nth-child(4)", c => c.title === "red_flower"), "models: hotbar block survives reload");
		check(errors.length === 0, "models: no page errors", errors.slice(0, 3).join(" | "));
	} finally { await page.close(); }
}

async function biomeTints() {
	// IDs and colors follow the registry order, just like client_biome_colors.
	const registry = readFileSync(join(root, "data/registry/biomes.toml"), "utf8").split("[[biomes]]").slice(1).map(entry => ({
		name: entry.match(/name = "([^"]+)"/)[1],
		grass: JSON.parse(entry.match(/grass_color = (\[[^\]]+\])/)[1]),
	}));
	const { page, errors } = await open(`server=local&world=e2e-tint-${run}&seed=2026&view=3&time=6000`);
	try {
		await settle(page, "tint Terrain", chunksInView(3));
		await page.waitForFunction(() => {
			const p = window.__mc.playerPosition();
			return window.__mc.tint(p[0], p[2]) !== null;
		});
		const spawn = await page.evaluate(() => {
			const p = window.__mc.playerPosition();
			return { tint: window.__mc.tint(p[0], p[2]), biome: window.__mc.stats().server.biome };
		});
		check(registry[spawn.tint.biome]?.name === spawn.biome, "tint: spawn cell agrees with server biome", JSON.stringify(spawn));
		check(JSON.stringify(spawn.tint.grass) === JSON.stringify(registry[spawn.tint.biome].grass), "tint: spawn grass matches registry");
		const caves = await page.evaluate(() => {
			const api = window.__mc;
			const [sx, , sz] = api.stats().spawn;
			const [cx, cz] = [Math.floor(sx / 16), Math.floor(sz / 16)];
			const excluded = new Set(["air", "water", "ice", "oak_log", "oak_leaves"].map(name => api.stateId(name)));
			const air = api.stateId("air");
			let checked = 0;
			for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
				for (let z = 0; z < 16; z += 3) for (let x = 0; x < 16; x += 3) {
					const [wx, wz] = [(cx + dx) * 16 + x, (cz + dz) * 16 + z];
					if (api.getBlock(wx, -64, wz) < 0) continue;
					let top = 319;
					while (top > -50 && excluded.has(api.getBlock(wx, top, wz))) top--;
					for (let y = -50; y <= top - 8; y += 2) {
						checked++;
						if (api.getBlock(wx, y, wz) === air) return { found: true, checked, at: [wx, y, wz] };
					}
				}
			}
			return { found: false, checked };
		});
		check(caves.found, "caves: Terrain seed 2026 has underground air in loaded spawn chunks", JSON.stringify(caves));
		const ores = await page.evaluate(() => {
			const api = window.__mc;
			const [sx, , sz] = api.stats().spawn;
			const [cx, cz] = [Math.floor(sx / 16), Math.floor(sz / 16)];
			const names = ["coal_ore", "copper_ore", "iron_ore", "gold_ore"];
			const ids = names.map(name => api.stateId(name));
			const counts = [0, 0, 0, 0];
			const excluded = new Set(["air", "water", "ice", "oak_log", "oak_leaves"].map(name => api.stateId(name)));
			let checked = 0;
			for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
				for (let z = 0; z < 16; z += 2) for (let x = 0; x < 16; x += 2) {
					const [wx, wz] = [(cx + dx) * 16 + x, (cz + dz) * 16 + z];
					if (api.getBlock(wx, -64, wz) < 0) continue;
					let top = 319;
					while (top > -60 && excluded.has(api.getBlock(wx, top, wz))) top--;
					for (let y = -60; y <= Math.min(143, top - 1); y++) {
						checked++;
						const index = ids.indexOf(api.getBlock(wx, y, wz));
						if (index >= 0) counts[index]++;
					}
				}
			}
			return { counts: Object.fromEntries(names.map((name, i) => [name, counts[i]])), checked };
		});
		check(ores.counts.coal_ore > 0 && ores.counts.iron_ore > 0, "ores: Terrain seed 2026 has underground coal and iron in loaded spawn chunks", JSON.stringify(ores));
		const trees = await page.evaluate(() => {
			const [sx, , sz] = window.__mc.stats().spawn.map(Math.floor);
			const log = window.__mc.stateId("oak_log");
			const leaves = window.__mc.stateId("oak_leaves");
			let logs = 0, crowns = 0;
			for (let z = sz - 24; z <= sz + 24; z++) {
				for (let x = sx - 24; x <= sx + 24; x++) {
					for (let y = 57; y < 320; y++) {
						const block = window.__mc.getBlock(x, y, z);
						if (block === log) logs++;
						if (block === leaves) crowns++;
					}
				}
			}
			return { logs, crowns };
		});
		check(trees.logs > 0 && trees.crowns > 0, "trees: Terrain seed 2026 has logs and leaves within 24 blocks of spawn", JSON.stringify(trees));
		for (const [z, name, grass] of [[0, "rain_grove", [72, 170, 74]], [144, "mild_meadow", [124, 184, 84]]]) {
			await page.evaluate(z => window.__mc.setCamera(0, 140, z, 0, 0), z);
			await page.waitForFunction(z => window.__mc.tint(0, z) !== null, {}, z);
			const tint = await page.evaluate(z => window.__mc.tint(0, z), z);
			check(registry[tint.biome]?.name === name && JSON.stringify(tint.grass) === JSON.stringify(grass), `tint: ${name} sample`, JSON.stringify(tint));
		}
		check(errors.length === 0, "tint: no Terrain page errors", errors.slice(0, 3).join(" | "));
	} finally { await page.close(); }
	for (const gen of ["flat", "hills"]) {
		const { page, errors } = await open(`server=local&world=e2e-tint-${gen}-${run}&gen=${gen}&seed=2026&view=2`);
		try {
			await settle(page, `tint ${gen}`, chunksInView(2));
			check(await page.evaluate(() => {
				const p = window.__mc.playerPosition();
				return window.__mc.tint(p[0], p[2]) === null;
			}), `tint: ${gen} keeps uncomputed default colors`);
			check(errors.length === 0, `tint: no ${gen} page errors`, errors.slice(0, 3).join(" | "));
		} finally { await page.close(); }
	}
}

/** Same generated world and fixed camera; freeze presentation time to compare exact pixels. */
async function sectionCulling() {
	const images = [];
	let camera;
	for (const disabled of [false, true]) {
		const { page, errors } = await open(`server=local&world=e2e-culling-${run}&seed=2026&view=3&time=6000${disabled ? "&cull=0" : ""}`);
		try {
			const initial = await settle(page, "culling initial", chunksInView(3));
			camera ??= [initial.spawn[0], initial.spawn[1] + 2, initial.spawn[2], 0, 20];
			await page.evaluate(async camera => {
				// E2E runs against the dev server. Patch only presentation time, leaving
				// actual geometry, culling, meshes and all terrain passes in use.
				const { Renderer } = await import("/src/client/renderer.ts");
				const render = Renderer.prototype.render;
				Renderer.prototype.render = function(camera, distance, target, fov) {
					return render.call(this, camera, distance, target, fov, 6000);
				};
				window.__mc.setCamera(...camera);
				await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			}, camera);
			const stats = await settle(page, "culling fixed camera", chunksInView(3));
			check(disabled ? stats.visibleSections === stats.sections : stats.visibleSections < stats.sections,
				`culling ${disabled ? "disabled: all sections visible" : "surface: hidden sections exist"}`, `${stats.visibleSections}/${stats.sections}`);
			await page.addStyleTag({ content: "body > :not(#view) { visibility: hidden !important; }" });
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			images.push(await page.screenshot({ path: join(shots, `culling-${disabled ? "off" : "on"}.png`), encoding: "base64" }));
			check(errors.length === 0, "culling: no page errors", errors.join(" | "));
			if (disabled) {
				const fraction = await page.evaluate(async images => {
					const pixels = await Promise.all(images.map(async data => {
						const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
						const g = new OffscreenCanvas(img.width, img.height).getContext("2d");
						g.drawImage(img, 0, 0);
						return g.getImageData(0, 0, img.width, img.height).data;
					}));
					if (pixels[0].length !== pixels[1].length) return 1;
					let changed = 0;
					for (let i = 0; i < pixels[0].length; i += 4) {
						if ([0,1,2].some(c => pixels[0][i+c] !== pixels[1][i+c])) changed++;
					}
					return changed / (pixels[0].length / 4);
				}, images);
				check(fraction < 0.005, "culling: fewer than 0.5% different pixels", `${(fraction * 100).toFixed(3)}%`);
			}
		} finally { await page.close(); }
	}
}

/** Survival uses authoritative item stacks while the existing playthroughs stay creative. */
async function survivalInventory() {
	const { page, errors } = await open(`server=local&world=e2e-survival-${run}&mode=survival&gen=flat&seed=2026&view=2&time=6000`);
	try {
		const stats = await settle(page, "survival", chunksInView(2));
		check(stats.gameMode === "survival", "survival: new-world URL sets game mode");
		check(await page.$$eval("#hotbar canvas", slots => slots.every(c => c.title === "")), "survival: starts with an empty hotbar");
		const [sx, sy, sz] = stats.spawn;
		const targets = [1, 2].map(dx => [Math.floor(sx) + dx, Math.floor(sy) - 1, Math.floor(sz)]);
		await page.mouse.click(640, 360);
		await page.waitForFunction(() => document.pointerLockElement?.id === "view");
		await page.keyboard.press("KeyE");
		check(await page.$eval("#block-picker", picker => picker.hidden), "survival: block picker stays closed");
		for (let i = 0; i < targets.length; i++) {
			await page.evaluate(([x,y,z]) => window.__mc.setCamera(x + 0.5, y + 4, z + 0.5, 0, 90), targets[i]);
			await page.mouse.down();
			await page.waitForFunction(() => window.__mc.stats().dig !== null);
			await page.mouse.up();
			await new Promise(resolve => setTimeout(resolve, 200));
			check(await page.evaluate(([x,y,z]) => window.__mc.getBlock(x,y,z) !== 0, targets[i]), "survival: releasing early preserves the block");
			await page.mouse.down();
			const stageHandle = await page.waitForFunction(() => {
				const stage = window.__mc.stats().dig?.stage;
				return stage > 0 ? stage : false;
			});
			const stage = await stageHandle.jsonValue();
			await stageHandle.dispose();
			check(stage > 0 && stage <= 9, "survival: held mining exposes a crack stage");
			await page.waitForFunction(([x,y,z]) => window.__mc.getBlock(x,y,z) === 0, {}, targets[i]);
			await page.mouse.up();
			check(await page.evaluate(([x,y,z]) => window.__mc.getBlock(x,y,z) === 0, targets[i]), "survival: holding breaks the block");
			await page.waitForFunction(() => window.__mc.stats().entities.length > 0);
			check(await page.evaluate(() => window.__mc.stats().entities.length > 0), "survival: breaking spawns a visible item entity");
			await page.evaluate(([x,y,z]) => window.__mc.setCamera(x + 0.5, y + 1.62, z + 0.5, 0, 90), targets[i]);
			await page.waitForFunction(count => window.__mc.stats().inventory[0]?.count === count, {}, i + 1);
		}
		check(await page.$eval("#hotbar canvas", c => c.title === "grass_block" && c.dataset.count === "2" && c.width === 64), "survival: breaking two blocks shows the hotbar count");
		await page.keyboard.press("KeyQ");
		await page.waitForFunction(() => window.__mc.stats().inventory[0]?.count === 1 && window.__mc.stats().entities.length > 0);
		check(await page.evaluate(() => window.__mc.stats().entities.length > 0), "survival: Q removes one item and displays a dropped entity");
		await page.waitForFunction(() => window.__mc.stats().inventory[0]?.count === 2 && window.__mc.stats().entities.length === 0);

		await page.evaluate(([x,y,z]) => window.__mc.setCamera(x + 0.5, y + 4, z + 0.5, 0, 90), targets[1]);
		await page.mouse.click(640, 360, { button: "right" });
		await page.waitForFunction(() => window.__mc.stats().inventory[0]?.count === 1);
		check(await page.evaluate(([x,y,z]) => window.__mc.getBlock(x,y,z) === window.__mc.stateId("grass_block"), targets[1]), "survival: placement consumes one item (1 remaining)");
		const savedItem = await page.evaluate(() => window.__mc.stats().inventory[0].item);
		// Export waits for a full save, including the remaining item in player.dat.
		await page.evaluate(async () => { await window.__mc.exportWorld(); });
		await page.goto(`${edge}/play.html?server=local&world=e2e-survival-${run}&mode=creative&view=2`, { waitUntil: "load" });
		const restored = await settle(page, "survival reload", chunksInView(2));
		check(restored.gameMode === "survival", "survival: saved mode ignores URL changes");
		let inventoryRestored = true;
		let inventoryDetail = "";
		try {
			await page.waitForFunction(item => {
				const slot = window.__mc.stats().inventory[0];
				return slot?.item === item && slot?.count === 1;
			}, { timeout: 5000 }, savedItem);
		} catch (err) {
			if (err.name !== "TimeoutError") throw err;
			inventoryRestored = false;
			const slot = await page.evaluate(() => window.__mc.stats().inventory[0]);
			inventoryDetail = `expected item ${savedItem}, count 1; inventory[0]=${JSON.stringify(slot)}`;
		}
		const hotbarRestored = await page.$eval("#hotbar canvas", c => c.title === "grass_block" && c.dataset.count === "1");
		check(inventoryRestored && hotbarRestored, "survival: reload restores one grass block in the first slot", inventoryDetail);
		await page.evaluate(([x,y,z]) => window.__mc.setCamera(x + 0.5, y + 4, z + 0.5, 0, 90), targets[0]);
		await page.mouse.click(640, 360);
		await page.waitForFunction(() => document.pointerLockElement?.id === "view");
		await page.mouse.click(640, 360, { button: "right" });
		await page.waitForFunction(() => window.__mc.stats().inventory[0] === null);
		check(await page.evaluate(([x,y,z]) => window.__mc.getBlock(x,y,z) === window.__mc.stateId("grass_block"), targets[0]), "survival: placement consumes one item (0 remaining)");
		check(await page.$eval("#hotbar canvas", c => c.title === "" && c.dataset.count === "0"), "survival: last item leaves an empty slot");
		check(errors.length === 0, "survival: no page errors", errors.join(" | "));
	} finally { await page.close(); }
}

try {
	await sectionCulling();
	await biomeTints();
	await inputs();
	if (process.env.MC_E2E_ONLY === "input") throw new Error("stopped after the input stage");
	await partialModels();
	await survivalInventory();
	await dayNight();
	await undergroundLighting();
	await transparentMaterials();
	const fallback = await open(`server=local&world=e2e-gen-off-${run}&seed=2026&view=2&genworkers=0`);
	try {
		const stats = await settle(fallback.page, "generation disabled", chunksInView(2));
		check(stats.chunks === chunksInView(2), "local: genworkers=0 loads chunks");
		const generation = await fallback.page.evaluate(() => window.__mc.stats().server?.generation);
		check(!generation || generation.requested === 0, "local: genworkers=0 disables offload");
	} finally { await fallback.page.close(); }
	const page = await playthrough("local");
	const expected = ServerCore.fromModule(new WebAssembly.Module(readFileSync(join(root, "apps/web/src/wasm/server.wasm")))).runScenario(2026n, 600);
	const inBrowser = await page.evaluate(() => window.__mc.runScenario("2026", 600));
	check(inBrowser === expected, "scenario fingerprint in Chrome equals Node", `${inBrowser} vs ${expected}`);
	await page.close();
	await (await playthrough("ws")).close();
} catch (err) {
	check(false, "run completed", err.message);
} finally {
	await browser.close();
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nAll end-to-end checks passed");
