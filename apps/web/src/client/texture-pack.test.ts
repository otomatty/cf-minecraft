import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { appleRGB, fixtureArtEntries, fixtureArtRGB, fixturePack, packEntries, solidPng, testEntries, zipBytes } from "../../test/texture-pack-fixture.mjs";
import { crackPaths, importTexturePack, isPackVersion, moonSheetOrder, packArtDimensions, pngTileWidth } from "./texture-pack.ts";
import { installedPack } from "./texture-pack-settings.ts";
import { ClientCore, gameTextureNames } from "./client-core.ts";
import { textureIconPixels } from "./textures.ts";

const file = async (entries = testEntries, name = "local.zip") => new File([await zipBytes(entries)], name);
const versioned = (entries, prefix = "") => [
	...packEntries({ prefix }).filter(([path]) => !entries.some(([entry]) => path === prefix + "resource_pack/" + entry)),
	...entries.map(([path, data]) => [prefix + "resource_pack/" + path, data]),
];
const tile = new Uint8Array(1024);
const load = (pack: File, names = ["stone", "apple", "dirt"]) => importTexturePack(pack, names, undefined, async (_, width) => {
	assert.equal(width, 1);
	return tile;
});

test("wrapped pack, JSON comments, path objects and partial fallback", async () => {
	const pack = await load(await file([...testEntries, ["sample/scripts/init.js", "throw 1"]]));
	assert.deepEqual([...pack.tiles.keys()], ["stone", "apple"]);
	assert.equal(pack.tiles.get("apple"), tile);
	assert.equal(pack.version, "1.26.60");
});
test("item variants, including material-specific indices and safe local references", async () => {
	const json = { texture_data: { pickaxe: { textures: ["textures/items/wood", "textures/items/stone", "textures/items/test"] },
		apple: { textures: "https://example.invalid/image" }, stick: { textures: "textures/items/../payload" } } };
	const pack = await load(await file(versioned([["textures/item_texture.json", JSON.stringify(json)],
		["textures/items/test.png", solidPng([5, 10, 15])], ["textures/items/apple.png", solidPng([0, 1, 2])]])),
		["stone_pickaxe", "iron_pickaxe", "apple", "stick"]);
	assert.deepEqual([...pack.tiles.keys()], ["iron_pickaxe"]);
});
test("invalid JSON, PNG, ambiguous roots and unsupported packs fail atomically", async () => {
	for (const entries of [
		testEntries.map(([path, data]) => [path, path.endsWith("item_texture.json") ? "{" : data]),
		[...testEntries, ["sample/resource_pack/textures/blocks/dirt.png", "not PNG"]],
		[...testEntries, ...packEntries({ prefix: "other/" })],
		[["textures/entity/mob.png", solidPng([0, 0, 0])]],
	]) await assert.rejects(load(await file(entries)));
});
test("rejects traversal, excessive inflated entry sizes and image dimensions before decoding", async () => {
	const bytes = Buffer.from(await zipBytes([["aa/textures/items/apple.png", solidPng([0, 0, 0])], ...testEntries]));
	const unsafe = Buffer.from(bytes.toString("latin1").replaceAll("aa/textures", "../textures"), "latin1");
	await assert.rejects(load(new File([unsafe], "bad.zip")));
	const oversized = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
	bytes.writeUInt32LE(513 * 1024 ** 2, oversized + 24);
	await assert.rejects(load(new File([bytes], "huge.zip")), /展開サイズが上限/);
	const png = solidPng([0, 0, 0]);
	png.writeUInt32BE(65536, 16);
	assert.throws(() => pngTileWidth(png), /寸法/);
});

