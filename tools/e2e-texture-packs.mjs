// Two independent browser profiles share a real Durable Object and install packs locally.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleRGB, fixtureArtRGB, fixtureFilename, fixturePack, packEntries, stoneRGB, testEntries, zipBytes } from "../apps/web/test/texture-pack-fixture.mjs";

const panel = "#textures-tab-panel";
const input = panel + " input";
const selected = panel + " output";
const notice = panel + " [role=status]";

function assertPlayNext(titleUrl, playUrl) {
	const title = new URL(titleUrl);
	assert.equal(title.pathname, "/");
	const next = title.searchParams.get("next");
	const { search } = new URL(playUrl);
	// The dev server can redirect /play.html to /play before the client runs.
	assert(["/play.html" + search, "/play" + search].includes(next), `Unexpected next: ${JSON.stringify(next)}`);
}

async function openSettings(page) {
	await page.bringToFront();
	if (!await page.$eval("#settings-open", el => el.offsetWidth > 0)) {
		await page.click("#overlay", { offset: { x: 10, y: 10 } });
		await page.waitForFunction(() => document.pointerLockElement !== null, { timeout: 4000 });
		await page.evaluate(() => document.exitPointerLock());
	}
	await page.click("#settings-open");
	await page.click("#textures-tab");
	await page.waitForSelector(panel + " button:enabled", { visible: true });
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

async function assertWorldArt(page, variant) {
	const { cracks, sky, clouds } = await page.evaluate(() => window.testWorldArt);
	const stages = Array.from({ length: 10 }, (_, stage) => [
		[0, 0, 0, 0], [...fixtureArtRGB("environment/destroy_stage_" + stage, variant, stage), 255],
	]);
	const start = cracks.findIndex(([, center]) => center.every((value, i) => value === stages[0][1][i]));
	assert.notEqual(start, -1, "fixture crack overlays in the world atlas");
	assert.deepEqual(cracks.slice(start, start + 10), stages);
	const transparent = [0, 0, 0, 0];
	const sun = [...fixtureArtRGB("environment/sun", variant), 255];
	assert.deepEqual(sky[0], [transparent, sun, sun]);
	for (const [phase, cell] of [0, 7, 6, 5, 4, 3, 2, 1].entries()) {
		const moon = [...fixtureArtRGB("environment/moon_phases", variant, cell), 255];
		assert.deepEqual(sky[phase + 1], [transparent, phase === 0 || phase > 4 ? moon : transparent,
			phase < 4 ? moon : transparent], "moon phase " + phase);
	}
	assert.deepEqual(clouds, [[...fixtureArtRGB("environment/clouds", variant), 255], transparent]);
}

async function assertHudArt(page, variant) {
	const points = await page.evaluate(() => {
		const sample = (selector, x) => {
			const rect = document.querySelector(selector).getBoundingClientRect();
			if (rect.width !== 18 || rect.height !== 18) throw new Error("Unexpected HUD icon size");
			return [Math.floor(rect.x + x * 2 + 1), Math.floor(rect.y + 7)];
		};
		return [
			sample(".heart[data-state=full]", 3), sample(".heart[data-state=half]", 3),
			sample(".heart[data-state=half]", 5), sample(".heart[data-state=empty]", 3),
			sample(".food[data-state=full]", 3), sample(".food[data-state=half]", 3),
			sample(".food[data-state=half]", 5), sample(".food[data-state=empty]", 3),
			sample(".bubble:not([hidden])", 3),
		];
	});
	assert.deepEqual(await screenPixels(page, points), ["heart", "heart_half", "heart_background", "heart_background",
		"hunger_full", "hunger_half", "hunger_background", "hunger_background", "bubble"]
		.map(name => fixtureArtRGB("ui/" + name, variant)));
}

async function screenPixels(page, points) {
	const screenshot = await page.screenshot({ encoding: "base64" });
	return page.evaluate(async (url, points) => {
		const image = new Image();
		image.src = url;
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.width;
		canvas.height = image.height;
		const ctx = canvas.getContext("2d");
		ctx.drawImage(image, 0, 0);
		return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)]);
	}, "data:image/png;base64," + screenshot, points);
}

