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
import { bounded, diagnose, shouldDiagnoseRunFailure } from "./e2e-diag.mjs";

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
	// A waitForFunction can occupy one CDP call for settle's full 120s;
	// allow that wait, but fail sooner than the default 180s on a hung renderer.
	protocolTimeout: 150000,
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

async function resumePointerLock(page, label) {
	const waitFor = async (step, predicate, options) => {
		try { return await page.waitForFunction(predicate, options); }
		catch (error) { throw new Error(`${step}: ${error.message}`, { cause: error }); }
	};
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
			if (attempt === 5) throw new Error(`${label}: resume failed after ${attempt} attempts: ${error.message}`, { cause: error });
		}
	}
}

async function diagnoseFailure(page, label, err) {
	if (shouldDiagnoseRunFailure(err)) {
		await diagnose(browser, page, label, { edge, shots });
		err.diagnosed = true;
	}
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
		const state = await diagnose(browser, page, label, { edge, shots });
		const error = new Error(`${label}: world did not settle: ${err.message} ${JSON.stringify({ page: state.page, targets: state.targets })}`);
		error.diagnosed = true;
		throw error;
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
		} catch (err) {
			await diagnoseFailure(page, `sky-${time}`, err);
			throw err;
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
	} catch (err) {
		await diagnoseFailure(page, "lighting", err);
		throw err;
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
	} catch (err) {
		await diagnoseFailure(page, "materials", err);
		throw err;
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
		const toolNames = ["wooden", "stone", "copper", "iron"].flatMap(tier => ["pickaxe", "axe", "shovel", "hoe"].map(kind => `${tier}_${kind}`));
		check(toolNames.every(name => names.filter(n => n === name).length === 1), "tools: picker includes all sixteen tools once");
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
		await resumePointerLock(page, "models resume after inventory key");
		await page.keyboard.press("KeyE");
		await waitFor("picker reopened before Escape", () => !document.getElementById("block-picker").hidden);
		await page.keyboard.press("Escape");
		await waitFor("picker closed with Escape into game menu", () => document.getElementById("block-picker").hidden
			&& !document.getElementById("overlay").hidden && !document.pointerLockElement
			&& !document.getElementById("game-menu").hidden);
		await resumePointerLock(page, "models resume after Escape");

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
			await resumePointerLock(page, `models resume after selecting ${name}`);
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
	} catch (err) {
		await diagnoseFailure(page, "models", err);
		throw err;
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
	} catch (err) {
		await diagnoseFailure(page, "tint-terrain", err);
		throw err;
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
		} catch (err) {
			await diagnoseFailure(page, `tint-${gen}`, err);
			throw err;
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
		} catch (err) {
			await diagnoseFailure(page, `culling-${disabled ? "off" : "on"}`, err);
			throw err;
		} finally { await page.close(); }
	}
}

