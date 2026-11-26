import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { appleRGB, decodeFixtureArt, fixtureArtEntries, fixtureArtRGB, fixtureEntityEntries, fixturePack, packEntries, solidPng, testEntries, zipBytes } from "../../test/texture-pack-fixture.mjs";
import { crackPaths, importTexturePack, isPackVersion, missingEntityArt, moonSheetOrder, packArtDimensions, packMissingNotice, pngTileWidth } from "./texture-pack.ts";
import { installedPack } from "./texture-pack-settings.ts";
import { ClientCore, gameTextureLayout } from "./client-core.ts";
import { missingTile, textureIconPixels } from "./textures.ts";
import { preparePackTextures } from "./renderer.ts";
import { crc32 } from "./world-archive.ts";

const file = async (entries = testEntries, name = "local.zip") => new File([await zipBytes(entries)], name);
const versioned = (entries, prefix = "") => [
	...packEntries({ prefix }).filter(([path]) => !entries.some(([entry]) => path === prefix + "resource_pack/" + entry)),
	...entries.map(([path, data]) => [prefix + "resource_pack/" + path, data]),
];
const blocksOnly = (names: string[]) => ({ names, spriteStart: names.length });
const tile = new Uint8Array(1024);
const load = (pack: File, names?: string[], spriteStart?: number) => importTexturePack(pack,
	names ? { names, spriteStart: spriteStart ?? names.length } : { names: ["stone", "dirt", "apple"], spriteStart: 2 },
	undefined, async (_, width) => {
		assert.equal(width, 1);
		return tile;
	});
const runNode = promisify(execFile);

