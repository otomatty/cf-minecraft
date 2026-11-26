// Original, deterministic tile patterns for host and browser tests.
import { readFile } from "node:fs/promises";
import { ClientCore, gameTextureNames } from "../src/client/client-core.ts";
import { deflateSync } from "node:zlib";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { crc32 } from "../src/client/world-archive.ts";
import { packArtDimensions } from "../src/client/texture-pack.ts";

function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length);
	out.write(type, 4);
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
	return out;
}
export function solidPng(rgb, { width = 1, height = 1, description = "" } = {}) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const stride = 1 + width * 3;
	const rows = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(rgb, y * stride + 1 + x * 3);
	const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
	if (description) chunks.push(chunk("tEXt", Buffer.from("Description\0" + description)));
	return Buffer.concat([...chunks, chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
export const stoneRGB = [222, 17, 145], appleRGB = [37, 212, 129];
export const fixtureFilename = "bedrock-samples-v1.26.60.5-full.zip";
export const fixtureGrassBrightness = 144;
export function packEntries({ prefix = "", engine = [1, 26, 60], uuid = "66c6e9a8-3093-462a-9c36-dbb052165822", terrain = {}, items = {} } = {}) {
	return [
		[prefix + "resource_pack/manifest.json", JSON.stringify({ header: { uuid, min_engine_version: engine } })],
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
	grass_block_top: [185, 185, 185],
	oak_planks: [182, 119, 64], cobblestone: [112, 112, 112],
	glass: [192, 233, 250], water: [170, 170, 170], water_flow: [178, 178, 178],
	red_flower: [242, 29, 36], yellow_flower: [238, 206, 35], short_grass: [168, 184, 84],
	oak_leaves_dense: [61, 110, 39], torch: [245, 171, 65],
	lava: [242, 95, 22],
};

function rgbaPng(width, height, pixel) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const stride = width * 4 + 1;
	const rows = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		rows.set(pixel(x, y), y * stride + 1 + x * 4);
	}
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function fixturePng(name, item, color) {
	const water = name === "water" || name === "water_flow";
	const size = name === "water_flow" ? 32 : 16;
	const frameShades = water ? [0, 36, -20] : [0];
	const hash = crc32(Buffer.from(name));
	const rgb = color ?? featuredColors[name] ?? [0, 8, 16].map(shift => 55 + ((hash >>> shift) % 157));
	return rgbaPng(size, size * frameShades.length, (x, row) => {
		const y = row % size;
		let opaque = true;
		if (item) opaque = Math.abs(x - 7) + Math.abs(y - 7) <= 8;
		else if (name === "glass") opaque = x === 0 || x === 15 || y === 0 || y === 15 || Math.abs(x - y) <= 1;
		else if (name.endsWith("_flower")) opaque = (y < 8 && Math.abs(x - 7) + Math.abs(y - 4) < 6) || (y >= 7 && x >= 7 && x <= 8);
		else if (name === "short_grass" || name.startsWith("wheat_")) opaque = y > 3 && (x + (y >> 2)) % 4 < 2;
		if (!opaque) return [0, 0, 0, 0];
		const shade = frameShades[Math.floor(row / size)] + (color ? 0 : ((x * 13 + y * 7 + hash) % 31) - 15);
		const base = name.endsWith("_flower") && y >= 8 ? [57, 151, 54] : rgb;
		const alpha = name === "water" ? 240 : 255;
		return [...base.map(value => Math.min(255, Math.max(0, value + shade))), alpha];
	});
}

export function fixtureArtRGB(path, variant, index = 0) {
	return [variant ? 88 : 208, 32 + index * 13, 76 + crc32(Buffer.from(path)) % 150];
}

export function fixtureArtEntries(variant = false) {
	return [...packArtDimensions].map(([path, [width, height]]) => {
		const pixel = (x, y) => {
			const rgb = index => fixtureArtRGB(path, variant, index);
			if (path.startsWith("environment/destroy_stage_")) {
				const stage = Number(path.at(-1));
				return y >= 3 && y <= 3 + stage && x >= 4 && x <= 11 ? [...rgb(stage), 255] : [255, 255, 255, 1];
			}
			if (path === "environment/sun") {
				return x >= 11 && x <= 20 && y >= 11 && y <= 20 ? [...rgb(0), 255] : [0, 0, 0, 255];
			}
			if (path === "environment/moon_phases") {
				const cell = Math.floor(y / 32) * 4 + Math.floor(x / 32);
				const u = x % 32, v = y % 32;
				const lit = cell === 0 || (cell < 4 ? u < 16 : cell > 4 && u >= 16);
				return lit && u >= 11 && u <= 20 && v >= 11 && v <= 20 ? [...rgb(cell), 255] : [0, 0, 0, 255];
			}
			if (path === "environment/clouds") return [...rgb(0), (x + 2 * y) % 31 < 9 ? 255 : 0];
			return [...rgb(0), y >= 2 && y <= 6 && (path.endsWith("_half") ? x <= 3 : x >= 2 && x <= 6) ? 255 : 0];
		};
		return ["resource_pack/textures/" + path + ".png", rgbaPng(width, height, pixel)];
	});
}

function fixtureTga(name, color) {
	const size = 16;
	const bytes = Buffer.alloc(18 + size ** 2 * 4);
	bytes[2] = 2;
	bytes.writeUInt16LE(size, 12);
	bytes.writeUInt16LE(size, 14);
	bytes[16] = 32;
	bytes[17] = 8; // Bottom-left origin, eight alpha bits.
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const grass = name === "grass_block_side";
		const level = color?.[0] ?? (grass ? fixtureGrassBrightness : 145 + (x * 13 + y * 7) % 31);
		const opaque = grass ? y < 4 : (x + 2 * y) % 7 !== 0;
		bytes.set([level, level, level, opaque ? 255 : 0], 18 + ((size - 1 - y) * size + x) * 4);
	}
	if (name !== "grass_block_side") return bytes;
	// Bottom-up: 192 transparent pixels, then 64 opaque pixels.
	const header = bytes.subarray(0, 18);
	header[2] = 10;
	return Buffer.concat([header, ...[[0, 128], [128, 64], [192, 64]].map(([pixel, count]) => {
		const offset = 18 + pixel * 4;
		return Buffer.of(0x80 | (count - 1), ...bytes.subarray(offset, offset + 4));
	})]);
}

export async function fixturePack({ colors = {}, artVariant = false } = {}) {
	const wasm = await readFile(new URL("../src/wasm/client.wasm", import.meta.url));
	const { instance } = await WebAssembly.instantiate(wasm, {});
	const core = new ClientCore(instance);
	const names = new Set(gameTextureNames(core));
	const itemNames = new Set([...core.itemRegistry().map(item => item.texture), "bow"]);
	const terrain = {}, items = {}, images = [];
	for (const name of names) {
		const item = itemNames.has(name);
		const atlas = item ? items : terrain;
		const folder = `textures/${item ? "items" : "blocks"}/`;
		const path = folder + ({ grass_block_side: "grass_side", oak_leaves: "leaves_oak", oak_leaves_dense: "leaves_oak_opaque" }[name] ?? name);
		if (name === "oak_leaves_dense") continue; // The opaque tile is the second oak_leaves variant.
		if (name === "oak_leaves") {
			atlas.oak_leaves = { textures: [path, folder + "leaves_oak_opaque"] };
			images.push(["resource_pack/" + folder + "leaves_oak_opaque.png", fixturePng("oak_leaves_dense", false, colors.oak_leaves_dense)]);
		} else atlas[name === "grass_block_side" ? "grass_side" : name] = { textures: path };
		const tga = name === "grass_block_side" || name === "oak_leaves";
		images.push(["resource_pack/" + path + (tga ? ".tga" : ".png"),
			tga ? fixtureTga(name, colors[name]) : fixturePng(name, item, colors[name])]);
	}
	return zipBytes([...packEntries({ terrain, items }), ...images, ...fixtureArtEntries(artVariant)]);
}

export async function zipBytes(entries = testEntries) {
	const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
	for (const [path, data] of entries) {
		await writer.add(path, new Uint8ArrayReader(typeof data === "string" ? new TextEncoder().encode(data) : data));
	}
	return writer.close();
}