test("file limit precedes archive reads, and encrypted or oversized images never decode", async () => {
	const large = new File([], "large.zip");
	Object.defineProperty(large, "size", { value: 256 * 1024 ** 2 + 1 });
	await assert.rejects(load(large), /256 MiB/);
	const bytes = Buffer.from(await zipBytes([["resource_pack/textures/items/apple.png", solidPng([1, 2, 3])], ...packEntries()]));
	const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
	for (const encrypted of [false, true]) {
		const bad = Buffer.from(bytes);
		if (encrypted) {
			bad.writeUInt16LE(bad.readUInt16LE(central + 8) | 1, central + 8);
		} else {
			bad.writeUInt32LE(5 * 1024 ** 2, central + 24);
		}
		let decoded = false;
		await assert.rejects(importTexturePack(new File([bad], "invalid.zip"), ["apple"], undefined, async () => {
			decoded = true;
			return tile;
		}));
		assert.equal(decoded, false);
	}
});

test("current Bedrock face keys take priority over legacy keys and filenames", async () => {
	const faces = {
		stone: "flattened_stone", dirt: "flattened_dirt", sand: "flattened_sand",
		sandstone: "flattened_sandstone", sandstone_top: "flattened_sandstone_top",
		sandstone_bottom: "flattened_sandstone_bottom", white_wool: "wool_colored_white", furnace_front: "furnace_front_off",
	};
	const texture_data = Object.fromEntries(Object.values(faces).map(key => [key, { textures: "textures/blocks/renamed" }]));
	texture_data.stone = { textures: "textures/blocks/legacy" };
	const pack = await load(await file(versioned([["textures/terrain_texture.json", JSON.stringify({ texture_data })],
		["textures/blocks/renamed.png", solidPng([1, 2, 3])]])), Object.keys(faces));
	assert.deepEqual([...pack.tiles.keys()], Object.keys(faces));
});

test("Finder metadata is ignored while a referenced dotted path stays inside the pack", async () => {
	const atlas = { texture_data: { stone: { textures: "textures/blocks/pack.v2/stone.v2.png" },
		dirt: { textures: "textures/blocks/../blocks/pack.v2/stone.v2" } } };
	const pack = await load(await file(versioned([
		["textures/terrain_texture.json", JSON.stringify(atlas)],
		["textures/blocks/pack.v2/stone.v2.png", solidPng([1, 2, 3])],
	], "pack/").concat([["__MACOSX/pack/resource_pack/textures/blocks/._stone.v2.png", "metadata"]])));
	assert.deepEqual([...pack.tiles.keys()], ["stone"]);
});

test("torch inventory and drop sprite shares the block tile unless the pack supplies an item sprite", async () => {
	const entries = [["textures/blocks/torch_on.png", solidPng([1, 2, 3])]];
	const names = ["torch", "torch_item"];
	const decode = async () => new Uint8Array(1024);
	const block = await importTexturePack(await file(versioned(entries)), names, undefined, decode);
	assert.ok(block.tiles.has("torch"));
	assert.equal(block.tiles.get("torch_item"), block.tiles.get("torch"));
	assert.deepEqual([...(await load(await file(versioned(entries)), ["torch_item"])).tiles.keys()], ["torch_item"]);
	const both = await importTexturePack(await file(versioned([...entries, ["textures/items/torch.png", solidPng([6, 7, 8])]])), names, undefined, decode);
	assert.ok(both.tiles.has("torch_item"));
	assert.notEqual(both.tiles.get("torch_item"), both.tiles.get("torch"));
});

test("many references to one unsupported image consume its extraction budget only once", async () => {
	// A non-square image that is not a vertical strip is skipped before decoding.
	const wide = solidPng([1, 2, 3], { width: 2, description: "x".repeat(3_800_000) });
	const names = ["stone", "dirt", "sand", "gravel", "obsidian", "ice", "bedrock", "glass", "coal_ore"];
	const texture_data = Object.fromEntries(names.map(name => [name, { textures: "textures/blocks/wide" }]));
	const pack = await load(await file(versioned([["textures/terrain_texture.json", JSON.stringify({ texture_data })],
		["textures/blocks/wide.png", wide], ["textures/items/apple.png", solidPng([4, 5, 6])]])), [...names, "apple"]);
	assert.deepEqual([...pack.tiles.keys()], ["apple"]);
});

