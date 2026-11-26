// Original, deterministic tile patterns for host and browser tests.
import { readFile } from "node:fs/promises";
import { ClientCore, gameTextureNames } from "../src/client/client-core.ts";
import { deflateSync } from "node:zlib";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { crc32 } from "../src/client/world-archive.ts";

function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length);
	out.write(type, 4);
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
	return out;
}
export function solidPng(rgb, { width = 1, description = "" } = {}) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
	const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
	if (description) chunks.push(chunk("tEXt", Buffer.from("Description\0" + description)));
	return Buffer.concat([...chunks, chunk("IDAT", deflateSync(row)), chunk("IEND", Buffer.alloc(0))]);
}
export const stoneRGB = [222, 17, 145], appleRGB = [37, 212, 129];
export function packEntries({ prefix = "", version = "1.26.60.5", uuid = "66c6e9a8-3093-462a-9c36-dbb052165822", terrain = {}, items = {} } = {}) {
	return [
		[prefix + "version.json", JSON.stringify({ latest: { version } })],
		[prefix + "resource_pack/manifest.json", JSON.stringify({ header: { uuid } })],
		[prefix + "resource_pack/textures/terrain_texture.json", JSON.stringify({ texture_data: terrain })],
		[prefix + "resource_pack/textures/item_texture.json", JSON.stringify({ texture_data: items })],
	];
}

const sample = "sample/resource_pack/textures/";
export const testEntries = [
	...packEntries({ prefix: "sample/" }).filter(([path]) => !path.endsWith("terrain_texture.json")),
	[sample + "terrain_texture.json", '// local test\n{"texture_data":{"stone":{"textures":[{"path":"textures/blocks/sample"}]},"grass_side":{"textures":"textures/blocks/sample"}}}'],
	[sample + "blocks/sample.png", solidPng(stoneRGB)],
	[sample + "items/apple.png", solidPng(appleRGB)],
];

const featuredColors = {
	grass_block_top: [185, 185, 185], grass_block_side: [112, 78, 48],
	oak_planks: [182, 119, 64], cobblestone: [112, 112, 112],
	glass: [192, 233, 250], water: [96, 152, 231], water_flow: [106, 163, 219],
	red_flower: [242, 29, 36], yellow_flower: [238, 206, 35], short_grass: [168, 184, 84],
	oak_leaves: [94, 140, 54], oak_leaves_dense: [61, 110, 39], torch: [245, 171, 65],
	lava: [242, 95, 22],
};

function fixturePng(name, item, color) {
	const size = 16;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 6;
	const rows = Buffer.alloc(size * (size * 4 + 1));
	const hash = crc32(Buffer.from(name));
	const rgb = color ?? featuredColors[name] ?? [0, 8, 16].map(shift => 55 + ((hash >>> shift) % 157));
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const i = y * (size * 4 + 1) + 1 + x * 4;
		let opaque = true;
		if (item) opaque = Math.abs(x - 7) + Math.abs(y - 7) <= 8;
		else if (name === "glass") opaque = x === 0 || x === 15 || y === 0 || y === 15 || Math.abs(x - y) <= 1;
		else if (name.endsWith("_flower")) opaque = (y < 8 && Math.abs(x - 7) + Math.abs(y - 4) < 6) || (y >= 7 && x >= 7 && x <= 8);
		else if (name === "short_grass" || name.startsWith("wheat_")) opaque = y > 3 && (x + (y >> 2)) % 4 < 2;
		else if (name === "oak_leaves") opaque = (x + 2 * y) % 7 !== 0;
		if (!opaque) continue;
		const shade = color ? 0 : ((x * 13 + y * 7 + hash) % 31) - 15;
		const base = name.endsWith("_flower") && y >= 8 ? [57, 151, 54] : rgb;
		const alpha = name === "water" ? 156 : name === "water_flow" ? 166 : 255;
		rows.set([...base.map(value => Math.min(255, Math.max(0, value + shade))), alpha], i);
	}
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

export async function fixturePack({ version, colors = {} } = {}) {
	const wasm = await readFile(new URL("../src/wasm/client.wasm", import.meta.url));
	const { instance } = await WebAssembly.instantiate(wasm, {});
	const core = new ClientCore(instance);
	const names = new Set(gameTextureNames(core));
	const itemNames = new Set([...core.itemRegistry().map(item => item.texture), "bow"]);
	const terrain = {}, items = {}, images = [];
	for (const name of names) {
		const item = itemNames.has(name);
		const path = `textures/${item ? "items" : "blocks"}/${name}`;
		(item ? items : terrain)[name] = { textures: path };
		images.push(["resource_pack/" + path + ".png", fixturePng(name, item, colors[name])]);
	}
	return zipBytes([...packEntries({ version, terrain, items }), ...images]);
}

export async function zipBytes(entries = testEntries) {
	const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
	for (const [path, data] of entries) {
		await writer.add(path, new Uint8ArrayReader(typeof data === "string" ? new TextEncoder().encode(data) : data));
	}
	return writer.close();
}
