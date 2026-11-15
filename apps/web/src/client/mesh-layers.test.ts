import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { quadCenters, sortedQuadIndices, sortSections, splitMeshLayers, updateTranslucentSort } from "./mesh-layers.ts";
import { paintTexture, downsample, textureIconPixels, LEAVES_TINT, WATER_TINT } from "./textures.ts";
import { ClientCore } from "./client-core.ts";
import { terrainShader, CLOUD_HEIGHT, cloudsBeforeTranslucent } from "./renderer.ts";

test("clouds draw before translucent terrain only below the cloud plane", () => {
	assert.equal(CLOUD_HEIGHT, 192);
	for (const cameraY of [-64, 64, 191.999]) assert.equal(cloudsBeforeTranslucent(cameraY), true);
	for (const cameraY of [192, 192.001, 320]) assert.equal(cloudsBeforeTranslucent(cameraY), false);
	assert.equal(cloudsBeforeTranslucent(95.999, 96), true);
	assert.equal(cloudsBeforeTranslucent(96, 96), false);
	assert.equal(cloudsBeforeTranslucent(97, 96), false);
});

test("leaf and water icons use terrain tints without changing alpha or shared texture pixels", () => {
	for (const [name, tint] of [["oak_leaves", LEAVES_TINT], ["water", WATER_TINT]]) {
		const pixels = paintTexture(name);
		const original = pixels.slice();
		const icon = textureIconPixels(name, pixels);
		assert.notDeepEqual([...icon], [...pixels]);
		assert.deepEqual(pixels, original);
		for (let i = 0; i < pixels.length; i += 4) {
			assert.equal(icon[i + 3], pixels[i + 3]);
			for (let c = 0; c < 3; c++) assert.equal(icon[i + c], Math.round(pixels[i + c] * tint[c] / 255));
		}
		if (name === "oak_leaves") assert.ok(icon.some((v, i) => i % 4 === 3 && v === 0));
	}
	const stone = paintTexture("stone");
	assert.deepEqual([...textureIconPixels("stone", stone)], [...stone]);
});

test("terrain tint layers follow texture names when the texture array is reordered", () => {
	for (const names of [["water", "stone", "oak_leaves"], ["oak_leaves", "water", "stone"]]) {
		const shader = terrainShader(names);
		assert.ok(shader.includes(`if (in.layer == ${names.indexOf("oak_leaves")}u) { tint =`));
		assert.ok(shader.includes(`if (in.layer == ${names.indexOf("water")}u) { tint =`));
		assert.ok(!shader.includes("__LEAVES_LAYER__") && !shader.includes("__WATER_LAYER__"));
	}
	const absent = terrainShader(["stone"]);
	assert.equal(absent.match(/if \(in.layer == 4294967295u\)/g)?.length, 2);
});

function quad(x, y, z, rotated = false) {
	const vertices = [[x, y, z], [x + 1, y, z], [x + 1, y + 1, z], [x, y + 1, z]];
	if (rotated) vertices.push(vertices.shift());
	return vertices.flatMap(([x, y, z]) => [x | y << 5 | z << 10, 0]);
}

test("quad centers and far-first order preserve whole quads and rotated AO diagonals", () => {
	const words = new Uint32Array([...quad(1, 2, 2), ...quad(1, 2, 10, true), ...quad(1, 2, 6)]);
	const centers = quadCenters(words);
	assert.deepEqual([...centers], [1.5, 2.5, 2, 1.5, 2.5, 10, 1.5, 2.5, 6]);
	const indices = sortedQuadIndices(centers, [1.5, 2.5, 0]);
	assert.deepEqual([...indices], [4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 0, 1, 2, 0, 2, 3]);
	assert.deepEqual([...sortedQuadIndices(centers, [1.5, 2.5, 16])].filter((_, i) => i % 6 === 0), [0, 8, 4]);
	assert.deepEqual([...sortedQuadIndices(centers, [1.5, 2.5, 6])].filter((_, i) => i % 6 === 0), [0, 4, 8]);
});

test("sections draw far-first every frame and sort near-first, including negative world coordinates", () => {
	const sections = [{ origin: [-32, -64, -32] }, { origin: [0, 0, 0] }, { origin: [32, 0, 0] }];
	const before = [...sections];
	assert.deepEqual(sortSections(sections, [8, 8, 8]), [sections[0], sections[2], sections[1]]);
	assert.deepEqual(sortSections(sections, [8, 8, 8], false), [sections[1], sections[2], sections[0]]);
	assert.deepEqual(sortSections(sections, [-24, -56, -24]), [sections[2], sections[1], sections[0]]);
	assert.deepEqual(sections, before);
	assert.deepEqual(sortSections([{ origin: [0, 0, 0], id: 1 }, { origin: [0, 0, 0], id: 2 }], [0, 0, 0]).map(s => s.id), [1, 2]);
});