test("official manifest, engine version, extension and common prefix are required", async () => {
	for (const entries of [
		packEntries({ uuid: "other" }),
		...[null, "1.2.3", [1, 2], [1, 2, 3, 4], [-1, 2, 3], [1, 2.5, 3], [1, 2, "3"]].map(engine => packEntries({ engine })),
		packEntries().map(([path, data]) => [path, path.endsWith("manifest.json")
			? JSON.stringify({ header: { uuid: JSON.parse(data).header.uuid } }) : data]),
		...packEntries().map(([missing]) => packEntries().filter(([path]) => path !== missing)),
		packEntries({ prefix: "first/second/" }),
		packEntries().map(([path, data]) => [path.endsWith("manifest.json") ? "different/" + path : path, data]),
	]) await assert.rejects(load(await file(entries)), /公式の Bedrock Samples の ZIP ではありません/);
	await assert.rejects(load(await file(testEntries, "local.mcpack")), /公式の Bedrock Samples/);
	await assert.rejects(load(await file(packEntries())), /ブロックとアイテムの画像が入っていません/);
});

test("a matching release filename supplies the version and preserves preview", async () => {
	for (const [filename, expected] of [
		["bedrock-samples-v1.26.60.5-full.zip", "1.26.60.5"],
		["BEDROCK-SAMPLES-V1.26.60.26-PREVIEW-FULL.ZIP", "1.26.60.26-preview"],
		["bedrock-samples-v1.26.60-preview-full.zip", "1.26.60-preview"],
		["bedrock-samples-v1.26.70.26-preview-full.zip", "1.26.60"],
		["bedrock-samples-v1.26.60.5-extra-full.zip", "1.26.60"],
		["renamed.zip", "1.26.60"],
	]) {
		assert.equal((await load(await file(testEntries, filename))).version, expected);
		assert.ok(isPackVersion(expected));
	}
});

test("manifest and both atlases use the same bounded read", async () => {
	for (const name of ["manifest.json", "terrain_texture.json", "item_texture.json"]) {
		const entries = testEntries.map(([path, data]) =>
			[path, path.endsWith(name) ? data + " ".repeat(2 * 1024 ** 2) : data]);
		await assert.rejects(load(await file(entries)), /サイズまたは圧縮形式/);
	}
});

test("wool bindings use the current Bedrock filenames", async () => {
	const colors = ["gray", "brown", "black"];
	const entries = colors.map(color => ["textures/blocks/wool_colored_" + color + ".png", solidPng([1, 2, 3])]);
	const names = colors.map(color => color + "_wool");
	assert.deepEqual([...(await load(await file(versioned(entries)), names)).tiles.keys()], names);
});

test("progress counts unique selected PNG files", async () => {
	const progress: number[][] = [];
	await importTexturePack(await file(), ["stone", "grass_block_side", "apple"], (done, total) => progress.push([done, total]), async () => tile);
	assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
});

function tga(width: number, height: number, top: boolean, body: number[], type = 2): Buffer {
	const header = Buffer.alloc(18);
	header[2] = type;
	header.writeUInt16LE(width, 12);
	header.writeUInt16LE(height, 14);
	header[16] = 32;
	header[17] = top ? 0x28 : 0x08;
	return Buffer.concat([header, Buffer.from(body)]);
}

const pixel = (tile: Uint8Array, x: number, y: number) => Array.from(tile.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));

