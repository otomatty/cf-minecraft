import assert from "node:assert/strict";
import { test } from "node:test";
import { TintMap, tintBudgetMs } from "./tint-map.ts";
import { GRASS_TINT, LEAVES_TINT, WATER_TINT } from "./textures.ts";
import { ClientCore } from "./client-core.ts";
import { readFileSync } from "node:fs";

test("tint budget has a 1ms floor, a 10ms ceiling and scales with frame time", () => {
	assert.equal(tintBudgetMs(5), 1);
	assert.equal(tintBudgetMs(200), 10);
	assert.equal(tintBudgetMs(25), 2);
});

const colors = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
function fixture(costMs = 1) {
	let time = 0;
	const calls = [];
	const map = new TintMap(colors, (x, z) => { calls.push([x, z]); time += costMs; return Uint8Array.from({ length: 16 }, (_, i) => i % 2); }, () => time);
	map.setWorld(2026n, 2);
	map.takeUploads();
	return { map, calls };
}

test("negative cells wrap and chunks 64 apart replace the same slot", () => {
	const { map } = fixture();
	map.update(-1, -1, 0, 10);
	assert.deepEqual(map.tint(-1, -1), { biome: 1, grass: [21, 22, 23], leaves: [24, 25, 26], water: [27, 28, 29] });
	assert.equal(map.tint(-17, -1), null);
	const first = map.takeUploads();
	assert.deepEqual(first.map(r => [r.x, r.y, r.width, r.height]), [[252, 252, 4, 4]]);
	assert.equal(first[0].data.length, 192);
	for (let layer = 0; layer < 3; layer++) {
		for (let cell = 0; cell < 16; cell++) {
			const offset = (cell % 2) * 9 + layer * 3;
			assert.deepEqual([...first[0].data.slice(layer * 64 + cell * 4, layer * 64 + cell * 4 + 4)], [...colors.slice(offset, offset + 3), 255]);
		}
	}
	map.update(63, 63, 0, 10);
	assert.equal(map.tint(-1, -1), null);
	assert.deepEqual(map.tint(1023, 1023), { biome: 1, grass: [21, 22, 23], leaves: [24, 25, 26], water: [27, 28, 29] });
	assert.deepEqual(map.takeUploads().map(r => [r.x, r.y]), first.map(r => [r.x, r.y]));
});

test("nearest first, time budget resumes, completed frames do no work", () => {
	const { map, calls } = fixture(0.5);
	map.update(0, 0, 1); // The default 1ms budget permits two half-ms calls.
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0], [0, 0]);
	map.update(0, 0, 1, 0.5);
	assert.equal(calls.length, 3);
	map.update(0, 0, 1, 100);
	assert.equal(calls.length, 9);
	const distances = calls.map(([x, z]) => x * x + z * z);
	assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
	assert.equal(map.takeUploads().length, 9);
	map.update(0, 0, 1, 100);
	assert.equal(calls.length, 9);
	assert.deepEqual(map.takeUploads(), []);
});

test("camera movement calculates only newly exposed chunks and drops old pending work", () => {
	const { map, calls } = fixture();
	map.update(0, 0, 1, 100);
	map.takeUploads();
	map.update(1, 0, 1, 100);
	assert.deepEqual(calls.slice(9), [[2, 0], [2, -1], [2, 1]]);
	assert.equal(map.takeUploads().length, 3);
	map.update(10, 0, 1, 0.5);
	map.update(20, 0, 0, 100);
	assert.deepEqual(calls.slice(12), [[10, 0], [20, 0]]);
});

test("seed and generator changes restore every default texel; unknown and non-Terrain never calculate", () => {
	const { map, calls } = fixture();
	map.update(0, 0, 0, 10);
	for (const [seed, generator] of [[7n, 2], [7n, 0], [7n, 1], [null, null], [7n, null]]) {
		map.setWorld(seed, generator);
		assert.equal(map.tint(0, 0), null);
		const rects = map.takeUploads();
		assert.equal(rects.length, 1);
		assert.deepEqual([rects[0].x, rects[0].y, rects[0].width, rects[0].height], [0, 0, 256, 256]);
		assert.equal(rects[0].data.length, 256 * 256 * 4 * 3);
		for (const [layer, rgb] of [GRASS_TINT, LEAVES_TINT, WATER_TINT].entries()) {
			const data = rects[0].data.subarray(layer * 256 * 256 * 4, (layer + 1) * 256 * 256 * 4);
			for (let i = 0; i < data.length; i += 4) assert.deepEqual([...data.slice(i, i + 4)], [...rgb, 255]);
		}
		const before = calls.length;
		map.update(0, 0, 0, 10);
		assert.equal(calls.length - before, generator === 2 ? 1 : 0);
		map.takeUploads();
		map.setWorld(seed, generator);
		assert.deepEqual(map.takeUploads(), []);
	}
});

test("WASM wrappers copy biome colors and cell IDs into independent CPU storage", () => {
	const core = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {}));
	const table = core.biomeColors();
	assert.deepEqual([...table.slice(18, 21)], [72, 170, 74]);
	const map = new TintMap(table, (x, z) => core.tintCells(2026n, 2, x, z));
	map.setWorld(2026n, 2);
	map.update(0, 0, 0, 100);
	assert.equal(map.tint(0, 0)?.biome, 2);
	assert.deepEqual(map.tint(0, 0)?.grass, [72, 170, 74]);
	core.tintCells(7n, 2, 90, 90);
	assert.deepEqual([...table.slice(18, 21)], [72, 170, 74]);
	assert.deepEqual(map.tint(0, 0)?.grass, [72, 170, 74]);
	map.update(0, 9, 0, 100);
	assert.equal(map.tint(0, 144)?.biome, 0);
	assert.deepEqual(map.tint(0, 144)?.grass, [124, 184, 84]);
});