/** Survival uses authoritative item stacks while the existing playthroughs stay creative. */
// Mine an original generated tree and craft through the actual DOM, with no item injection.
async function survivalCrafting() {
    const { page, errors } = await open(`server=local&world=e2e-crafting-${run}&mode=survival&gen=terrain&seed=2026&view=3&time=6000`);
    try {
        const stats = await settle(page, "survival crafting", chunksInView(3));
        check(stats.gameMode === "survival", "crafting: Terrain survival world");
        const target = await page.evaluate(() => {
            const api = window.__mc;
            const [sx,,sz] = api.stats().spawn.map(Math.floor);
            const log = api.stateId("oak_log");
            // Search the same spawn radius and seed as the existing tree check.
            // A supported, clear cell east of the trunk gives a stable mining view.
            for (let z=sz-24;z<=sz+24;z++) for (let x=sx-24;x<=sx+24;x++) {
                for (let y=57;y<319;y++) {
                    if (api.getBlock(x,y,z) !== log || api.getBlock(x,y-1,z) === log) continue;
                    // Require the next two logs in this same trunk as well.
                    if ([1,2].some(dy => api.getBlock(x,y+dy,z) !== log)) continue;
                    const floor = api.getBlock(x+1,y-1,z);
                    if (floor <= 0 || floor === api.stateId("water")) continue;
                    if ([0,1,2].some(dy => api.getBlock(x+1,y+dy,z) !== 0)) continue;
                    return [x,y,z];
                }
            }
            return null;
        });
        check(target !== null, "crafting: finds an accessible spawn tree");
        if (!target) return;
        await page.mouse.click(640,360);
        await page.waitForFunction(() => document.pointerLockElement?.id === "view");
        await page.evaluate(([x,y,z]) => window.__mc.setCamera(x+1.5,y+1.62,z+0.5,90,Math.atan2(1.12,0.51)*180/Math.PI),target);
        await page.waitForFunction(([x,y,z]) => {
            const c=window.__mc.stats().camera;
            const pitch=c.pitch*Math.PI/180;
            const t=window.__mc.raycast([c.x,c.y,c.z],[-Math.cos(pitch),-Math.sin(pitch),0],6);
            return t?.x===x && t?.y===y && t?.z===z;
        },{},target);
        await page.mouse.down();
        await page.waitForFunction(([x,y,z]) => window.__mc.getBlock(x,y,z)===0,{},target);
        await page.mouse.up();
        await page.evaluate(([x,y,z]) => window.__mc.setCamera(x+0.5,y+1.62,z+0.5,0,0),target);
        await page.waitForFunction(() => window.__mc.stats().inventory[0]?.count===1);
        check(await page.$eval("#hotbar canvas", c=>c.title==="oak_log"), "crafting: mines and picks up log");
        await page.keyboard.press("KeyE");
        await page.waitForSelector('#inventory-screen:not([hidden])');
        await page.click('#inventory-screen [data-slot="0"]');
        await page.waitForFunction(() => document.querySelector('#inventory-screen [data-slot="0"] canvas').dataset.count === "0");
        await page.click('#inventory-screen [data-slot="36"]');
        await page.waitForFunction(() => document.querySelector('#inventory-screen [data-slot="40"] canvas').title === "oak_planks");
        check(await page.$eval('#inventory-screen [data-slot="40"] canvas',c=>c.dataset.count==="4"),"crafting: log previews four planks");
        await page.click('#inventory-screen [data-slot="40"]');
        await page.waitForFunction(() => document.querySelector('#inventory-screen [data-slot="36"] canvas').dataset.count === "0");
        await page.click('#inventory-screen [data-slot="9"]');
        await page.waitForFunction(() => window.__mc.stats().inventory[9]?.count===4);
        check(await page.$eval('#inventory-screen [data-slot="9"] canvas',c=>c.title==="oak_planks" && c.dataset.count==="4"),"crafting: takes result and returns planks to inventory");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.getElementById("inventory-screen").hidden);
        // Preserve the first-log checks above, then mine the next two trunk blocks.
        await page.waitForFunction(() => document.pointerLockElement?.id === "view");
        for (const dy of [1,2]) {
            await page.evaluate(([x,y,z,dy]) => window.__mc.setCamera(x+1.5,y+1.62,z+0.5,90,Math.atan2(1.12-dy,1)*180/Math.PI),[...target,dy]);
            await page.waitForFunction(([x,y,z,dy]) => {
                const c=window.__mc.stats().camera, p=c.pitch*Math.PI/180;
                const hit=window.__mc.raycast([c.x,c.y,c.z],[-Math.cos(p),-Math.sin(p),0],6);
                return hit?.x===x && hit?.y===y+dy && hit?.z===z;
            },{},[...target,dy]);
            await page.mouse.down();
            await page.waitForFunction(([x,y,z,dy]) => window.__mc.getBlock(x,y+dy,z)===0,{},[...target,dy]);
            await page.mouse.up();
            await page.evaluate(([x,y,z]) => window.__mc.setCamera(x+0.5,y+1.62,z+0.5,0,0),target);
            await page.waitForFunction(count => window.__mc.stats().inventory[0]?.count===count,{},dy);
        }
        check(await page.evaluate(() => window.__mc.stats().inventory[0]?.count===2),"crafting: collects three logs from the same trunk");
        await page.keyboard.press("KeyE");
        await page.waitForFunction(() => !document.getElementById("inventory-screen").hidden);
        // Each click waits for a changed slot rendered from the server Inventory.
        const clickSlot = async (screen, slot, count, button = "left", observedSlot = slot) => {
            const selector = `#${screen} [data-slot="${slot}"]`;
            await page.click(selector,{button});
            await page.waitForFunction((selector,count) => document.querySelector(`${selector} canvas`).dataset.count===String(count),{},`#${screen} [data-slot="${observedSlot}"]`,count);
        };
        const inv = (slot,count,button) => clickSlot("inventory-screen",slot,count,button);
        await inv(0,0);
        await inv(36,2);
        // The preview stays four planks; observe the consumed log to acknowledge the click.
        await clickSlot("inventory-screen",40,1,"left",36);
        await inv(40,0);
        await inv(9,12);
        check(await page.$eval('#inventory-screen [data-slot="9"] canvas',c=>c.dataset.count==="12"),"crafting: three logs yield twelve planks");
        await inv(9,0);
        await inv(36,1,"right");
        await inv(38,1,"right");
        await inv(9,10);
        await inv(40,0);
        await inv(10,4);
        check(await page.$eval('#inventory-screen [data-slot="10"] canvas',c=>c.title==="stick"),"crafting: crafts sticks through inventory buttons");
        await inv(9,0);
        for (const slot of [36,37,38,39]) await inv(slot,1,"right");
        await inv(9,6);
        await page.waitForFunction(() => document.querySelector('#inventory-screen [data-slot="40"] canvas').title==="crafting_table");
        await inv(40,0);
        await inv(0,1);
        check(await page.$eval('#inventory-screen [data-slot="0"] canvas',c=>c.title==="crafting_table"),"crafting: crafts table into hotbar");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.pointerLockElement?.id === "view");
        // Move before aiming: under pointer lock this movement rotates the camera.
        await page.mouse.move(640, 360);
        await page.keyboard.press("Digit1");
        await page.waitForFunction(() => window.__mc.stats().selectedSlot===0);
        await page.evaluate(([x,y,z]) => window.__mc.setCamera(x+1.5,y+1.62,z+0.5,90,Math.atan2(2.12,1)*180/Math.PI),target);
        await page.waitForFunction(([x,y,z]) => {
            const c=window.__mc.stats().camera, p=c.pitch*Math.PI/180;
            const hit=window.__mc.raycast([c.x,c.y,c.z],[-Math.cos(p),-Math.sin(p),0],6);
            return hit?.x===x && hit?.y===y-1 && hit?.z===z && hit?.face===1;
        },{},target);
        await page.mouse.click(640,360,{button:"right"});
        await page.waitForFunction(([x,y,z]) => window.__mc.getBlock(x,y,z)===window.__mc.stateId("crafting_table") && !window.__mc.stats().inventory[0],{},target);
        check(await page.evaluate(([x,y,z])=>window.__mc.getBlock(x,y,z)===window.__mc.stateId("crafting_table"),target),"crafting: places table on the ground");
        // No mouse movement since placement; the next right-click stays at the center.
        await page.evaluate(([x,y,z]) => window.__mc.setCamera(x+1.5,y+1.62,z+0.5,90,Math.atan2(1.12,1)*180/Math.PI),target);
        await page.waitForFunction(([x,y,z]) => {
            const c=window.__mc.stats().camera, p=c.pitch*Math.PI/180;
            const hit=window.__mc.raycast([c.x,c.y,c.z],[-Math.cos(p),-Math.sin(p),0],6);
            return hit?.x===x && hit?.y===y && hit?.z===z;
        },{},target);
        await page.mouse.click(640,360,{button:"right"});
        await page.waitForFunction(() => !document.getElementById("crafting-table-screen").hidden);
        check(await page.$eval("#crafting-table-screen",el=>!el.hidden),"crafting: right-click opens table screen");
        const table = (slot,count,button) => clickSlot("crafting-table-screen",slot,count,button);
        await table(9,0);
        for (const slot of [41,42,43]) await table(slot,1,"right");
        await table(9,3);
        await table(10,0);
        for (const slot of [45,48]) await table(slot,1,"right");
        await table(10,2);
        await page.waitForFunction(() => document.querySelector('#crafting-table-screen [data-slot="50"] canvas').title==="wooden_pickaxe");
        check(await page.$eval('#crafting-table-screen [data-slot="50"] canvas',c=>c.title==="wooden_pickaxe"),"crafting: three planks and two sticks preview wooden pickaxe");
        await table(50,0);
        await table(11,1);
        check(await page.$eval('#crafting-table-screen [data-slot="11"] canvas',c=>c.title==="wooden_pickaxe"),"crafting: takes wooden pickaxe into inventory");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.getElementById("crafting-table-screen").hidden && window.__mc.stats().screen===0);
        check(await page.evaluate(() => window.__mc.stats().inventory[11]?.count===1 && document.querySelector('#crafting-table-screen [data-slot="11"] canvas').title==="wooden_pickaxe"),"crafting: wooden pickaxe remains in inventory after closing");
        check(errors.length===0,"crafting: no page errors",errors.join(" | "));
    } catch (err) {
        await diagnoseFailure(page, "crafting", err);
        throw err;
    } finally { await page.close(); }
}

