import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ChunkGenCore } from "../shared/server-core.ts";
import { ClientCore, MIN_Y, S2C } from "./client-core.ts";
import { titleCameraHeight, titleChunks, titleLandscape, titleYaw } from "./title-landscape.ts";
import { gameRedirect, hasPlaySession, safeNext, thumbColor, titleScreen } from "./title-route.ts";

test("title stays for no query or a login return URL", () => {
	assert.equal(gameRedirect(""), null);
	assert.equal(gameRedirect("?next=%2Fplay.html"), null);
});

test("legacy game queries redirect to play with the original query", () => {
	for (const search of ["?world=main", "?server=ws&world=lobby", "?autopilot=1"]) {
		assert.equal(gameRedirect(search), "/play.html" + search);
	}
});

test("every game parameter redirects even with an empty value", () => {
	for (const key of ["server", "world", "view", "gen", "seed", "time", "autopilot"]) {
		const search = `?next=%2Fplay.html&${key}=`;
		assert.equal(gameRedirect(search), "/play.html" + search);
	}
	assert.equal(gameRedirect("?worldName=main"), null);
});

test("safeNext accepts local return paths", () => {
	for (const path of ["/", "/play.html?server=ws&world=lobby", "/play.html#pause"]) {
		assert.equal(safeNext(path), path);
	}
});

test("safeNext rejects external and normalized return paths", () => {
	for (const path of [null, "", "play.html", "https://example.com/", "//example.com", "/\\example.com", "/a\nb", "/a\tb", "/a b", "/a\u0000b", "/a\u007fb", "/a\u00a0b"]) {
		assert.equal(safeNext(path), null);
	}
});

test("world names choose deterministic colors from the palette", () => {
	assert.deepEqual(["", "a", "b", "c", "d", "e"].map(thumbColor),
		["#829fba", "#769262", "#937d67", "#557e91", "#889184", "#a49b7d"]);
	assert.equal(thumbColor("日本語"), "#a49b7d");
});

test("title camera stays eight blocks above the highest non-air cell", () => {
	assert.equal(titleCameraHeight(-64, 319, y => y === 76 ? 12 : Number(y <= 70)), 84);
	assert.equal(titleCameraHeight(-64, 319, y => y === 319 ? 1 : 0), 327);
	assert.equal(titleCameraHeight(-64, 319, () => -1), -56);
});

