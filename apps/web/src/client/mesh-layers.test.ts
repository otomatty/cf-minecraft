import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { quadCenters, sortedQuadIndices, sortSections, splitMeshLayers, updateTranslucentSort } from "./mesh-layers.ts";
import { missingTile, WATER_FRAME_COUNT, downsample, textureIconPixels } from "./textures.ts";
import { CARRIED_GRASS_TOP_TINT, CARRIED_GRASS_SIDE_TINT, CARRIED_SHORT_GRASS_TINT, CARRIED_LEAVES_TINT, WATER_TINT, type BlockItemTint } from "./block-tints.ts";
import { blockIconPixels, ICON_SIZE } from "./block-icon.ts";
import { iconTintChanged } from "./hotbar.ts";
import type { CellTint } from "./tint-map.ts";
import { ClientCore, gameTextureLayout } from "./client-core.ts";
import { filterVisibleSections, outlineBox, preparePackTextures, terrainShader, usesCutoutMips, CLOUD_HEIGHT, cloudsBeforeTranslucent, Renderer } from "./renderer.ts";
import { decodedFixturePack } from "../../test/texture-pack-fixture.mjs";

const fixture = await decodedFixturePack();
const coreLayout = gameTextureLayout(new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(
	readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {})));
const atlas = preparePackTextures(coreLayout.names, fixture);
const rendererTile = (name: string) => atlas.tiles[coreLayout.names.indexOf(name)];
const packTile = (name: string): Uint8Array => {
	const tile = fixture.tiles.get(name);
	assert.ok(tile, name);
	return tile;
};

test("fire and explosion cutouts write depth before translucent terrain can blend", async (t) => {
	const pipelines: GPURenderPipelineDescriptor[] = [];
	const uploads = new Map<object, Map<number, Uint8Array>>();
	const noop = () => {};
	const device = {
		lost: new Promise(() => {}), addEventListener: noop,
		createBuffer: noop, createSampler: noop, createBindGroupLayout: noop, createPipelineLayout: noop,
		createShaderModule: ({ code }: GPUShaderModuleDescriptor) => code,
		createTexture: () => ({ createView: () => ({}), destroy: noop }),
		createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => {
			pipelines.push(descriptor);
			return { getBindGroupLayout: noop };
		},
		createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor,
		queue: { writeBuffer: noop, writeTexture: ({ texture, origin }: GPUTexelCopyTextureInfo, pixels: Uint8Array) => {
			if (!Array.isArray(origin)) return;
			if (!uploads.has(texture)) uploads.set(texture, new Map());
			uploads.get(texture)!.set(origin[2], pixels);
		} },
	};
	const globals = {
		GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, VERTEX: 8, INDEX: 16 },
		GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2 },
		GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
	};
	Object.assign(globalThis, globals);
	Object.defineProperty(navigator, "gpu", { configurable: true, value: {
		getPreferredCanvasFormat: () => "rgba8unorm",
		requestAdapter: async () => ({ info: {}, requestDevice: async () => device }),
	} });
	t.after(() => {
		for (const name of Object.keys(globals)) Reflect.deleteProperty(globalThis, name);
		Reflect.deleteProperty(navigator, "gpu");
	});
	const renderer = await Renderer.create({ getContext: () => ({ configure: noop }) } as unknown as HTMLCanvasElement,
		coreLayout, null!);
	const effects = pipelines.find(pipeline => pipeline.fragment?.constants?.entityPass === 3)!;
	assert.equal(effects.fragment!.constants!.renderLayer, 1);
	assert.equal([...effects.fragment!.targets][0]!.blend, undefined);
	assert.equal(effects.depthStencil?.depthWriteEnabled, true);
	assert.match(String(effects.fragment!.module), /renderLayer == 1u.*pixel\.a < 0\.5.*discard/);
	const water = pipelines.find(pipeline => pipeline.fragment?.constants?.renderLayer === 2 && pipeline.vertex.entryPoint === "vs")!;
	assert.equal(water.depthStencil?.depthCompare, "less");
	assert.equal([...water.fragment!.targets][0]!.blend?.color.srcFactor, "src-alpha");
	const effectAtlas = [...uploads.values()].find(layers => layers.get(1) === missingTile);
	assert.ok(effectAtlas);
	assert.deepEqual(renderer["flame"], [1, 0]);
});

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
		const pixels = packTile(name);
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
	const stone = packTile("stone");
	assert.deepEqual([...textureIconPixels("stone", stone)], [...stone]);
});