test("TGA pixels decode in atlas order with both vertical origins and RLE packet types", async () => {
	const top = [3, 2, 1, 255, 3, 2, 1, 255], bottom = [9, 8, 7, 0, 6, 5, 4, 255];
	for (const image of [
		tga(2, 2, false, [...bottom, ...top]),
		tga(2, 2, true, [...top, ...bottom]),
		tga(2, 2, true, [0x81, ...top.slice(0, 4), 1, ...bottom], 10),
		tga(2, 2, false, [1, ...bottom, 0x81, ...top.slice(0, 4)], 10),
	]) {
		const { tiles } = await load(await file(versioned([["textures/blocks/leaves_oak.tga", image]])), ["oak_leaves"]);
		const leaves = tiles.get("oak_leaves")!;
		assert.deepEqual(pixel(leaves, 15, 0), [1, 2, 3, 255]);
		assert.deepEqual(pixel(leaves, 7, 8), [7, 8, 9, 0]);
		assert.deepEqual(pixel(leaves, 8, 15), [4, 5, 6, 255]);
	}
	const strip = tga(1, 2, true, [3, 2, 1, 255, 6, 5, 4, 255]);
	const { tiles } = await load(await file(versioned([["textures/items/apple.tga", strip]])), ["apple"]);
	assert.deepEqual(pixel(tiles.get("apple")!, 15, 15), [1, 2, 3, 255]);
});

test("unsupported or malformed TGAs are skipped and a matching PNG takes priority", async () => {
	const image = tga(1, 1, true, [1, 2, 3, 255]);
	for (const [offset, value] of [[1, 1], [2, 3], [16, 24], [17, 0x38], [13, 3], [2, 10]]) {
		const bad = Buffer.from(image);
		bad[offset] = value;
		const pack = await load(await file(versioned([
			["textures/blocks/leaves_oak.tga", bad], ["textures/items/apple.png", solidPng(appleRGB)],
		])), ["oak_leaves", "apple"]);
		assert.deepEqual([...pack.tiles.keys()], ["apple"]);
	}
	const terrain = { texture_data: { oak_leaves: { textures: "textures/blocks/leaves_oak.tga" } } };
	const pack = await load(await file(versioned([
		["textures/terrain_texture.json", JSON.stringify(terrain)],
		["textures/blocks/leaves_oak.tga", image], ["textures/blocks/leaves_oak.png", solidPng([4, 5, 6])],
	])), ["oak_leaves"]);
	assert.equal(pack.tiles.get("oak_leaves"), tile);
});

test("grass side uses pack soil and a tint mask and requires both images", async () => {
	const entries = [
		["textures/blocks/grass_side.tga", tga(2, 2, true, [200, 200, 200, 255, 20, 20, 20, 0, 200, 200, 200, 255, 20, 20, 20, 0])],
		["textures/blocks/dirt.png", solidPng([1, 2, 3])],
		["textures/items/apple.png", solidPng(appleRGB)],
	];
	const soil = new Uint8Array(1024);
	for (let i = 0; i < soil.length; i += 4) soil.set([1, 2, 3, 255], i);
	const pack = await importTexturePack(await file(versioned(entries)), ["grass_block_side"], undefined, async () => soil);
	assert.deepEqual([...pack.tiles.keys()], ["grass_block_side"]);
	const side = pack.tiles.get("grass_block_side")!;
	assert.deepEqual(pixel(side, 0, 0), [0, 0, 0, 200]);
	assert.deepEqual(pixel(side, 15, 0), [1, 2, 3, 0]);
	const icon = textureIconPixels("grass_block_side", side, { grass: [64, 128, 192], leaves: [0, 0, 0] });
	assert.deepEqual(Array.from(icon.subarray(0, 4)), [50, 100, 151, 255]);
	assert.deepEqual(Array.from(icon.subarray(60, 64)), [1, 2, 3, 255]);
	assert.deepEqual(pixel(soil, 0, 0), [1, 2, 3, 255]);
	for (const missing of [0, 1]) {
		const incomplete = await load(await file(versioned(entries.filter((_, i) => i !== missing))), ["grass_block_side", "apple"]);
		assert.deepEqual([...incomplete.tiles.keys()], ["apple"]);
	}
});