async function assertWorldFrame(page, variant, spawn) {
	const { width, height } = page.viewport();
	const belowCenter = [width / 2 + 24, height / 2 + 24];
	const aboveCenter = [width / 2 + 24, height / 2 - 24];
	const show = async (camera, time, dig) => {
		await page.evaluate(async (camera, time, dig) => {
			window.testTextureScene = { camera, time, dig };
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		}, camera, time, dig);
		return screenPixels(page, [belowCenter, aboveCenter]);
	};
	const closeTo = (actual, expected, label) => assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= 2),
		`${label}: ${actual} vs ${expected}`);
	const up = { x: 0, y: 200, z: 0, yaw: 0, pitch: -90 };
	const [sun] = await show(up, 6000);
	const daylight = [120, 167, 255];
	closeTo(sun, fixtureArtRGB("environment/sun", variant).map((value, channel) => Math.min(255, value + daylight[channel])), "sun over sky");
	const [moon, dark] = await show(up, 24000 * 2 + 18000);
	closeTo(moon, fixtureArtRGB("environment/moon_phases", variant, 6), "first quarter, lit side");
	assert.ok(dark.every(value => value < 30), "first quarter, dark side");
	const [cloud] = await show({ ...up, x: -88, y: 191, z: 2 }, 6000);
	closeTo(cloud, fixtureArtRGB("environment/clouds", variant), "opaque cloud texel");
	const [gap] = await show({ ...up, x: -28, y: 191, z: 2 }, 6000);
	closeTo(gap, sun, "clear cloud texel");
	const [x, y, z] = spawn.map(Math.floor);
	const [crack] = await show({ x: x + 0.5, y: y + 2, z: z + 0.5, yaw: 0, pitch: 90 }, 6000,
		{ x, y: y - 1, z, stage: 9, bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
	closeTo(crack, fixtureArtRGB("environment/destroy_stage_9", variant, 9), "crack overlay on terrain");
	await page.evaluate(() => { delete window.testTextureScene; });
}

export async function installFixture(page, edge, bytes) {
	await page.goto(edge + "/", { waitUntil: "domcontentloaded" });
	await page.waitForSelector("#texture-drop");
	await page.$eval("#texture-drop", (target, base64, filename) => {
		const transfer = new DataTransfer();
		transfer.items.add(new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], filename));
		target.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
	}, Buffer.from(bytes).toString("base64"), fixtureFilename);
	await page.waitForSelector('.pack-summary');
}

