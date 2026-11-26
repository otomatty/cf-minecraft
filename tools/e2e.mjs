// Drives the real client in headless Chrome against a running dev server.
//
//   node tools/e2e.mjs [--edge http://localhost:5173] [--shots /tmp/shots]
// Set MC_E2E_SESSION_COOKIE to a Better Auth session cookie (name=value) from the dev server to test player persistence.
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";
import { installFixture, testTexturePacks } from "./e2e-texture-packs.mjs";
import { bounded, diagnose, shouldDiagnoseRunFailure, watchForCrash } from "./e2e-diag.mjs";

import { fixtureGrassBrightness, fixturePack } from "../apps/web/test/texture-pack-fixture.mjs";
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

const textureFixture = await fixturePack();

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
	await watchForCrash(page, (message) => errors.push(`page crashed: ${message}`));
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
		const error = new Error(`${label}: world did not settle: ${err.message} ${JSON.stringify({ page: state.page, targets: state.targets, crashed: state.crashed, crash: state.crash })}`);
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

async function waitForSkyBrightness(page, night) {
	try {
		const result = await page.waitForFunction(night => {
			const sky = window.__mc.stats().skyBrightness;
			return (night ? sky < 0.1 : sky > 0.9) && { sky };
		}, { timeout: 10000 }, night);
		try {
			return { ...(await result.jsonValue()), matched: true };
		} finally {
			await result.dispose();
		}
	} catch (err) {
		if (err.name !== "TimeoutError") throw err;
		const sky = await page.evaluate(() => window.__mc.stats().skyBrightness);
		return { sky, matched: false };
	}
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
			const sky = await waitForSkyBrightness(page, time === 18000);
			const brightness = await distinctColours(page, join(shots, `sky-${time}.png`), true);
			measurements.push({ brightness, ...sky });
			check(errors.length === 0, `sky ${time}: no page errors`, errors.slice(0, 3).join(" | "));
		} catch (err) {
			await diagnoseFailure(page, `sky-${time}`, err);
			throw err;
		} finally {
			await page.close();
		}
	}
	const [day, night] = measurements;
	check(day.matched && night.matched, "sky: clock selects noon and midnight", `${day.sky} / ${night.sky}`);
	check(night.brightness < day.brightness * 0.65, "sky: midnight frame is darker than noon", `${night.brightness.toFixed(1)} / ${day.brightness.toFixed(1)}`);
}

async function torches() {
	const view = 2;
	const { page, errors } = await open(`server=local&world=e2e-torches-${run}&mode=creative&gen=flat&view=${view}&time=18000`);
	const waitForBlock = (pos, name) => page.waitForFunction(
		(pos, name) => window.__mc.getBlock(...pos) === window.__mc.stateId(name), {}, pos, name,
	);
	const measure = async label => {
		const file = join(shots, `torches-${label}.png`);
		await page.screenshot({ path: file });
		return page.evaluate(async dataUrl => {
			const img = new Image();
			img.src = dataUrl;
			await img.decode();
			const canvas = new OffscreenCanvas(img.width, img.height);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(img, 0, 0);
			const pixels = ctx.getImageData(img.width / 2 - 100, img.height / 2 - 100, 200, 200).data;
			let brightness = 0, samples = 0, flame = 0;
			for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
				const i = (y * 200 + x) * 4;
				const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
				if (Math.abs(x - 100) < 38 && Math.abs(y - 100) < 38) {
					if (r > 100 && g > 65 && r > g * 1.06 && g > b * 1.45) flame++;
				} else {
					brightness += 0.2126 * r + 0.7152 * g + 0.0722 * b;
					samples++;
				}
			}
			return { brightness: brightness / samples, flame };
		}, `data:image/png;base64,${readFileSync(file).toString("base64")}`);
	};
	try {
		const stats = await settle(page, "torches night", chunksInView(view));
		const { sky, matched } = await waitForSkyBrightness(page, true);
		check(matched, "torches: flat world is at night", `skyBrightness=${sky}`);
		const [x, y, z] = stats.spawn.map(Math.floor);
		const torch = [x, y, z];
		await resumePointerLock(page, "torches initial pointer lock");
		await page.keyboard.press("KeyE");
		await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
		await page.click('#block-grid [data-block="torch"]');
		await page.waitForFunction(() => document.querySelector("#hotbar canvas.selected")?.title === "torch");
		await page.mouse.move(640, 360);
		await page.keyboard.press("KeyE");
		await resumePointerLock(page, "torches after picker");
		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 3, z + 0.5, 0, 90), torch);
		await settle(page, "torches unlit ground", chunksInView(view));
		const before = await measure("before");
		await page.mouse.click(640, 360, { button: "right" });
		await waitForBlock(torch, "torch");
		await page.waitForFunction(() => document.getElementById("hud").textContent.includes("  torch"));
		await settle(page, "torches lit ground", chunksInView(view));
		const after = await measure("placed");
		check(after.brightness > before.brightness + 10, "torches: nearby ground brightens", `${before.brightness.toFixed(1)} → ${after.brightness.toFixed(1)}`);
		check(after.flame > before.flame + 10, "torches: flame colors appear at the torch tip", `${after.flame} vs ${before.flame}`);

		// Aim at the edge of the same ground block, outside the torch's selection box.
		await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.85, y + 3, z + 0.5, 0, 90), torch);
		await page.waitForFunction(([x, y, z]) => document.getElementById("hud").textContent.includes(`Target: ${x} ${y - 1} ${z}  `), {}, torch);
		await page.mouse.click(640, 360, { button: "left" });
		await waitForBlock([x, y - 1, z], "air");
		await waitForBlock(torch, "air");
		check(true, "torches: breaking the ground block also removes the torch");
		check(errors.length === 0, "torches: no page errors", errors.slice(0, 3).join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "torches", err);
		throw err;
	} finally {
		await page.close();
	}
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
		const capture = async (label, step = 4) => {
			await new Promise(resolve => setTimeout(resolve, 500));
			await settle(page, label, chunksInView(3));
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			const file = join(shots, `${label}.png`);
			await page.screenshot({ path: file });
			return page.evaluate(async ({ dataUrl, step }) => {
				const img = new Image(); img.src = dataUrl; await img.decode();
				const canvas = new OffscreenCanvas(img.width, img.height), g = canvas.getContext("2d");
				g.drawImage(img, 0, 0);
				const pixels = g.getImageData(img.width / 2 - 80, img.height / 2 - 80, 160, 160).data;
				const samples = [];
				for (let y = -80; y < 80; y += step) for (let x = -80; x < 80; x += step) {
					if (Math.abs(x) < 16 && Math.abs(y) < 16) continue; // crosshair
					const i = ((y + 80) * 160 + x + 80) * 4;
					samples.push(pixels[i], pixels[i + 1], pixels[i + 2]);
				}
				return samples;
			}, { dataUrl: `data:image/png;base64,${readFileSync(file).toString("base64")}`, step });
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
				// The fixture glass has an opaque border and a diagonal stripe
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
		const leafCamera = [center[0] + 0.5, 256.5, center[2] + 0.5];
		await page.addStyleTag({ content: "body > :not(#view) { visibility: hidden !important; }" });
		await page.evaluate(camera => window.__mc.setCamera(...camera, 0, -10), leafCamera);
		const sky = await capture("leaves-sky", 1);
		check(sky.length > 0 && sky.every((v, i) => i % 3 !== 2 || (v > sky[i - 1] && sky[i - 1] > sky[i - 2])),
			"leaves: clear sky fills the central sample before placement");
		const wall = [];
		for (let dz = 4; dz <= 5; dz++) for (let dy = -1; dy <= 3; dy++) for (let dx = -2; dx <= 2; dx++) {
			wall.push([Math.floor(leafCamera[0]) + dx, Math.floor(leafCamera[1]) + dy, Math.floor(leafCamera[2]) + dz]);
		}
		await page.evaluate(wall => {
			const api = window.__mc;
			const leaves = api.stateId("placed_oak_leaves");
			for (const pos of wall) api.setBlock(...pos, leaves);
		}, wall);
		const covered = await capture("leaves-wall", 1);
		check(await page.evaluate(wall => {
			const api = window.__mc;
			return wall.every(pos => api.getBlock(...pos) === api.stateId("placed_oak_leaves"));
		}, wall), "leaves: both layers of the leaf wall are placed");
		let skyPixels = 0;
		for (let i = 0; i < covered.length; i += 3) {
			if ([0, 1, 2].every(c => Math.abs(covered[i + c] - sky[i + c]) < 4)) skyPixels++;
		}
		check(covered.length === sky.length && skyPixels === 0,
			"leaves: no sky pixels show through the center of the two-block-thick wall", `${skyPixels} sky pixels`);
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

async function playerPersistence() {
	const cookie = process.env.MC_E2E_SESSION_COOKIE;
	if (!cookie) {
		console.log("skip ws: player persistence requires MC_E2E_SESSION_COOKIE (anonymous connections get new IDs)");
		return;
	}
	const separator = cookie.indexOf("=");
	if (separator < 1 || separator === cookie.length - 1) throw new Error("MC_E2E_SESSION_COOKIE must be name=value");
	const context = await browser.createBrowserContext();
	try {
		const origin = new URL(edge);
		await context.setCookie({
			name: cookie.slice(0, separator), value: cookie.slice(separator + 1),
			domain: origin.hostname, path: "/", secure: origin.protocol === "https:", httpOnly: true,
		});
		const page = await context.newPage();
		await installFixture(page, edge, textureFixture);
		const world = `e2e-player-${run}`;
		await page.goto(`${edge}/play.html?server=ws&world=${world}&view=2&autopilot=1`);
		await page.waitForFunction(() => {
			const api = window.__mc;
			const spawn = api?.stats().spawn;
			if (!spawn || api.stats().connection !== "open") return false;
			const [x, y, z] = spawn.map(Math.floor);
			return api.getBlock(x, y - 1, z) > 0;
		}, { timeout: 15000 });
		const authenticated = await page.evaluate(async () => {
			const response = await fetch("/api/me");
			return response.ok && Boolean((await response.json())?.user?.id);
		});
		if (!authenticated) throw new Error("MC_E2E_SESSION_COOKIE must identify a signed-in development user");

		const destination = await page.evaluate(() => {
			const [x, y, z] = window.__mc.stats().spawn;
			return [x + 0.125, y, z];
		});
		const checkPosition = async (label, moveTo) => {
			const corrections = await page.evaluate(moveTo => {
				const api = window.__mc;
				const before = api.stats().positionsCorrected;
				if (moveTo) api.sendRawPosition(...moveTo);
				// A rejected move asks the server to report its accepted position.
				api.sendRawPosition(100000, 200, 100000);
				return before;
			}, moveTo ?? null);
			await page.waitForFunction(before => window.__mc.stats().positionsCorrected > before, { timeout: 10000 }, corrections);
			const actual = await page.evaluate(() => window.__mc.playerPosition());
			check(Math.hypot(...actual.map((value, i) => value - destination[i])) < 0.01, label, actual.join(","));
		};
		await checkPosition("ws: signed-in player moved away from spawn", destination);
		for (const action of ["disconnect", "evict"]) {
			const before = await page.evaluate(() => window.__mc.stats().reconnects);
			const response = await fetch(`${edge}/api/debug/${action}?world=${world}`, { method: "POST" });
			check(response.ok, `ws: player persistence debug ${action} accepted`);
			await page.waitForFunction(before => {
				const stats = window.__mc.stats();
				return stats.connection === "open" && stats.reconnects > before;
			}, { timeout: 15000, polling: 10 }, before);
			await checkPosition(`ws: accepted player position survived ${action}`);
		}
	} finally {
		await context.close();
	}
}

async function protocolMismatch() {
	const world = `e2e-version-${run}`;
	const page = await browser.newPage();
	const url = `${edge}/play.html?server=ws&world=${world}&view=2`;
	let navigations = 0;
	page.on("framenavigated", frame => {
		if (frame !== page.mainFrame()) return;
		const { pathname, searchParams } = new URL(frame.url());
		// The dev server can redirect /play.html to /play.
		if ((pathname === "/play" || pathname === "/play.html") && searchParams.get("world") === world) {
			navigations++;
		}
	});
	try {
		await page.evaluateOnNewDocument((path) => {
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (data) {
				// Hello starts with packet ID 0 and a single-byte version in this build.
				if (new URL(this.url).pathname === path && data instanceof Uint8Array && data.length === 3 && data[0] === 0) {
					data = data.slice();
					data[1] = 0;
				}
				return send.call(this, data);
			};
		}, `/ws/${world}`);
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() =>
			document.querySelector("#status.error")?.textContent === "ゲームのバージョンがサーバーと違います。ページを再読み込みしてください",
			{ timeout: 20000 },
		);
		const navigationsAtError = navigations;
		await new Promise(resolve => setTimeout(resolve, 1500));
		check(navigationsAtError === 2 && navigations === navigationsAtError,
			"ws: protocol mismatch reloads once and then shows the error",
			`${navigationsAtError} navigations at error, ${navigations} after 1.5 s`);
	} finally {
		await page.close();
	}
}

