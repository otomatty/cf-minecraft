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
	await page.goto(`${edge}/?${query}`, { waitUntil: "load" });
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
				return s.joined && (!autopilot || s.autopilotStarted) && s.chunks >= chunks && s.sections > 0 && s.meshQueue === 0 && window.__mc.frames > 5 ? s : false;
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
	check(stats.sections > 20, `${kind}: terrain meshed`, `${stats.sections} sections, ${stats.chunks} chunks, adapter ${stats.adapter}`);
	check(stats.chunks === chunksInView(view), `${kind}: all ${chunksInView(view)} chunks in view arrived`, `${stats.chunks}`);

	// Let the orbiting camera draw a few frames, then look at what is on screen.
	await new Promise((r) => setTimeout(r, 1500));
	const drawn = await page.evaluate(() => window.__mc.stats());
	check(drawn.drawn > 0 && drawn.quads > 1000, `${kind}: sections drawn`, `${drawn.drawn} sections, ${drawn.quads} quads`);
	// Server clock is advancing at 20 ticks per second. Measured before the
	// screenshot below, which blocks the page for more than a second.
	const rate = await tickRate(page);
	check(Math.abs(rate.tps - 20) < 1.5, `${kind}: server ticks at 20 TPS`, `${rate.tps.toFixed(2)} measured between ${rate.packets} time packets`);
	const colours = await distinctColours(page, join(shots, `${kind}.png`));
	check(colours >= 12, `${kind}: frame is not blank`, `${colours} distinct colours`);

	// Place a block through the same path a mouse click takes.
	const [sx, sy, sz] = drawn.spawn.map(Math.floor);
	const pos = [sx + 2, sy + 3, sz + 1];
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
		await page.goto(url.href, { waitUntil: "load" });
		const imported = await settle(page, "local imported world", chunksInView(view));
		const importedBlock = await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), pos);
		check(importedBlock === 9 && imported.seed === seedBefore, "local: imported world kept the block and seed", `block ${importedBlock}, seed ${imported.seed}`);
	}

	if (kind === "ws") {
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
	const targetLine = async () => {
		await new Promise((r) => setTimeout(r, 400));
		return page.evaluate(() => document.getElementById("hud").textContent.split("\n").find((l) => l.startsWith("Target")));
	};
	const top = sy - 1;
	check((await targetLine()) === `Target: ${sx} ${top} ${sz}  grass_block`, "input: crosshair targets the block below", await targetLine());

	await page.mouse.down({ button: "left" });
	await page.mouse.up({ button: "left" });
	await new Promise((r) => setTimeout(r, 300));
	check((await page.evaluate(([x, y, z]) => window.__mc.getBlock(x, y, z), [sx, top, sz])) === 0, "input: left click breaks the targeted block");
	check((await targetLine()) === `Target: ${sx} ${top - 1} ${sz}  dirt`, "input: the block underneath is targeted next", await targetLine());

	await page.keyboard.press("Digit5");
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

	// Walk: W for one second at yaw 30 moves along the view direction.
	const from = await page.evaluate(() => window.__mc.stats().camera);
	await page.keyboard.down("KeyW");
	await new Promise((r) => setTimeout(r, 1000));
	await page.keyboard.up("KeyW");
	const to = await page.evaluate(() => window.__mc.stats().camera);
	const [dx, dz] = [to.x - from.x, to.z - from.z];
	const dist = Math.hypot(dx, dz);
	const heading = (Math.atan2(-dx, dz) * 180) / Math.PI;
	check(dist > 6 && dist < 13 && Math.abs(heading - 30) < 1, "input: W flies forward along the view direction", `${dist.toFixed(1)} blocks, heading ${heading.toFixed(1)}`);

	check(errors.length === 0, "input: no page errors", errors.slice(0, 3).join(" | "));
	await page.close();
}

try {
	await inputs();
	if (process.env.MC_E2E_ONLY === "input") throw new Error("stopped after the input stage");
	await dayNight();
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