async function leafDecay() {
	const { page, errors } = await open(`server=local&world=e2e-leaves-${run}&mode=creative&gen=terrain&seed=2026&view=3&time=6000`);
	try {
		const { spawn } = await settle(page, "leaf decay", chunksInView(3));
		const trunk = await page.evaluate(() => {
			const api = window.__mc;
			const [sx, , sz] = api.stats().spawn.map(Math.floor);
			const log = api.stateId("oak_log");
			// Match survivalCrafting's radius and clear east-side approach.
			for (let z = sz - 24; z <= sz + 24; z++) for (let x = sx - 24; x <= sx + 24; x++) {
				for (let y = 57; y < 319; y++) {
					if (api.getBlock(x, y, z) !== log || api.getBlock(x, y - 1, z) === log) continue;
					if ([1, 2].some(dy => api.getBlock(x, y + dy, z) !== log)) continue;
					const floor = api.getBlock(x + 1, y - 1, z);
					if (floor <= 0 || floor === api.stateId("water")) continue;
					if ([0, 1, 2].some(dy => api.getBlock(x + 1, y + dy, z) !== 0)) continue;
					let top = y + 2;
					while (api.getBlock(x, top + 1, z) === log) top++;
					return { x, y, z, top };
				}
			}
			return null;
		});
		check(trunk !== null, "leaves: finds an accessible spawn tree");
		if (!trunk) return;
		await resumePointerLock(page, "leaves initial pointer lock");
		const aim = async (pos, view, face) => {
			await page.waitForFunction(([x, y, z], { direction, yaw, pitch }, face) => {
				const api = window.__mc;
				const c = api.stats().camera;
				if (c.yaw !== yaw || c.pitch !== pitch) return false;
				const hit = api.raycast([c.x, c.y, c.z], direction, 6);
				return hit?.x === x && hit?.y === y && hit?.z === z && (face === undefined || hit.face === face);
			}, { timeout: 5000 }, pos, view, face);
		};
		const click = async (button = "left") => {
			await page.mouse.down({ button });
			await page.mouse.up({ button });
		};
		const waitForBlock = (pos, name) => page.waitForFunction(([x, y, z], name) => {
			const api = window.__mc;
			return api.getBlock(x, y, z) === api.stateId(name);
		}, { timeout: 5000 }, pos, name);

		// Place the leaf high over spawn, then remove its temporary support.
		const anchor = [Math.floor(spawn[0]), Math.floor(spawn[1]) + 16, Math.floor(spawn[2])];
		const placed = [anchor[0], anchor[1] + 1, anchor[2]];
		await page.keyboard.press("Digit7"); // Default oak leaves item.
		await page.waitForFunction(() => window.__mc.stats().selectedSlot === 6);
		await page.evaluate(([x, y, z]) => {
			const api = window.__mc;
			api.setCamera(x + 0.5, y + 4.5, z + 0.5, 0, 90);
			api.setBlock(x, y, z, api.stateId("stone"));
		}, anchor);
		await aim(anchor, { direction: [0, -1, 0], yaw: 0, pitch: 90 }, 1);
		await click("right");
		await waitForBlock(placed, "placed_oak_leaves");
		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 2.5, y + 0.5, z + 0.5, 90, 0), anchor);
		await aim(anchor, { direction: [-1, 0, 0], yaw: 90, pitch: 0 });
		await click();
		await waitForBlock(anchor, "air");
		check(true, "leaves: right-click places persistent leaves in the air");

		for (let y = trunk.y; y <= trunk.top; y++) {
			const pos = [trunk.x, y, trunk.z];
			const view = await page.evaluate(([x, y, z]) => {
				const api = window.__mc;
				// Enclosed upper logs can be reached through the cleared trunk below.
				for (const [dx, dy, dz, yaw, pitch] of [
					[1, 0, 0, 90, 0], [-1, 0, 0, -90, 0], [0, 0, 1, 180, 0], [0, 0, -1, 0, 0],
					[0, -1, 0, 0, -90],
				]) {
					const camera = [x + 0.5 + dx, y + 0.5 + dy, z + 0.5 + dz];
					const direction = [-dx, -dy, -dz];
					const hit = api.raycast(camera, direction, 6);
					if (hit?.x === x && hit?.y === y && hit?.z === z) {
						api.setCamera(...camera, yaw, pitch);
						return { direction, yaw, pitch };
					}
				}
				throw new Error(`leaves: no clear ray to trunk log at ${x},${y},${z}`);
			}, pos);
			await aim(pos, view);
			await click();
			await waitForBlock(pos, "air");
		}

		function countLeaves({ x, y, z, top }, atMost = Infinity) {
			const api = window.__mc;
			const leaves = api.stateId("oak_leaves");
			let count = 0;
			for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
				for (let wy = y - 1; wy <= top + 3; wy++) {
					if (api.getBlock(x + dx, wy, z + dz) === leaves) count++;
				}
			}
			return count <= atMost ? { count } : false;
		}
		const before = await page.evaluate(countLeaves, trunk);
		check(before.count >= 5, "leaves: at least five terrain leaves remain after breaking the trunk", before.count);
		if (before.count < 5) return;
		const after = await bounded(async () => {
			const result = await page.waitForFunction(countLeaves, { timeout: 60000, polling: 250 }, trunk, before.count - 5);
			return result.jsonValue();
		}, 60000);
		if (typeof after === "string") {
			const state = await diagnose(browser, page, "leaf-decay", { edge, shots });
			const error = new Error(`leaf decay: ${after} ${JSON.stringify({ page: state.page, targets: state.targets })}`);
			error.diagnosed = true;
			throw error;
		}
		check(before.count - after.count >= 5, "leaves: at least five terrain leaves decay", `${before.count} → ${after.count}`);
		check(await page.evaluate(({ x, y, z, top }) => {
			for (let wy = y; wy <= top; wy++) {
				if (window.__mc.getBlock(x, wy, z) !== 0) return false;
			}
			return true;
		}, trunk), "leaves: all trunk logs stayed broken");
		await waitForBlock(placed, "placed_oak_leaves");
		check(true, "leaves: placed leaves stay after the decay wait");
		check(errors.length === 0, "leaves: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "leaf-decay", err);
		throw err;
	} finally {
		await page.close();
	}
}

async function furnaceSmelting() {
    const { page, errors } = await open(`server=local&world=e2e-furnace-${run}&mode=creative&gen=flat&seed=2026&view=3&time=6000`);
    try {
        const stats = await settle(page, "furnace smelting", chunksInView(3));
        check(stats.gameMode === "creative" && stats.generatorName === "Flat", "furnace: Flat creative world");
        await page.mouse.click(640, 360);
        await resumePointerLock(page, "furnace initial pointer lock");
        const pickBlock = async (name, slot) => {
            await page.keyboard.press(`Digit${slot + 1}`);
            await page.waitForFunction(slot => window.__mc.stats().selectedSlot === slot, {}, slot);
            await page.keyboard.press("KeyE");
            await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
            await page.click(`#block-grid [data-block="${name}"]`);
            await page.waitForFunction(name => document.querySelector("#hotbar canvas.selected")?.title === name, {}, name);
            check(await page.$eval("#hotbar canvas.selected", (c, name) => c.title === name, name), `furnace: picker selects ${name}`);
            await page.mouse.move(640, 360);
            await page.keyboard.press("KeyE");
            await page.waitForFunction(() => document.getElementById("block-picker").hidden);
            await resumePointerLock(page, `furnace resume after selecting ${name}`);
        };
        await pickBlock("furnace", 0);
        await pickBlock("iron_ore", 1);
        await pickBlock("coal", 2);
        const target = await page.evaluate(() => {
            const api = window.__mc;
            const [sx, sy, sz] = api.stats().spawn.map(Math.floor);
            for (let y = sy + 4; y >= sy - 8; y--) {
                if (api.getBlock(sx - 1, y - 1, sz) !== 0 && api.getBlock(sx - 1, y, sz) === 0) return [sx - 1, y, sz];
            }
            throw new Error("furnace: no ground in front of spawn");
        });
        await page.keyboard.press("Digit1");
        await page.waitForFunction(() => window.__mc.stats().selectedSlot === 0);
        // Move before setting the camera: pointer-locked movement changes yaw.
        await page.mouse.move(640, 360);
        await page.evaluate(([x,y,z]) => window.__mc.setCamera(x+1.5,y+1.62,z+0.5,90,Math.atan2(2.12,1)*180/Math.PI), target);
        await page.waitForFunction(([x,y,z]) => {
            const c = window.__mc.stats().camera, p = c.pitch*Math.PI/180;
            const hit = window.__mc.raycast([c.x,c.y,c.z],[-Math.cos(p),-Math.sin(p),0],6);
            return hit?.x === x && hit?.y === y-1 && hit?.z === z && hit?.face === 1;
        }, {}, target);
        await page.mouse.click(640, 360, { button: "right" });
        await page.waitForFunction(([x,y,z]) => window.__mc.getBlock(x,y,z) === window.__mc.stateId("furnace"), {}, target);
        check(await page.evaluate(([x,y,z]) => window.__mc.getBlock(x,y,z) === window.__mc.stateId("furnace"), target), "furnace: places furnace on the ground");
        await page.evaluate(([x,y,z]) => window.__mc.setCamera(x+1.5,y+1.62,z+0.5,90,Math.atan2(1.12,1)*180/Math.PI), target);
        await page.waitForFunction(([x,y,z]) => {
            const c = window.__mc.stats().camera, p = c.pitch*Math.PI/180;
            const hit = window.__mc.raycast([c.x,c.y,c.z],[-Math.cos(p),-Math.sin(p),0],6);
            return hit?.x === x && hit?.y === y && hit?.z === z;
        }, {}, target);
        await page.mouse.click(640, 360, { button: "right" });
        await page.waitForFunction(() => !document.getElementById("furnace-screen").hidden && window.__mc.stats().screen === 2);
        check(await page.evaluate(() => !document.getElementById("furnace-screen").hidden && window.__mc.stats().screen === 2), "furnace: right-click opens furnace screen");
        const clickSlot = async (slot, count) => {
            await page.click(`#furnace-screen [data-slot="${slot}"]`);
            await page.waitForFunction((slot, count) => document.querySelector(`#furnace-screen [data-slot="${slot}"] canvas`).dataset.count === String(count), {}, slot, count);
        };
        await clickSlot(1, 0);
        await clickSlot(51, 1);
        check(await page.$eval('#furnace-screen [data-slot="51"] canvas', c => c.title === "iron_ore"), "furnace: moves iron ore into input");
        await clickSlot(2, 0);
        await clickSlot(52, 0); // The server consumes the one coal as burning starts.
        await page.waitForFunction(() => {
            const burn = document.getElementById("furnace-burn");
            const smelt = document.getElementById("furnace-smelt");
            return Number(burn.getAttribute("aria-valuenow")) > 0 && Number(burn.getAttribute("aria-valuemax")) === 1600
                && Number(smelt.getAttribute("aria-valuenow")) > 0 && Number(smelt.getAttribute("aria-valuemax")) === 160;
        }, { timeout: 20000 });
        const burning = await page.$eval("#furnace-burn", el => Number(el.getAttribute("aria-valuenow")));
        await page.waitForFunction(before => {
            const value = Number(document.getElementById("furnace-burn").getAttribute("aria-valuenow"));
            return value > 0 && value < before;
        }, { timeout: 20000 }, burning);
        check(true, "furnace: burn gauge decreases and smelting gauge advances");
        await page.waitForFunction(() => {
            const output = document.querySelector('#furnace-screen [data-slot="53"] canvas');
            return output.title === "iron_ingot" && output.dataset.count === "1";
        }, { timeout: 20000 });
        check(await page.$eval('#furnace-screen [data-slot="53"] canvas', c => c.title === "iron_ingot" && c.dataset.count === "1"), "furnace: smelts iron ingot after 160 ticks");
        await page.keyboard.down("ShiftLeft");
        try { await clickSlot(53, 0); }
        finally { await page.keyboard.up("ShiftLeft"); }
        await page.waitForFunction(() => [...document.querySelectorAll('#furnace-screen [data-slot]')].some(button => Number(button.dataset.slot) < 36 && button.querySelector("canvas").title === "iron_ingot"));
        check(true, "furnace: shift-click takes iron ingot into inventory");
        await page.click("#furnace-screen > button:last-child");
        await page.waitForFunction(() => document.getElementById("furnace-screen").hidden && window.__mc.stats().screen === 0);
        check(await page.evaluate(() => document.getElementById("furnace-screen").hidden && window.__mc.stats().screen === 0), "furnace: closes furnace screen");
        await resumePointerLock(page, "furnace resume after closing furnace");
        check(errors.length === 0, "furnace: no page errors", errors.join(" | "));
    } catch (err) {
        await diagnoseFailure(page, "furnace", err);
        throw err;
    } finally { await page.close(); }
}

