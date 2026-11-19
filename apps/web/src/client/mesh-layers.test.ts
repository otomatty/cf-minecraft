import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { quadCenters, sortedQuadIndices, sortSections, splitMeshLayers, updateTranslucentSort } from "./mesh-layers.ts";
import { paintTexture, downsample, textureIconPixels } from "./textures.ts";
import { CARRIED_GRASS_TOP_TINT, CARRIED_GRASS_SIDE_TINT, CARRIED_SHORT_GRASS_TINT, CARRIED_LEAVES_TINT, WATER_TINT } from "./block-tints.ts";
import { waterTextureFrame, WATER_FRAME_COUNT } from "./building-textures.ts";
import { grassSideAtlasPixels } from "./flora-textures.ts";
import { itemTexture } from "./item-textures.ts";
import { ClientCore } from "./client-core.ts";
import { filterVisibleSections, outlineBox, terrainShader, CLOUD_HEIGHT, cloudsBeforeTranslucent } from "./renderer.ts";

test("clouds draw before translucent terrain only below the cloud plane", () => {
	assert.equal(CLOUD_HEIGHT, 192);
	for (const cameraY of [-64, 64, 191.999]) assert.equal(cloudsBeforeTranslucent(cameraY), true);
	for (const cameraY of [192, 192.001, 320]) assert.equal(cloudsBeforeTranslucent(cameraY), false);
	assert.equal(cloudsBeforeTranslucent(95.999, 96), true);
	assert.equal(cloudsBeforeTranslucent(96, 96), false);
	assert.equal(cloudsBeforeTranslucent(97, 96), false);
});