test("official pack checker validates PNG chunk types and full tile payloads", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "cf-check-pack-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const checker = fileURLToPath(new URL("../../../../tools/check-official-pack.mjs", import.meta.url));
	const path = join(dir, "bedrock-samples-v1.26.60.5-full.zip");
	const logPath = join(dir, "checker.log");
	const check = async (entries: typeof testEntries) => {
		await writeFile(path, await zipBytes(entries));
		const log = await open(logPath, "w");
		try {
			const child = spawn(process.execPath, [checker, path], { stdio: ["ignore", log.fd, log.fd] });
			const [code] = await once(child, "close");
			return { code, output: await readFile(logPath, "utf8") };
		} finally { await log.close(); }
	};
	const chunk = (type: string, data: Buffer = Buffer.alloc(0)) => {
		const result = Buffer.alloc(12 + data.length);
		result.writeUInt32BE(data.length);
		result.write(type, 4);
		data.copy(result, 8);
		result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
		return result;
	};
	const imagePath = "sample/resource_pack/textures/";
	const png = solidPng([1, 2, 3]);
	const withChunk = (kind: string) => Buffer.concat([png.subarray(0, 33), chunk(kind), png.subarray(33)]);
	const ancillary = await check([...testEntries, [imagePath + "blocks/dirt.png", withChunk("vpAg")]]);
	assert.equal(ancillary.code, 1); // The fixture is a partial pack.
	assert.match(ancillary.output, /^Resolved: 4\//m);
	assert.deepEqual(await check([...testEntries, [imagePath + "blocks/dirt.png", withChunk("VpAg")]]), {
		code: 1, output: "Unknown critical PNG chunk: VpAg\n",
	});
	const stripPath = imagePath + "blocks/water_still_grey.png";
	const strip = solidPng([4, 5, 6], { width: 16, height: 48 });
	const validStrip = await check([...testEntries, [stripPath, strip]]);
	assert.equal(validStrip.code, 1);
	assert.match(validStrip.output, /^Resolved: 4\//m);
	assert.doesNotMatch(validStrip.output, /^Unresolved:.*\bwater\b/m);
	const tileWithData = (source: Buffer, data: Buffer) => Buffer.concat([
		source.subarray(0, 33), chunk("IDAT", data), source.subarray(-12),
	]);
	const invalidApple = testEntries.map(([name, data]) => [name, name.endsWith("items/apple.png") ? tileWithData(png, Buffer.of(0)) : data]);
	const badItem = await check(invalidApple);
	assert.equal(badItem.code, 1);
	assert.match(badItem.output, /^unexpected end of file\n$/);
	const shortStrip = tileWithData(strip, deflateSync(Buffer.alloc(16 * (1 + 16 * 3))));
	assert.deepEqual(await check([...testEntries, [stripPath, shortStrip]]), { code: 1, output: "Invalid PNG pixel data\n" });
});

test("texture-pack E2E fixture write failures are handled before the temporary directory is removed", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "cf-pack-write-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const e2e = new URL("../../../../tools/e2e-texture-packs.mjs", import.meta.url);
	await runNode(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "--eval", `
		import assert from "node:assert/strict";
		import { testTexturePacks } from ${JSON.stringify(e2e.href)};
		await assert.rejects(testTexturePacks(null, "", "", undefined), { code: "ERR_INVALID_ARG_TYPE" });
	`], { env: { ...process.env, TMPDIR: dir } });
	assert.deepEqual(await readdir(dir), []);
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
		["stone_pickaxe", "iron_pickaxe", "apple", "stick"], 0);
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
		await assert.rejects(importTexturePack(new File([bad], "invalid.zip"), { names: ["apple"], spriteStart: 0 }, undefined, async () => {
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
	const block = await importTexturePack(await file(versioned(entries)), { names, spriteStart: 1 }, undefined, decode);
	assert.ok(block.tiles.has("torch"));
	assert.equal(block.tiles.get("torch_item"), block.tiles.get("torch"));
	assert.deepEqual([...(await load(await file(versioned(entries)), ["torch_item"], 0)).tiles.keys()], ["torch_item"]);
	const both = await importTexturePack(await file(versioned([...entries, ["textures/items/torch.png", solidPng([6, 7, 8])]])), { names, spriteStart: 1 }, undefined, decode);
	assert.ok(both.tiles.has("torch_item"));
	assert.notEqual(both.tiles.get("torch_item"), both.tiles.get("torch"));
});

test("many references to one unsupported image consume its extraction budget only once", async () => {
	// A non-square image that is not a vertical strip is skipped before decoding.
	const wide = solidPng([1, 2, 3], { width: 2, description: "x".repeat(3_800_000) });
	const names = ["stone", "dirt", "sand", "gravel", "obsidian", "ice", "bedrock", "glass", "coal_ore"];
	const texture_data = Object.fromEntries(names.map(name => [name, { textures: "textures/blocks/wide" }]));
	const pack = await load(await file(versioned([["textures/terrain_texture.json", JSON.stringify({ texture_data })],
		["textures/blocks/wide.png", wide], ["textures/items/apple.png", solidPng([4, 5, 6])]])), [...names, "apple"], names.length);
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
	await importTexturePack(await file(), { names: ["stone", "grass_block_side", "apple"], spriteStart: 2 }, (done, total) => progress.push([done, total]), async () => tile);
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
	const { tiles } = await load(await file(versioned([["textures/items/apple.tga", strip]])), ["apple"], 0);
	assert.deepEqual(pixel(tiles.get("apple")!, 15, 15), [1, 2, 3, 255]);
});

test("unsupported or malformed TGAs are skipped and a matching PNG takes priority", async () => {
	const image = tga(1, 1, true, [1, 2, 3, 255]);
	for (const [offset, value] of [[1, 1], [2, 3], [16, 24], [17, 0x38], [17, 0x21], [17, 0x29], [13, 3], [2, 10]]) {
		const bad = Buffer.from(image);
		bad[offset] = value;
		const pack = await load(await file(versioned([
			["textures/blocks/leaves_oak.tga", bad], ["textures/items/apple.png", solidPng(appleRGB)],
		])), ["oak_leaves", "apple"], 1);
		assert.deepEqual([...pack.tiles.keys()], ["apple"]);
	}
	const terrain = { texture_data: { oak_leaves: { textures: "textures/blocks/leaves_oak.tga" } } };
	const pack = await load(await file(versioned([
		["textures/terrain_texture.json", JSON.stringify(terrain)],
		["textures/blocks/leaves_oak.tga", image], ["textures/blocks/leaves_oak.png", solidPng([4, 5, 6])],
	])), ["oak_leaves"]);
	assert.equal(pack.tiles.get("oak_leaves"), tile);
});

test("32-bit TGA pixels without alpha attributes are opaque", async () => {
	for (const image of [tga(1, 1, true, [3, 2, 1, 0]), tga(1, 1, true, [0x80, 3, 2, 1, 0], 10)]) {
		image[17] = 0x20;
		const { tiles } = await load(await file(versioned([["textures/blocks/leaves_oak.tga", image]])), ["oak_leaves"]);
		assert.deepEqual(pixel(tiles.get("oak_leaves")!, 0, 0), [1, 2, 3, 255]);
	}
});

test("grass side keeps its tint mask with either pack soil or missing soil", async () => {
	const entries = [
		["textures/blocks/grass_side.tga", tga(2, 2, true, [200, 200, 200, 255, 20, 20, 20, 0, 200, 200, 200, 255, 20, 20, 20, 0])],
		["textures/blocks/dirt.png", solidPng([1, 2, 3])],
		["textures/items/apple.png", solidPng(appleRGB)],
	];
	const soil = new Uint8Array(1024);
	for (let i = 0; i < soil.length; i += 4) soil.set([1, 2, 3, 255], i);
	const pack = await importTexturePack(await file(versioned(entries)), blocksOnly(["grass_block_side"]), undefined, async () => soil);
	assert.deepEqual([...pack.tiles.keys()], ["grass_block_side"]);
	const side = pack.tiles.get("grass_block_side")!;
	assert.deepEqual(pixel(side, 0, 0), [0, 0, 0, 200]);
	assert.deepEqual(pixel(side, 15, 0), [1, 2, 3, 0]);
	const icon = textureIconPixels("grass_block_side", side, { grass: [64, 128, 192], leaves: [0, 0, 0] });
	assert.deepEqual(Array.from(icon.subarray(0, 4)), [50, 100, 151, 255]);
	assert.deepEqual(Array.from(icon.subarray(60, 64)), [1, 2, 3, 255]);
	assert.deepEqual(pixel(soil, 0, 0), [1, 2, 3, 255]);
	const withoutGrass = await load(await file(versioned(entries.slice(1))), ["grass_block_side", "apple"], 1);
	assert.deepEqual([...withoutGrass.tiles.keys()], ["apple"]);
	const names = ["grass_block_side", "dirt", "apple"];
	const withoutDirt = await load(await file(versioned([entries[0], entries[2]])), names, 2);
	const fallback = withoutDirt.tiles.get("grass_block_side")!;
	assert.deepEqual(pixel(fallback, 0, 0), [0, 0, 0, 200]);
	assert.deepEqual(pixel(fallback, 8, 0), [248, 0, 248, 0]);
	assert.deepEqual(pixel(fallback, 8, 8), [0, 0, 0, 0]);
	assert.equal(withoutDirt.tiles.has("dirt"), false);
	assert.equal(packMissingNotice(withoutDirt, names), packMissingNotice(withoutDirt, ["dirt", "apple"]));
	assert.notEqual(packMissingNotice(withoutDirt, names), packMissingNotice(withoutDirt, ["grass_block_side", "apple"]));
});

test("water decodes each square frame up to 32 and uses fixed alpha", async () => {
	const names = ["water", "water_flow", "stone"];
	const reads: number[][] = [];
	const pack = await importTexturePack(await file(versioned([
		["textures/blocks/water_still_grey.png", solidPng([1, 2, 3], { width: 16, height: 48 })],
		["textures/blocks/water_flow_grey.png", solidPng([1, 2, 3], { width: 32, height: 32 * 33 })],
		["textures/blocks/stone.png", solidPng([1, 2, 3], { width: 2, height: 4 })],
	])), blocksOnly(names), undefined, async (_, width, frame) => {
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

test("stored selection requires a valid version, registry pixels, water frames and validated installed art maps", () => {
	const tiles = new Map([["stone", tile], ["water", tile]]);
	const waterFrames = new Map([["water", [tile, tile.slice()]]]);
	const art = new Map([["environment/sun", new Uint8Array(32 ** 2 * 4)], ["ui/heart_half", new Uint8Array(9 ** 2 * 4)]]);
	const pack = { version: "1.2.3.4-preview", tiles, waterFrames, art, entities: new Map(), effects: new Map() };
	const names = ["stone", "water", "water_flow"];
	assert.equal(installedPack({ pack: { name: "old.zip", tiles }, active: true }, names), undefined);
	for (const bad of [
		undefined, { ...pack, version: "bad" }, { ...pack, version: "1.2.3-preview.4" },
		{ version: "1.2.3", tiles }, { ...pack, tiles: new Map(), waterFrames: new Map() },
		{ version: pack.version, tiles, waterFrames }, { ...pack, art: {} },
		{ version: pack.version, tiles, waterFrames, art },
		{ ...pack, entities: new Map([["unknown", {}]]) },
		{ ...pack, effects: new Map([["fire", []]]) },
		{ ...pack, effects: new Map([["smoke", [new Uint8Array(1)]]]) },
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

test("native-size environment and HUD art, black celestial backgrounds and crack alpha", async () => {
	const entries = [...testEntries, ...fixtureArtEntries().map(([path, png]) => ["sample/" + path, png])];
	const { art } = await importTexturePack(await file(entries), blocksOnly(["stone"]), undefined, async () => tile, decodeFixtureArt);
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
	const { art, tiles } = await importTexturePack(await file(entries), { names: ["stone", "apple"], spriteStart: 1 }, undefined, async () => tile,
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
	const layout = gameTextureLayout(new ClientCore(instance));
	const names = new Set(layout.names);
	const pack = await importTexturePack(new File([await fixturePack()], "fixture.zip"), layout, undefined, async (_, width) => {
		assert.ok(width === 16 || width === 32);
		return tile;
	}, decodeFixtureArt);
	assert.deepEqual(new Set(pack.tiles.keys()), names);
	assert.equal(pack.waterFrames.get("water")?.length, 3);
	assert.equal(pack.waterFrames.get("water_flow")?.length, 3);
	assert.equal(pack.art.size, packArtDimensions.size);
	assert.equal(pack.entities.size, 9);
	assert.deepEqual([...pack.effects].map(([name, frames]) => [name, frames.length]), [["fire", 3], ["explosion", 3], ["smoke", 3]]);
	assert.deepEqual(missingEntityArt(pack), []);
	assert.equal(packMissingNotice(pack, layout.names), "");
	assert.deepEqual(installedPack(structuredClone({ pack }), layout.names), pack);
});

test("the layout sends new sprite names and block faces to their respective atlases", async () => {
	const terrain = { future_face: { textures: "textures/blocks/face" }, future_sprite: { textures: "textures/blocks/wrong" } };
	const items = { future_face: { textures: "textures/items/wrong" }, future_sprite: { textures: "textures/items/sprite" } };
	const fileEntries = [...packEntries({ terrain, items }),
		["resource_pack/textures/blocks/face.png", solidPng([0, 0, 0], { width: 2, height: 2 })],
		["resource_pack/textures/items/sprite.png", solidPng([0, 0, 0], { width: 3, height: 3 })],
	];
	const layout = { names: ["future_face", "future_sprite"], spriteStart: 1 };
	const pack = await importTexturePack(await file(fileEntries), layout, undefined, async (_, width) =>
		new Uint8Array(1024).fill(width));
	assert.deepEqual([...pack.tiles.keys()], layout.names);
	assert.equal(pack.tiles.get("future_face")?.[0], 2);
	assert.equal(pack.tiles.get("future_sprite")?.[0], 3);
});

test("an archive needs at least one resolved block or item image", async () => {
	const layout = { names: ["stone", "grass_block_side", "apple"], spriteStart: 2 };
	const message = "ブロックとアイテムの画像が入っていません。手順 1 のページで、名前が -full.zip で終わるファイルをダウンロードして、もう一度開いてください。";
	const renamed = packEntries({
		terrain: { stone: { textures: "textures/blocks/renamed_stone" } },
		items: { apple: { textures: "textures/items/renamed_apple" } },
	});
	await assert.rejects(importTexturePack(await file(packEntries(), "sample-min.zip"), layout), { message });
	const artOnly = await file([...renamed, fixtureArtEntries()[0]], "bedrock-samples-v1.26.60.5-full.zip");
	await assert.rejects(importTexturePack(artOnly, layout, undefined, async () => tile, decodeFixtureArt), { message });
});

test("renderer prepares shared markers and skips unavailable art, including with no installed pack", async () => {
	const names = ["stone", "grass_block_side", "water", "apple"];
	const { tiles, water, cracks, sun, moon, clouds } = preparePackTextures(names);
	assert.equal(tiles.length, names.length);
	assert.ok(tiles.every(pixels => pixels === missingTile));
	assert.ok(water.length === 64 && water.every(pixels => pixels === missingTile));
	assert.deepEqual(pixel(missingTile, 0, 0), [0, 0, 0, 255]);
	assert.deepEqual(pixel(missingTile, 8, 0), [248, 0, 248, 255]);
	assert.deepEqual(pixel(missingTile, 0, 8), [248, 0, 248, 255]);
	assert.deepEqual(pixel(missingTile, 8, 8), [0, 0, 0, 255]);
	for (const name of names) assert.deepEqual([...textureIconPixels(name, missingTile)], [...missingTile]);
	assert.deepEqual(cracks, Array(10).fill(undefined));
	assert.deepEqual([sun, moon, clouds], [undefined, undefined, undefined]);

	const stage = crackPaths[4], sunPath = "environment/sun";
	const entries = [...testEntries, ...fixtureArtEntries().filter(([path]) => [stage, sunPath].some(name => path.endsWith(name + ".png")))
		.map(([path, png]) => ["sample/" + path, png])].filter(([path]) => !path.endsWith("items/apple.png"));
	const pack = await importTexturePack(await file(entries), { names, spriteStart: 3 }, undefined, async () => tile, decodeFixtureArt);
	const partial = preparePackTextures(names, pack);
	assert.deepEqual(partial.tiles, [tile, pack.tiles.get("grass_block_side"), missingTile, missingTile]);
	assert.deepEqual(pixel(partial.tiles[1], 8, 0), [248, 0, 248, 0]);
	assert.equal(partial.cracks[4], pack.art.get(stage));
	assert.equal(partial.cracks.filter(Boolean).length, 1);
	assert.equal(partial.sun, pack.art.get(sunPath));
	assert.deepEqual([partial.moon, partial.clouds], [undefined, undefined]);
	assert.equal(packMissingNotice(pack, names), "この版のパックに無い画像が 33 件あります");
});

test("missing or unsupported entity definitions and particle UVs are counted once per target", async () => {
	const { instance } = await WebAssembly.instantiate(await readFile(new URL("../wasm/client.wasm", import.meta.url)), {});
	const layout = gameTextureLayout(new ClientCore(instance));
	const pack = await importTexturePack(new File([await fixturePack({ omit: [
		"resource_pack/textures/entity/fixture_cow.png",
		"resource_pack/models/entity/fixture_sheep.geo.json",
		"resource_pack/particles/basic_smoke.json",
		"resource_pack/textures/blocks/fire_0.png",
	] })], "fixture.zip"), layout, undefined, async () => tile, decodeFixtureArt);
	assert.ok(!pack.entities.has("cow") && !pack.entities.has("sheep"));
	assert.ok(pack.entities.has("sheep/sheared") && pack.entities.has("player"));
	assert.ok(pack.effects.has("explosion"));
	assert.deepEqual(missingEntityArt(pack), ["cow", "sheep", "fire", "explosion"]);
	assert.equal(packMissingNotice(pack, layout.names), "この版のパックに無い画像が 4 件あります");

	const entries = fixtureEntityEntries().filter(([path]) => /fixture_cow|entity\/cow\.entity/.test(path));
	const changed = entries.map(([path, data]) => path.endsWith(".geo.json")
		? [path, String(data).replace('"uv":[0,0]', '"uv":"unsupported"')] : [path, data]);
	const corrupt = await importTexturePack(await file([...testEntries, ...changed.map(([path, data]) =>
		["sample/" + path, data])]), blocksOnly(["stone"]), undefined, async () => tile, decodeFixtureArt);
	assert.equal(corrupt.entities.size, 0);
	assert.ok(corrupt.tiles.has("stone"));
	for (const [size, missing] of [[[0, 2, 2], true], [[2, 2, 0], false]] as const) {
		const geometry = entries.map(([path, data]) => {
			if (!path.endsWith(".geo.json")) return ["sample/" + path, data];
			const model = JSON.parse(String(data));
			model["minecraft:geometry"][0].bones = [{ name: "body", cubes: [{ origin: [0, 0, 0], size,
				uv: { north: { uv: [0, 0], uv_size: [2, 2] } } }] }];
			return ["sample/" + path, JSON.stringify(model)];
		});
		const partial = await importTexturePack(await file([...testEntries, ...geometry]), blocksOnly(["stone"]), undefined, async () => tile, decodeFixtureArt);
		assert.equal(missingEntityArt(partial).includes("cow"), missing);
	}

	const stored = structuredClone(pack);
	stored.entities.get("pig")!.bones[1].parent = "absent";
	assert.equal(installedPack({ pack: stored }, layout.names), undefined);
});

test("particle frames use their declared texture, UV origin, dimensions and negative step", async () => {
	const { instance } = await WebAssembly.instantiate(await readFile(new URL("../wasm/client.wasm", import.meta.url)), {});
	const layout = gameTextureLayout(new ClientCore(instance));
	const pack = await importTexturePack(new File([await fixturePack()], "fixture.zip"), layout,
		undefined, async () => tile, decodeFixtureArt);
	const flashes = pack.effects.get("explosion")!, smoke = pack.effects.get("smoke")!;
	const readPixel = (frame: Uint8Array, x: number, y: number) => Array.from(frame.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
	assert.deepEqual(readPixel(flashes[2], 4, 2), [251, 212, 96, 255]);
	assert.deepEqual(readPixel(smoke[0], 4, 2), [125, 125, 125, 255]);
	assert.deepEqual(readPixel(smoke[1], 4, 2), [208, 208, 208, 255]);
	assert.deepEqual(readPixel(smoke[2], 4, 2), [167, 167, 167, 255]);
	assert.equal(readPixel(smoke[0], 0, 0)[3], 0);
});