async function farming() {
	const { page, errors } = await open(`server=local&world=e2e-farm-${run}&mode=creative&gen=flat&seed=2026&view=2&time=6000`);
	try {
		const { spawn } = await settle(page, "farming", chunksInView(2));
		await resumePointerLock(page, "farming: initial pointer lock");
		for (const [slot, name] of [[0, "wooden_hoe"], [1, "wheat_seeds"]]) {
			await page.keyboard.press(`Digit${slot + 1}`);
			await page.waitForFunction(slot => window.__mc.stats().selectedSlot === slot, {}, slot);
			await page.keyboard.press("KeyE");
			await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
			await page.click(`#block-grid [data-block="${name}"]`);
			await page.waitForFunction(name => document.querySelector("#hotbar canvas.selected")?.title === name, {}, name);
			await page.mouse.move(640, 360);
			await page.keyboard.press("KeyE");
			await page.waitForFunction(() => document.getElementById("block-picker").hidden);
			await resumePointerLock(page, `farming: resume after selecting ${name}`);
		}
		const target = [Math.floor(spawn[0]) + 1, Math.floor(spawn[1]) - 1, Math.floor(spawn[2])];
		await page.keyboard.press("Digit1");
		await page.waitForFunction(() => window.__mc.stats().selectedSlot === 0);
		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 4, z + 0.5, 0, 90), target);
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			return api.getBlock(x, y, z) === api.stateId("grass_block") && api.getBlock(x, y + 1, z) === 0;
		}, {}, target);
		await page.mouse.click(640, 360, { button: "right" });
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			return api.getBlock(x, y, z) === api.stateId("farmland[moist=false]");
		}, {}, target);
		check(true, "farming: right-click with hoe tills grass into dry farmland");
		await page.keyboard.press("Digit2");
		await page.waitForFunction(() => window.__mc.stats().selectedSlot === 1);
		await page.mouse.click(640, 360, { button: "right" });
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			return api.getBlock(x, y + 1, z) === api.stateId("wheat[age=0]");
		}, {}, target);
		check(true, "farming: right-click with seeds plants age-zero wheat");
		check(errors.length === 0, "farming: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "farming", err);
		throw err;
	} finally { await page.close(); }
}

async function waterFlow() {
	const { page, errors } = await open(`server=local&world=e2e-water-${run}&mode=creative&gen=flat&seed=2026&view=2&time=6000`);
	try {
		const { spawn } = await settle(page, "water flow", chunksInView(2));
		await resumePointerLock(page, "water flow: initial pointer lock");
		const source = [Math.floor(spawn[0]) + 1, Math.floor(spawn[1]), Math.floor(spawn[2])];
		const selectBucket = async name => {
			await page.keyboard.press("KeyE");
			await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
			await page.click(`#block-grid [data-block="${name}"]`);
			await page.waitForFunction(name => document.querySelector("#hotbar canvas.selected")?.title === name, {}, name);
			await page.mouse.move(640, 360);
			await page.keyboard.press("KeyE");
			await page.waitForFunction(() => document.getElementById("block-picker").hidden);
			await resumePointerLock(page, `water flow: resume after selecting ${name}`);
			await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 3, z + 0.5, 0, 90), source);
		};
		await selectBucket("water_bucket");
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			return api.getBlock(x, y - 1, z) === api.stateId("grass_block") && api.getBlock(x, y, z) === 0;
		}, { timeout: 5000 }, source);
		await page.mouse.click(640, 360, { button: "right" });
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			return api.getBlock(x, y, z) === api.stateId("water")
				&& api.getBlock(x + 1, y, z) === api.stateId("flowing_water[level=1]");
		}, { timeout: 5000 }, source);
		check(true, "water flow: a filled bucket places a source and water spreads");
		await selectBucket("bucket");
		await page.mouse.click(640, 360, { button: "right" });
		await page.waitForFunction(([x, y, z]) => window.__mc.getBlock(x, y, z) === 0, { timeout: 5000 }, source);
		check(true, "water flow: an empty bucket collects the source");
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			for (let dx = -7; dx <= 7; dx++) for (let dz = -7; dz <= 7; dz++) {
				if (Math.abs(dx) + Math.abs(dz) <= 7 && api.getBlock(x + dx, y, z + dz) !== 0) return false;
			}
			return true;
		}, { timeout: 5000 }, source);
		check(true, "water flow: the surrounding water drains");
		check(errors.length === 0, "water flow: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "water-flow", err);
		throw err;
	} finally { await page.close(); }
}