test("water decodes each square frame up to 32 and uses fixed alpha", async () => {
	const names = ["water", "water_flow", "stone"];
	const reads: number[][] = [];
	const pack = await importTexturePack(await file(versioned([
		["textures/blocks/water_still_grey.png", solidPng([1, 2, 3], { width: 16, height: 48 })],
		["textures/blocks/water_flow_grey.png", solidPng([1, 2, 3], { width: 32, height: 32 * 33 })],
		["textures/blocks/stone.png", solidPng([1, 2, 3], { width: 2, height: 4 })],
	])), names, undefined, async (_, width, frame) => {
		reads.push([width, frame]);
		return Uint8Array.from({ length: 1024 }, (_, i) => i % 4 === 3 ? 240 : 100 + frame);
	});
	assert.deepEqual(reads, [[16, 0], [16, 1], [16, 2], ...Array.from({ length: 32 }, (_, i) => [32, i]), [2, 0]]);
	for (const [name, alpha, count] of [["water", 156, 3], ["water_flow", 166, 32]] as const) {
		const frames = pack.waterFrames.get(name)!;
		assert.equal(frames.length, count);
		assert.equal(frames[0], pack.tiles.get(name));
		for (const [i, frame] of frames.entries()) {
			assert.deepEqual(pixel(frame, 15, 15), [100 + i, 100 + i, 100 + i, alpha]);
			assert.ok(frame.every((value, at) => at % 4 !== 3 || value === alpha));
		}
	}
	assert.equal(pack.tiles.get("stone")![3], 240);
});

test("stored selection requires a valid version, registry pixels, water frames and optional art map", () => {
	const tiles = new Map([["stone", tile], ["water", tile]]);
	const waterFrames = new Map([["water", [tile, tile.slice()]]]);
	const art = new Map([["environment/sun", new Uint8Array(32 ** 2 * 4)], ["ui/heart_half", new Uint8Array(9 ** 2 * 4)]]);
	const pack = { version: "1.2.3.4-preview", tiles, waterFrames, art };
	const names = ["stone", "water", "water_flow"];
	assert.equal(installedPack({ pack: { name: "old.zip", tiles }, active: true }, names), undefined);
	for (const bad of [
		undefined, { ...pack, version: "bad" }, { ...pack, version: "1.2.3-preview.4" },
		{ version: "1.2.3", tiles }, { ...pack, tiles: new Map() },
		{ version: pack.version, tiles, waterFrames }, { ...pack, art: {} },
		{ ...pack, art: new Map([["ui/unknown", new Uint8Array(9 ** 2 * 4)]]) },
		{ ...pack, art: new Map([["environment/sun", tile]]) },
		{ ...pack, art: new Map([["ui/heart_half", new Uint16Array(9 ** 2 * 4)]]) },
		{ ...pack, tiles: new Map([["stone", new Uint8Array(1)]]) },
		...[
			new Map(), new Map([["water", []]]), new Map([["water", [tile.slice()]]]),
			new Map([["water", [tile, new Uint8Array(1)]]]), new Map([["water", Array(33).fill(tile)]]),
			new Map([["water_flow", [tile]]]), new Map([["stone", [tile]]]),
		].map(waterFrames => ({ ...pack, waterFrames })),
	]) assert.equal(installedPack({ pack: bad }, names), undefined);
	assert.equal(installedPack({ pack }, ["apple"]), undefined);
	assert.ok(installedPack({ pack: { ...pack, art: new Map() } }, names));
	assert.deepEqual(installedPack(structuredClone({ pack }), names), pack);
});

// The fixture writes one unfiltered RGBA IDAT chunk immediately after IHDR.
async function decodeFixtureArt(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
	const png = Buffer.from(bytes);
	assert.equal(png.toString("ascii", 37, 41), "IDAT");
	const rows = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
	const stride = width * 4 + 1;
	assert.equal(rows.length, stride * height);
	return Uint8Array.from(rows.filter((_, i) => i % stride !== 0));
}

