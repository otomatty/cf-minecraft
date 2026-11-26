import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureFilename, fixturePack } from "../apps/web/test/texture-pack-fixture.mjs";

const timeout = 120_000;

async function waitForTitleFrame(page, terrain) {
	await page.waitForFunction(terrain => {
		const canvas = document.querySelector("#title-background");
		return canvas && !canvas.hidden && document.body.classList.contains("terrain-background") === terrain;
	}, { timeout }, terrain);
}

async function screenshot(page, path) {
	// Sample the canvas without the UI or the overlay gradient.
	const hidden = await page.addStyleTag({ content: "main, #user, #status, .shade { visibility: hidden; }" });
	try {
		return await page.screenshot({ path, encoding: "base64" });
	} finally {
		await hidden.evaluate(node => node.remove());
		await hidden.dispose();
	}
}

async function frameColors(page, png) {
	return page.evaluate(async png => {
		const image = new Image();
		image.src = "data:image/png;base64," + png;
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext("2d");
		context.drawImage(image, 0, 0);
		const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
		const colors = new Set();
		let entirelyBlue = true;
		for (let i = 0; i < data.length; i += 4) {
			const [r, g, b] = data.subarray(i, i + 3);
			colors.add((r << 16) | (g << 8) | b);
			entirelyBlue &&= r < g && g < b;
		}
		return { count: colors.size, entirelyBlue };
	}, png);
}

async function waitForStillFrame(page) {
	await page.waitForFunction(() => document.body.classList.contains("terrain-background") &&
		performance.now() - window.titleFrameSubmittedAt > 1500, { timeout, polling: 250 });
}

export async function testTitleBackground(browser, edge, shots, initialFixture) {
	const dir = await mkdtemp(join(tmpdir(), "cf-title-test-"));
	const context = await browser.createBrowserContext();
	try {
		const file = join(dir, fixtureFilename);
		const replacement = join(dir, "bedrock-samples-v1.26.60.6-full.zip");
		await writeFile(file, initialFixture);
		await writeFile(replacement, await fixturePack({ artVariant: true, colors: {
			grass_block_top: [241, 155, 44], dirt: [190, 36, 42], water: [130, 95, 200],
		} }));
		const page = await context.newPage();
		await page.setViewport({ width: 960, height: 640 });
		await page.bringToFront();
		const errors = [];
		page.on("pageerror", error => errors.push(String(error)));
		const traffic = await page.createCDPSession();
		// Keep the long install panel's scrollbar out of every screenshot.
		await traffic.send("Emulation.setScrollbarsHidden", { hidden: true });
		const sockets = [];
		await traffic.send("Network.enable");
		traffic.on("Network.webSocketCreated", ({ url }) => sockets.push(url));

		// Use known admission and world list responses so the same flow runs with or without auth.
		let signedIn = true;
		await page.setRequestInterception(true);
		page.on("request", request => {
			const url = new URL(request.url());
			if (url.origin !== new URL(edge).origin) return request.continue();
			const json = body => request.respond({ contentType: "application/json", body: JSON.stringify(body) });
			if (url.pathname === "/api/me") return json({
				open: false, user: signedIn ? { name: "Coast Player", email: "player@example.com" } : null,
				turnstileSiteKey: null, canCreateWorlds: false,
			});
			if (url.pathname === "/api/worlds") return json({ worlds: [{ name: "coast", role: "player", owner: false, gameMode: "creative" }] });
			return request.continue();
		});
		await page.evaluateOnNewDocument(() => {
			if (!window.GPUQueue) return;
			const submit = GPUQueue.prototype.submit;
			GPUQueue.prototype.submit = function (commands) {
				const result = submit.call(this, commands);
				window.titleFrameSubmittedAt = performance.now();
				return result;
			};
		});
		const reduce = [{ name: "prefers-reduced-motion", value: "reduce" }];
		await page.emulateMediaFeatures(reduce);
		await page.goto(edge + "/", { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#texture-drop", { timeout });
		assert.equal(await page.evaluate(() => crossOriginIsolated), false, "title works without COEP");
		await waitForTitleFrame(page, false);
		assert.equal(await page.$eval(".shade", node => getComputedStyle(node).display), "none");
		const sky = await frameColors(page, await screenshot(page, join(shots, "title-sky.png")));
		assert(sky.entirelyBlue && sky.count > 1 && sky.count < 180, JSON.stringify(sky));

		await page.evaluate(() => { window.titleDocumentMarker = true; });
		await (await page.$("#texture-file")).uploadFile(file);
		await page.waitForSelector('a[href="/play.html"]', { timeout });
		await waitForTitleFrame(page, true);
		assert.equal(await page.evaluate(() => window.titleDocumentMarker), true, "install swaps the background in place");
		assert.equal(await page.$eval(".shade", node => getComputedStyle(node).display), "block");
		await waitForStillFrame(page);
		const first = await screenshot(page, join(shots, "title-terrain.png"));
		const land = await frameColors(page, first);
		assert(!land.entirelyBlue && land.count > sky.count, JSON.stringify({ sky, land }));
		await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
		const started = await page.evaluate(() => performance.now());
		await page.waitForFunction(start => window.titleFrameSubmittedAt > start + 2000, { timeout }, started);
		const second = await screenshot(page, join(shots, "title-rotated.png"));
		assert.notEqual(second, first, "the rotating title frame changes");

		await page.emulateMediaFeatures(reduce);
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForStillFrame(page);
		const still = await screenshot(page, join(shots, "title-still.png"));
		await delay(1800);
		assert.equal(await screenshot(page), still, "the title frame is still with reduced motion");

		await page.evaluate(() => { window.titleDocumentMarker = true; });
		await page.$eval("#panel", panel => [...panel.querySelectorAll("button")].find(button => button.textContent === "入れ直す").click());
		await (await page.$("#texture-file")).uploadFile(replacement);
		await page.waitForSelector('a[href="/play.html"]', { timeout });
		await waitForStillFrame(page);
		assert.equal(await page.evaluate(() => window.titleDocumentMarker), true, "replacement keeps the same document");
		assert.notEqual(await screenshot(page), still, "reinstalling redraws the same viewpoint with the new pack");

		await page.click('[data-role="multiplayer"]');
		await page.waitForSelector(".world-card .thumbnail");
		assert.equal(await page.$eval(".thumbnail", node => getComputedStyle(node).backgroundImage), "none");
		assert.match(await page.$eval(".thumbnail", node => node.style.backgroundColor), /^rgb\(/);

		signedIn = false;
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => document.querySelector("#panel h2")?.textContent === "ログイン", { timeout });
		await waitForTitleFrame(page, true);
		assert.deepEqual(await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const names = [];
			for await (const name of root.keys()) names.push(name);
			return names;
		}), [], "the title never creates OPFS world data");
		assert.deepEqual(sockets, [], "the title never opens a WebSocket");
		assert.deepEqual(errors, []);
		console.log("ok  title: sky without a pack, live install and replacement, rotation, reduced motion, login and worlds, no world I/O");
	} finally {
		await context.close();
		await rm(dir, { recursive: true, force: true });
	}
}