test("quad sort budget prioritizes nearby sections, resumes work and invalidates on block changes or new meshes", () => {
	const near = { origin: [0, 0, 0], sortedAt: "" }, far = { origin: [16, 0, 0], sortedAt: "" };
	const sections = [far, near];
	let elapsed = 0;
	const calls = [];
	const update = (section, local) => { calls.push([section, local]); elapsed += 1.5; };
	const now = () => elapsed;
	updateTranslucentSort(sections, [0.5, 0.5, 0.5], update, now);
	assert.deepEqual(calls, [[near, [0.5, 0.5, 0.5]]]); // One indivisible overrun; far waits.
	updateTranslucentSort(sections, [0.5, 0.5, 0.5], update, now);
	assert.deepEqual(calls[1], [far, [-15.5, 0.5, 0.5]]);
	updateTranslucentSort(sections, [0.9, 0.9, 0.9], update, now);
	assert.equal(calls.length, 2); // Camera still in the same block.
	updateTranslucentSort(sections, [-0.1, 0.9, 0.9], update, now);
	assert.equal(calls.length, 3);
	assert.equal(near.sortedAt, "-1,0,0");
	assert.equal(far.sortedAt, "0,0,0");
	// A mesh replacement in the current camera block also gets a fresh sort.
	near.sortedAt = "";
	updateTranslucentSort(sections, [-0.1, 0.9, 0.9], update, now);
	assert.equal(calls.length, 4);
	assert.equal(calls[3][0], near);
});

test("layer slices respect quad boundaries, empty layers and invalid counts", () => {
	const words = new Uint32Array(Array.from({ length: 48 }, (_, i) => i));
	assert.deepEqual(splitMeshLayers(words, [1, 2, 3]).map(v => [...v]), [
		[...words.slice(0, 8)], [...words.slice(8, 24)], [...words.slice(24)],
	]);
	assert.deepEqual(splitMeshLayers(words, [0, 6, 0]).map(v => v.length), [0, 48, 0]);
	for (const counts of [[1, 2, 2], [-1, 4, 3], [0.5, 2.5, 3], [NaN, 0, 6]]) {
		assert.throws(() => splitMeshLayers(words, counts), /Invalid mesh/);
	}
});

test("WASM mesh output exposes the same layer counts and boundaries in the worker and main APIs", async () => {
	const module = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const x = new WebAssembly.Instance(module, {}).exports;
	const padded = new Uint16Array(18 ** 3);
	const index = (x, y, z) => ((y + 1) * 18 + z + 1) * 18 + x + 1;
	for (const [x, block] of [[2, 1], [5, 11], [8, 13]]) padded[index(x, 3, 3)] = block;
	const ptr = x.mc_alloc(padded.byteLength);
	try {
		new Uint16Array(x.memory.buffer, ptr, padded.length).set(padded);
		assert.equal(x.mesh_padded(ptr, padded.length, 0, 0), 18);
		const words = new Uint32Array(x.memory.buffer, x.client_mesh_ptr(), 18 * 8).slice();
		const counts = [0, 1, 2].map(i => x.client_mesh_count(i));
		assert.deepEqual(counts, [6, 6, 6]);
		assert.deepEqual(splitMeshLayers(words, counts).map(v => v[1] & 4095), [0, 12, 14]);
		// Main-thread world meshing uses the identical counts ABI, even when empty.
		const core = new ClientCore(new WebAssembly.Instance(module, {}));
		assert.equal(core.mesh(0, 0, 0).length, 0);
		assert.deepEqual(core.meshCounts(), [0, 0, 0]);
	} finally { x.mc_free(ptr, padded.byteLength); }
});

test("original glass and leaf textures contain holes; water stays grayscale and translucent", () => {
	for (const name of ["glass", "oak_leaves"]) {
		const pixels = paintTexture(name);
		const alpha = [...pixels].filter((_, i) => i % 4 === 3);
		assert.ok(alpha.includes(0) && alpha.includes(255));
		assert.deepEqual(pixels, paintTexture(name));
	}
	for (const name of ["oak_leaves", "water"]) {
		const pixels = paintTexture(name);
		for (let i = 0; i < pixels.length; i += 4) {
			assert.equal(pixels[i], pixels[i + 1]);
			assert.equal(pixels[i], pixels[i + 2]);
			if (name === "water") assert.ok(pixels[i + 3] / 255 >= 0.6 && pixels[i + 3] / 255 <= 0.75);
		}
	}
});

test("cutout mipmaps preserve threshold coverage to the nearest representable texel", () => {
	const coverage = pixels => [...pixels].filter((v, i) => i % 4 === 3 && v >= 128).length / (pixels.length / 4);
	for (const name of ["glass", "oak_leaves"]) {
		let pixels = paintTexture(name);
		for (let size = 16; size > 1; size >>= 1) {
			const expected = coverage(pixels);
			pixels = downsample(pixels, size, true);
			assert.ok(Math.abs(coverage(pixels) - expected) <= 0.5 / (pixels.length / 4));
		}
	}
	// Non-cutout averaging keeps water's continuous opacity.
	assert.equal(downsample(new Uint8Array([255, 255, 255, 170, 255, 255, 255, 170, 255, 255, 255, 170, 255, 255, 255, 170]), 2)[3], 170);
});