test("native-size environment and HUD art, black celestial backgrounds and crack alpha", async () => {
	const entries = [...testEntries, ...fixtureArtEntries().map(([path, png]) => ["sample/" + path, png])];
	const { art } = await importTexturePack(await file(entries), ["stone"], undefined, async () => tile, decodeFixtureArt);
	assert.deepEqual([...art.keys()], [...packArtDimensions.keys()]);
	const rgba = (path: string, x: number, y: number) => {
		const offset = (y * packArtDimensions.get(path)![0] + x) * 4;
		return Array.from(art.get(path)!.subarray(offset, offset + 4));
	};
	const sun = "environment/sun", moon = "environment/moon_phases";
	assert.deepEqual(rgba(sun, 0, 0), [0, 0, 0, 0]);
	assert.deepEqual(rgba(sun, 11, 11), [...fixtureArtRGB(sun, false), 255]);
	for (const [phase, cell] of moonSheetOrder.entries()) {
		const x = cell % 4 * 32, y = Math.floor(cell / 4) * 32;
		assert.deepEqual(rgba(moon, x, y), [0, 0, 0, 0]);
		const lit = [...fixtureArtRGB(moon, false, [0, 7, 6, 5, 4, 3, 2, 1][phase]), 255];
		assert.deepEqual(rgba(moon, x + 12, y + 16), phase === 0 || phase > 4 ? lit : [0, 0, 0, 0]);
		assert.deepEqual(rgba(moon, x + 19, y + 16), phase < 4 ? lit : [0, 0, 0, 0]);
	}
	for (const [stage, path] of crackPaths.entries()) {
		assert.deepEqual(rgba(path, 0, 0), [0, 0, 0, 0]);
		assert.equal(art.get(path)!.filter((value, i) => i % 4 === 3 && value === 255).length,
			8 * (1 + stage));
	}
});

test("missing, malformed, wrong-size and undecodable art fall back independently", async () => {
	const artEntries = fixtureArtEntries().map(([path, png]) => ["sample/" + path, png]);
	const moon = "environment/moon_phases", sun = "environment/sun";
	const entries = [...testEntries, ...artEntries.filter(([path]) => !path.endsWith(moon + ".png")).map(([path, png]) => [
		path, path.endsWith(sun + ".png") ? "bad PNG" : path.endsWith("ui/heart.png") ? solidPng([0, 0, 0]) : png,
	])];
	const { art, tiles } = await importTexturePack(await file(entries), ["stone", "apple"], undefined, async () => tile,
		async (bytes, width, height) => {
			if (width === 256) throw new Error("image decoder rejected this file");
			return decodeFixtureArt(bytes, width, height);
		});
	assert.deepEqual([...tiles.keys()], ["stone", "apple"]);
	assert.deepEqual([...art.keys()], [...packArtDimensions.keys()].filter(path =>
		![sun, moon, "ui/heart", "environment/clouds"].includes(path)));
});

test("generated browser fixture covers every registry name through the importer", async () => {
	const { instance } = await WebAssembly.instantiate(await readFile(new URL("../wasm/client.wasm", import.meta.url)), {});
	const names = new Set(gameTextureNames(new ClientCore(instance)));
	const pack = await importTexturePack(new File([await fixturePack()], "fixture.zip"), [...names], undefined, async (_, width) => {
		assert.ok(width === 16 || width === 32);
		return tile;
	}, decodeFixtureArt);
	assert.deepEqual(new Set(pack.tiles.keys()), names);
	assert.equal(pack.waterFrames.get("water")?.length, 3);
	assert.equal(pack.waterFrames.get("water_flow")?.length, 3);
	assert.equal(pack.art.size, packArtDimensions.size);
});
