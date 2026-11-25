import assert from "node:assert/strict";
import test from "node:test";
import { solidPng, testEntries, zipBytes } from "../../test/texture-pack-fixture.mjs";
import { importTexturePack, pngTileWidth } from "./texture-pack.ts";

const file = async (entries = testEntries) => new File([await zipBytes(entries)], "local.mcpack");
const tile = new Uint8Array(1024);
const load = (pack: File, names = ["stone", "apple", "dirt"]) => importTexturePack(pack, names, async (_, width) => {
	assert.equal(width, 1);
	return tile;
});

test("wrapped pack, JSON comments, path objects and partial fallback", async () => {
	const pack = await load(await file([...testEntries, ["sample/scripts/init.js", "throw 1"]]));
	assert.deepEqual([...pack.tiles.keys()], ["stone", "apple"]);
	assert.equal(pack.tiles.get("apple"), tile);
});
test("item variants, including material-specific indices and safe local references", async () => {
	const json = { texture_data: { pickaxe: { textures: ["textures/items/wood", "textures/items/stone", "textures/items/test"] },
		apple: { textures: "https://example.invalid/image" }, stick: { textures: "textures/items/../payload" } } };
	const pack = await load(await file([["textures/item_texture.json", JSON.stringify(json)],
		["textures/items/test.png", solidPng([5, 10, 15])], ["textures/items/apple.png", solidPng([0, 1, 2])]]),
		["stone_pickaxe", "iron_pickaxe", "apple", "stick"]);
	assert.deepEqual([...pack.tiles.keys()], ["iron_pickaxe"]);
});
test("invalid JSON, PNG, ambiguous roots and unsupported packs fail atomically", async () => {
	for (const entries of [
		[...testEntries, ["sample/textures/item_texture.json", "{"]],
		[...testEntries, ["sample/textures/blocks/dirt.png", "not PNG"]],
		[...testEntries, ["other/textures/items/stick.png", solidPng([0, 0, 0])]],
		[["textures/entity/mob.png", solidPng([0, 0, 0])]],
	]) await assert.rejects(load(await file(entries)));
});
test("rejects traversal, excessive inflated entry sizes and image dimensions before decoding", async () => {
	const bytes = Buffer.from(await zipBytes([["aa/textures/items/apple.png", solidPng([0, 0, 0])]]));
	const unsafe = Buffer.from(bytes.toString("latin1").replaceAll("aa/textures", "../textures"), "latin1");
	await assert.rejects(load(new File([unsafe], "bad.zip")));
	const oversized = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
	bytes.writeUInt32LE(513 * 1024 ** 2, oversized + 24);
	await assert.rejects(load(new File([bytes], "huge.zip")));
	const png = solidPng([0, 0, 0]);
	png.writeUInt32BE(65536, 16);
	assert.throws(() => pngTileWidth(png), /寸法/);
});

test("file limit precedes archive reads, and encrypted or oversized images never decode", async () => {
	const large = new File([], "large.zip");
	Object.defineProperty(large, "size", { value: 256 * 1024 ** 2 + 1 });
	await assert.rejects(load(large), /256 MiB/);
	const bytes = Buffer.from(await zipBytes([["textures/items/apple.png", solidPng([1, 2, 3])]]));
	const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
	for (const encrypted of [false, true]) {
		const bad = Buffer.from(bytes);
		if (encrypted) {
			bad.writeUInt16LE(bad.readUInt16LE(central + 8) | 1, central + 8);
		} else {
			bad.writeUInt32LE(5 * 1024 ** 2, central + 24);
		}
		let decoded = false;
		await assert.rejects(importTexturePack(new File([bad], "invalid.zip"), ["apple"], async () => {
			decoded = true;
			return tile;
		}));
		assert.equal(decoded, false);
	}
});