export async function testTexturePacks(browser, edge, shots, initialFixture) {
	const dir = await mkdtemp(join(tmpdir(), "cf-pack-test-"));
	const pages = [], contexts = [], traffic = [], errors = [], frames = [];
	try {
		const version = "1.26.60.6";
		const name = `bedrock-samples-v${version}-full.zip`;
		const versionLabel = "Bedrock Samples v" + version;
		const partialFilename = "bedrock-samples-v1.26.60.7-full.zip";
		const partialNotice = "この版のパックに無い画像が 5 件あります";
		const metadataFilename = "sample-min.zip";
		const missingImages = "ブロックとアイテムの画像が入っていません。手順 1 のページで、名前が -full.zip で終わるファイルをダウンロードして、もう一度開いてください。";
		const fringeBrightness = 222;
		const officialError = /公式の Bedrock Samples の ZIP ではありません/;
		const rejected = [
			["other.zip", await zipBytes(packEntries({ uuid: "other" })), officialError],
			["no-engine-version.zip", await zipBytes(testEntries.map(([path, data]) => [path,
				path.endsWith("manifest.json") ? JSON.stringify({ header: { uuid: JSON.parse(data).header.uuid } }) : data])), officialError],
			["old-format.zip", await zipBytes(testEntries.filter(([path]) => path.includes("/textures/")).map(([path, data]) => [path.replace("sample/resource_pack/", ""), data])), officialError],
			["broken.zip", "invalid archive", /.+/],
			[metadataFilename, await zipBytes(packEntries()), new RegExp(missingImages)],
		];
		await Promise.all([
			writeFile(join(dir, fixtureFilename), initialFixture),
			writeFile(join(dir, partialFilename), await fixturePack({ omit: [
				"resource_pack/textures/blocks/stone.png", "resource_pack/textures/items/apple.png",
				"resource_pack/textures/environment/clouds.png", "resource_pack/textures/environment/destroy_stage_4.png",
				"resource_pack/textures/ui/heart.png",
			] })),
			writeFile(join(dir, name), await fixturePack({ artVariant: true, colors: {
				stone: stoneRGB, grass_block_side: [fringeBrightness, fringeBrightness, fringeBrightness], apple: appleRGB,
				water: [120, 120, 120], water_flow: [130, 130, 130],
			} })),
			...rejected.map(([filename, data]) => writeFile(join(dir, filename), data)),
		]);
		const world = "e2e-pack-" + Date.now().toString(36);
		const url = `${edge}/play.html?server=ws&view=2&world=${world}`;
		async function player(checkInstall = false) {
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
			// Observe atlas pixels and the animated layer indices selected by the renderer.
			await page.evaluateOnNewDocument(() => {
				const write = GPUQueue.prototype.writeTexture, writeBuffer = GPUQueue.prototype.writeBuffer;
				let atlas;
				const art = window.testWorldArt = { sky: [] };
				GPUQueue.prototype.writeTexture = function(dst, data, layout, size) {
					const pixel = (x, y, layer = 0) => {
						const at = (layout.offset ?? 0) + layer * (layout.rowsPerImage ?? size[1]) * layout.bytesPerRow
							+ y * layout.bytesPerRow + x * 4;
						return Array.from(data.subarray(at, at + 4));
					};
					if (dst.mipLevel === 0 && size[0] === 16 && size[2] > 80) {
						window.testStoneRGB = Array.from(data.subarray(0, 3));
						atlas = window.testAtlas = Array.from({ length: size[2] }, (_, layer) => Array.from(data.subarray(layer * 1024, layer * 1024 + 4)));
						window.testWaterSamples = [new Map(), new Map()];
						art.cracks = Array.from({ length: size[2] }, (_, layer) => [pixel(0, 0, layer), pixel(4, 3, layer)]);
					}
					if (dst.texture.depthOrArrayLayers === 9 && size[0] === 32 && size[1] === 32) {
						art.sky[dst.origin?.[2] ?? 0] = [pixel(0, 0), pixel(12, 16), pixel(19, 16)];
					}
					if (dst.texture.width === 256 && size[0] === 256 && size[1] === 256 && dst.texture.depthOrArrayLayers === 1) {
						art.clouds = [pixel(0, 0), pixel(15, 0)];
					}
					return write.call(this, dst, data, layout, size);
				};
				GPUQueue.prototype.writeBuffer = function(buffer, offset, data, ...rest) {
					if (atlas && (buffer.usage & GPUBufferUsage.UNIFORM) && data instanceof ArrayBuffer && data.byteLength === 272) {
						const indices = new Uint32Array(data, 128, 2);
						indices.forEach((layer, i) => window.testWaterSamples[i].set(layer, atlas[layer]));
					}
					return writeBuffer.call(this, buffer, offset, data, ...rest);
				};
			});
			if (checkInstall) {
				const unauthenticated = req => new URL(req.url()).pathname === "/api/me"
					? req.respond({ contentType: "application/json", body: JSON.stringify({ open: false, user: null }) })
					: req.continue();
				await page.setRequestInterception(true);
				page.on("request", unauthenticated);
				await page.goto(url, { waitUntil: "domcontentloaded" });
				await page.waitForFunction(() => document.querySelector("#panel h2")?.textContent === "ログイン");
				assertPlayNext(page.url(), url);
				page.off("request", unauthenticated);
				await page.setRequestInterception(false);
				await page.goto(edge + "/", { waitUntil: "domcontentloaded" });
				await page.waitForSelector("#texture-drop");
				const assertLocked = async () => {
					assert.equal(await page.$eval("#panel h2", node => node.textContent), "テクスチャをインストール");
					assert.doesNotMatch(await page.$eval("#panel", node => node.textContent), /シングルプレイ|マルチプレイ|メニューに戻る/);
					assert.equal(await page.$eval(".shade", node => getComputedStyle(node).display), "none");
				};
				await assertLocked();
				for (const play of [edge + "/play.html", url]) {
					await page.goto(play, { waitUntil: "domcontentloaded" });
					await page.waitForSelector("#texture-drop");
					assertPlayNext(page.url(), play);
					await assertLocked();
				}
				const returnUrl = new URL(new URL(page.url()).searchParams.get("next"), url).href;
				await page.setViewport({ width: 320, height: 720 });
				assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "install page fits a narrow viewport");
				await page.setViewport({ width: 1280, height: 720 });

				// Seed the former IndexedDB shape, then confirm startup deletes it.
				const oldSelection = async seed => {
					const request = indexedDB.open("cf-minecraft.texture-pack", 1);
					const db = await new Promise((resolve, reject) => {
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
					try {
						const tx = db.transaction("settings", seed ? "readwrite" : "readonly");
						const store = tx.objectStore("settings");
						const read = seed ? store.put({
							pack: { name: "old.zip", tiles: new Map([["stone", new Uint8Array(1024)]]) },
							active: true,
						}, "selection") : store.get("selection");
						return await new Promise((resolve, reject) => {
							tx.oncomplete = () => resolve(read.result);
							tx.onabort = () => reject(tx.error);
						});
					} finally { db.close(); }
				};
				await page.evaluate(oldSelection, true);
				await page.reload({ waitUntil: "domcontentloaded" });
				await page.waitForSelector("#texture-drop");
				await assertLocked();
				assert.equal(await page.evaluate(oldSelection, false), undefined);
				for (const [filename, , reason] of rejected) {
					await (await page.$("#texture-file")).uploadFile(join(dir, filename));
					await page.waitForSelector("#texture-error:not([hidden])");
					assert.match(await page.$eval("#texture-error", node => node.textContent), /このファイルは使えません/);
					assert.equal(await page.$eval("#texture-error .texture-filename", node => node.textContent), filename);
					assert.match(await page.$eval("#texture-error-reason", node => node.textContent), reason);
					await assertLocked();
				}
				// A failed write must keep the player on the install screen.
				await page.evaluate(() => {
					const put = IDBObjectStore.prototype.put;
					IDBObjectStore.prototype.put = function () {
						IDBObjectStore.prototype.put = put;
						this.transaction.abort();
					};
				});
				await (await page.$("#texture-file")).uploadFile(join(dir, fixtureFilename));
				await page.waitForFunction(() => document.querySelector("#texture-error-reason")?.textContent.includes("保存できません"));
				await assertLocked();
				await (await page.$("#texture-file")).uploadFile(join(dir, fixtureFilename));
				await page.waitForSelector(".pack-summary");
				assert.equal(await page.$eval("#panel [role=status]", node => node.textContent), "テクスチャを適用しました");
				assert.match(await page.$eval(".pack-summary", node => node.textContent), /Bedrock Samples v1\.26\.60\.5/);
				await page.reload({ waitUntil: "domcontentloaded" });
				await page.waitForSelector(".pack-summary");
				assert.equal(await page.$("#texture-drop"), null);
				await page.click(".pack-summary button");
				await page.waitForSelector("#texture-drop");
				const back = await page.waitForSelector("#panel > .btn.outline", { visible: true });
				assert.equal(await back.evaluate(node => node.textContent), "メニューに戻る");
				await back.click();
				await page.waitForSelector(".pack-summary");
				const returnLink = await page.waitForSelector('#panel a[href*="server=ws"]');
				assert.equal(await returnLink.evaluate(link => link.textContent), "ゲームに戻る");
				assert.equal(await returnLink.evaluate(link => link.href), returnUrl);
				await Promise.all([page.waitForNavigation(), returnLink.click()]);
			} else {
				await installFixture(page, edge, initialFixture);
				await page.goto(url);
			}
			await page.waitForFunction(() => window.__mc?.stats().joined && window.__mc.stats().chunks >= 9 && window.testStoneRGB);
			return page;
		}
		const a = await player(true), b = await player();
		const waterPixels = async page => {
			await page.waitForFunction(() => window.testWaterSamples?.every(samples =>
				new Set([...samples.values()].map(pixel => pixel[0])).size === 3));
			return page.evaluate(() => window.testWaterSamples.map(samples => {
				let start = samples.keys().next().value;
				const atlas = window.testAtlas, alpha = atlas[start][3];
				while (atlas[start - 1]?.[3] === alpha) start--;
				return atlas.slice(start, start + 32);
			}));
		};
		const originalWater = await waterPixels(a);
		const defaults = await pixels(b);
		assert.deepEqual(await pixels(a), defaults);
		for (const page of [a, b]) await assertWorldArt(page, false);
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
		await a.waitForFunction((sel, label) => document.querySelector(sel).textContent === label, {}, selected, versionLabel);
		assert.equal(await a.$eval(notice, node => node.textContent), "テクスチャを適用しました");
		await assertWorldArt(a, true);
		await assertWorldArt(b, false);
		const changed = await pixels(a);
		assert.deepEqual(changed.worldStone, stoneRGB);
		assert.notEqual(changed.stone, defaults.stone);
		assert.notEqual(changed.apple, defaults.apple);
		assert.equal(changed.dirt, defaults.dirt);
		// Both icons use the pack's dirt under the grass mask. The cached fringe must repaint in the same biome.
		const sidePixel = c => Array.from(c.getContext("2d").getImageData(20, 32, 1, 1).data);
		const dirtSide = await a.$eval('[data-block="dirt"] canvas', sidePixel);
		const grassTint = await a.evaluate(() => {
			const [x, , z] = window.__mc.playerPosition();
			return window.__mc.tint(x, z).grass;
		});
		for (const selector of ["#hotbar canvas.selected", '#inventory-screen [data-slot="0"] canvas']) {
			assert.deepEqual(await a.$eval(selector, sidePixel), dirtSide);
			const fringe = await a.$eval(selector, c => Array.from(c.getContext("2d").getImageData(20, 19, 1, 1).data));
			assert.deepEqual(fringe, [...grassTint.map(channel => Math.round(Math.round(channel * fringeBrightness / 255) * 0.68)), 255]);
		}
		const changedWater = await waterPixels(a);
		for (const [i, frames] of changedWater.entries()) {
			assert.equal(frames.length, 32);
			assert(frames.every(pixel => pixel[3] === (i ? 166 : 156)));
			assert.equal(new Set(frames.map(pixel => pixel[0])).size, 3);
			assert(Math.max(...frames.map(pixel => pixel[0])) < Math.max(...originalWater[i].map(pixel => pixel[0])));
			for (const [frame, pixel] of frames.entries()) assert.deepEqual(pixel, frames[frame % 3]);
		}
		assert.deepEqual(await pixels(b), defaults);
		const sprite = await a.$eval('[data-block="apple"] canvas', c => [...c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data]);
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
				for (const [i, label] of ["B: original", "A: replaced", "Input PNG"].entries()) ctx.fillText(label, 172 + i * 179, 81);
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
		await a.waitForFunction((sel, label) => window.__mc?.stats().joined && document.querySelector(sel).textContent === label, {}, selected, versionLabel);
		assert.deepEqual(await pixels(a), changed);
		assert.deepEqual(await pixels(b), defaults);

		const survival = await contexts[1].newPage();
		survival.on("pageerror", error => errors.push(error.message));
		await survival.evaluateOnNewDocument(() => {
			window.Worker = class extends Worker {
				constructor(url, options) {
					super(url, options);
					if (!String(url).includes("/sim.worker.ts")) return;
					// Exercise the normal status handler with stable half, empty and underwater states.
					window.testVitals = () => this.dispatchEvent(new MessageEvent("message", {
						data: { type: "packets", list: [Uint8Array.of(12, 13, 0, 180, 0, 0, 13).buffer] },
					}));
				}
			};
		});
		await survival.goto(`${edge}/play.html?server=local&mode=survival&gen=flat&view=2&time=6000&world=${world}-hud`);
		await survival.bringToFront();
		await survival.waitForFunction(() => window.__mc?.stats().joined && window.__mc.stats().chunks >= 9
			&& !window.__mc.stats().meshQueue && document.querySelector('.heart[data-state="full"]'));
		const spawn = await survival.evaluate(async () => {
			const { Renderer } = await import("/src/client/renderer.ts");
			const render = Renderer.prototype.render;
			Renderer.prototype.render = function(camera, view, target, fov, time, items, now, digs, ...entities) {
				const scene = window.testTextureScene;
				return render.call(this, scene?.camera ?? camera, view, target, fov, scene?.time ?? time, items, now,
					scene?.dig ? [scene.dig] : digs, ...entities);
			};
			window.testVitals();
			document.querySelector("#overlay").hidden = true;
			return window.__mc.stats().spawn;
		});
		await survival.waitForFunction(() => document.querySelector('.heart[data-state="half"]') &&
			!document.querySelector(".bubble").hidden && document.querySelector("#damage-flash").hidden);
		await assertHudArt(survival, false);
		await assertWorldFrame(survival, false, spawn);
		await survival.$eval("#overlay", overlay => { overlay.hidden = false; });
		await openSettings(survival);
		await (await survival.$(input)).uploadFile(join(dir, name));
		await survival.waitForFunction((sel, label) => document.querySelector(sel).textContent === label, {}, selected, versionLabel);
		await survival.evaluate(() => {
			window.testVitals();
			document.querySelector("#overlay").hidden = true;
		});
		await survival.waitForFunction(() => document.querySelector("#damage-flash").hidden);
		await assertHudArt(survival, true);
		await assertWorldFrame(survival, true, spawn);
		await survival.close();

		// Install a partial pack from the title, reload, then enter the world using it.
		await a.goto(edge + "/?" + new URLSearchParams({ next: new URL(url).pathname + new URL(url).search }));
		await a.waitForSelector(".pack-summary button");
		await a.click(".pack-summary button");
		await a.waitForSelector("#texture-file");
		await (await a.$("#texture-file")).uploadFile(join(dir, partialFilename));
		const missing = ".pack-summary [data-pack-missing]";
		await a.waitForSelector(missing);
		assert.equal(await a.$eval(missing, node => node.textContent), partialNotice);
		await a.reload();
		await a.waitForSelector(missing);
		assert.equal(await a.$eval(missing, node => node.textContent), partialNotice);
		await a.click('#panel a[href*="server=ws"]');
		await a.waitForFunction(() => window.__mc?.stats().joined && window.__mc.stats().chunks >= 9);
		await openSettings(a);
		assert.equal(await a.$eval(panel + " [data-pack-missing]", node => node.textContent), partialNotice);
		assert.deepEqual(await a.evaluate(() => window.testStoneRGB), [0, 0, 0]);
		assert.deepEqual(await a.$eval('[data-block="apple"] canvas', canvas => {
			const context = canvas.getContext("2d");
			return [0, 8].map(x => [...context.getImageData(x, 0, 1, 1).data]);
		}), [[0, 0, 0, 255], [248, 0, 248, 255]]);

		assert.equal(await a.evaluate(() => window.testWorldArt.clouds), undefined);
		const beforeRejectedReplacement = await pixels(a);
		await (await a.$(input)).uploadFile(join(dir, metadataFilename));
		await a.waitForFunction((sel, reason) => document.querySelector(sel).textContent === reason,
			{}, notice, "テクスチャを変更できませんでした。" + missingImages);
		assert.equal(await a.$eval(selected, node => node.textContent), "Bedrock Samples v1.26.60.7");
		assert.equal(await a.$eval(panel + " [data-pack-missing]", node => node.textContent), partialNotice);
		assert.deepEqual(await pixels(a), beforeRejectedReplacement);
		assert.equal(await a.evaluate(() => window.__mc.stats().joined), true);

		// Only same-origin game/module GETs, never a pack filename, image upload, or pack endpoint.
		for (const [method, target, body] of traffic) {
			if (!/^https?:/.test(target)) continue;
			const url = new URL(target);
			assert.equal(method, "GET");
			assert(!body && !url.href.includes(name) && !/\.(png|mcpack|zip)(?:$|\?)/i.test(url.href), target);
			// Both pages load a fixed Google Fonts stylesheet and its static font subsets.
			if (target === "https://fonts.googleapis.com/css2?family=DotGothic16&family=M+PLUS+1p:wght@400;500;700&display=swap") continue;
			if (url.origin === "https://fonts.gstatic.com" && /^\/s\/(?:dotgothic16|mplus1p)\/[\w./-]+\.woff2$/.test(url.pathname) && !url.search) continue;
			assert.equal(url.origin, new URL(edge).origin);
			assert(/^\/(?:$|play(?:\.html)?$|api\/me$|@|src\/|node_modules\/|favicon\.ico$)/.test(url.pathname), target);
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
		console.log("ok  texture packs: title and play gates, invalid archives, missing images, replacement, independent multiplayer profiles, GPU and UI pixels, persistence and outbound traffic");
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