test("block icon materials use the supplied grass or leaves RGB and preserve alpha", () => {
	const cell: BlockItemTint = { grass: [72, 170, 74], leaves: [53, 145, 71] };
	for (const [name, tint] of [["grass_block_top", cell.grass], ["short_grass", cell.grass],
		["oak_leaves", cell.leaves], ["oak_leaves_dense", cell.leaves]] as const) {
		const pixels = packTile(name);
		const original = pixels.slice();
		const icon = textureIconPixels(name, pixels, cell);
		for (let i = 0; i < pixels.length; i += 4) {
			assert.equal(icon[i + 3], pixels[i + 3]);
			for (let c = 0; c < 3; c++) assert.equal(icon[i + c], Math.round(pixels[i + c] * tint[c] / 255));
		}
		assert.deepEqual(pixels, original);
	}
	for (const name of ["stone", "water", "water_flow", "water_bucket"]) {
		const pixels = packTile(name);
		assert.deepEqual(textureIconPixels(name, pixels, cell), textureIconPixels(name, pixels));
	}
});

test("grass block side icons recolor the fringe and keep the dirt pixels", () => {
	const cell: BlockItemTint = { grass: [72, 170, 74], leaves: [53, 145, 71] };
	const packed = packTile("grass_block_side");
	const dirt = packTile("dirt");
	const side = textureIconPixels("grass_block_side", packTile("grass_block_side"), cell);
	for (let i = 0; i < side.length; i += 4) {
		assert.equal(side[i + 3], 255);
		for (let c = 0; c < 3; c++) {
			assert.equal(side[i + c], packed[i + c] + Math.round(packed[i + 3] * cell.grass[c] / 255));
			if (packed[i + 3] === 0) assert.equal(side[i + c], dirt[i + c]);
		}
	}
	const core = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {}));
	const block = core.blockRegistry().find(block => block.name === "grass_block")!;
	const atlas = new Map(block.faces.map(name => [name, packTile(name)]));
	const carried = blockIconPixels(block, atlas);
	const tinted = blockIconPixels(block, atlas, cell);
	const pixel = (image: Uint8ClampedArray, y: number) => image.subarray((y * ICON_SIZE + 20) * 4, (y * ICON_SIZE + 21) * 4);
	assert.notDeepEqual(pixel(tinted, 19), pixel(carried, 19));
	assert.equal(pixel(tinted, 32)[3], 255);
	assert.deepEqual(pixel(tinted, 32), pixel(carried, 32));
});

test("icons repaint for RGB changes and transitions to or from the fallback", () => {
	const previous: CellTint = { grass: [72, 170, 74], leaves: [53, 145, 71], biome: 1, water: [1, 2, 3] };
	const next: CellTint = { grass: [72, 170, 74], leaves: [53, 145, 71], biome: 2, water: [0, 0, 0] };
	assert.equal(iconTintChanged(previous, next), false);
	assert.equal(iconTintChanged(previous, { ...next, grass: [124, 184, 84] }), true);
	assert.equal(iconTintChanged(previous, { ...next, leaves: [54, 145, 71] }), true);
	assert.equal(iconTintChanged(null, previous), true);
	assert.equal(iconTintChanged(previous, null), true);
	assert.equal(iconTintChanged(null, null), false);
});