async function lavaFlow() {
	const { page, errors } = await open(`server=local&world=e2e-lava-${run}&mode=creative&gen=flat&seed=2026&view=2&time=6000`);
	try {
		const { spawn } = await settle(page, "lava flow", chunksInView(2));
		await resumePointerLock(page, "lava flow: initial pointer lock");
		const source = [Math.floor(spawn[0]) + 1, Math.floor(spawn[1]), Math.floor(spawn[2])];
		const pedestal = [source[0] - 1, source[1], source[2]];
		const place = async (name, pos) => {
			await page.keyboard.press("KeyE");
			await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
			await page.click(`#block-grid [data-block="${name}"]`);
			await page.waitForFunction(name => document.querySelector("#hotbar canvas.selected")?.title === name, {}, name);
			await page.mouse.move(640, 360);
			await page.keyboard.press("KeyE");
			await page.waitForFunction(() => document.getElementById("block-picker").hidden);
			await resumePointerLock(page, `lava flow: resume after selecting ${name}`);
			await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 3, z + 0.5, 0, 90), pos);
			await page.mouse.click(640, 360, { button: "right" });
		};
		// Support a water source above the lava so water can reach the lava from the top.
		await place("stone", pedestal);
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			return api.getBlock(x, y, z) === api.stateId("stone");
		}, { timeout: 5000 }, pedestal);
		await place("lava_bucket", source);
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			return api.getBlock(x, y, z) === api.stateId("lava")
				&& api.getBlock(x + 1, y, z) === api.stateId("flowing_lava[level=1]");
		}, { timeout: 5000 }, source);
		check(true, "lava flow: a lava bucket places a source and lava spreads");
		const water = [pedestal[0], pedestal[1] + 1, pedestal[2]];
		await place("water_bucket", water);
		await page.waitForFunction(({ source, water }) => {
			const api = window.__mc;
			return api.getBlock(...water) === api.stateId("water")
				&& api.getBlock(...source) === api.stateId("obsidian");
		}, { timeout: 5000 }, { source, water });
		check(true, "lava flow: water turns the lava source into obsidian");
		check(errors.length === 0, "lava flow: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "lava-flow", err);
		throw err;
	} finally { await page.close(); }
}

async function swimming() {
	const { page, errors } = await open(`server=local&world=e2e-swim-${run}&mode=survival&gen=terrain&seed=2026&view=3&time=6000`);
	try {
		const { spawn } = await settle(page, "swimming", chunksInView(3));
		await resumePointerLock(page, "swimming: initial pointer lock");
		const findWater = origin => page.evaluate(([sx, sy, sz]) => {
			const api = window.__mc;
			const source = api.stateId("water");
			sx = Math.floor(sx);
			sz = Math.floor(sz);
			for (let radius = 0; radius <= 48; radius++) {
				for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
					if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
					const x = sx + dx;
					const z = sz + dz;
					for (let y = Math.floor(sy); y >= 0; y--) {
						if ([0, 1, 2].every(dy => api.getBlock(x, y - dy, z) === source)
							&& [1, 2].every(dy => api.getBlock(x, y + dy, z) === 0)) {
							return [x + 0.5, y + 1, z + 0.5];
						}
					}
				}
			}
			return null;
		}, origin);
		let water = await findWater(spawn);
		if (!water) {
			// Seed 2026 has open sea just north of the initial view.
			const [x, y, z] = [spawn[0], spawn[1] + 12, spawn[2] - 48];
			await page.evaluate(([x, y, z]) => window.__mc.setCamera(x, y + 1.62, z, 0, 0), [x, y, z]);
			await page.waitForFunction(([x, z]) => window.__mc.getBlock(x, 0, z) !== -1,
				{ timeout: 15000 }, [Math.floor(x) - 16, Math.floor(z) - 32]);
			await settle(page, "swimming: coast", chunksInView(3));
			water = await findWater([x, y, z]);
		}
		if (!water) throw new Error("swimming: no open water at least three blocks deep near spawn");
		const start = await page.evaluate(([x, surface, z]) => {
			const api = window.__mc;
			const corrections = api.stats().positionsCorrected;
			api.setCamera(x, surface - 2 + 1.62, z, 0, 0);
			return { corrections, feetY: api.playerPosition()[1] };
		}, water);
		check(Math.abs(start.feetY - (water[1] - 2)) < 0.001,
			"swimming: starts two blocks below the water surface");
		await page.keyboard.down("Space");
		try {
			await page.waitForFunction(surface => {
				const y = window.__mc.playerPosition()[1];
				return y + 1.62 > surface && y > surface - 0.5;
			}, { timeout: 8000 }, water[1]);
			check(true, "swimming: holding Space raises the player to the surface");
		} finally {
			await page.keyboard.up("Space");
		}
		const serverTime = await page.evaluate(() => window.__mc.stats().server?.gameTime ?? 0);
		await page.waitForFunction(t => window.__mc.stats().server?.gameTime > t, { timeout: 5000 }, serverTime);
		check(await page.evaluate(() => window.__mc.stats().positionsCorrected) === start.corrections,
			"swimming: server sends no position corrections");
		check(errors.length === 0, "swimming: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "swimming", err);
		throw err;
	} finally { await page.close(); }
}

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
        check(await page.$eval("#inventory-screen", screen => !screen.hidden), "survival: E opens inventory");
        await page.keyboard.press("KeyE");
        await page.waitForFunction(() => document.pointerLockElement?.id === "view");
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
	} catch (err) {
		await diagnoseFailure(page, "survival", err);
		throw err;
	} finally { await page.close(); }
}

async function survivalHealth() {
	const { page, errors } = await open(`server=local&world=e2e-health-${run}&mode=survival&gen=flat&seed=2026&view=2&time=6000`);
	try {
		const { spawn } = await settle(page, "survival health", chunksInView(2));
		await resumePointerLock(page, "health: initial pointer lock");
		await page.waitForFunction(() => window.__mc.stats().health === 20 && !document.getElementById("vitals").hidden);
		check(await page.$eval("#health", meter => meter.getAttribute("aria-valuenow") === "20"
			&& meter.querySelectorAll('.heart[data-state="full"]').length === 10), "health: starts with ten full hearts");

		await page.mouse.move(640, 360);
		await page.evaluate(([x, y, z]) => {
			const flash = document.getElementById("damage-flash");
			// Retain evidence of the flash even if it finishes between Puppeteer calls.
			const observer = new MutationObserver(() => {
				if (flash.hidden) return;
				performance.mark("health-damage-flash");
				observer.disconnect();
			});
			observer.observe(flash, { attributes: true, attributeFilter: ["hidden"] });
			window.__mc.setCamera(x, y + 10 + 1.62, z, 0, 90);
		}, spawn);
		await page.waitForFunction(() => window.__mc.stats().health === 13);
		check(await page.$eval("#health", meter => meter.getAttribute("aria-valuenow") === "13"
			&& Array.from(meter.children, heart => heart.dataset.state).join(" ") === "full full full full full full half empty empty empty"),
		"health: a ten-block fall leaves six full hearts and one half heart");
		await page.waitForFunction(() => performance.getEntriesByName("health-damage-flash").length > 0);
		await page.waitForFunction(() => document.getElementById("damage-flash").hidden);
		check(true, "health: damage flashes red briefly");

		const [sx, sy, sz] = spawn;
		const target = [Math.floor(sx) + 1, sy - 1, Math.floor(sz)];
		await page.mouse.move(640, 360);
		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 1 + 1.62, z + 0.5, 0, 90), target);
		await page.mouse.down();
		await page.waitForFunction(([x, y, z]) => window.__mc.getBlock(x, y, z) === 0, {}, target);
		await page.mouse.up();
		await page.waitForFunction(() => {
			const { inventory, entities } = window.__mc.stats();
			return inventory[0]?.count === 1 && entities.length === 0;
		});
		const held = await page.evaluate(() => window.__mc.stats().inventory[0]);
		check(held.count === 1, "health: mines and picks up a block");

		const landing = [sx + 4, sy, sz];
		await page.mouse.move(640, 360);
		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x, y + 40 + 1.62, z, 0, 90), landing);
		await page.waitForFunction(() => window.__mc.stats().dead && document.getElementById("death-screen").open
			&& document.pointerLockElement === null);
		check(await page.$eval("#death-cause", cause => cause.textContent.includes("落下")), "health: fatal fall shows the cause of death");
		await page.waitForFunction(([x, y, z], stack) => {
			const { entities, inventory } = window.__mc.stats();
			return inventory[0] === null && entities.some(({ item, count, position: [ex, ey, ez] }) =>
				item === stack.item && count === stack.count && Math.hypot(ex - x, ey - y, ez - z) < 1);
		}, {}, landing, held);
		check(true, "health: carried item drops at the landing position");

		await page.click("#respawn");
		await page.waitForFunction(([sx, sy, sz]) => {
			const { health, dead } = window.__mc.stats();
			const [x, y, z] = window.__mc.playerPosition();
			return !dead && health === 20 && !document.getElementById("death-screen").open
				&& Math.hypot(x - sx, y - sy, z - sz) < 1
				&& document.pointerLockElement?.id === "view";
		}, {}, spawn);
		check(true, "health: respawn restores full health, spawn position, and pointer lock");
		check(errors.length === 0, "health: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "health", err);
		throw err;
	} finally { await page.close(); }
}

