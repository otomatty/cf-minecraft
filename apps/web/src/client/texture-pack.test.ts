import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appleRGB, fixturePack, packEntries, solidPng, testEntries, zipBytes } from "../../test/texture-pack-fixture.mjs";
import { importTexturePack, pngTileWidth } from "./texture-pack.ts";
import { installedPack } from "./texture-pack-settings.ts";
import { ClientCore, gameTextureNames } from "./client-core.ts";

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
	assert.equal(pack.version, "1.26.60.5");
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

test("official metadata, version, extension and common prefix are required", async () => {
	for (const entries of [
		packEntries({ uuid: "other" }),
		...["1.2", "1.2.3.4.5", "v1.2.3", 123].map(version => packEntries({ version })),
		...packEntries().map(([missing]) => packEntries().filter(([path]) => path !== missing)),
		packEntries({ prefix: "first/second/" }),
		packEntries().map(([path, data]) => [path === "version.json" ? "different/" + path : path, data]),
	]) await assert.rejects(load(await file(entries)), /公式の Bedrock Samples の ZIP ではありません/);
	await assert.rejects(load(await file(testEntries, "local.mcpack")), /公式の Bedrock Samples/);
	await assert.rejects(load(await file(packEntries())), /ブロックとアイテムの画像が入っていません/);
	const version = await load(await file([...packEntries({ version: "1.2.3" }), ["resource_pack/textures/items/apple.png", solidPng(appleRGB)]]));
	assert.equal(version.version, "1.2.3");
});

test("version and manifest use the same bounded read as the atlases", async () => {
	for (const name of ["version.json", "manifest.json"]) {
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

test("stored selection requires a version and valid registry pixels", () => {
	const tiles = new Map([["stone", tile]]);
	assert.equal(installedPack({ pack: { name: "old.zip", tiles }, active: true }, ["stone"]), undefined);
	for (const bad of [undefined, { version: "bad", tiles }, { version: "1.2.3", tiles: new Map() },
		{ version: "1.2.3", tiles: new Map([["stone", new Uint8Array(1)]]) }]) {
		assert.equal(installedPack({ pack: bad }, ["stone"]), undefined);
	}
	assert.equal(installedPack({ pack: { version: "1.2.3", tiles } }, ["apple"]), undefined);
	assert.deepEqual(installedPack({ pack: { version: "1.2.3", tiles } }, ["stone"]), { version: "1.2.3", tiles });
});

test("generated browser fixture covers every registry name through the importer", async () => {
	const { instance } = await WebAssembly.instantiate(await readFile(new URL("../wasm/client.wasm", import.meta.url)), {});
	const names = new Set(gameTextureNames(new ClientCore(instance)));
	const pack = await importTexturePack(new File([await fixturePack()], "fixture.zip"), [...names], undefined, async (_, width) => {
		assert.equal(width, 16);
		return tile;
	});
	assert.deepEqual(new Set(pack.tiles.keys()), names);
});