test("drop shader decodes marked colors and keeps the grass side opaque", () => {
	for (const names of [["water_bucket", "grass_block_side", "oak_leaves"], ["grass_block_side", "water_bucket"], ["stone"]]) {
		const shader = terrainShader({ names, spriteStart: names.length });
		assert.match(shader, /fn vsDrop\(.*@location\(5\) tint: f32\)/);
		assert.match(shader, /if \(tint > 0\.0 && out\.layer == u32\(layer\)\) \{\s+out\.tintColor = unpack4x8unorm\(u32\(tint\) - 1u\)\.rgb;/);
		assert.match(shader, new RegExp(`in.layer == ${names.indexOf("grass_block_side") >>> 0}u`));
		assert.ok(shader.includes("color += pixel.a * in.tintColor"));
		assert.ok(shader.includes("!(entityPass == 1u && grassSide)"));
		assert.doesNotMatch(shader, /__[A-Z_]+__/);
	}
});

test("terrain tint layers follow texture names when the texture array is reordered", () => {
	for (const names of [["water", "grass_block_side", "oak_leaves", "water_flow"], ["water_flow", "oak_leaves", "water", "grass_block_side"]]) {
		const shader = terrainShader({ names, spriteStart: names.length });
		assert.ok(shader.includes(`if (out.layer == ${names.indexOf("oak_leaves")}u) { tintLayer =`));
		assert.ok(shader.includes(`if (out.layer == ${names.indexOf("water")}u || out.layer == ${names.indexOf("water_flow")}u)`));
		assert.ok(shader.includes(`if (in.layer == ${names.indexOf("grass_block_side")}u)`));
		assert.ok(!shader.includes("__LEAVES_LAYER__") && !shader.includes("__WATER_LAYER__"));
	}
	const shader = terrainShader({ names: ["water", "oak_leaves"], spriteStart: 2 });
	const vertex = shader.slice(shader.indexOf("@vertex"), shader.indexOf("override renderLayer"));
	assert.equal(vertex.match(/textureSampleLevel\(tintTex/g)?.length, 4);
	assert.ok(vertex.includes("origins[section].xz & vec2<i32>(1023)"));
	assert.ok(vertex.includes("out.tintColor = vec3<f32>(1.0)"));
	assert.ok(shader.includes("@location(4) @interpolate(perspective, center) tintColor: vec3<f32>"));
	assert.ok(shader.includes("color = color * in.tintColor"));
	assert.ok(!shader.includes("g.grassTint"));
	const absent = terrainShader({ names: ["stone"], spriteStart: 1 });
	assert.ok(absent.includes("if (out.layer == 4294967295u || out.layer == 4294967295u)"));
	assert.ok(absent.includes("if (false) { tintLayer = 1; }"));
	assert.doesNotMatch(absent, /__[A-Z_]+__/);
});

test("dense and regular leaves share terrain tint and cap rotation", () => {
	for (const [names, predicate] of [
		[["oak_leaves", "water", "oak_leaves_dense"], "out.layer == 0u || out.layer == 2u"],
		[["water", "oak_leaves_dense", "stone", "oak_leaves"], "out.layer == 1u || out.layer == 3u"],
	]) {
		const shader = terrainShader({ names, spriteStart: names.length });
		assert.ok(shader.includes(`if (${predicate}) { tintLayer = 1; }`));
		assert.ok(shader.includes(`face <= 1u && (${predicate})`));
		assert.doesNotMatch(shader, /__LEAVES_LAYERS__/);
	}
});

test("grass side keeps soil colour and reproduces the tinted fringe through all mip levels", () => {
	let packed = packTile("grass_block_side");
	let icon = textureIconPixels("grass_block_side", packed);
	const dirt = packTile("dirt");
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

test("water repeats each pack animation independently for its surface and sides", () => {
	assert.equal(WATER_FRAME_COUNT, 32);
	const names = ["water", "water_flow"];
	const { water } = preparePackTextures(names, fixture);
	assert.equal(water.length, 2 * WATER_FRAME_COUNT);
	for (const [i, name] of names.entries()) {
		const frames = fixture.waterFrames.get(name)!;
		assert.equal(frames.length, 3);
		assert.equal(water[i * WATER_FRAME_COUNT], packTile(name));
		assert.equal(new Set(frames.map(pixels => Buffer.from(pixels).toString("base64"))).size, 3);
		for (let frame = 0; frame < WATER_FRAME_COUNT; frame++) {
			const pixels = water[i * WATER_FRAME_COUNT + frame];
			assert.equal(pixels, frames[frame % 3]);
			assert.equal(pixels.length, 16 * 16 * 4);
			assert.equal(pixels[3], i ? 166 : 156);
		}
	}
	assert.notDeepEqual(water[0], water[WATER_FRAME_COUNT]);
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
		const pixels = packTile(name);
		assert.equal(rendererTile(name), pixels, name);
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

test("pack glass and leaf textures contain holes; water stays grayscale and translucent", () => {
	for (const name of ["glass", "oak_leaves"]) {
		const pixels = packTile(name);
		const alpha = [...pixels].filter((_, i) => i % 4 === 3);
		assert.ok(alpha.includes(0) && alpha.includes(255));
		assert.equal(rendererTile(name), pixels, name);
	}
	for (const name of ["oak_leaves", "water"]) {
		const pixels = packTile(name);
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
		let pixels = packTile(name);
		for (let size = 16; size > 1; size >>= 1) {
			const expected = coverage(pixels);
			pixels = downsample(pixels, size, true);
			assert.ok(Math.abs(coverage(pixels) - expected) <= 0.5 / (pixels.length / 4));
		}
	}
	// Non-cutout averaging keeps water's continuous opacity.
	assert.equal(downsample(new Uint8Array([255, 255, 255, 170, 255, 255, 255, 170, 255, 255, 255, 170, 255, 255, 255, 170]), 2)[3], 170);
});

test("dense leaves fill only the original holes with a darker opaque gray", () => {
	const regular = packTile("oak_leaves");
	let dense = packTile("oak_leaves_dense");
	assert.equal(dense.length, 16 * 16 * 4);
	const darkest = Math.min(...regular.filter((_, i) => i % 4 === 0 && regular[i + 3] === 255));
	for (let i = 0; i < dense.length; i += 4) {
		assert.equal(dense[i + 3], 255);
		if (regular[i + 3] === 255) {
			assert.deepEqual(dense.subarray(i, i + 4), regular.subarray(i, i + 4));
		} else {
			assert.equal(dense[i], dense[i + 1]);
			assert.equal(dense[i], dense[i + 2]);
			assert.ok(dense[i] < darkest);
		}
	}
	assert.ok(usesCutoutMips({ names: ["oak_leaves_dense"], spriteStart: 1 }, 0));
	for (let size = 16; size > 1; size >>= 1) {
		dense = downsample(dense, size, true);
		assert.ok(dense.every((v, i) => i % 4 !== 3 || v === 255));
	}
});


test("section visibility filters every layer before frustum tests and translucent sorting", () => {
    const meshes = new Map([["-1,4,2", { counts: [3,2,1] }], ["0,4,2", { counts: [1,0,2] }]]);
    assert.deepEqual(filterVisibleSections(meshes, new Set(["-1,4,2"])), [meshes.get("-1,4,2")]);
    assert.deepEqual(filterVisibleSections(meshes, new Set(["0,4,2", "missing", "-1,4,2"])), [...meshes.values()]);
    assert.deepEqual(filterVisibleSections(meshes, new Set()), []);
    assert.deepEqual(filterVisibleSections(meshes, null), [...meshes.values()]);
});

test("four pack ore textures are opaque stone with distinct mineral grains", () => {
	const names = ["coal_ore", "copper_ore", "iron_ore", "gold_ore"];
	const textures = names.map(packTile);
	const plainStone = packTile("stone");
	const unknown = missingTile;
	for (const [i, pixels] of textures.entries()) {
		assert.equal(pixels.length, 16 * 16 * 4);
		assert.equal(rendererTile(names[i]), pixels);
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

function texels(pixels: Uint8Array): Uint8Array[] {
	return Array.from({ length: pixels.length / 4 }, (_, i) => pixels.subarray(i * 4, i * 4 + 4));
}

function luminance([r, g, b]: Uint8Array): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("opaque pack tiles retain their colour variation", () => {
	const names = [
		"crafting_table_top", "crafting_table_side", "crafting_table_bottom",
		"furnace_front", "furnace_side", "furnace_top",
		"farmland_dry", "farmland_moist", "oak_log_top", "white_wool",
	];
	const missing = missingTile;
	for (const name of names) {
		const pixels = packTile(name);
		assert.equal(pixels.length, 16 * 16 * 4, name);
		assert.equal(rendererTile(name), pixels, name);
		assert.notDeepEqual(pixels, missing, name);
		const colors = texels(pixels);
		assert.ok(colors.every(([, , , a]) => a === 255), name);
		assert.ok(new Set(colors.map(([r, g, b]) => r << 16 | g << 8 | b)).size >= 5, name);
	}
});

test("colored wool tiles share the white wool tuft pattern and shears have a hand-drawn icon", () => {
	const white = texels(packTile("white_wool")).map(luminance);
	const ranks = (values: number[]) => {
		const shades = [...new Set(values)].sort((a, b) => a - b);
		return values.map(value => shades.indexOf(value));
	};
	for (const name of ["gray_wool", "brown_wool", "black_wool"]) {
		const pixels = packTile(name);
		const colors = texels(pixels);
		assert.ok(colors.every(([, , , alpha]) => alpha === 255), name);
		assert.notDeepEqual(pixels, packTile("white_wool"), name);
		assert.deepEqual(ranks(colors.map(luminance)), ranks(white), name);
	}
	const shears = packTile("shears");
	assert.ok(shears);
	const colors = texels(shears);
	assert.equal(colors.length, 256);
	assert.ok(colors.some(([, , , alpha]) => alpha === 0));
	assert.ok(new Set(colors.filter(([, , , alpha]) => alpha === 255).map(pixel => pixel.join(","))).size >= 5);
});

test("table and furnace faces are distinct and show their tools and firebox", () => {
	for (const names of [
		["crafting_table_top", "crafting_table_side", "crafting_table_bottom"],
		["furnace_front", "furnace_side", "furnace_top"],
	]) {
		const faces = names.map(packTile);
		for (const [i, pixels] of faces.entries()) {
			for (let j = 0; j < i; j++) assert.notDeepEqual(pixels, faces[j], `${names[i]} vs ${names[j]}`);
		}
	}
	for (const name of ["crafting_table_top", "crafting_table_side"]) {
		const gray = texels(packTile(name)).filter(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 10);
		assert.ok(gray.length >= 8, name);
	}
	const front = texels(packTile("furnace_front"));
	const firebox = front.filter((_, i) => i % 16 >= 4 && i % 16 <= 11 && i >= 6 * 16 && i < 13 * 16);
	assert.ok(firebox.filter(pixel => luminance(pixel) < 45).length >= 12);
	assert.ok(firebox.some(([r, g, b]) => r >= 170 && r - g >= 40 && g - b >= 30));
});

test("moist furrows are darker than dry furrows", () => {
	const averageLuminance = (name: string) => {
		const pixels = texels(packTile(name));
		return pixels.reduce((sum, pixel) => sum + luminance(pixel), 0) / pixels.length;
	};
	assert.ok(averageLuminance("farmland_moist") < averageLuminance("farmland_dry"));
});

test("wheat cutouts grow denser, keep four grounded stems and ripen gold", () => {
	const missing = missingTile;
	let previousCoverage = 0;
	for (const name of ["wheat_sprout", "wheat_shoot", "wheat_green", "wheat_ripe"]) {
		const pixels = packTile(name);
		assert.equal(pixels.length, 16 * 16 * 4, name);
		assert.equal(rendererTile(name), pixels, name);
		assert.notDeepEqual(pixels, missing, name);
		const colors = texels(pixels);
		assert.deepEqual(new Set(colors.map(([, , , a]) => a)), new Set([0, 255]), name);
		const coverage = colors.filter(([, , , a]) => a === 255).length;
		assert.ok(coverage > previousCoverage, name);
		previousCoverage = coverage;
		const bottom = colors.slice(-16);
		assert.equal(bottom.filter(([, , , a], x) => a === 255 && !bottom[x - 1]?.[3]).length, 4, name);
		if (name === "wheat_ripe") {
			assert.ok(colors.some(([r, g, b, a]) => a === 255 && r >= 200 && g >= 150 && g - b >= 50));
		}
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
			const pixels = packTile(name);
			assert.equal(pixels.length, 16 * 16 * 4);
			const gripX = kind === "hoe" ? 8 : 2;
			assert.equal(pixels[(12 * 16 + gripX) * 4 + 3], 255, name);
			assert.ok(pixels.some((v, i) => i % 4 === 3 && v === 0));
			assert.ok(pixels.some((v, i) => i % 4 === 3 && v === 255));
			assert.equal(rendererTile(name), pixels, name);
			return pixels;
		});
		for (let a = 0; a < images.length; a++) for (let b = a + 1; b < images.length; b++) assert.notDeepEqual(images[a], images[b]);
	}
});

test("registry sprite layers resolve pack art for inventory, drops and held items", () => {
	const core = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {}));
	const keys = core.itemRegistry().flatMap(item => item.texture ? [item.texture] : []);
	const layout = gameTextureLayout(core);
	assert.deepEqual(layout.names.slice(layout.spriteStart), [...new Set([...keys, "bow"])]);
	const blockLayers = new Set(layout.names.slice(0, layout.spriteStart));
	for (const block of core.blockRegistry().filter(block => block.name !== "air")) {
		for (const name of block.faces) assert.ok(blockLayers.has(name), name);
	}
	const prepared = preparePackTextures(layout.names, fixture);
	const futureDrops = ["arrow", "bone", "gunpowder", "rotten_flesh"];
	for (const name of [...keys, ...futureDrops, "bow"]) {
		const pixels = packTile(name);
		assert.ok(pixels, name);
		assert.equal(pixels.length, 16 * 16 * 4);
		const alpha = pixels.filter((_, i) => i % 4 === 3);
		assert.deepEqual(new Set(alpha), new Set([0, 255]), name);
		const layer = layout.names.indexOf(name);
		assert.ok(layer >= layout.spriteStart, name);
		assert.ok(usesCutoutMips(layout, layer), name);
		assert.equal(prepared.tiles[layer], pixels, name);
	}
	assert.equal(fixture.tiles.get("unknown_item"), undefined);
});

test("dropped sprites keep cutout coverage while block drops retain their alpha test", async () => {
	const { dropAlphaTest } = await import("./renderer.ts");
	const names = ["water", "grass_block_side", "stick", "apple", "iron_shovel", "bow", "future_sprite"];
	const layout = { names, spriteStart: 2 };
	assert.equal(dropAlphaTest(layout), "(pixel.a <= 0.0 || (pixel.a < 0.5 && in.layer >= 2u && in.layer < 7u))");
	assert.equal(dropAlphaTest({ names: ["water"], spriteStart: 1 }), "pixel.a <= 0.0");
	assert.deepEqual(names.map((_, layer) => usesCutoutMips(layout, layer)), [false, false, true, true, true, true, true]);
	assert.equal(usesCutoutMips(layout, names.length), false, "the crack layers follow the sprites");
	let mip = packTile("stick");
	for (let size = 16; size > 2; size >>= 1) {
		const visible = mip.filter((v, i) => i % 4 === 3 && v >= 128).length;
		mip = downsample(mip, size, usesCutoutMips(layout, names.indexOf("stick")));
		assert.equal(mip.filter((v, i) => i % 4 === 3 && v >= 128).length, Math.round(visible / 4));
	}
	assert.ok(mip.some((v, i) => i % 4 === 3 && v < 128));
});