async function survivalHunger() {
	const { page, errors } = await open(`server=local&world=e2e-hunger-${run}&mode=survival&gen=terrain&seed=2026&view=3&time=6000`);
	try {
		const { spawn } = await settle(page, "survival hunger", chunksInView(3));
		await resumePointerLock(page, "hunger: initial pointer lock");
		check(await page.$eval("#food", meter => !meter.closest("#vitals").hidden
			&& meter.getAttribute("aria-valuenow") === "20"
			&& meter.querySelectorAll('.food[data-state="full"]').length === 10), "hunger: starts with ten full food icons");

		const leaves = await page.evaluate(() => {
			const api = window.__mc;
			const [sx, , sz] = api.stats().spawn.map(Math.floor);
			const leaf = api.stateId("oak_leaves");
			const exposed = [];
			for (let z = sz - 24; z <= sz + 24; z++) for (let x = sx - 24; x <= sx + 24; x++) {
				for (let y = 57; y < 317; y++) {
					if (api.getBlock(x, y, z) === leaf && [1, 2, 3].every(dy => api.getBlock(x, y + dy, z) === 0)) {
						exposed.push([x, y, z]);
					}
				}
			}
			const distance = ([x, , z]) => (sx - x) * (sx - x) + (sz - z) * (sz - z);
			return exposed.sort((a, b) => distance(a) - distance(b)).slice(0, 150);
		});
		const apple = 49;
		let appleSlot = -1;
		await page.mouse.move(640, 360);
		for (const target of leaves) {
			await resumePointerLock(page, "hunger: mining pointer lock");
			const before = await page.evaluate(([x, y, z]) => {
				const api = window.__mc;
				api.setCamera(x + 0.5, y + 1 + 1.62, z + 0.5, 0, 90);
				return api.stats().inventory.reduce((sum, stack) => sum + (stack?.count ?? 0), 0);
			}, target);
			await page.waitForFunction(([x, y, z]) => {
				const api = window.__mc;
				const c = api.stats().camera;
				const hit = api.raycast([c.x, c.y, c.z], [0, -1, 0], 5);
				return c.pitch === 90 && hit?.x === x && hit?.y === y && hit?.z === z;
			}, {}, target);
			await page.mouse.down();
			try {
				await page.waitForFunction(([x, y, z]) => window.__mc.getBlock(x, y, z) === 0, {}, target);
			} finally {
				await page.mouse.up();
			}
			await page.waitForFunction(count => {
				const { entities, inventory } = window.__mc.stats();
				return entities.length > 0 || inventory.reduce((sum, stack) => sum + (stack?.count ?? 0), 0) > count;
			}, {}, before);
			await page.evaluate(() => {
				const api = window.__mc;
				const drop = api.stats().entities[0];
				if (drop) {
					const [x, y, z] = drop.position;
					api.setCamera(x, y + 1.62, z, 0, 0);
				}
			});
			// Finish collecting this drop before mining the next leaf.
			const pickup = await page.waitForFunction((count, item) => {
				const { inventory } = window.__mc.stats();
				if (inventory.reduce((sum, stack) => sum + (stack?.count ?? 0), 0) <= count) return false;
				return { slot: inventory.slice(0, 9).findIndex(stack => stack?.item === item) };
			}, {}, before, apple);
			({ slot: appleSlot } = await pickup.jsonValue());
			await pickup.dispose();
			if (appleSlot >= 0) break;
		}
		if (appleSlot < 0) throw new Error(`hunger: no apple in the hotbar after mining ${leaves.length} leaves`);
		check(true, "hunger: mines oak leaves and picks up an apple");

		const health = await page.evaluate(([x, y, z]) => {
			const api = window.__mc;
			// The spawn can be below a canopy. Measure from the first surface below open sky.
			const surface = api.raycast([x, y + 32, z], [0, -1, 0], 48);
			if (!surface) throw new Error("hunger: no landing surface near spawn");
			api.setCamera(x, surface.y + 1 + 10 + 1.62, z, 0, 90);
			return api.stats().health;
		}, spawn);
		await page.waitForFunction(previous => window.__mc.stats().health < previous, {}, health);
		await page.waitForFunction(() => window.__mc.stats().food <= 19);
		await page.keyboard.press(`Digit${appleSlot + 1}`);
		await page.waitForFunction(slot => window.__mc.stats().selectedSlot === slot, {}, appleSlot);
		const before = await page.evaluate(slot => {
			const api = window.__mc;
			const [x, y, z] = api.playerPosition();
			api.setCamera(x, y + 1.62, z, 0, -90);
			const { food, inventory } = api.stats();
			return { food, count: inventory[slot].count };
		}, appleSlot);
		await page.waitForFunction(() => {
			const api = window.__mc;
			const c = api.stats().camera;
			return c.pitch === -90 && !api.raycast([c.x, c.y, c.z], [0, 1, 0], 5);
		});
		await page.mouse.down({ button: "right" });
		try {
			await page.waitForSelector("#eat-progress:not([hidden])");
			check(true, "hunger: eating in open air displays progress");
			await page.waitForFunction((slot, before) => {
				const { food, inventory } = window.__mc.stats();
				return food === Math.min(20, before.food + 4) && (inventory[slot]?.count ?? 0) === before.count - 1;
			}, {}, appleSlot, before);
			check(true, "hunger: holding use consumes one apple and restores food");
		} finally {
			await page.mouse.up({ button: "right" });
		}
		await page.waitForSelector("#eat-progress[hidden]");
		check(await page.$eval("#food", meter => Number(meter.getAttribute("aria-valuenow")) === window.__mc.stats().food),
			"hunger: the food meter reflects server food");
		check(errors.length === 0, "hunger: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "hunger", err);
		throw err;
	} finally { await page.close(); }
}

async function mobs() {
	const { page, errors } = await open(`server=local&world=e2e-mobs-${run}&mode=creative&gen=flat&seed=2026&view=4&time=6000`);
	try {
		await settle(page, "mobs", chunksInView(4));
		await resumePointerLock(page, "mobs: initial pointer lock");
		await page.mouse.move(640, 360);
		const spawned = await page.waitForFunction(
			() => window.__mc.stats().mobs.findLast(mob => mob.kind === 0),
			{ timeout: 60000, polling: 100 },
		);
		const cow = await spawned.jsonValue();
		await spawned.dispose();
		check(cow.kind === 0, "mobs: a cow spawned", `id ${cow.id} at ${cow.position.join(", ")}`);
		const cowView = async (id, placeCamera = false) => {
			const api = window.__mc;
			const inspect = (target, mobs) => {
				if (!target) return null;
				const [x, y, z] = target.position;
				const angle = target.yaw * Math.PI / 180;
				const forwardX = -Math.sin(angle), forwardZ = Math.cos(angle);
				const occluder = mobs.find(other => {
					if (other.id === target.id) return false;
					const dx = other.position[0] - x, dz = other.position[2] - z;
					const ahead = dx * forwardX + dz * forwardZ;
					const side = dx * forwardZ - dz * forwardX;
					return dx * dx + dz * dz <= 1.5 ** 2
						|| (ahead > 0 && ahead < 3.9 && Math.abs(side) <= 1);
				});
				return {
					id: target.id,
					position: target.position, yaw: target.yaw, blockedBy: occluder?.id ?? null,
					camera: [x + forwardX * 3.4, y + 1.62, z + forwardZ * 3.4, target.yaw + 180, 13],
				};
			};
			let mobs = api.stats().mobs;
			const findCow = cowId => mobs.find(mob => mob.kind === 0 && mob.id === cowId);
			if (!placeCamera) {
				const target = id == null ? mobs.findLast(mob => mob.kind === 0) : findCow(id);
				return inspect(target, mobs);
			}
			globalThis.__mcLastCowAttempt = null;
			for (const candidate of mobs) {
				if (candidate.kind !== 0) continue;
				const initial = inspect(findCow(candidate.id), mobs);
				globalThis.__mcLastCowAttempt = initial ?? { id: candidate.id, missing: true };
				if (!initial || initial.blockedBy !== null) continue;
				// Give a moving cow time to finish its turn and the client time to interpolate.
				await new Promise(resolve => setTimeout(resolve, 150));
				mobs = api.stats().mobs;
				const settled = inspect(findCow(candidate.id), mobs);
				globalThis.__mcLastCowAttempt = settled ?? { id: candidate.id, missing: true };
				if (!settled || settled.blockedBy !== null || settled.yaw !== initial.yaw
					|| !settled.position.every((value, axis) => value === initial.position[axis])) continue;
				api.setCamera(...settled.camera);
				return { ...settled, frames: api.frames };
			}
			return false;
		};
		const file = join(shots, "mobs-cow.png");
		const matches = (aim, current) => current?.id === aim.id && current.blockedBy === null && current.yaw === aim.yaw
			&& current.position.every((value, axis) => value === aim.position[axis]);
		const captureDeadline = Date.now() + 25000;
		let captureProblem;
		let lastCowId = "none";
		let photographedId;
		for (let attempt = 0; attempt < 4 && Date.now() < captureDeadline; attempt++) {
			const placement = await page.waitForFunction(
				cowView, { timeout: Math.max(1, captureDeadline - Date.now()), polling: 100 }, null, true,
			).catch(async error => {
				const latest = await bounded(() => page.evaluate(() => globalThis.__mcLastCowAttempt ?? null), 1000);
				const id = typeof latest === "object" ? latest?.id ?? "none" : "none";
				throw new Error(`mobs: could not aim at a clear, still cow; last tried cow ${id} state ${JSON.stringify(latest)}; ${captureProblem ?? error.message}`, { cause: error });
			});
			const aim = await placement.jsonValue();
			await placement.dispose();
			lastCowId = aim.id;
			try {
				await page.waitForFunction(frames => document.pointerLockElement?.id === "view"
					&& document.getElementById("overlay").hidden && window.__mc.frames >= frames + 2,
				{ timeout: Math.max(1, captureDeadline - Date.now()) }, aim.frames);
			} catch (error) {
				if (error?.name !== "TimeoutError" && !/Waiting failed: \d+ms exceeded/.test(error?.message)) throw error;
				captureProblem = `capture deadline expired waiting for two frames for cow ${aim.id} yaw ${aim.yaw} at ${aim.position.join(", ")} (blocking cow ${aim.blockedBy ?? "none"}): ${error.message}`;
				continue;
			}
			let current = await page.evaluate(cowView, aim.id);
			if (matches(aim, current)) {
				if (Date.now() >= captureDeadline) {
					captureProblem = `capture deadline expired before screenshot of cow ${aim.id} yaw ${aim.yaw} at ${aim.position.join(", ")}`;
					continue;
				}
				await page.screenshot({ path: file });
				current = await page.evaluate(cowView, aim.id);
				if (matches(aim, current)) {
					photographedId = aim.id;
					captureProblem = null;
					break;
				}
			}
			captureProblem = `aimed at cow ${aim.id} yaw ${aim.yaw} at ${aim.position.join(", ")}, then saw yaw ${current?.yaw ?? "missing"} at ${current?.position.join(", ") ?? "missing"} (blocking cow ${current?.blockedBy ?? "none"})`;
		}
		if (captureProblem !== null) throw new Error(`mobs: could not photograph cow ${lastCowId}; ${captureProblem ?? "capture timed out"}`);
		const pinkPixels = await page.evaluate(async data => {
			const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
			const canvas = new OffscreenCanvas(img.width, img.height);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(img, 0, 0);
			// At 3.4 blocks from the cow, the nose is 2.95 blocks away and 0.62–0.85 below the eye.
			// With 13° pitch and 70° vertical FOV, it projects to roughly x ±41 and y −11…28
			// from the center at 720 px viewport height. Allow a little margin around the nose.
			const scale = img.height / 720;
			const pixels = ctx.getImageData(
				Math.floor(img.width / 2 - 58 * scale), Math.floor(img.height / 2 - 23 * scale),
				Math.ceil(116 * scale), Math.ceil(65 * scale),
			).data;
			let pink = 0;
			for (let i = 0; i < pixels.length; i += 4) {
				const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
				if (r > 100 && r > b * 1.3 && b > g * 1.08 && b < g * 1.4) pink++;
			}
			return pink;
		}, readFileSync(file).toString("base64"));
		check(pinkPixels > 20, "mobs: cow muzzle is visibly rendered", `${pinkPixels} pink pixels, cow ${photographedId}`);
		await page.waitForFunction(({ id, position }) => {
			const mob = window.__mc.stats().mobs.find(mob => mob.id === id);
			return mob && Math.hypot(mob.position[0] - position[0], mob.position[2] - position[2]) > 0.15;
		}, { timeout: 25000, polling: 100 }, cow);
		check(true, "mobs: the same cow wandered");
		check(errors.length === 0, "mobs: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "mobs", err);
		throw err;
	} finally { await page.close(); }
}

async function mobCombat() {
	const { page, errors } = await open(`server=local&world=e2e-mob-combat-${run}&mode=survival&gen=flat&seed=2026&view=4&time=6000`);
	try {
		const stats = await settle(page, "mobCombat", chunksInView(4));
		check(stats.gameMode === "survival" && stats.generatorName === "Flat", "mobCombat: starts in survival Flat");
		await resumePointerLock(page, "mobCombat: initial pointer lock");
		await page.mouse.move(640, 360);
		const spawned = await page.waitForFunction(
			() => window.__mc.stats().mobs.findLast(mob => mob.kind === 0),
			{ timeout: 60000, polling: 100 },
		);
		const { id: initialId, hurt } = await spawned.jsonValue();
		await spawned.dispose();
		check(hurt === 0, "mobCombat: cow starts unhurt", `id ${initialId}`);

		const blocks = new Map();
		let targetId = initialId;
		let lastPosition;
		let clicks = 0;
		let removed = false;
		const timeoutSeconds = 60;
		const deadline = Date.now() + timeoutSeconds * 1000;
		while (Date.now() < deadline) {
			const aim = await page.evaluate(async (id, firstClick) => {
				const api = window.__mc;
				const initial = api.stats().mobs.find(mob => mob.id === id);
				if (!initial) return null;
				await new Promise(resolve => setTimeout(resolve, 150));
				const { mobs } = api.stats();
				const cow = mobs.find(mob => mob.id === id);
				if (!cow) return null;
				if (cow.yaw !== initial.yaw
					|| !cow.position.every((value, axis) => value === initial.position[axis])) return false;
				const [x, y, z] = cow.position;
				// At this distance the grass behind the cow is also within the ray's reach.
				const distance = 2.25, eye = 1.62, body = 0.785;
				const length = Math.hypot(distance, eye - body);
				for (const [dx, dz, yaw] of [[-1, 0, 90], [0, 1, 0], [1, 0, 270], [0, -1, 180]]) {
					const blocked = mobs.some(other => {
						if (other.id === id) return false;
						const ox = other.position[0] - x, oz = other.position[2] - z;
						const towardCamera = -(ox * dx + oz * dz);
						return towardCamera > -0.45 && towardCamera < distance + 0.45 && Math.abs(ox * dz - oz * dx) < 0.65;
					});
					if (blocked) continue;
					const origin = [x - dx * distance, y + eye, z - dz * distance];
					const direction = [dx * distance / length, (body - eye) / length, dz * distance / length];
					const hit = api.raycast(origin, direction, 5);
					if (!hit) continue;
					const block = [hit.x, hit.y, hit.z];
					const state = api.getBlock(...block);
					if (state !== api.stateId("grass_block")) continue;
					// The local dev server permits setCamera teleports, including in survival.
					api.setCamera(...origin, yaw, Math.atan2(eye - body, distance) * 180 / Math.PI);
					const hurtBefore = firstClick
						? Object.fromEntries(mobs.filter(mob => mob.kind === 0).map(mob => [mob.id, mob.hurt]))
						: null;
					return { position: cow.position, block, state, hurtBefore };
				}
				return false;
			}, targetId, clicks === 0);
			if (aim === null) {
				removed = true;
				break;
			}
			if (aim) {
				lastPosition = aim.position;
				const key = aim.block.join(",");
				if (!blocks.has(key)) blocks.set(key, { block: aim.block, state: aim.state });
				await page.mouse.down();
				try {
					if (clicks === 0) {
						await new Promise(resolve => setTimeout(resolve, 100));
						check(await page.evaluate(() => window.__mc.stats().dig === null), "mobCombat: the first attack does not start mining");
					}
				} finally {
					await page.mouse.up();
				}
				clicks++;
				if (clicks === 1) {
					const hit = await page.waitForFunction(
						hurtBefore => window.__mc.stats().mobs.find(mob => mob.kind === 0 && mob.hurt > (hurtBefore[mob.id] ?? 0)),
						{ timeout: 3000, polling: 50 }, aim.hurtBefore,
					);
					const cow = await hit.jsonValue();
					await hit.dispose();
					targetId = cow.id;
					lastPosition = cow.position;
					check(true, "mobCombat: the first click increases hurt", `initial id ${initialId}, hit id ${targetId}`);
				}
			}
			await new Promise(resolve => setTimeout(resolve, 600));
		}
		check(removed && clicks > 1, "mobCombat: repeated attacks remove the same cow", `id ${targetId}, ${clicks} clicks`);
		check(blocks.size > 0 && await page.evaluate(blocks => blocks.every(({ block, state }) => window.__mc.getBlock(...block) === state), [...blocks.values()]),
			"mobCombat: the grass blocks behind the cow are still intact");
		if (!removed || !lastPosition) throw new Error(`mobCombat: cow ${targetId} was not defeated within ${timeoutSeconds} seconds`);

		const beef = 62;
		const dropped = await page.waitForFunction((item, position) => window.__mc.stats().entities.find(entity =>
			entity.item === item && Math.hypot(...entity.position.map((value, axis) => value - position[axis])) < 2),
		{ timeout: 5000, polling: 50 }, beef, lastPosition);
		const drop = await dropped.jsonValue();
		await dropped.dispose();
		check(drop.count >= 1 && drop.count <= 3, "mobCombat: cow drops 1–3 raw beef nearby", `${drop.count} raw beef`);
		await page.evaluate(({ drop, feetY }) => {
			window.__mc.setCamera(drop.position[0], feetY + 1.62, drop.position[2], 0, 0);
		}, { drop, feetY: lastPosition[1] });
		await page.waitForFunction(({ id, item, count }) => {
			const { entities, inventory } = window.__mc.stats();
			return !entities.some(entity => entity.id === id)
				&& inventory.reduce((sum, stack) => sum + (stack?.item === item ? stack.count : 0), 0) === count;
		}, { timeout: 5000, polling: 50 }, drop);
		check(true, "mobCombat: the dropped raw beef is picked up into the inventory");
		check(errors.length === 0, "mobCombat: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "mobCombat", err);
		throw err;
	} finally { await page.close(); }
}

try {
	await sectionCulling();
	await biomeTints();
	await inputs();
	if (process.env.MC_E2E_ONLY === "input") throw new Error("stopped after the input stage");
	await waterFlow();
	await lavaFlow();
	await mobs();
	await mobCombat();
	await swimming();
	await partialModels();
	await survivalInventory();
	await survivalHealth();
	await survivalHunger();
	await survivalCrafting();
	await leafDecay();
	await farming();
	await furnaceSmelting();
	await dayNight();
	await undergroundLighting();
	await transparentMaterials();
	const fallback = await open(`server=local&world=e2e-gen-off-${run}&seed=2026&view=2&genworkers=0`);
	try {
		const stats = await settle(fallback.page, "generation disabled", chunksInView(2));
		check(stats.chunks === chunksInView(2), "local: genworkers=0 loads chunks");
		const generation = await fallback.page.evaluate(() => window.__mc.stats().server?.generation);
		check(!generation || generation.requested === 0, "local: genworkers=0 disables offload");
	} catch (err) {
		await diagnoseFailure(fallback.page, "generation-disabled", err);
		throw err;
	} finally { await fallback.page.close(); }
	const page = await playthrough("local");
	const expected = ServerCore.fromModule(new WebAssembly.Module(readFileSync(join(root, "apps/web/src/wasm/server.wasm")))).runScenario(2026n, 600);
	const inBrowser = await page.evaluate(() => window.__mc.runScenario("2026", 600));
	check(inBrowser === expected, "scenario fingerprint in Chrome equals Node", `${inBrowser} vs ${expected}`);
	await page.close();
	await (await playthrough("ws")).close();
} catch (err) {
	if (shouldDiagnoseRunFailure(err)) {
		// Enumerating pages can itself require CDP; keep the failure path bounded.
		const pages = await bounded(() => browser.pages(), 5000);
		if (Array.isArray(pages)) {
			for (const [i, page] of pages.entries()) {
				if (page.url() !== "about:blank") await diagnose(browser, page, `run-timeout-${i}`, { edge, shots });
			}
		} else {
			console.log(`DIAG run-timeout-pages ${JSON.stringify({ error: pages })}`);
		}
	}
	check(false, "run completed", err.message);
} finally {
	await browser.close();
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nAll end-to-end checks passed");