test("icons use carried colours without changing alpha or shared terrain pixels", () => {
	for (const [name, tint] of [["oak_leaves", CARRIED_LEAVES_TINT], ["grass_block_top", CARRIED_GRASS_TOP_TINT],
		["short_grass", CARRIED_SHORT_GRASS_TINT], ["water", WATER_TINT], ["water_flow", WATER_TINT]]) {
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
	for (const names of [["water", "grass_block_side", "oak_leaves", "water_flow"], ["water_flow", "oak_leaves", "water", "grass_block_side"]]) {
		const shader = terrainShader(names);
		assert.ok(shader.includes(`if (out.layer == ${names.indexOf("oak_leaves")}u) { tintLayer =`));
		assert.ok(shader.includes(`if (out.layer == ${names.indexOf("water")}u || out.layer == ${names.indexOf("water_flow")}u)`));
		assert.ok(shader.includes(`if (in.layer == ${names.indexOf("grass_block_side")}u)`));
		assert.ok(!shader.includes("__LEAVES_LAYER__") && !shader.includes("__WATER_LAYER__"));
	}
	const shader = terrainShader(["water", "oak_leaves"]);
	const vertex = shader.slice(shader.indexOf("@vertex"), shader.indexOf("override renderLayer"));
	assert.equal(vertex.match(/textureSampleLevel\(tintTex/g)?.length, 4);
	assert.ok(vertex.includes("origins[section].xz & vec2<i32>(1023)"));
	assert.ok(vertex.includes("out.tintColor = vec3<f32>(1.0)"));
	assert.ok(shader.includes("@location(4) @interpolate(perspective, center) tintColor: vec3<f32>"));
	assert.ok(shader.includes("color = color * in.tintColor"));
	assert.ok(!shader.includes("g.grassTint"));
	const absent = terrainShader(["stone"]);
	assert.ok(absent.includes("if (out.layer == 4294967295u || out.layer == 4294967295u)"));
	assert.doesNotMatch(absent, /__[A-Z_]+__/);
});

test("grass side keeps soil colour and reproduces the tinted fringe through all mip levels", () => {
	let packed = grassSideAtlasPixels();
	let icon = paintTexture("grass_block_side");
	const dirt = paintTexture("dirt");
	for (let i = 0; i < packed.length; i += 4) {
		if (packed[i + 3] === 0) assert.deepEqual(packed.subarray(i, i + 3), dirt.subarray(i, i + 3));
		else assert.deepEqual([...packed.subarray(i, i + 3)], [0, 0, 0]);
	}
	assert.ok(packed[3] > 0 && packed.at(-1) === 0);
	for (let size = 16; size >= 1; size >>= 1) {
		for (let i = 0; i < packed.length; i += 4) for (let c = 0; c < 3; c++) {
			const tinted = packed[i + c] + packed[i + 3] * CARRIED_GRASS_SIDE_TINT[c] / 255;
			assert.ok(Math.abs(icon[i + c] - tinted) <= 2);
		}
		if (size > 1) {
			packed = downsample(packed, size);
			icon = downsample(icon, size);
		}
	}
});

test("water has separate, looping animation frames for its surface and sides", () => {
	assert.equal(WATER_FRAME_COUNT, 32);
	for (const [name, flowing] of [["water", false], ["water_flow", true]]) {
		const first = paintTexture(name);
		assert.deepEqual(first, waterTextureFrame(0, flowing));
		assert.deepEqual(first, waterTextureFrame(WATER_FRAME_COUNT, flowing));
		const frames = new Set();
		for (let frame = 0; frame < WATER_FRAME_COUNT; frame++) {
			const pixels = waterTextureFrame(frame, flowing);
			assert.equal(pixels.length, 16 * 16 * 4);
			assert.ok(pixels[3] > 0 && pixels[3] < 255);
			frames.add(Buffer.from(pixels).toString("base64"));
		}
		assert.equal(frames.size, WATER_FRAME_COUNT);
	}
	assert.notDeepEqual(paintTexture("water"), paintTexture("water_flow"));
});

function quad(x, y, z, rotated = false) {
	const vertices = [[x, y, z], [x + 1, y, z], [x + 1, y + 1, z], [x, y + 1, z]];
	if (rotated) vertices.push(vertices.shift());
	return vertices.flatMap(([x, y, z]) => [x * 16 | (y * 16) << 9 | (z * 16) << 18, 0]);
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

test("quad centers decode sixteenths, section edge 256, shading bits and water height", () => {
	const words = new Uint32Array([[240, 256, 240], [256, 256, 240], [256, 256, 256], [240, 256, 256]].flatMap(([x, y, z]) => [x | y << 9 | z << 18, 0]));
	for (let i = 0; i < words.length; i += 2) {
		words[i] |= 5 << 27 | 3 << 30;
		words[i + 1] = (1 << 31 | 16 << 26 | 16 << 21 | 15 << 17 | 15 << 13 | 4095) >>> 0;
	}
	const center = quadCenters(words);
	assert.equal(center[0], 15.5);
	assert.ok(Math.abs(center[1] - (16 - 1 / 9)) < 1e-6);
	assert.equal(center[2], 15.5);
	const partial = quadCenters(new Uint32Array(quad(0.3125, 0.5, 0.6875)));
	assert.deepEqual([...partial], [0.8125, 1, 0.6875]);
});

test("outlines use the selected shape bounds relative to the camera", () => {
	for (const [min, max] of [[[0, 0, 0], [1, 0.5, 1]], [[0, 0.5, 0], [1, 1, 1]], [[5 / 16, 0, 5 / 16], [11 / 16, 10 / 16, 11 / 16]]]) {
		const vertices = outlineBox({ x: -16, y: 80, z: 3, face: 1, hitY: 1, min, max }, [-17, 79, 3], [0.5, 0.25, 0.75]);
		const relative = [0.5, 0.75, -0.75];
		for (let a = 0; a < 3; a++) {
			const values = [...vertices].filter((_, i) => i % 3 === a);
			assert.ok(Math.abs(Math.min(...values) - (relative[a] + min[a] - 0.002)) < 1e-6);
			assert.ok(Math.abs(Math.max(...values) - (relative[a] + max[a] + 0.002)) < 1e-6);
		}
	}
});

test("plant textures are deterministic cutouts with visible colored pixels", () => {
	for (const name of ["red_flower", "yellow_flower", "short_grass"]) {
		const pixels = paintTexture(name);
		assert.deepEqual(pixels, paintTexture(name));
		const alpha = [...pixels].filter((_, i) => i % 4 === 3);
		assert.ok(alpha.includes(0) && alpha.includes(255));
	}
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
	// Two adjacent leaves contribute ten cutout faces; their shared faces are absent.
	for (const [x, block] of [[2, 1], [5, 11], [8, 13], [11, 12], [12, 12]]) padded[index(x, 3, 3)] = block;
	const ptr = x.mc_alloc(padded.byteLength);
	try {
		new Uint16Array(x.memory.buffer, ptr, padded.length).set(padded);
		assert.equal(x.mesh_padded(ptr, padded.length, 0, 0), 28);
		const words = new Uint32Array(x.memory.buffer, x.client_mesh_ptr(), 28 * 8).slice();
		const counts = [0, 1, 2].map(i => x.client_mesh_count(i));
		assert.deepEqual(counts, [6, 16, 6]);
		assert.deepEqual(splitMeshLayers(words, counts).map(v => v[1] & 4095), [0, 12, 14]);
		// Main-thread world meshing uses the identical counts ABI, even when empty.
		const core = new ClientCore(new WebAssembly.Instance(module, {}));
		assert.equal(core.mesh(0, 0, 0).length, 0);
		assert.deepEqual(core.meshCounts(), [0, 0, 0]);
	} finally { x.mc_free(ptr, padded.byteLength); }
});

test("WASM water height seam emits one narrow quad with a displaced sorting center", () => {
	const module = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const x = new WebAssembly.Instance(module, {}).exports;
	const padded = new Uint16Array(18 ** 3);
	const index = (x, y, z) => ((y + 1) * 18 + z + 1) * 18 + x + 1;
	for (const [x, y, z] of [[5, 5, 5], [5, 6, 5], [6, 5, 5]]) padded[index(x, y, z)] = 13;
	const ptr = x.mc_alloc(padded.byteLength);
	try {
		new Uint16Array(x.memory.buffer, ptr, padded.length).set(padded);
		assert.equal(x.mesh_padded(ptr, padded.length, 0, 0), 15);
		assert.deepEqual([0, 1, 2].map(i => x.client_mesh_count(i)), [0, 0, 15]);
		const words = new Uint32Array(x.memory.buffer, x.client_mesh_ptr(), 15 * 8).slice();
		const strips = [];
		for (let q = 0; q < words.length; q += 8) {
			const vertices = [0, 2, 4, 6].map(v => words[q + v]);
			if (vertices.every(v => (v & 511) === 96 && ((v >>> 9) & 511) === 96 && ((v >>> 27) & 7) === 5)) strips.push(words.slice(q, q + 8));
		}
		assert.equal(strips.length, 1);
		const strip = strips[0];
		const center = quadCenters(strip);
		assert.equal(center[0], 6);
		assert.ok(Math.abs(center[1] - (6 - 1 / 18)) < 1e-6);
		assert.equal(center[2], 5.5);
		assert.equal([1, 3, 5, 7].filter(i => strip[i] >>> 31).length, 2);
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
	for (const name of ["glass", "oak_leaves", "red_flower", "yellow_flower", "short_grass"]) {
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


test("section visibility filters every layer before frustum tests and translucent sorting", () => {
    const meshes = new Map([["-1,4,2", { counts: [3,2,1] }], ["0,4,2", { counts: [1,0,2] }]]);
    assert.deepEqual(filterVisibleSections(meshes, new Set(["-1,4,2"])), [meshes.get("-1,4,2")]);
    assert.deepEqual(filterVisibleSections(meshes, new Set(["0,4,2", "missing", "-1,4,2"])), [...meshes.values()]);
    assert.deepEqual(filterVisibleSections(meshes, new Set()), []);
    assert.deepEqual(filterVisibleSections(meshes, null), [...meshes.values()]);
});

test("four original ore textures are opaque stone with distinct mineral grains", () => {
	const names = ["coal_ore", "copper_ore", "iron_ore", "gold_ore"];
	const textures = names.map(paintTexture);
	const plainStone = paintTexture("stone");
	const unknown = paintTexture("unknown_ore");
	for (const [i, pixels] of textures.entries()) {
		assert.equal(pixels.length, 16 * 16 * 4);
		assert.deepEqual(pixels, paintTexture(names[i]));
		assert.notDeepEqual(pixels, unknown);
		let stone = 0, mineral = 0;
		for (let p = 0; p < pixels.length; p += 4) {
			assert.equal(pixels[p + 3], 255);
			if (pixels[p] === plainStone[p] && pixels[p + 1] === plainStone[p + 1] && pixels[p + 2] === plainStone[p + 2]) stone++;
			else mineral++;
		}
		assert.ok(stone > 128 && mineral > 0, names[i]);
		for (let j = 0; j < i; j++) assert.notDeepEqual(pixels, textures[j]);
	}
});


test("tool sprites preserve their grip shapes and distinct colors for each material", () => {
	const core = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {}));
	const tools = core.itemRegistry().filter(item => /^(wooden|stone|copper|iron)_(pickaxe|axe|shovel|hoe)$/.test(item.name));
	assert.ok(tools.every(item => item.block === null && item.maxStack === 1));
	assert.equal(tools.length, 16);
	for (const kind of ["pickaxe", "axe", "shovel", "hoe"]) {
		const images = ["wooden", "stone", "copper", "iron"].map(tier => {
			const name = `${tier}_${kind}`;
			const item = tools.find(item => item.name === name)!;
			assert.equal(item.texture, name);
			assert.equal(item.maxStack, 1);
			assert.ok(core.textureNames().includes(name));
			const pixels = paintTexture(name);
			assert.equal(pixels.length, 16 * 16 * 4);
			const gripX = kind === "hoe" ? 8 : 2;
			assert.equal(pixels[(12 * 16 + gripX) * 4 + 3], 255, name);
			assert.ok(pixels.some((v, i) => i % 4 === 3 && v === 0));
			assert.ok(pixels.some((v, i) => i % 4 === 3 && v === 255));
			assert.deepEqual(paintTexture(name), pixels);
			return pixels;
		});
		for (let a = 0; a < images.length; a++) for (let b = a + 1; b < images.length; b++) assert.notDeepEqual(images[a], images[b]);
	}
});

test("registered item sprites and prepared mob drops resolve through the atlas painter", () => {
	const core = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {}));
	const keys = core.itemRegistry().flatMap(item => item.texture ? [item.texture] : []);
	const futureDrops = ["arrow", "bone", "gunpowder", "leather", "rotten_flesh"];
	for (const name of [...keys, ...futureDrops, "bow"]) {
		const pixels = itemTexture(name);
		assert.ok(pixels, name);
		assert.equal(pixels.length, 16 * 16 * 4);
		const alpha = pixels.filter((_, i) => i % 4 === 3);
		assert.deepEqual(new Set(alpha), new Set([0, 255]), name);
		assert.deepEqual(paintTexture(name), pixels, name);
	}
	assert.equal(itemTexture("unknown_item"), undefined);
});

test("dropped sprites keep cutout coverage while block drops retain their alpha test", async () => {
	const { dropAlphaTest, usesCutoutMips } = await import("./renderer.ts");
	const names = ["water", "stick", "apple", "grass_block_side", "iron_shovel", "crack_0"];
	assert.equal(dropAlphaTest(names), "(pixel.a <= 0.0 || (pixel.a < 0.5 && ((in.layer >= 1u && in.layer <= 2u) || (in.layer >= 4u && in.layer <= 4u))))");
	assert.equal(dropAlphaTest(["water", "crack_0"]), "pixel.a <= 0.0");
	assert.deepEqual(names.map(usesCutoutMips), [false, true, true, false, true, false]);
	let mip = paintTexture("stick");
	for (let size = 16; size > 2; size >>= 1) {
		const visible = mip.filter((v, i) => i % 4 === 3 && v >= 128).length;
		mip = downsample(mip, size, usesCutoutMips("stick"));
		assert.equal(mip.filter((v, i) => i % 4 === 3 && v >= 128).length, Math.round(visible / 4));
	}
	assert.ok(mip.some((v, i) => i % 4 === 3 && v < 128));
});