test("the generated title viewpoint has green terrain, trees, water and a clear view", () => {
	const load = (name: string) => new WebAssembly.Module(readFileSync(new URL(`../wasm/${name}.wasm`, import.meta.url)));
	const generatorCore = ChunkGenCore.fromModule(load("server"));
	const clientModule = load("client");
	const { generator, radius } = titleLandscape;
	const maxY = 319;

	function violations(seed: bigint, x: number, z: number) {
		const core = new ClientCore(new WebAssembly.Instance(clientModule, {}));
		const footingX = Math.floor(x), footingZ = Math.floor(z);
		for (const [cx, cz] of titleChunks(Math.floor(x / 16), Math.floor(z / 16), radius)) {
			const bytes = generatorCore.generate(seed, generator, cx, cz);
			const packet = new Uint8Array(9 + bytes.length);
			const header = new DataView(packet.buffer);
			header.setUint8(0, S2C.ChunkData);
			header.setInt32(1, cx);
			header.setInt32(5, cz);
			packet.set(bytes, 9);
			assert.equal(core.packet(packet), S2C.ChunkData);
		}

		const blocks = core.blockRegistry();
		const oakLog = blocks.findIndex(block => block.name === "oak_log");
		function column(bx: number, bz: number) {
			let top: number | undefined;
			for (let y = maxY; y >= MIN_Y; y--) {
				const block = core.getBlock(bx, y, bz);
				if (block <= 0) continue;
				top ??= y;
				const { name, model } = blocks[block];
				// Find the ground or water underneath the vegetation.
				if (name !== "oak_log" && name !== "oak_leaves" && model !== "cross") return { top, y, name };
			}
			throw new Error(`Missing terrain at ${bx}, ${bz}`);
		}

		const cameraY = titleCameraHeight(MIN_Y, maxY, y => core.getBlock(footingX, y, footingZ));
		const clearance = cameraY - column(footingX, footingZ).top;
		let air = true;
		for (let dz = -2; dz <= 2; dz++) {
			for (let dx = -2; dx <= 2; dx++) {
				for (let dy = -2; dy <= 2; dy++) {
					if (core.getBlock(footingX + dx, Math.floor(cameraY) + dy, footingZ + dz) !== 0) air = false;
				}
			}
		}

		let columns = 0, grass = 0, water = 0, trunks = 0, nearTrunks = 0;
		let groundLow = Infinity, groundHigh = -Infinity;
		let nearTop = -Infinity, farTop = -Infinity;
		for (let bz = footingZ - 65; bz <= footingZ + 65; bz++) {
			for (let bx = footingX - 65; bx <= footingX + 65; bx++) {
				const dx = Math.abs(bx + 0.5 - x), dz = Math.abs(bz + 0.5 - z);
				// Use the nearest edge for obstruction checks, and cell centers for surface area.
				const edgeDistance = Math.hypot(Math.max(0, dx - 0.5), Math.max(0, dz - 0.5));
				if (edgeDistance > 64) continue;
				const { top, y, name } = column(bx, bz);
				if (edgeDistance <= 24) nearTop = Math.max(nearTop, top + 1);
				else farTop = Math.max(farTop, top + 1);

				const distance = Math.hypot(dx, dz);
				if (distance > 64) continue;
				columns++;
				if (name === "grass_block") grass++;
				if (name === "water") water++;
				else {
					groundLow = Math.min(groundLow, y);
					groundHigh = Math.max(groundHigh, y);
				}
				// Count rooted vertical stems, including those under a leaf canopy.
				if (core.getBlock(bx, y + 1, bz) === oakLog && core.getBlock(bx, y + 2, bz) === oakLog) {
					trunks++;
					if (distance <= 32) nearTrunks++;
				}
			}
		}
		const issues = [];
		if (grass / columns < 0.7) issues.push(`grass: ${grass}/${columns} columns`);
		if (water / columns < 0.05 || water / columns > 0.35) issues.push(`water: ${water}/${columns} columns`);
		if (trunks < 8 || nearTrunks < 2) issues.push(`trunks: ${trunks} within 64, ${nearTrunks} within 32`);
		if (groundHigh - groundLow < 8) issues.push(`relief: y=${groundLow}..${groundHigh}`);
		if (nearTop > cameraY || farTop > cameraY + 12) issues.push(`wall: y=${nearTop} nearby and y=${farTop} farther out at camera y=${cameraY}`);
		if (clearance < 6 || clearance > 10 || !air) issues.push(`camera: clearance ${clearance}, air around it: ${air}`);
		return issues;
	}

	const { seed, x, z } = titleLandscape;
	assert.deepEqual(violations(seed, x, z), []);
	assert.match(violations(71n, 104.5, 88.5).join("\n"), /^wall:/m);
	assert.match(violations(501n, 201.5, 544.5).join("\n"), /^grass:/m);
});

test("title yaw rotates at a constant speed and respects reduced motion", () => {
	assert.equal(titleYaw(0, false), 205);
	assert.equal(titleYaw(15_000, false), 235);
	assert.equal(titleYaw(45_000, false), 295);
	assert.equal(titleYaw(180_000, false), 205);
	assert.equal(titleYaw(225_000, false), 295);
	assert.equal(titleYaw(225_000, true), 205);
});

test("title chunks are unique, inside the radius, and generated nearest first", () => {
	assert.deepEqual(titleChunks(-2, 3, 1), [[-2, 3], [-2, 2], [-3, 3], [-1, 3], [-2, 4]]);
	const chunks = titleChunks(-2, 3, 6);
	const distances = chunks.map(([x, z]) => (x + 2) ** 2 + (z - 3) ** 2);
	assert.equal(new Set(chunks.map(chunk => chunk.join(","))).size, 113);
	assert.equal(distances.at(-1), 36);
	assert.deepEqual(distances, distances.toSorted((a, b) => a - b));
});

test("title requires a session, then an installed pack", () => {
	for (const me of [{ open: false, user: null }, {}]) {
		assert.equal(titleScreen(me, false), "login");
		assert.equal(titleScreen(me, true), "login");
	}
	for (const me of [{ open: true, user: null }, { open: false, user: { id: "player" } }]) {
		assert.equal(titleScreen(me, false), "textures");
		assert.equal(titleScreen(me, true), "menu");
	}
});

test("play admission requires a user or the development override", () => {
	assert.equal(hasPlaySession({ open: false, user: null }), false);
	assert.equal(hasPlaySession({}), false);
	assert.equal(hasPlaySession({ open: true, user: null }), true);
	assert.equal(hasPlaySession({ open: false, user: { id: "player" } }), true);
});