async function gameModeChange() {
	const world = `e2e-mode-${run}`;
	const { page, errors } = await open(`server=ws&world=${world}&view=2`);
	try {
		const initial = await settle(page, "game mode change", chunksInView(2));
		check(initial.gameMode === "creative", "game mode: new multiplayer world starts in creative");
		check(await page.$eval("#vitals", vitals => vitals.hidden), "game mode: creative hides the health and food HUD");

		for (const mode of ["survival", "creative"]) {
			const before = await page.evaluate(() => window.__mc.stats().reconnects);
			const response = await fetch(`${edge}/api/debug/gamemode?world=${encodeURIComponent(world)}&mode=${mode}`, { method: "POST" });
			if (!response.ok) throw new Error(`game mode: debug request for ${mode} failed (${response.status})`);
			await page.waitForFunction((mode, before) => {
				const stats = window.__mc.stats();
				return stats.connection === "open" && stats.reconnects > before && stats.gameMode === mode;
			}, { timeout: 15000 }, mode, before);
			check(true, `game mode: reconnected in ${mode}`);
			const healthVisible = await page.$eval("#health", meter => meter.getClientRects().length > 0);
			check(healthVisible === (mode === "survival"), `game mode: health visibility matches ${mode}`);
			const foodVisible = await page.$eval("#food", meter => meter.getClientRects().length > 0);
			check(foodVisible === (mode === "survival"), `game mode: food visibility matches ${mode}`);

			await resumePointerLock(page, `game mode: ${mode}`);
			await page.keyboard.press("KeyE");
			const screen = mode === "survival" ? "#inventory-screen" : "#block-picker";
			await page.waitForSelector(`${screen}:not([hidden])`, { timeout: 5000 });
			check(true, `game mode: ${mode} opens ${screen}`);
			await page.keyboard.press("Escape");
		}
		check(errors.length === 0, "game mode: no page errors", errors.join(" | "));
	} catch (error) {
		await diagnoseFailure(page, "game-mode-change", error);
		throw error;
	} finally {
		await page.close();
	}
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
async function chat() {
	const local = await open(`server=local&world=e2e-chat-local-${run}&gen=flat&mode=creative&view=2`);
	try {
		const { page, errors } = local;
		await settle(page, "chat local", chunksInView(2));
		await resumePointerLock(page, "chat local start");
		await page.keyboard.press("KeyT");
		await page.waitForFunction(() => window.__mc.stats().chat.open
			&& document.activeElement?.id === "chat-input" && !document.pointerLockElement);
		check(await page.$eval("#chat-input", input => input.value === ""), "chat local: T opens an empty input");
		await page.keyboard.type("local chat <b>text</b>");
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => {
			const { open, lines } = window.__mc.stats().chat;
			return !open && lines.some(({ kind, sender, text }) => kind === 0 && sender === "あなた" && text === "local chat <b>text</b>");
		});
		check(await page.$eval("#chat-log", log => log.textContent.includes("<あなた> local chat <b>text</b>")
			&& !log.querySelector("b")), "chat local: the message is rendered as literal text");

		// Enter is a user gesture, so closeChat(true) must restore the lock without a click.
		await page.waitForFunction(() => document.pointerLockElement?.id === "view");
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => window.__mc.stats().chat.open
			&& document.activeElement?.id === "chat-input" && !document.pointerLockElement);
		const before = await page.evaluate(() => window.__mc.playerPosition());
		const startFrame = await page.evaluate(() => window.__mc.frames);
		await page.keyboard.down("KeyW");
		try {
			await page.waitForFunction(frame => window.__mc.frames >= frame + 5, {}, startFrame);
			await new Promise(resolve => setTimeout(resolve, 400));
		} finally {
			await page.keyboard.up("KeyW");
		}
		const after = await page.evaluate(() => window.__mc.playerPosition());
		check(before[0] === after[0] && before[2] === after[2], "chat local: W does not move the player while typing");
		await page.keyboard.type(" cancel this message");
		const gameTime = await page.evaluate(() => window.__mc.stats().gameTime);
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !window.__mc.stats().chat.open);
		await page.waitForFunction(time => window.__mc.stats().gameTime > time, {}, gameTime);
		check(await page.evaluate(() => window.__mc.stats().chat.lines.length === 1), "chat local: Escape discards the draft");
		// Chrome does not treat Escape as a user gesture, so closeChat cannot restore pointer lock on its own.
		await resumePointerLock(page, "chat local after cancel");
		check(errors.length === 0, "chat local: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(local.page, "chat-local", err);
		throw err;
	} finally { await local.page.close(); }

	const query = `server=ws&world=e2e-chat-ws-${run}&view=2`;
	const first = await open(query);
	let second;
	try {
		await settle(first.page, "chat first multiplayer page", chunksInView(2));
		second = await open(query);
		await second.page.waitForFunction(() => window.__mc.stats().joined);
		const joined = await first.page.waitForFunction(() => {
			const line = window.__mc.stats().chat.lines.find(line => line.kind === 1);
			return line?.sender;
		}, { polling: 50 });
		const secondName = await joined.jsonValue();
		await joined.dispose();
		check(await first.page.$eval("#chat-log", (log, name) => log.textContent.includes(`${name} が参加しました`), secondName),
			"chat multiplayer: the first page displays the second player's join");

		await first.page.bringToFront();
		await resumePointerLock(first.page, "chat multiplayer start");
		await first.page.keyboard.press("KeyT");
		await first.page.waitForFunction(() => window.__mc.stats().chat.open
			&& document.activeElement?.id === "chat-input" && !document.pointerLockElement);
		await first.page.keyboard.type("hello from the first page");
		await first.page.keyboard.press("Enter");
		await second.page.waitForFunction(() => window.__mc.stats().chat.lines.some(
			line => line.kind === 0 && line.sender && line.text === "hello from the first page"), { polling: 50 });
		check(true, "chat multiplayer: the second page receives the first player's message");

		check(second.errors.length === 0, "chat multiplayer second page: no page errors", second.errors.join(" | "));
		await second.page.close();
		await first.page.waitForFunction(sender => window.__mc.stats().chat.lines.some(
			line => line.kind === 2 && line.sender === sender), {}, secondName);
		check(await first.page.$eval("#chat-log", (log, name) => log.textContent.includes(`${name} が退出しました`), secondName),
			"chat multiplayer: the first page displays the second player's departure");
		check(first.errors.length === 0, "chat multiplayer first page: no page errors", first.errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(first.page, "chat-multiplayer", err);
		throw err;
	} finally {
		if (second && !second.page.isClosed()) await second.page.close();
		await first.page.close();
	}
}

async function chatCommands() {
	const openCommand = async (page, label) => {
		await resumePointerLock(page, label);
		await page.keyboard.press("Slash");
		await page.waitForFunction(() => window.__mc.stats().chat.open
			&& document.activeElement?.id === "chat-input" && !document.pointerLockElement);
	};
	const sendCommand = async (page, command) => {
		await openCommand(page, `chat commands: ${command}`);
		await page.keyboard.type(command.slice(1));
		await page.keyboard.press("Enter");
	};
	const local = await open(`server=local&world=e2e-chat-commands-local-${run}&gen=flat&mode=creative&view=2`);
	try {
		const { page, errors } = local;
		await settle(page, "chat commands local", chunksInView(2));
		await openCommand(page, "chat commands local start");
		check(await page.$eval("#chat-input", input => input.value === "/" && input.selectionStart === 1
			&& input.selectionEnd === 1), "chat commands local: Slash opens the input with one slash and the caret at the end");
		await page.keyboard.type("help");
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => window.__mc.stats().chat.lines.some(
			({ kind, sender, text }) => kind === 3 && sender === "" && text.startsWith("/time set ")));
		check(true, "chat commands local: /help includes the operator time command as a system line");

		await sendCommand(page, "/time set night");
		await page.waitForFunction(() => {
			const time = window.__mc.stats().dayTime % 24000;
			return time >= 13000 && time <= 13100;
		}, { polling: 50 });
		check(true, "chat commands local: /time set night moves the clock to night");
		await sendCommand(page, "/seed");
		await page.waitForFunction(() => window.__mc.stats().chat.lines.some(
			({ kind, text }) => kind === 3 && text.startsWith("シード:")));
		check(true, "chat commands local: /seed reports the seed as a system line");
		await sendCommand(page, "/nope");
		await page.waitForFunction(() => window.__mc.stats().chat.lines.some(
			({ kind, text }) => kind === 3 && text.includes("不明なコマンド")));
		check(!await page.evaluate(() => window.__mc.stats().chat.lines.some(({ kind }) => kind === 0)),
			"chat commands local: /nope reports an unknown command and none of the commands appear as player chat");

		await openCommand(page, "chat commands local history");
		await page.keyboard.type("draft");
		await page.keyboard.press("ArrowUp");
		check(await page.$eval("#chat-input", input => input.value === "/nope"),
			"chat commands local: ArrowUp recalls the last command");
		await page.keyboard.press("ArrowDown");
		check(await page.$eval("#chat-input", input => input.value === "/draft"),
			"chat commands local: ArrowDown restores the draft");
		check(errors.length === 0, "chat commands local: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(local.page, "chat-commands-local", err);
		throw err;
	} finally { await local.page.close(); }

	const query = `server=ws&world=e2e-chat-commands-ws-${run}&view=2`;
	const first = await open(query);
	let second;
	try {
		await settle(first.page, "chat commands first multiplayer page", chunksInView(2));
		second = await open(query);
		await settle(second.page, "chat commands second multiplayer page", chunksInView(2));
		await second.page.waitForFunction(() => window.__mc.stats().players[0]?.name, { polling: 50 });
		const firstName = await second.page.evaluate(() => window.__mc.stats().players[0].name);
		await first.page.waitForFunction(() => window.__mc.stats().players[0]?.name, { polling: 50 });
		const secondName = await first.page.evaluate(() => window.__mc.stats().players[0].name);

		await sendCommand(second.page, `/msg ${firstName} secret`);
		await first.page.waitForFunction(name => window.__mc.stats().chat.lines.some(
			({ kind, sender, text }) => kind === 5 && sender === name && text === "secret"), { polling: 50 }, secondName);
		await second.page.waitForFunction(name => window.__mc.stats().chat.lines.some(
			({ kind, sender, text }) => kind === 6 && sender === name && text === "secret"), { polling: 50 }, firstName);
		check(true, "chat commands multiplayer: /msg reaches both pages with their respective whisper kinds and names");

		await first.page.bringToFront();
		await sendCommand(first.page, "/me waves");
		for (const { page } of [first, second]) {
			await page.waitForFunction(name => window.__mc.stats().chat.lines.some(
				({ kind, sender, text }) => kind === 4 && sender === name && text === "waves"), { polling: 50 }, firstName);
		}
		check(true, "chat commands multiplayer: /me reaches both pages as an emote");
		await sendCommand(first.page, "/list");
		await first.page.waitForFunction(() => window.__mc.stats().chat.lines.some(
			({ kind, text }) => kind === 3 && text.includes("参加中 2 人")));
		check(true, "chat commands multiplayer: /list reports two players as a system line");
		for (const [label, { page, errors }] of [["first", first], ["second", second]]) {
			check(!await page.evaluate(() => window.__mc.stats().chat.lines.some(
				({ kind, text }) => kind === 0 && text.includes("secret"))),
			`chat commands multiplayer ${label} page: the whisper does not appear as player chat`);
			check(errors.length === 0, `chat commands multiplayer ${label} page: no page errors`, errors.join(" | "));
		}
	} catch (err) {
		await diagnoseFailure(first.page, "chat-commands-multiplayer", err);
		throw err;
	} finally {
		if (second && !second.page.isClosed()) await second.page.close();
		await first.page.close();
	}
}

