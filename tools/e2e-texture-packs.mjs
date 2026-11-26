// Two independent browser profiles share a real Durable Object and no local storage.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleRGB, stoneRGB, zipBytes } from "../apps/web/test/texture-pack-fixture.mjs";

const panel = "#textures-tab-panel";
const input = panel + " input";
const selected = panel + " output";
const notice = panel + " [role=status]";

async function openSettings(page) {
	await page.bringToFront();
	if (!await page.$eval("#settings-open", el => el.offsetWidth > 0)) {
		await page.click("#overlay", { offset: { x: 10, y: 10 } });
		await page.waitForFunction(() => document.pointerLockElement !== null, { timeout: 4000 });
		await page.evaluate(() => document.exitPointerLock());
	}
	await page.click("#settings-open");
	await page.click("#textures-tab");
	await page.waitForSelector(input + ":enabled");
}

async function pixels(page) {
	return page.evaluate(() => {
		const canvas = selector => document.querySelector(selector).toDataURL();
		return {
			stone: canvas('[data-block="stone"] canvas'),
			apple: canvas('[data-block="apple"] canvas'),
			dirt: canvas('[data-block="dirt"] canvas'),
			worldStone: window.testStoneRGB,
		};
	});
}

export async function testTexturePacks(browser, edge, shots) {
	const dir = await mkdtemp(join(tmpdir(), "cf-pack-test-"));
	const pages = [], contexts = [], traffic = [], errors = [], frames = [];
	const name = "local-only-pixel-fixture.mcpack";
	try {
		await writeFile(join(dir, name), await zipBytes());
		await writeFile(join(dir, "broken.zip"), "invalid archive");
		const world = "e2e-pack-" + Date.now().toString(36);
		const url = `${edge}/play.html?server=ws&view=2&world=${world}`;
		async function player() {
			const context = await browser.createBrowserContext();
			contexts.push(context);
			const page = await context.newPage();
			pages.push(page);
			page.on("pageerror", e => errors.push(e.message));
			page.on("request", req => traffic.push([req.method(), req.url(), req.hasPostData()]));
			const client = await page.createCDPSession();
			await client.send("Network.enable");
			const sockets = new Set();
			client.on("Network.webSocketCreated", msg => {
				const { pathname } = new URL(msg.url);
				if (pathname === "/ws/" + world) sockets.add(msg.requestId);
				else if (pathname !== "/") errors.push("unexpected socket " + pathname);
			});
			client.on("Network.webSocketFrameSent", ({ requestId, response }) => {
				if (sockets.has(requestId)) frames.push(response);
			});
			// Observe the first terrain layer (stone) at the WebGPU boundary, independently of UI canvases.
			await page.evaluateOnNewDocument(() => {
				const write = GPUQueue.prototype.writeTexture;
				GPUQueue.prototype.writeTexture = function(dst, data, layout, size) {
					if (dst.mipLevel === 0 && size[0] === 16 && size[2] > 80) {
						window.testStoneRGB = Array.from(data.subarray(0, 3));
					}
					return write.call(this, dst, data, layout, size);
				};
			});
			await page.goto(url);
			await page.waitForFunction(() => window.__mc?.stats().joined && window.__mc.stats().chunks >= 9 && window.testStoneRGB);
			return page;
		}
		const a = await player(), b = await player();
		const defaults = await pixels(b);
		assert.deepEqual(await pixels(a), defaults);
		await openSettings(a);
		// Populate the biome-specific icon cache before changing the atlas.
		await a.waitForFunction(() => {
			const [x, , z] = window.__mc.playerPosition();
			return window.__mc.tint(x, z) !== null;
		});
		await a.$eval('[data-block="grass_block"]', el => el.click());
		await a.waitForFunction(() => document.querySelector("#hotbar canvas.selected")?.title === "grass_block");
		const frameStart = frames.length;
		await (await a.$(input)).uploadFile(join(dir, name));
		await a.waitForFunction(sel => document.querySelector(sel).textContent.includes("3 枚"), {}, notice);
		assert.deepEqual(await pixels(a), defaults);
		await a.click("#texture-apply");
		await a.waitForFunction(sel => document.querySelector(sel).textContent.includes("3 枚"), {}, selected);
		const changed = await pixels(a);
		assert.deepEqual(changed.worldStone, stoneRGB);
		assert.notEqual(changed.stone, defaults.stone);
		assert.notEqual(changed.apple, defaults.apple);
		assert.equal(changed.dirt, defaults.dirt);
		// Both blocks use the same pack PNG on their sides. The cached grass icon must repaint
		// without replacing that face with the built-in biome-coloured grass fringe.
		const sidePixel = c => Array.from(c.getContext("2d").getImageData(20, 32, 1, 1).data);
		const stoneSide = await a.$eval('[data-block="stone"] canvas', sidePixel);
		for (const selector of ["#hotbar canvas.selected", '#inventory-screen [data-slot="0"] canvas']) {
			assert.deepEqual(await a.$eval(selector, sidePixel), stoneSide);
		}
		assert.deepEqual(await pixels(b), defaults);
		const sprite = await a.$eval('[data-block="apple"] canvas', c => [...c.getContext("2d").getImageData(0, 0, 1, 1).data]);
		assert.deepEqual(sprite, [...appleRGB, 255]);
		if (shots) {
			const chart = await a.evaluate(async (before, after, colors) => {
				const canvas = document.createElement("canvas");
				canvas.width = 720; canvas.height = 320;
				const ctx = canvas.getContext("2d");
				ctx.fillStyle = "#17202b"; ctx.fillRect(0, 0, canvas.width, canvas.height);
				ctx.fillStyle = "#fff"; ctx.font = "bold 24px sans-serif";
				ctx.fillText("Local texture pack", 22, 38);
				ctx.font = "16px sans-serif"; ctx.imageSmoothingEnabled = false;
				for (const [i, label] of ["B: default", "A: applied", "Input PNG"].entries()) ctx.fillText(label, 172 + i * 179, 81);
				for (const [row, key] of ["stone", "apple"].entries()) {
					const y = 98 + row * 108;
					ctx.fillStyle = "#fff"; ctx.fillText(key, 22, y + 48);
					for (const [col, src] of [before[key], after[key]].entries()) {
						const img = new Image(); img.src = src; await img.decode();
						ctx.drawImage(img, 177 + col * 179, y, 88, 88);
					}
					ctx.fillStyle = "rgb(" + colors[row].join(",") + ")";
					ctx.fillRect(535, y, 88, 88);
				}
				return canvas.toDataURL("image/png").split(",")[1];
			}, defaults, changed, [stoneRGB, appleRGB]);
			await writeFile(join(shots, "local-texture-pack.png"), Buffer.from(chart, "base64"));
		}
		await (await a.$(input)).uploadFile(join(dir, "broken.zip"));
		await a.waitForFunction(sel => document.querySelector(sel).textContent.includes("変更できません"), {}, notice);
		assert.deepEqual(await pixels(a), changed);
		// Idle players may send position updates while a pack is read, applied, or rejected.
		assert(frames.slice(frameStart).every(f => f.opcode === 2 && Buffer.from(f.payloadData, "base64")[0] === 1));

		// Select a known item via the existing creative picker, then inspect hotbar and inventory.
		await a.$eval('[data-block="apple"]', el => el.click());
		await a.waitForFunction(() => document.querySelector("#hotbar canvas.selected")?.title === "apple");
		for (const selector of ["#hotbar canvas.selected", '#inventory-screen [data-slot="0"] canvas']) {
			assert.equal(await a.$eval(selector, c => c.toDataURL()), changed.apple);
		}
		const target = await a.evaluate(() => {
			const [x, y, z] = window.__mc.stats().spawn.map(Math.floor);
			let top = y + 2;
			while (window.__mc.getBlock(x, top, z) !== 0 && top < 319) top++;
			return [x, top, z];
		});
		const stone = await a.evaluate(() => window.__mc.stateId("stone"));
		for (const [sender, observer, state] of [[a, b, stone], [b, a, 0]]) {
			assert(await sender.evaluate(([x,y,z], state) => {
				window.__mc.setCamera(x + 1.5, y + 1, z + 0.5, 0, 0);
				return window.__mc.setBlock(x, y, z, state);
			}, target, state));
			await observer.waitForFunction((pos, state) => window.__mc.getBlock(...pos) === state, { polling: 100 }, target, state);
		}
		await a.reload();
		await a.waitForFunction(() => window.__mc?.stats().joined && document.querySelector("#textures-tab-panel output").textContent.includes("3 枚"));
		assert.deepEqual(await pixels(a), changed);
		await openSettings(a);
		await a.click("#texture-standard");
		await a.waitForFunction(sel => document.querySelector(sel).textContent.includes("保存済み"), {}, selected);
		assert.deepEqual(await pixels(a), defaults);
		await a.click("#texture-apply");
		await a.waitForFunction(sel => document.querySelector(sel).textContent.includes("3 枚"), {}, selected);
		await a.click("#texture-delete");
		await a.waitForFunction(sel => document.querySelector(sel).textContent === "使用中：標準素材", {}, selected);
		await a.reload();
		await a.waitForFunction(sel => window.__mc?.stats().joined && !document.querySelector(sel).disabled, {}, input);
		assert.deepEqual(await pixels(a), defaults);
		assert.deepEqual(await pixels(b), defaults);

		// Only same-origin game/module GETs, never a pack filename, image upload, or pack endpoint.
		for (const [method, target, body] of traffic) {
			if (!/^https?:/.test(target)) continue;
			const url = new URL(target);
			assert.equal(method, "GET");
			assert(!body && !url.href.includes(name) && !/\.(png|mcpack|zip)(?:$|\?)/i.test(url.href), target);
			// play.html loads a fixed Google Fonts stylesheet and its static font subsets.
			if (target === "https://fonts.googleapis.com/css2?family=DotGothic16&family=M+PLUS+1p:wght@400;500;700&display=swap") continue;
			if (url.origin === "https://fonts.gstatic.com" && /^\/s\/(?:dotgothic16|mplus1p)\/[\w./-]+\.woff2$/.test(url.pathname) && !url.search) continue;
			assert.equal(url.origin, new URL(edge).origin);
			assert(/^\/(?:play(?:\.html)?$|api\/me$|@|src\/|node_modules\/|favicon\.ico$)/.test(url.pathname), target);
		}
		// Packet kinds and lengths in this scenario: hello, position, set block, teleport, creative slot.
		const lengths = new Map([[0, 3], [1, 33], [2, 14], [3, 25], [5, 5]]);
		assert(frames.length > 0);
		for (const frame of frames) {
			const bytes = Buffer.from(frame.payloadData, "base64");
			assert.equal(frame.opcode, 2);
			assert.equal(bytes.length, lengths.get(bytes[0]), "unexpected outbound game packet " + bytes[0]);
		}
		assert.deepEqual(errors, []);
		console.log("ok  texture packs: independent multiplayer profiles, GPU and UI pixels, local persistence, shared block edits and outbound traffic");
	} catch (error) {
		for (const page of pages) {
			console.error(await page.evaluate(() => ({
				status: document.querySelector("#status")?.textContent, message: document.querySelector("#menu-message")?.textContent,
				pack: document.querySelector("#textures-tab-panel [role=status]")?.textContent, error: window.__mc?.error,
				connection: window.__mc?.stats().connection, menu: document.querySelector("#overlay .menu-panel:not([hidden])")?.id,
			})).catch(() => "page closed"));
		}
		throw error;
	} finally {
		await Promise.all(contexts.map(context => context.close()));
		await rm(dir, { recursive: true, force: true });
	}
}