async function players() {
	const query = `server=ws&world=e2e-players-${run}&view=2`;
	const first = await open(query);
	let second;
	try {
		const { spawn } = await settle(first.page, "players first page", chunksInView(2));
		second = await open(query);
		await settle(second.page, "players second page", chunksInView(2));
		const remote = await first.page.waitForFunction(() => {
			const { chat, players } = window.__mc.stats();
			const joined = chat.lines.find(line => line.kind === 1);
			return players.find(player => player.name && player.name === joined?.sender);
		}, { polling: 50 });
		const player = await remote.jsonValue();
		await remote.dispose();
		check(true, "players: first page sees second player with their name", player.name);
		await second.page.waitForFunction(() => window.__mc.stats().players.length > 0, { polling: 50 });
		const seenBySecond = await second.page.evaluate(() => window.__mc.stats().players);
		check(seenBySecond.length === 1 && seenBySecond[0].id !== player.id,
			"players: second page sees only the first player");

		// Creative setCamera holds both players above the build limit, with sky behind the jacket.
		const destination = [spawn[0], 324, player.position[2] + 4];
		await second.page.evaluate(([x, y, z]) => window.__mc.setCamera(x, y + 1.62, z, 180, 0), destination);
		await first.page.bringToFront();
		await first.page.waitForFunction((id, destination) => window.__mc.stats().players.some(
			player => player.id === id && player.position.every((coordinate, axis) => Math.abs(coordinate - destination[axis]) < 0.05)),
		{ polling: 50 }, player.id, destination);
		check(true, "players: first page receives the second player's four-block horizontal move");

		await resumePointerLock(first.page, "players camera");
		const beforeAim = await first.page.evaluate(([x, y, z]) => {
			window.__mc.setCamera(x, y + 1.25, z - 5, 0, 0);
			return window.__mc.frames;
		}, destination);
		await first.page.waitForFunction(frame => window.__mc.frames > frame + 1, {}, beforeAim);
		const selector = `#player-names > [data-player-id="${player.id}"]`;
		await first.page.waitForSelector(selector, { visible: true });
		check(await first.page.$eval(selector, (label, name) => label.textContent.includes(name), player.name),
			"players: visible name label contains the second player's name");
		const image = await first.page.screenshot({ path: join(shots, "players.png"), encoding: "base64" });
		const greenPixels = await first.page.evaluate(async image => {
			const img = new Image();
			img.src = `data:image/png;base64,${image}`;
			await img.decode();
			const canvas = new OffscreenCanvas(img.width, img.height);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(img, 0, 0);
			const pixels = ctx.getImageData(img.width / 2 - 40, img.height / 2 - 32, 80, 64).data;
			let count = 0;
			for (let i = 0; i < pixels.length; i += 4) {
				const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
				if (g > 12 && g > 1.5 * r && g > 1.25 * b) count++;
			}
			return count;
		}, image);
		check(greenPixels > 20, "players: green jacket pixels are visible at the aim point", `${greenPixels} pixels`);

		await second.page.close();
		await first.page.waitForFunction((id, selector) => !window.__mc.stats().players.some(player => player.id === id)
			&& !document.querySelector(selector), { polling: 50 }, player.id, selector);
		check(true, "players: closing the second page removes its player and name");
		check(first.errors.length === 0, "players first page: no page errors", first.errors.join(" | "));
		check(second.errors.length === 0, "players second page: no page errors", second.errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(first.page, "players", err);
		throw err;
	} finally {
		if (second && !second.page.isClosed()) await second.page.close();
		await first.page.close();
	}
}

async function audio() {
	const { page, errors } = await open(`server=local&world=e2e-audio-${run}&mode=creative&gen=flat&seed=2026&view=2&time=6000`);
	try {
		const stats = await settle(page, "audio", chunksInView(2));
		check(stats.gameMode === "creative" && stats.generatorName === "Flat", "audio: starts in creative Flat");
		await resumePointerLock(page, "audio: initial click");
		const ready = await page.waitForFunction(() => {
			const audio = window.__mc.stats().audio;
			return audio.state === "running" || audio.state === "unavailable" ? audio : false;
		}, { timeout: 5000 });
		const initial = await ready.jsonValue();
		await ready.dispose();

		const [sx, sy, sz] = stats.spawn;
		const cell = [Math.floor(sx) + 2, sy - 1, Math.floor(sz)];
		const aim = async () => {
			await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 4, z + 0.5, 0, 90), cell);
		};
		const expectCount = async (kind, before) => {
			if (initial.state === "unavailable") return;
			try {
				await page.waitForFunction((kind, before) => (window.__mc.stats().audio.counts[kind] ?? 0) > before,
					{ timeout: 5000 }, kind, before);
				check(true, `audio: ${kind} count increases`);
			} catch (err) {
				if (err.name !== "TimeoutError") throw err;
				const audio = await page.evaluate(() => window.__mc.stats().audio);
				check(false, `audio: ${kind} count increases`, JSON.stringify(audio));
			}
		};
		await aim();
		await page.mouse.down();
		await page.mouse.up();
		await page.waitForFunction(([x, y, z]) => window.__mc.getBlock(x, y, z) === 0, { timeout: 5000 }, cell);
		await expectCount("break", initial.counts.break ?? 0);

		await page.keyboard.press("Digit3");
		await aim();
		await page.mouse.down({ button: "right" });
		await page.mouse.up({ button: "right" });
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			return api.getBlock(x, y, z) === api.stateId("oak_planks");
		}, { timeout: 5000 }, cell);
		await expectCount("place", initial.counts.place ?? 0);

		await page.evaluate(([x, y, z]) => {
			const api = window.__mc;
			// Teleport above the Flat surface so reaching spawn Y requires landing.
			api.setCamera(x, y + 1 + 1.62, z, 0, 0);
			if (api.toggleFlight()) throw new Error("audio: player is still flying after teleport");
		}, stats.spawn);
		await page.waitForFunction(y => Math.abs(window.__mc.playerPosition()[1] - y) < 0.001, { timeout: 5000 }, sy);
		const { start, beforeSteps } = await page.evaluate(() => ({
			start: window.__mc.playerPosition(),
			beforeSteps: window.__mc.stats().audio.counts.step ?? 0,
		}));
		await page.keyboard.down("KeyW");
		try {
			await page.waitForFunction(z => window.__mc.playerPosition()[2] - z >= 3, { timeout: 5000 }, start[2]);
		} finally { await page.keyboard.up("KeyW"); }
		await expectCount("step", beforeSteps);

		const final = await page.evaluate(() => window.__mc.stats().audio);
		check(final.state === initial.state, "audio: playback state stays stable", final.state);
		const fallback = initial.state === "unavailable" ? "AudioContext unavailable, skipped break/place/step counter assertions" : "";
		check(errors.length === 0, "audio: no page errors", [...errors, fallback].filter(Boolean).join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "audio", err);
		throw err;
	} finally { await page.close(); }
}

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
	const { page, errors } = await open(`server=local&world=e2e-tint-${run}&mode=creative&seed=2026&view=3&time=6000`);
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
		await resumePointerLock(page, "tint initial pointer lock");
		await page.keyboard.press("KeyE");
		await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
		await page.click('#block-grid [data-block="grass_block"]');
		await page.waitForFunction(() => document.querySelector("#hotbar canvas.selected")?.title === "grass_block");
		await page.keyboard.press("KeyE");
		await page.waitForFunction(() => document.getElementById("block-picker").hidden);
		const iconColors = [], sideColors = [], dirtColors = [];
		for (const [z, name, grass] of [[0, "rain_grove", [72, 170, 74]], [144, "mild_meadow", [124, 184, 84]]]) {
			await page.evaluate(z => window.__mc.setCamera(0, 140, z, 0, 0), z);
			await page.waitForFunction(z => window.__mc.tint(0, z) !== null, {}, z);
			const tint = await page.evaluate(z => window.__mc.tint(0, z), z);
			check(registry[tint.biome]?.name === name && JSON.stringify(tint.grass) === JSON.stringify(grass), `tint: ${name} sample`, JSON.stringify(tint));
			const pixel = await page.$eval("#hotbar canvas.selected", canvas =>
				Array.from(canvas.getContext("2d").getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height * 0.15), 1, 1).data));
			check(pixel[3] === 255, `tint: ${name} grass hotbar icon has an opaque top pixel`, JSON.stringify(pixel));
			iconColors.push(pixel.slice(0, 3));
			// The fixture's TGA contributes the fringe brightness. This side face has 0.68 shading.
			const expected = grass.map(channel => Math.round(Math.round(channel * fixtureGrassBrightness / 255) * 0.68)).concat(255);
			await page.waitForFunction(rgba => {
				const canvas = document.querySelector("#hotbar canvas.selected");
				return canvas.getContext("2d").getImageData(20, 19, 1, 1).data.every((value, i) => value === rgba[i]);
			}, {}, expected);
			const side = await page.$eval("#hotbar canvas.selected", canvas => {
				const ctx = canvas.getContext("2d");
				return [19, 32].map(y => Array.from(ctx.getImageData(20, y, 1, 1).data));
			});
			sideColors.push(side[0]);
			dirtColors.push(side[1]);
		}
		check(JSON.stringify(iconColors[0]) !== JSON.stringify(iconColors[1]), "tint: grass hotbar icon changes between biome cells", JSON.stringify(iconColors));
		check(JSON.stringify(sideColors[0]) !== JSON.stringify(sideColors[1]), "tint: pack grass fringe changes between biome cells", JSON.stringify(sideColors));
		check(dirtColors[0][3] === 255 && JSON.stringify(dirtColors[0]) === JSON.stringify(dirtColors[1]), "tint: pack soil stays opaque and keeps its colour between biome cells", JSON.stringify(dirtColors));
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
        await page.waitForFunction(() => document.pointerLockElement?.id === "view");
        await page.keyboard.press("KeyE");
        await page.waitForSelector("#inventory-screen:not([hidden])");
        await inv(11,0);
        await inv(0,1);
        check(await page.$eval('#inventory-screen [data-slot="11"] canvas', c => !c.hasAttribute("data-durability")),
            "crafting: moving the pickaxe clears durability from the empty slot");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.pointerLockElement?.id === "view" && window.__mc.stats().screen === 0);
        await page.keyboard.press("Digit1");
        const firstHotbarIcon = "#hotbar canvas:first-child";
        const durabilityPixel = c => [...c.getContext("2d").getImageData(2, c.height - 3, 1, 1).data];
        const freshPixel = await page.$eval(firstHotbarIcon, durabilityPixel);
        check(await page.$eval(firstHotbarIcon, c => c.title === "wooden_pickaxe" &&
            c.dataset.durability === "48/48" && window.__mc.stats().inventory[0]?.damage === 0),
            "crafting: a new pickaxe has full durability");
        // The table takes time to mine even with a pickaxe.
        await page.evaluate(([x,y,z]) => window.__mc.setCamera(x+1.5,y+1.62,z+0.5,90,Math.atan2(1.12,1)*180/Math.PI),target);
        await page.waitForFunction(([x,y,z]) => {
            const c = window.__mc.stats().camera, pitch = c.pitch * Math.PI / 180;
            const hit = window.__mc.raycast([c.x,c.y,c.z],[-Math.cos(pitch),-Math.sin(pitch),0],6);
            return hit?.x === x && hit?.y === y && hit?.z === z;
        },{},target);
        await page.mouse.down();
        await page.waitForFunction(([x,y,z]) => window.__mc.getBlock(x,y,z) === 0 && window.__mc.stats().inventory[0]?.damage === 1,{},target);
        await page.mouse.up();
        check(await page.$eval(firstHotbarIcon, c => c.title === "wooden_pickaxe" &&
            c.dataset.durability === "47/48" && window.__mc.stats().inventory[0]?.damage === 1),
            "crafting: mining consumes one use of the pickaxe");
        const wornPixel = await page.$eval(firstHotbarIcon, durabilityPixel);
        check(wornPixel[1] > wornPixel[0] && wornPixel[1] > wornPixel[2] && wornPixel[3] === 255 &&
            wornPixel.some((value, channel) => value !== freshPixel[channel]), "crafting: worn pickaxe shows a green durability bar in the hotbar");
        await page.keyboard.press("KeyE");
        await page.waitForSelector("#inventory-screen:not([hidden])");
        const inventoryPixel = await page.$eval('#inventory-screen [data-slot="0"] canvas', durabilityPixel);
        check(inventoryPixel.every((value, channel) => value === wornPixel[channel]), "crafting: worn pickaxe shows the same bar in the inventory");
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
			// Use an accessible trunk without nearby logs that could sustain its crown.
			for (let z = sz - 24; z <= sz + 24; z++) for (let x = sx - 24; x <= sx + 24; x++) {
				for (let y = 57; y < 319; y++) {
					if (api.getBlock(x, y, z) !== log || api.getBlock(x, y - 1, z) === log) continue;
					if ([1, 2].some(dy => api.getBlock(x, y + dy, z) !== log)) continue;
					if (api.getBlock(x, y - 1, z) <= 0) continue;
					const floor = api.getBlock(x + 1, y - 1, z);
					if (floor <= 0 || floor === api.stateId("water")) continue;
					if ([0, 1, 2].some(dy => api.getBlock(x + 1, y + dy, z) !== 0)) continue;
					let top = y + 2;
					while (api.getBlock(x, top + 1, z) === log) top++;
					let nearbyLog = false;
					for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
						if (dx === 0 && dz === 0) continue;
						for (let wy = y; wy <= top + 2; wy++) {
							if (api.getBlock(x + dx, wy, z + dz) === log) nearbyLog = true;
						}
					}
					if (nearbyLog) continue;
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
				for (let wy = y; wy <= top + 2; wy++) {
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

async function fallingBlocks() {
	const { page, errors } = await open(`server=local&world=e2e-falling-blocks-${run}&mode=creative&gen=flat&seed=2026&view=2&time=6000`);
	try {
		const { spawn } = await settle(page, "falling blocks", chunksInView(2));
		const support = [Math.floor(spawn[0]) + 2, Math.floor(spawn[1]), Math.floor(spawn[2])];
		check(await page.evaluate(([x, y, z]) => {
			const api = window.__mc;
			const sand = api.stateId("sand");
			return api.getBlock(x, y - 1, z) === api.stateId("grass_block")
				&& api.setBlock(x, y, z, api.stateId("stone"))
				&& api.setBlock(x, y + 1, z, sand)
				&& api.setBlock(x, y + 2, z, sand);
		}, support), "falling blocks: stacks two sand blocks on a stone support");
		check(await page.evaluate(pos => window.__mc.setBlock(...pos, 0), support),
			"falling blocks: breaks the stone support");
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			const sand = api.stateId("sand");
			return api.getBlock(x, y, z) === sand
				&& api.getBlock(x, y + 1, z) === sand
				&& api.getBlock(x, y + 2, z) === 0;
		}, { timeout: 5000 }, support);
		check(true, "falling blocks: both sand blocks land one block lower");
		check(errors.length === 0, "falling blocks: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "falling-blocks", err);
		throw err;
	} finally { await page.close(); }
}

async function waterFlow() {
	const { page, errors } = await open(`server=local&world=e2e-water-${run}&mode=creative&gen=flat&seed=2026&view=2&time=6000`);
	try {
		const { spawn } = await settle(page, "water flow", chunksInView(2));
		await resumePointerLock(page, "water flow: initial pointer lock");
		const source = [Math.floor(spawn[0]) + 1, Math.floor(spawn[1]), Math.floor(spawn[2])];
		const flower = [source[0] + 1, source[1], source[2]];
		const selectItem = async (name, pos) => {
			await page.keyboard.press("KeyE");
			await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
			await page.click(`#block-grid [data-block="${name}"]`);
			await page.waitForFunction(name => document.querySelector("#hotbar canvas.selected")?.title === name, {}, name);
			await page.mouse.move(640, 360);
			await page.keyboard.press("KeyE");
			await page.waitForFunction(() => document.getElementById("block-picker").hidden);
			await resumePointerLock(page, `water flow: resume after selecting ${name}`);
			await page.evaluate(([x, y, z]) => window.__mc.setCamera(x + 0.5, y + 3, z + 0.5, 0, 90), pos);
		};
		await selectItem("red_flower", flower);
		await page.mouse.click(640, 360, { button: "right" });
		await page.waitForFunction(pos => {
			const api = window.__mc;
			return api.getBlock(...pos) === api.stateId("red_flower");
		}, { timeout: 5000 }, flower);

		await selectItem("water_bucket", source);
		await page.waitForFunction(([x, y, z]) => {
			const api = window.__mc;
			return api.getBlock(x, y - 1, z) === api.stateId("grass_block") && api.getBlock(x, y, z) === 0;
		}, { timeout: 5000 }, source);
		await page.mouse.click(640, 360, { button: "right" });
		await page.waitForFunction(({ source: [x, y, z], flower }) => {
			const api = window.__mc;
			const flow = api.stateId("flowing_water[level=1]");
			return api.getBlock(x, y, z) === api.stateId("water")
				&& api.getBlock(x - 1, y, z) === flow
				&& api.getBlock(...flower) === flow;
		}, { timeout: 5000 }, { source, flower });
		check(true, "water flow: a filled bucket places a source that spreads and washes away the adjacent flower");
		await selectItem("bucket", source);
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
		const previous = await page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin }));
		await page.goto(`${edge}/play.html?server=local&world=e2e-survival-${run}&mode=creative&view=2`, { waitUntil: "load" });
		const restored = await settle(page, "survival reload", chunksInView(2));
		check(restored.gameMode === "survival", "survival: saved mode ignores URL changes");
		// Going back either restores the cached page (which must reload) or
		// loads a fresh document through a back_forward navigation.
		try {
			await page.evaluate(() => { history.back(); });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!/context was destroyed|Execution context was destroyed|Navigating frame was detached/i.test(message)) throw err;
		}
		let navigationType;
		try {
			const navigation = await page.waitForFunction(previous => {
				// A restored document retains its original navigation timing.
				if (location.href !== previous.url || performance.timeOrigin === previous.timeOrigin || document.readyState !== "complete") return false;
				const nav = performance.getEntriesByType("navigation")[0];
				return (nav?.type === "reload" || nav?.type === "back_forward") && nav.type;
			}, { timeout: 30000 }, previous);
			navigationType = await navigation.jsonValue();
			await navigation.dispose();
		} catch (err) {
			let nav = "unavailable";
			try {
				nav = await page.evaluate(previous => {
					const type = performance.getEntriesByType("navigation")[0]?.type ?? "missing";
					return performance.timeOrigin === previous.timeOrigin ? `${type}, original document still active` : type;
				}, previous);
			}
			catch (readErr) { nav = readErr instanceof Error ? readErr.message : String(readErr); }
			const reason = err instanceof Error ? err.message : String(err);
			throw new Error(`survival: back navigation did not load a fresh document (navigation type ${nav}): ${reason}`, { cause: err });
		}
		const returnDetail = navigationType === "reload" ? "reload after BFCache restore" : "back_forward without BFCache";
		const returned = await settle(page, `survival back navigation (${navigationType})`, chunksInView(2));
		check(returned.gameMode === "survival", "survival: back navigation settles in survival mode", returnDetail);
		// Vite's dev client opens an HMR socket at ws(s)://<host>/?token=<id>. Chrome
		// logs a console error when that socket closes because the page entered
		// BFCache. Production has no Vite client, so this is not an app error.
		// Drop only that message: it starts with "WebSocket connection to 'ws://"
		// or "wss://", the URL query is exactly ?token= (no other parameters), and
		// it ends with "failed: Page entered Back-Forward Cache."
		const viteHmrBfcacheSocket = /^WebSocket connection to 'wss?:\/\/[^'?]*\?token=[^'&]*' failed: Page entered Back-Forward Cache\.$/;
		let ignoredViteHmr = 0;
		for (let i = errors.length - 1; i >= 0; i--) {
			if (!viteHmrBfcacheSocket.test(errors[i])) continue;
			errors.splice(i, 1);
			ignoredViteHmr += 1;
		}
		check(
			errors.length === 0,
			"survival: back navigation has no page errors",
			ignoredViteHmr
				? `ignored ${ignoredViteHmr} Vite HMR BFCache socket error${ignoredViteHmr === 1 ? "" : "s"}${errors.length ? `; ${errors.join(" | ")}` : ""}`
				: errors.join(" | "),
		);
		await page.goto(`${edge}/play.html?server=local&world=e2e-survival-${run}&mode=creative&view=2`, { waitUntil: "load" });
		await settle(page, "survival after back", chunksInView(2));
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

async function entitySave() {
	const world = `e2e-entity-save-${run}`;
	const { page, errors } = await open(`server=local&world=${world}&mode=creative&gen=flat&seed=2026&view=4&time=6000`);
	const reopen = phase => page.goto(`${edge}/play.html?server=local&world=${world}&view=4&phase=${phase}`, { waitUntil: "load" });
	try {
		const { spawn } = await settle(page, "entity save", chunksInView(4));
		await page.waitForFunction(() => window.__mc.stats().mobs.some(mob => mob.kind <= 3),
			{ timeout: 90000, polling: 100 });
		const saved = await page.evaluate(async () => {
			const { mobs, gameTime } = window.__mc.stats();
			const animal = mobs.find(mob => mob.kind <= 3);
			await window.__mc.exportWorld();
			return { animal, gameTime };
		});
		await reopen("animal");
		const restored = await page.waitForFunction(({ animal, gameTime }) => {
			const stats = window.__mc?.stats();
			if (stats?.joinedGameTime == null || stats.joinedGameTime < gameTime) return false;
			return stats.mobs.find(mob => mob.kind === animal.kind
				&& Math.hypot(mob.position[0] - animal.position[0], mob.position[2] - animal.position[2]) <= 2);
		}, { timeout: 30000, polling: 50 }, saved);
		const animal = await restored.jsonValue();
		await restored.dispose();
		check(animal.kind === saved.animal.kind, "entity save: the same kind of animal reappears within two blocks", animal.position.join(", "));

		await settle(page, "entity save after reopening", chunksInView(4));
		await resumePointerLock(page, "entity save: pointer lock before dropping");
		await page.keyboard.press("Digit1");
		const item = await page.evaluate(([x, y, z]) => {
			const api = window.__mc;
			api.setCamera(x + 8, y + 1.62, z, 0, 0);
			return api.stats().inventory[0].item;
		}, spawn);
		await page.keyboard.press("KeyQ");
		await page.waitForFunction(item => window.__mc.stats().entities.some(e => e.item === item && e.count === 1), {}, item);
		await page.evaluate(async ([x, y, z]) => {
			window.__mc.setCamera(x, y + 1.62, z, 0, 0);
			await window.__mc.exportWorld();
		}, spawn);
		await reopen("item");
		const dropped = await page.waitForFunction(item => window.__mc?.stats().entities?.find(e => e.item === item && e.count === 1),
			{ timeout: 30000, polling: 50 }, item);
		const entity = await dropped.jsonValue();
		await dropped.dispose();
		check(entity.item === item && entity.count === 1, "entity save: the dropped item survived reopening", entity.position.join(", "));
		check(errors.length === 0, "entity save: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "entity-save", err);
		throw err;
	} finally { await page.close(); }
}

async function mobs() {
	const { page, errors } = await open(`server=local&world=e2e-mobs-${run}&mode=creative&gen=flat&seed=2026&view=4&time=6000`);
	try {
		await settle(page, "mobs", chunksInView(4));
		await resumePointerLock(page, "mobs: initial pointer lock");
		await page.mouse.move(640, 360);
		const initialCamera = await page.evaluate(() => window.__mc.stats().camera);
		// Flat seed 2026, player 1 at spawn: sample(seed, 1, tick, 17) % 4 picks
		// chicken at 400, sheep at 800, two cows at 1200, and a pig at 2000.
		const spawned = await page.waitForFunction(
			() => window.__mc.stats().mobs.findLast(mob => mob.kind === 0),
			{ timeout: 100000, polling: 100 },
		);
		const cow = await spawned.jsonValue();
		await spawned.dispose();
		check(cow.kind === 0, "mobs: a cow spawned", `id ${cow.id} at ${cow.position.join(", ")}`);
		let screenshotSession;
		const screenshotDeadlineExpired = Symbol();
		const photographMob = async (kind, name) => {
			const mobView = async (kind, id, findCandidate = false) => {
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
						id: target.id, woolColor: target.woolColor,
						position: target.position, yaw: target.yaw, blockedBy: occluder?.id ?? null,
						camera: [x + forwardX * 3.4, y + 1.62, z + forwardZ * 3.4, target.yaw + 180, [14.5, 20.7, 18.8, 15][kind]],
					};
				};
				let mobs = api.stats().mobs;
				const findMob = mobId => mobs.find(mob => mob.kind === kind && mob.id === mobId);
				if (!findCandidate) {
					const target = id == null ? mobs.findLast(mob => mob.kind === kind) : findMob(id);
					return inspect(target, mobs);
				}
				globalThis.__mcLastMobAttempt = null;
				for (const candidate of mobs) {
					if (candidate.kind !== kind) continue;
					const initial = inspect(findMob(candidate.id), mobs);
					globalThis.__mcLastMobAttempt = initial ?? { id: candidate.id, missing: true };
					if (!initial || initial.blockedBy !== null) continue;
					// Give a moving mob time to finish its turn and the client time to interpolate.
					await new Promise(resolve => setTimeout(resolve, 150));
					mobs = api.stats().mobs;
					const settled = inspect(findMob(candidate.id), mobs);
					globalThis.__mcLastMobAttempt = settled ?? { id: candidate.id, missing: true };
					if (!settled || settled.blockedBy !== null || settled.yaw !== initial.yaw
						|| !settled.position.every((value, axis) => value === initial.position[axis])) continue;
					return settled;
				}
				return false;
			};
			const file = join(shots, `mobs-${name}.png`);
			const matches = (aim, current) => current?.id === aim.id && current.blockedBy === null && current.yaw === aim.yaw
				&& current.position.every((value, axis) => value === aim.position[axis]);
			const captureDeadline = Date.now() + 25000;
			let captureProblem;
			let lastMobId = "none";
			let photographedId, photographedColor;
			for (let attempt = 0; attempt < 4 && Date.now() < captureDeadline; attempt++) {
				const placement = await page.waitForFunction(
					mobView, { timeout: Math.max(1, captureDeadline - Date.now()), polling: 100 }, kind, null, true,
				).catch(async error => {
					const latest = await bounded(() => page.evaluate(() => globalThis.__mcLastMobAttempt ?? null), 1000);
					const id = typeof latest === "object" ? latest?.id ?? "none" : "none";
					throw new Error(`mobs: could not aim at a clear, still ${name}; last tried ${name} ${id} state ${JSON.stringify(latest)}; ${captureProblem ?? error.message}`, { cause: error });
				});
				const aim = await placement.jsonValue();
				await placement.dispose();
				lastMobId = aim.id;
				aim.frames = await page.evaluate(camera => {
					window.__mc.setCamera(...camera);
					return window.__mc.frames;
				}, aim.camera);
				try {
					await page.waitForFunction(frames => document.pointerLockElement?.id === "view"
						&& document.getElementById("overlay").hidden && window.__mc.frames >= frames + 2,
					{ timeout: Math.max(1, captureDeadline - Date.now()) }, aim.frames);
				} catch (error) {
					if (error?.name !== "TimeoutError" && !/Waiting failed: \d+ms exceeded/.test(error?.message)) throw error;
					captureProblem = `capture deadline expired waiting for two frames for ${name} ${aim.id} yaw ${aim.yaw} at ${aim.position.join(", ")} (blocking mob ${aim.blockedBy ?? "none"}): ${error.message}`;
					continue;
				}
				let current = await page.evaluate(mobView, kind, aim.id);
				if (matches(aim, current)) {
					if (Date.now() >= captureDeadline) {
						captureProblem = `capture deadline expired before screenshot of ${name} ${aim.id} yaw ${aim.yaw} at ${aim.position.join(", ")}`;
						continue;
					}
					// Raw CDP keeps a stalled capture from holding Puppeteer's page-close lock.
					const capture = await bounded(async () => {
						screenshotSession ??= await page.createCDPSession();
						const remaining = captureDeadline - Date.now();
						if (remaining <= 0) return screenshotDeadlineExpired;
						return screenshotSession.send("Page.captureScreenshot", {
							format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: false,
						}, { timeout: remaining });
					}, Math.max(1, captureDeadline - Date.now()), screenshotDeadlineExpired);
					if (capture === screenshotDeadlineExpired || Date.now() >= captureDeadline) {
						captureProblem = `capture deadline expired during screenshot of ${name} ${aim.id} yaw ${aim.yaw} at ${aim.position.join(", ")}`;
						continue;
					}
					if (typeof capture === "string") throw new Error(`mobs: screenshot of ${name} ${aim.id} failed: ${capture}`);
					writeFileSync(file, Buffer.from(capture.data, "base64"));
					current = await page.evaluate(mobView, kind, aim.id);
					if (matches(aim, current)) {
						photographedId = aim.id;
						photographedColor = current.woolColor;
						captureProblem = null;
						break;
					}
				}
				captureProblem = `aimed at ${name} ${aim.id} yaw ${aim.yaw} at ${aim.position.join(", ")}, then saw yaw ${current?.yaw ?? "missing"} at ${current?.position.join(", ") ?? "missing"} (blocking mob ${current?.blockedBy ?? "none"})`;
			}
			if (captureProblem !== null) throw new Error(`mobs: could not photograph ${name} ${lastMobId}; ${captureProblem ?? "capture timed out"}`);
			const featurePixels = await page.evaluate(async (data, kind, woolColor) => {
				const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
				const canvas = new OffscreenCanvas(img.width, img.height);
				const ctx = canvas.getContext("2d");
				ctx.drawImage(img, 0, 0);
				// After scaling to the species height, the cow muzzle, pig snout and chicken
				// beak are centered at Y=0.91, 0.59 and 0.56 blocks above the feet.
				const scale = img.height / 720;
				const [left, top, width, height] = [[30, 15, 60, 30], [22, 15, 44, 30], [16, 7, 32, 14], [60, 45, 120, 90]][kind];
				const pixels = ctx.getImageData(
					Math.floor(img.width / 2 - left * scale), Math.floor(img.height / 2 - top * scale),
					Math.ceil(width * scale), Math.ceil(height * scale),
				).data;
				// Compare the skin's muzzle/beak swatch after the shader's daylight shading.
				const swatch = kind === 3
					? [null, [155, 156, 160], [148, 108, 82], [81, 82, 90]][woolColor]
					: [[182, 165, 152], [206, 126, 123], [233, 170, 66]][kind];
				let matching = 0;
				for (let i = 0; i < pixels.length; i += 4) {
					const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
					let matchesColor;
					if (kind === 3 && woolColor === 0) {
						matchesColor = r > 200 && g > 195 && b > 185 && r - b < 40 && Math.abs(r - g) < 25;
					} else {
						const min = kind === 3 ? swatch[0] * 0.52 : 100;
						const max = kind === 3 ? swatch[0] * 1.08 : 255;
						const tolerance = kind === 3 ? 8 : 4;
						matchesColor = r > min && r <= max && Math.abs(g - r * swatch[1] / swatch[0]) < tolerance
							&& Math.abs(b - r * swatch[2] / swatch[0]) < tolerance;
					}
					if (matchesColor) matching++;
				}
				return matching;
			}, readFileSync(file).toString("base64"), kind, photographedColor);
			const [feature, color] = [["muzzle", "beige"], ["snout", "pink"], ["beak", "orange"],
				["wool", ["white", "gray", "brown", "black"][photographedColor]]][kind];
			check(featurePixels > 20, `mobs: ${name} ${feature} is visibly rendered`, `${featurePixels} ${color} pixels, ${name} ${photographedId}`);
			return photographedId;
		};
		await photographMob(0, "cow");
		// Put the player back at spawn so subsequent herds use the original center.
		await page.evaluate(({ x, y, z, yaw, pitch }) => window.__mc.setCamera(x, y, z, yaw, pitch), initialCamera);
		await page.waitForFunction(({ id, position }) => {
			const mob = window.__mc.stats().mobs.find(mob => mob.id === id);
			return mob && Math.hypot(mob.position[0] - position[0], mob.position[2] - position[2]) > 0.15;
		}, { timeout: 25000, polling: 100 }, cow);
		check(true, "mobs: the same cow wandered");

		// Flat seed 2026, player 1: the 4-way split selects pig at tick 2000 (1 mob).
		// Tick 3600 is another pig if the 2000 herd had no room under the local cap.
		const pigSpawn = await page.waitForFunction(
			() => window.__mc.stats().mobs.findLast(mob => mob.kind === 1),
			{ timeout: 100000, polling: 100 },
		);
		const pig = await pigSpawn.jsonValue();
		await pigSpawn.dispose();
		check(pig.kind === 1, "mobs: a pig spawned", `id ${pig.id} at ${pig.position.join(", ")}`);
		await photographMob(1, "pig");
		await page.evaluate(({ x, y, z, yaw, pitch }) => window.__mc.setCamera(x, y, z, yaw, pitch), initialCamera);
		// The same Rust herd test selects chicken at tick 400 (3 mobs), already present
		// by the time the cow and pig above have spawned. Tick 2400 is another chicken herd.
		const chickenSpawn = await page.waitForFunction(
			() => window.__mc.stats().mobs.findLast(mob => mob.kind === 2),
			{ timeout: 100000, polling: 100 },
		);
		const chicken = await chickenSpawn.jsonValue();
		await chickenSpawn.dispose();
		check(chicken.kind === 2, "mobs: a chicken spawned", `id ${chicken.id} at ${chicken.position.join(", ")}`);
		await photographMob(2, "chicken");
		await page.evaluate(({ x, y, z, yaw, pitch }) => window.__mc.setCamera(x, y, z, yaw, pitch), initialCamera);
		// Rust confirms sheep at tick 800 (1 mob) for this seed and player, so it is
		// already in the world. Tick 2800 selects sheep again if that herd was missed.
		const sheepSpawn = await page.waitForFunction(
			() => window.__mc.stats().mobs.findLast(mob => mob.kind === 3),
			{ timeout: 100000, polling: 100 },
		);
		const sheep = await sheepSpawn.jsonValue();
		await sheepSpawn.dispose();
		check(sheep.kind === 3, "mobs: a sheep spawned", `id ${sheep.id} at ${sheep.position.join(", ")}`);
		await page.keyboard.press("KeyE");
		await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
		await page.click('#block-grid [data-block="shears"]');
		await page.waitForFunction(() => document.querySelector("#hotbar canvas.selected")?.title === "shears");
		await page.keyboard.press("KeyE");
		await resumePointerLock(page, "mobs: resume after selecting shears");
		await page.mouse.move(640, 360);
		const sheepId = await photographMob(3, "sheep");
		const aim = await page.waitForFunction(id => {
			const api = window.__mc;
			const { mobs, entities, aimedMob } = api.stats();
			const target = mobs.find(mob => mob.id === id);
			if (!target || target.sheared) return false;
			if (aimedMob === id) {
				return { wool: [70, 79, 80, 81][target.woolColor], existing: entities.map(entity => entity.id) };
			}
			const [x, y, z] = target.position;
			const angle = target.yaw * Math.PI / 180;
			api.setCamera(x - Math.sin(angle) * 3.4, y + 1.62, z + Math.cos(angle) * 3.4, target.yaw + 180, 15);
			return false;
		}, { timeout: 10000, polling: 100 }, sheepId);
		const before = await aim.jsonValue();
		await aim.dispose();
		await page.mouse.click(640, 360, { button: "right" });
		const result = await page.waitForFunction((id, { wool, existing }) => {
			const { mobs, entities } = window.__mc.stats();
			const target = mobs.find(mob => mob.id === id);
			const drop = entities.find(entity => entity.item === wool && !existing.includes(entity.id));
			return target?.sheared && drop?.count >= 1 && drop.count <= 3 && drop;
		}, { timeout: 10000, polling: 50 }, sheepId, before);
		await result.dispose();
		check(true, "mobs: right-clicking with shears removes the fleece and drops 1 to 3 matching wool");
		check(errors.length === 0, "mobs: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "mobs", err);
		throw err;
	} finally { await page.close(); }
}

async function bow() {
	const { page, errors } = await open(`server=local&world=e2e-bow-${run}&mode=creative&gen=flat&seed=2026&view=4&time=6000`);
	try {
		const stats = await settle(page, "bow", chunksInView(4));
		check(stats.gameMode === "creative" && stats.generatorName === "Flat", "bow: starts in creative Flat");
		await resumePointerLock(page, "bow: initial pointer lock");
		await page.keyboard.press("KeyE");
		await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
		await page.click('#block-grid [data-block="bow"]');
		await page.waitForFunction(() => document.querySelector("#hotbar canvas.selected")?.title === "bow");
		await page.keyboard.press("KeyE");
		await resumePointerLock(page, "bow: resume after selecting bow");
		await page.mouse.move(640, 360);
		await page.evaluate(() => {
			const api = window.__mc;
			const { x, y, z } = api.stats().camera;
			api.setCamera(x, y, z, 0, -15);
		});
		await page.mouse.down({ button: "right" });
		await page.waitForFunction(() => window.__mc.stats().bowDraw === 20);
		await page.mouse.up({ button: "right" });
		const shot = await page.waitForFunction(() => {
			const { arrows, bowDraw } = window.__mc.stats();
			return bowDraw === 0 && arrows.find(arrow => Math.hypot(...arrow.velocity) >= 2);
		});
		await shot.dispose();
		check(true, "bow: releasing a full draw fires an arrow at least two blocks per tick");

		const cow = await page.waitForFunction(() => window.__mc.stats().mobs.find(mob => mob.kind === 0),
			{ timeout: 100000, polling: 100 });
		await cow.dispose();
		await page.mouse.down({ button: "right" });
		let id;
		try {
			await page.waitForFunction(() => window.__mc.stats().bowDraw === 20);
			const target = await page.waitForFunction(async () => {
				const api = window.__mc;
				const initial = api.stats().mobs.filter(mob => mob.kind === 0 && mob.hurt === 0);
				await new Promise(resolve => setTimeout(resolve, 150));
				const { mobs } = api.stats();
				for (const before of initial) {
					const cow = mobs.find(mob => mob.id === before.id);
					if (!cow || cow.hurt !== 0 || cow.yaw !== before.yaw
						|| !cow.position.every((value, axis) => value === before.position[axis])) continue;
					const [x, y, z] = cow.position;
					const distance = 2.25, eye = 1.62, body = 0.785;
					const length = Math.hypot(distance, eye - body);
					for (const [dx, dz, yaw] of [[-1, 0, 90], [0, 1, 0], [1, 0, 270], [0, -1, 180]]) {
						const blocked = mobs.some(other => {
							if (other.id === cow.id) return false;
							const ox = other.position[0] - x, oz = other.position[2] - z;
							const towardCamera = -(ox * dx + oz * dz);
							return towardCamera > -0.45 && towardCamera < distance + 0.45 && Math.abs(ox * dz - oz * dx) < 0.65;
						});
						if (blocked) continue;
						const origin = [x - dx * distance, y + eye, z - dz * distance];
						const direction = [dx * distance / length, (body - eye) / length, dz * distance / length];
						if (api.raycast(origin, direction, length)) continue;
						api.setCamera(...origin, yaw, Math.atan2(eye - body, distance) * 180 / Math.PI);
						return cow.id;
					}
				}
				return false;
			}, { timeout: 30000, polling: 200 });
			id = await target.jsonValue();
			await target.dispose();
		} finally {
			await page.mouse.up({ button: "right" });
		}
		await page.waitForFunction(id => {
			const cow = window.__mc.stats().mobs.find(mob => mob.id === id);
			return !cow || cow.hurt !== 0;
		}, { timeout: 3000, polling: 50 }, id);
		check(true, "bow: the arrow hits the targeted cow", `id ${id}`);
		check(errors.length === 0, "bow: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "bow", err);
		throw err;
	} finally { await page.close(); }
}

async function eggs() {
	const { page, errors } = await open(`server=local&world=e2e-eggs-${run}&mode=creative&gen=flat&seed=2026&view=4&time=6000`);
	try {
		await settle(page, "eggs", chunksInView(4));
		await resumePointerLock(page, "eggs: initial pointer lock");
		await page.keyboard.press("KeyE");
		await page.waitForFunction(() => !document.getElementById("block-picker").hidden && !document.pointerLockElement);
		await page.click('#block-grid [data-block="egg"]');
		await page.waitForFunction(() => document.querySelector("#hotbar canvas.selected")?.title === "egg");
		await page.keyboard.press("KeyE");
		await resumePointerLock(page, "eggs: resume after selecting egg");
		await page.mouse.move(640, 360);
		await page.evaluate(() => {
			const api = window.__mc;
			const { x, y, z } = api.stats().camera;
			api.setCamera(x, y, z, 0, 12);
		});
		await page.mouse.click(640, 360, { button: "right" });
		const thrown = await page.waitForFunction(() => window.__mc.stats().eggs[0]?.id, { timeout: 3000 });
		const id = await thrown.jsonValue();
		await thrown.dispose();
		check(id > 0, "eggs: right-click spawns a flying egg", `id ${id}`);
		await page.waitForFunction(id => !window.__mc.stats().eggs.some(egg => egg.id === id), { timeout: 3000 }, id);
		check(true, "eggs: the flying egg disappears within a few seconds");
		check(errors.length === 0, "eggs: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "eggs", err);
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
		// First cow herd is tick 1200 under the 4-kind split (previously tick 400).
		const spawned = await page.waitForFunction(
			() => window.__mc.stats().mobs.findLast(mob => mob.kind === 0),
			{ timeout: 100000, polling: 100 },
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

async function zombies() {
	const { page, errors } = await open(`server=local&world=e2e-zombies-${run}&mode=survival&gen=flat&seed=2&view=4&time=18000`);
	try {
		const stats = await settle(page, "zombies", chunksInView(4));
		check(stats.gameMode === "survival" && stats.generatorName === "Flat", "zombies: starts in survival Flat");
		check(stats.health === 20, "zombies: starts at full health");
		await resumePointerLock(page, "zombies: initial pointer lock");
		await page.mouse.move(640, 360);
		const spawned = await page.waitForFunction(() => window.__mc.stats().mobs.find(mob => mob.kind === 4),
			{ timeout: 100000, polling: 100 });
		const zombie = await spawned.jsonValue();
		await spawned.dispose();
		check(zombie.kind === 4, "zombies: a zombie spawned at night", `id ${zombie.id}`);

		// Move within pursuit range and watch from the front as the zombie approaches.
		const screenshotSession = await page.createCDPSession();
		const camera = await page.evaluate(id => {
			const api = window.__mc;
			const { position: [x, y, z], yaw } = api.stats().mobs.find(mob => mob.id === id);
			const angle = yaw * Math.PI / 180;
			const camera = [x - 11 * Math.sin(angle), y + 1.62, z + 11 * Math.cos(angle)];
			api.setCamera(...camera, yaw + 180, -1.5);
			return camera;
		}, zombie.id);
		const approaching = await page.waitForFunction((id, [x, , z]) => {
			const { mobs, positionsCorrected } = window.__mc.stats();
			const mob = mobs.find(mob => mob.id === id);
			if (!mob) return false;
			const dx = x - mob.position[0], dz = z - mob.position[2];
			const distance = Math.hypot(dx, dz);
			return distance <= 7 && { distance, away: [dx, dz], positionsCorrected };
		}, { timeout: 30000, polling: 50 }, zombie.id, camera);
		const { distance, away, positionsCorrected: beforeHit } = await approaching.jsonValue();
		await approaching.dispose();
		check(distance <= 7, "zombies: the same zombie approached the player", `id ${zombie.id}, ${distance.toFixed(2)} blocks away`);

		const file = join(shots, "mobs-zombie.png");
		const capture = await bounded(() => screenshotSession.send("Page.captureScreenshot", {
			format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: false,
		}, { timeout: 8000 }), 8000);
		if (!capture || typeof capture === "string") throw new Error(`zombies: screenshot failed (${capture})`);
		writeFileSync(file, Buffer.from(capture.data, "base64"));
		const greenPixels = await page.evaluate(async data => {
			const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
			const canvas = new OffscreenCanvas(img.width, img.height);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(img, 0, 0);
			const scale = img.height / 720;
			const pixels = ctx.getImageData(
				Math.floor(img.width / 2 - 58 * scale), Math.floor(img.height / 2 - 55 * scale),
				Math.ceil(116 * scale), Math.ceil(90 * scale),
			).data;
			let green = 0;
			for (let i = 0; i < pixels.length; i += 4) {
				const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
				// Use color ratios so the face swatches can be recognized in moonlight.
				if (g > 16 && r > g * 0.50 && r < g * 0.86 && b > g * 0.34 && b < g * 0.75) green++;
			}
			return green;
		}, capture.data);
		check(greenPixels > 20, "zombies: green skin is visibly rendered", `${greenPixels} green pixels, zombie ${zombie.id}`);

		const damaged = await page.waitForFunction(() => {
			const { health } = window.__mc.stats();
			return health < 20 && { health };
		}, { timeout: 30000, polling: 100 });
		const { health } = await damaged.jsonValue();
		await damaged.dispose();
		check(health < 20, "zombies: the player took damage", `${health} health remaining`);

		const pushed = await page.waitForFunction(([awayX, awayZ]) => {
			const api = window.__mc;
			const { lastKnockback: hit, server } = api.stats();
			if (!hit || !server) return false;
			const [vx, , vz] = hit.velocity;
			if (vx * awayX + vz * awayZ <= 0) return false;
			const [x, , z] = api.playerPosition();
			const distance = ((x - hit.position[0]) * awayX + (z - hit.position[2]) * awayZ) / Math.hypot(awayX, awayZ);
			return distance >= 0.3 && { distance, corrections: hit.positionsCorrected, serverTick: server.gameTime };
		}, { timeout: 15000 }, away);
		const push = await pushed.jsonValue();
		await pushed.dispose();
		check(push.distance >= 0.3, "zombies: moved at least 0.3 blocks horizontally away from the attacker", `${push.distance.toFixed(3)} blocks`);
		// Server stats arrive every 20 ticks, so two updates cover at least one second after the push.
		await page.waitForFunction(tick => window.__mc.stats().server?.gameTime >= tick + 40,
			{ timeout: 10000, polling: 50 }, push.serverTick);
		const corrections = await page.evaluate(() => window.__mc.stats().positionsCorrected);
		check(corrections === beforeHit && corrections === push.corrections, "zombies: no position correction during or after knockback",
			`${beforeHit} → ${push.corrections} → ${corrections}`);
		check(errors.length === 0, "zombies: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "zombies", err);
		throw err;
	} finally { await page.close(); }
}

async function mobBurning() {
	const { page, errors } = await open(`server=local&world=e2e-mob-burning-${run}&mode=creative&gen=flat&seed=2&view=4&time=18000`);
	try {
		await settle(page, "mob burning", chunksInView(4));
		await resumePointerLock(page, "mob burning: initial pointer lock");
		const spawned = await page.waitForFunction(() => window.__mc.stats().mobs.find(mob => mob.kind === 4 || mob.kind === 5),
			{ timeout: 100000, polling: 100 });
		const mob = await spawned.jsonValue();
		await spawned.dispose();
		check(mob.burning === false, "mob burning: the mob starts unlit at night", `id ${mob.id}`);

		const screenshotSession = await page.createCDPSession();
		const daylight = await page.evaluate(() => window.__mc.setDayTime(6000));
		if (!daylight) throw new Error("mob burning: could not set the local world to noon");
		const burning = await page.waitForFunction(id => {
			const { dayTime, mobs } = window.__mc.stats();
			return dayTime >= 6000 && dayTime < 6200 && mobs.some(mob => mob.id === id && mob.burning === true);
		}, { timeout: 10000, polling: 50 }, mob.id);
		await burning.dispose();
		check(true, "mob burning: the same mob is burning in direct sunlight at noon", `id ${mob.id}`);

		const frames = await page.evaluate(id => {
			const api = window.__mc;
			const { position: [x, y, z] } = api.stats().mobs.find(mob => mob.id === id);
			api.setCamera(x, y + 1.62, z - 4.5, 0, 9);
			return api.frames;
		}, mob.id);
		await page.waitForFunction(start => window.__mc.frames >= start + 2, { timeout: 5000 }, frames);
		const capture = await bounded(() => screenshotSession.send("Page.captureScreenshot", {
			format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: false,
		}, { timeout: 8000 }), 8000);
		if (!capture || typeof capture === "string") throw new Error(`mob burning: screenshot failed (${capture})`);
		writeFileSync(join(shots, "mobs-burning.png"), Buffer.from(capture.data, "base64"));
		const flamePixels = await page.evaluate(async data => {
			const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
			const canvas = new OffscreenCanvas(img.width, img.height);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(img, 0, 0);
			const scale = img.height / 720;
			const pixels = ctx.getImageData(
				Math.floor(img.width / 2 - 90 * scale), Math.floor(img.height / 2 - 110 * scale),
				Math.ceil(180 * scale), Math.ceil(220 * scale),
			).data;
			let count = 0;
			for (let i = 0; i < pixels.length; i += 4) {
				const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
				if (r >= 245 && g >= 110 && b <= 150 && g - b >= 55 && r - g >= 20) count++;
			}
			return count;
		}, capture.data);
		check(flamePixels > 20, "mob burning: orange and yellow flame pixels are visible near the mob", `${flamePixels} pixels`);

		const roof = await page.evaluate(id => {
			const api = window.__mc;
			const mob = api.stats().mobs.find(mob => mob.id === id && mob.burning);
			if (!mob) throw new Error("mob burning: lost the burning mob before shading it");
			const [x, y, z] = mob.position.map(Math.floor);
			api.setCamera(x + 0.5, mob.position[1] + 1.62, z - 1.5, 0, 0);
			const stone = api.stateId("stone");
			for (let dx = -1; dx <= 1; dx++) {
				for (let dz = -1; dz <= 1; dz++) {
					if (!api.setBlock(x + dx, y + 3, z + dz, stone)) throw new Error("mob burning: could not place roof");
				}
			}
			return { x, y: y + 3, z, stone };
		}, mob.id);
		const extinguished = await page.waitForFunction((id, { x, y, z, stone }) => {
			const api = window.__mc;
			const mob = api.stats().mobs.find(mob => mob.id === id);
			if (!mob || mob.burning !== false) return false;
			return Math.abs(Math.floor(mob.position[0]) - x) <= 1 && Math.abs(Math.floor(mob.position[2]) - z) <= 1
				&& api.getBlock(Math.floor(mob.position[0]), y, Math.floor(mob.position[2])) === stone;
		}, { timeout: 5000, polling: 50 }, mob.id, roof);
		await extinguished.dispose();
		check(true, "mob burning: the same mob stopped burning under the roof", `id ${mob.id}`);
		check(errors.length === 0, "mob burning: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "mob-burning", err);
		throw err;
	} finally { await page.close(); }
}

async function skeletons() {
	// Seed 5 spawns a skeleton on the first night attempt once its column is loaded.
	const { page, errors } = await open(`server=local&world=e2e-skeletons-${run}&mode=survival&gen=flat&seed=5&view=4&time=18000`);
	try {
		const stats = await settle(page, "skeletons", chunksInView(4));
		check(stats.gameMode === "survival" && stats.generatorName === "Flat", "skeletons: starts in survival Flat");
		check(stats.health === 20, "skeletons: starts at full health");
		await resumePointerLock(page, "skeletons: initial pointer lock");
		await page.mouse.move(640, 360);
		const spawned = await page.waitForFunction(() => window.__mc.stats().mobs.find(mob => mob.kind === 5),
			{ timeout: 100000, polling: 100 });
		const skeleton = await spawned.jsonValue();
		await spawned.dispose();
		check(skeleton.kind === 5, "skeletons: a skeleton spawned at night", `id ${skeleton.id}`);

		// Stand inside stopping range with the skeleton's head centered in the frame.
		await page.evaluate(id => {
			const api = window.__mc;
			const { position: [x, y, z], yaw } = api.stats().mobs.find(mob => mob.id === id);
			const angle = yaw * Math.PI / 180;
			api.setCamera(x - 6 * Math.sin(angle), y + 1.62, z + 6 * Math.cos(angle), yaw + 180, -1.15);
		}, skeleton.id);

		const shot = await page.waitForFunction(() => window.__mc.stats().arrows.find(arrow => Math.hypot(...arrow.velocity) > 0),
			{ timeout: 30000, polling: 25 });
		const arrow = await shot.jsonValue();
		await shot.dispose();
		check(arrow.id > 0, "skeletons: an arrow is in flight", `id ${arrow.id}`);
		const damaged = await page.waitForFunction(() => {
			const api = window.__mc;
			const { health, mobs } = api.stats();
			if (health >= 20) return false;
			const [x, , z] = api.playerPosition();
			for (const mob of mobs) {
				if (mob.kind !== 4) continue;
				const distance = Math.hypot(mob.position[0] - x, mob.position[2] - z);
				if (distance <= 2) return { health, nearbyZombie: { id: mob.id, distance } };
			}
			return { health, nearbyZombie: null };
		}, { timeout: 30000, polling: 50 });
		const { health, nearbyZombie } = await damaged.jsonValue();
		await damaged.dispose();
		const zombieDetail = nearbyZombie ? `, zombie ${nearbyZombie.id} at ${nearbyZombie.distance.toFixed(2)} blocks horizontally` : "";
		check(health === 17 && nearbyZombie === null, "skeletons: the arrow dealt 3 damage", `${health} health remaining${zombieDetail}`);
		await page.waitForFunction(() => document.getElementById("damage-flash").hidden, { timeout: 3000 });

		const screenshotSession = await page.createCDPSession();
		const capture = await bounded(() => screenshotSession.send("Page.captureScreenshot", {
			format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: false,
		}, { timeout: 8000 }), 8000);
		if (!capture || typeof capture === "string") throw new Error(`skeletons: screenshot failed (${capture})`);
		writeFileSync(join(shots, "mobs-skeleton.png"), Buffer.from(capture.data, "base64"));
		const bonePixels = await page.evaluate(async data => {
			const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
			const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d");
			ctx.drawImage(img, 0, 0);
			const scale = img.height / 720;
			const pixels = ctx.getImageData(
				Math.floor(img.width / 2 - 24 * scale), Math.floor(img.height / 2 - 27 * scale),
				Math.ceil(48 * scale), Math.ceil(44 * scale),
			).data;
			let bone = 0;
			for (let i = 0; i < pixels.length; i += 4) {
				const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
				// Moonlit bone is gray, lighter than the sky and dimmer than the crosshair.
				if (r >= 26 && r <= 70 && Math.max(r, g, b) - Math.min(r, g, b) <= 5) bone++;
			}
			return bone;
		}, capture.data);
		check(bonePixels > 50, "skeletons: pale bone is visibly rendered", `${bonePixels} bone pixels, skeleton ${skeleton.id}`);
		check(errors.length === 0, "skeletons: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "skeletons", err);
		throw err;
	} finally { await page.close(); }
}

async function creepers() {
	// Seed 1 spawns a creeper on the first night attempt once its column is loaded.
	const { page, errors } = await open(`server=local&world=e2e-creepers-${run}&mode=survival&gen=flat&seed=1&view=4&time=18000`);
	try {
		const stats = await settle(page, "creepers", chunksInView(4));
		check(stats.gameMode === "survival" && stats.generatorName === "Flat", "creepers: starts in survival Flat");
		check(stats.health === 20, "creepers: starts at full health");
		await resumePointerLock(page, "creepers: initial pointer lock");
		await page.mouse.move(640, 360);
		const spawned = await page.waitForFunction(() => window.__mc.stats().mobs.find(mob => mob.kind === 6),
			{ timeout: 100000, polling: 100 });
		const creeper = await spawned.jsonValue();
		await spawned.dispose();
		check(creeper.kind === 6, "creepers: a creeper spawned at night", `id ${creeper.id}`);
		check(creeper.fuse === 0, "creepers: fuse starts at zero", `fuse ${creeper.fuse}`);

		const screenshotSession = await page.createCDPSession();
		const frames = await page.evaluate(id => {
			const api = window.__mc;
			const { position: [x, y, z], yaw } = api.stats().mobs.find(mob => mob.id === id);
			const angle = yaw * Math.PI / 180;
			api.setCamera(x - 7 * Math.sin(angle), y + 1.62, z + 7 * Math.cos(angle), yaw + 180, 3);
			return api.frames;
		}, creeper.id);
		await page.waitForFunction(start => window.__mc.frames >= start + 2, { timeout: 5000 }, frames);
		const file = join(shots, "mobs-creeper.png");
		const capture = await bounded(() => screenshotSession.send("Page.captureScreenshot", {
			format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: false,
		}, { timeout: 8000 }), 8000);
		if (!capture || typeof capture === "string") throw new Error(`creepers: screenshot failed (${capture})`);
		writeFileSync(file, Buffer.from(capture.data, "base64"));
		const greenPixels = await page.evaluate(async data => {
			const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
			const canvas = new OffscreenCanvas(img.width, img.height);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(img, 0, 0);
			const scale = img.height / 720;
			const pixels = ctx.getImageData(
				Math.floor(img.width / 2 - 40 * scale), Math.floor(img.height / 2 - 40 * scale),
				Math.ceil(80 * scale), Math.ceil(70 * scale),
			).data;
			let green = 0;
			for (let i = 0; i < pixels.length; i += 4) {
				const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
				if (g > 18 && g > r && g > b && r > g * 0.4 && b > g * 0.25) green++;
			}
			return green;
		}, capture.data);
		check(greenPixels > 20, "creepers: green skin is visibly rendered", `${greenPixels} green pixels, creeper ${creeper.id}`);

		const ground = await page.evaluate(id => {
			const api = window.__mc;
			const { mobs, health, explosionsReceived } = api.stats();
			const { position: [x, y, z] } = mobs.find(mob => mob.id === id);
			const block = [Math.floor(x), Math.floor(y) - 1, Math.floor(z)];
			api.setCamera(x + 1.5, y + 1.62, z, 90, 0);
			return { block, before: api.getBlock(...block), healthBefore: health, explosionsReceived };
		}, creeper.id);
		check(ground.before !== 0, "creepers: the ground under the creeper starts solid", `block ${ground.before} at ${ground.block.join(", ")}`);
		const ignited = await page.waitForFunction(id => {
			const { mobs, positionsCorrected, knockbacksReceived, lastKnockback } = window.__mc.stats();
			const mob = mobs.find(mob => mob.id === id);
			return mob && mob.fuse > 0 && {
				fuse: mob.fuse, positionsCorrected, knockbacksReceived, lastKnockback,
			};
		}, { timeout: 5000, polling: 50 }, creeper.id);
		const ignition = await ignited.jsonValue();
		await ignited.dispose();
		check(ignition.fuse > 0, "creepers: fuse climbs while the player is close", `fuse ${ignition.fuse}`);
		const { knockbacksReceived, lastKnockback } = ignition;
		if (knockbacksReceived !== 0 || lastKnockback !== null) {
			const latest = lastKnockback
				? `Latest knockback was packet ${lastKnockback.seq} with velocity [${lastKnockback.velocity.join(", ")}].`
				: "Latest knockback details were missing.";
			throw new Error(`creepers: expected zero knockbacks at ignition, saw ${knockbacksReceived}. ${latest}`);
		}

		// Capture the rendered game canvas in the browser's frame callback while the smoke is visible.
		const smoke = await page.waitForFunction(before => {
			const { camera, explosionsReceived, lastExplosion, explosionParticles } = window.__mc.stats();
			if (explosionsReceived <= before || !lastExplosion || !explosionParticles) return false;
			const view = document.getElementById("view");
			const [dx, dy, dz] = lastExplosion.center.map((value, axis) => value - [camera.x, camera.y, camera.z][axis]);
			const yaw = camera.yaw * Math.PI / 180, pitch = camera.pitch * Math.PI / 180;
			const horizontal = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
			const depth = horizontal * Math.cos(pitch) - dy * Math.sin(pitch);
			if (depth <= 0) return false;
			const focal = view.height / (2 * Math.tan(70 * Math.PI / 360));
			const x = view.width / 2 + (-dx * Math.cos(yaw) - dz * Math.sin(yaw)) * focal / depth;
			const y = view.height / 2 - (horizontal * Math.sin(pitch) + dy * Math.cos(pitch)) * focal / depth;
			const radius = 1.5 * focal / depth;
			const left = Math.max(0, Math.floor(x - radius)), top = Math.max(0, Math.floor(y - radius));
			const right = Math.min(view.width, Math.ceil(x + radius)), bottom = Math.min(view.height, Math.ceil(y + radius));
			if (right <= left || bottom <= top) return false;
			const snapshot = document.createElement("canvas");
			snapshot.width = view.width;
			snapshot.height = view.height;
			const ctx = snapshot.getContext("2d");
			ctx.drawImage(view, 0, 0);
			const pixels = ctx.getImageData(left, top, right - left, bottom - top).data;
			const shades = [0x88, 0xae, 0xc5];
			const counts = [0, 0, 0];
			for (let i = 0; i < pixels.length; i += 4) {
				const gray = pixels[i];
				if (gray !== pixels[i + 1] || gray !== pixels[i + 2]) continue;
				const shade = shades.indexOf(gray);
				if (shade !== -1) counts[shade]++;
			}
			if (counts.filter(count => count > 10).length < 2) return false;
			return { explosionsReceived, explosion: lastExplosion, counts, png: snapshot.toDataURL("image/png").split(",")[1] };
		}, { timeout: 10000, polling: "raf" }, ground.explosionsReceived);
		const shot = await smoke.jsonValue();
		await smoke.dispose();
		writeFileSync(join(shots, "mobs-creeper-explosion.png"), Buffer.from(shot.png, "base64"));
		check(shot.explosionsReceived > ground.explosionsReceived, "creepers: received the explosion packet",
			`packet ${shot.explosion.seq}, center ${shot.explosion.center.join(", ")}`);
		check(shot.counts.filter(count => count > 10).length >= 2, "creepers: gray smoke is visibly rendered around the blast",
			`gray pixel counts ${shot.counts.join(", ")}`);

		const blasted = await page.waitForFunction((id, { block, healthBefore }) => {
			const api = window.__mc;
			const mob = api.stats().mobs.find(mob => mob.id === id);
			const health = api.stats().health;
			const after = api.getBlock(...block);
			if (mob || health >= healthBefore || after !== 0) return false;
			return { health, after };
		}, { timeout: 10000, polling: 50 }, creeper.id, ground);
		const result = await blasted.jsonValue();
		await blasted.dispose();
		check(result.health < ground.healthBefore, "creepers: the explosion hurt the player", `${result.health} health remaining`);
		check(result.after === 0, "creepers: the explosion removed the ground block", `block ${result.after}`);

		const pushed = await page.waitForFunction(({ seq, center: [cx, , cz] }, before) => {
			const api = window.__mc;
			const { knockbacksReceived, lastKnockback: hit, server } = api.stats();
			const received = knockbacksReceived - before;
			if (received > 1) {
				return {
					error: `received ${received} knockbacks since ignition (${before} → ${knockbacksReceived}). `
						+ `Explosion packet ${seq} expected only knockback packet ${seq + 1}. `
						+ `Latest knockback was packet ${hit.seq} with velocity [${hit.velocity.join(", ")}].`,
				};
			}
			if (received !== 1 || !hit) return false;
			if (hit.seq !== seq + 1) {
				return { error: `explosion packet ${seq} expected knockback packet ${seq + 1}, saw ${hit.seq}` };
			}
			const [hx, , hz] = hit.position;
			const [vx, , vz] = hit.velocity;
			const dx = hx - cx, dz = hz - cz;
			if (vx * dx + vz * dz <= 0) {
				return { error: `knockback packet ${hit.seq} did not push away from the photographed blast` };
			}
			if (!server) return false;
			const [x, , z] = api.playerPosition();
			const distance = ((x - hx) * dx + (z - hz) * dz) / Math.hypot(dx, dz);
			return distance >= 0.3 && { distance, corrections: hit.positionsCorrected, serverTick: server.gameTime };
		}, { timeout: 10000 }, shot.explosion, ignition.knockbacksReceived).catch(error => {
			throw new Error(`creepers: no qualifying movement from knockback packet ${shot.explosion.seq + 1} after the photographed blast`, { cause: error });
		});
		const push = await pushed.jsonValue();
		await pushed.dispose();
		if (push.error) throw new Error(`creepers: ${push.error}`);
		check(push.distance >= 0.3, "creepers: moved at least 0.3 blocks horizontally away from the blast", `${push.distance.toFixed(3)} blocks`);
		// Two stats updates cover at least one second of server-side position validation.
		await page.waitForFunction(tick => window.__mc.stats().server?.gameTime >= tick + 40,
			{ timeout: 10000, polling: 50 }, push.serverTick);
		const corrections = await page.evaluate(() => window.__mc.stats().positionsCorrected);
		check(corrections === ignition.positionsCorrected && corrections === push.corrections, "creepers: no position correction during or after knockback",
			`${ignition.positionsCorrected} → ${push.corrections} → ${corrections}`);
		check(errors.length === 0, "creepers: no page errors", errors.join(" | "));
	} catch (err) {
		await diagnoseFailure(page, "creepers", err);
		throw err;
	} finally { await page.close(); }
}

try {
	const title = await browser.newPage();
	try {
		await installFixture(title, edge, textureFixture);
	} finally {
		await title.close();
	}
	await testTexturePacks(browser, edge, shots, textureFixture);
	await sectionCulling();
	await biomeTints();
	await inputs();
	if (process.env.MC_E2E_ONLY === "input") throw new Error("stopped after the input stage");
	await waterFlow();
	await lavaFlow();
	await fallingBlocks();
	await mobs();
	await entitySave();
	await mobCombat();
	await bow();
	await eggs();
	await audio();
	await chat();
	await chatCommands();
	await players();
	await zombies();
	await mobBurning();
	await skeletons();
	await creepers();
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
	await torches();
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
	await playerPersistence();
	await protocolMismatch();
	await gameModeChange();
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
