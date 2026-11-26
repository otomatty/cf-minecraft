// Original, deterministic tile patterns for host and browser tests.
import { readFile } from "node:fs/promises";
import { ClientCore, gameTextureLayout } from "../src/client/client-core.ts";
import { deflateSync, inflateSync } from "node:zlib";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { crc32 } from "../src/client/world-archive.ts";
import { importTexturePack, packArtDimensions } from "../src/client/texture-pack.ts";

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
	white_wool: [233, 233, 233], gray_wool: [110, 110, 110], brown_wool: [123, 76, 60], black_wool: [40, 40, 40],
	farmland_dry: [130, 105, 83], farmland_moist: [74, 54, 40], wheat_ripe: [220, 177, 60],
	oak_planks: [182, 119, 64], cobblestone: [112, 112, 112],
	glass: [192, 233, 250], water: [170, 170, 170], water_flow: [178, 178, 178],
	red_flower: [242, 29, 36], yellow_flower: [238, 206, 35], short_grass: [168, 184, 84],
	torch: [245, 171, 65],
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

function leafShade(x, y) {
	return 145 + (x * 13 + y * 7) % 31;
}

function leafOpaque(x, y) {
	return (x + 2 * y) % 7 !== 0;
}

function fixturePng(name, item, color) {
	const water = name === "water" || name === "water_flow";
	const size = name === "water_flow" ? 32 : 16;
	const stage = ["wheat_sprout", "wheat_shoot", "wheat_green", "wheat_ripe"].indexOf(name);
	const frameShades = water ? [0, 36, -20] : [0];
	const ore = name.endsWith("_ore");
	const tool = /_(pickaxe|axe|shovel|hoe)$/.exec(name)?.[1];
	const pattern = name.endsWith("_wool") ? "white_wool" : ore ? "stone" : name;
	const hash = crc32(Buffer.from(pattern));
	const colorHash = ore ? crc32(Buffer.from(name)) : hash;
	const rgb = color ?? featuredColors[name] ?? [0, 8, 16].map(shift => 55 + ((hash >>> shift) % 157));
	return rgbaPng(size, size * frameShades.length, (x, row) => {
		const y = row % size;
		let opaque = true;
		if (item) {
			opaque = Math.abs(x - 7) + Math.abs(y - 7) <= 8;
			if (tool && y === 12 && x === (tool === "hoe" ? 8 : 2)) opaque = true;
		}
		else if (name === "glass") opaque = x === 0 || x === 15 || y === 0 || y === 15 || Math.abs(x - y) <= 1;
		else if (name.endsWith("_flower")) opaque = (y < 8 && Math.abs(x - 7) + Math.abs(y - 4) < 6) || (y >= 7 && x >= 7 && x <= 8);
		else if (name === "short_grass") opaque = y > 3 && (x + (y >> 2)) % 4 < 2;
		else if (stage >= 0) opaque = y > 11 - stage * 3 && x % 4 < 2;
		if (!opaque) return [0, 0, 0, 0];
		const shade = frameShades[Math.floor(row / size)] + (color ? 0 : ((x * 13 + y * 7 + hash) % 31) - 15);
		if (name === "oak_leaves_dense" && !color) {
			const level = leafOpaque(x, y) ? leafShade(x, y) : 100;
			return [level, level, level, 255];
		}
		if (name === "furnace_front" && y >= 6 && y < 13 && x >= 4 && x <= 11 && !color) {
			return y === 12 ? [200, 130, 35, 255] : [25, 25, 25, 255];
		}
		let base = rgb;
		if (name.endsWith("_flower") && y >= 8) base = [57, 151, 54];
		if (name.startsWith("crafting_table_") && y < 2 && !color) base = [120, 120, 120];
		if (ore && (x + 2 * y) % 11 === 0 && !color) {
			base = [0, 8, 16].map(shift => 55 + ((colorHash >>> shift) % 157));
		}
		const alpha = name === "water" || name === "ice" ? 240 : 255;
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
		const level = color?.[0] ?? (grass ? fixtureGrassBrightness : leafShade(x, y));
		const opaque = grass ? y < 4 : leafOpaque(x, y);
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

// Original test models, stored under fixture-only identifiers and filenames.
const fixtureModels = {
	cow: [64, 64, [
		{name: "root", pivot: [0, 0, -1]},
		{name: "head", parent: "root", pivot: [0, 20, -9], cubes: [
			{origin: [-4, 16, -15], size: [8, 8, 6], uv: [0, 0]},
			{origin: [-3, 16, -16], size: [6, 3, 1], uv: [34, 6]},
			{origin: [-5, 22, -14], size: [1, 3, 1], uv: [30, 0]},
			{origin: [4, 22, -14], size: [1, 3, 1], uv: [30, 0]},
		] },
		{name: "body", parent: "root", pivot: [0, 19, 1], cubes: [
			{origin: [-6, 12, -9], size: [12, 10, 18], uv: [0, 24]},
			{origin: [-2, 11, 3], size: [4, 1, 6], uv: [20, 16]},
		] },
		{name: "leg0", parent: "root", pivot: [-4, 12, 6], cubes: [{origin: [-6, 0, 4], size: [4, 12, 4], uv: [48, 0], mirror: false}]},
		{name: "leg1", parent: "root", pivot: [4, 12, 6], cubes: [{origin: [2, 0, 4], size: [4, 12, 4], uv: [48, 0], mirror: true}]},
		{name: "leg2", parent: "root", pivot: [-4, 12, -7], cubes: [{origin: [-6, 0, -8], size: [4, 12, 4], uv: [48, 0], mirror: false}]},
		{name: "leg3", parent: "root", pivot: [4, 12, -7], cubes: [{origin: [2, 0, -8], size: [4, 12, 4], uv: [48, 0], mirror: true}]},
	]],
	pig: [64, 64, [
		{name: "root", pivot: [0, 0, 0]},
		{name: "head", parent: "root", pivot: [0, 12, -7], cubes: [
			{origin: [-4, 8, -15], size: [8, 8, 8], uv: [0, 0]},
			{origin: [-2, 9, -16], size: [4, 3, 1], uv: [32, 0]},
		] },
		{name: "body", parent: "root", pivot: [0, 10, -1], cubes: [{origin: [-5, 6, -9], size: [10, 8, 16], uv: [0, 18]}]},
		{name: "leg0", parent: "root", pivot: [-3, 6, 6], cubes: [{origin: [-5, 0, 4], size: [4, 6, 4], uv: [44, 0], mirror: false}]},
		{name: "leg1", parent: "root", pivot: [3, 6, 6], cubes: [{origin: [1, 0, 4], size: [4, 6, 4], uv: [44, 0], mirror: true}]},
		{name: "leg2", parent: "root", pivot: [-3, 6, -6], cubes: [{origin: [-5, 0, -8], size: [4, 6, 4], uv: [44, 0], mirror: false}]},
		{name: "leg3", parent: "root", pivot: [3, 6, -6], cubes: [{origin: [1, 0, -8], size: [4, 6, 4], uv: [44, 0], mirror: true}]},
	]],
	chicken: [64, 32, [
		{name: "body", pivot: [0, 8, 0], cubes: [{origin: [-3, 5, -4], size: [6, 6, 8], uv: [0, 12]}]},
		{name: "head", pivot: [0, 9, -4], cubes: [{origin: [-2, 9, -6], size: [4, 6, 3], uv: [0, 0]}]},
		{name: "comb", parent: "head", pivot: [0, 9, -4], cubes: [{origin: [-1, 9, -7], size: [2, 2, 2], uv: [46, 0]}]},
		{name: "beak", parent: "head", pivot: [0, 9, -4], cubes: [{origin: [-2, 11, -8], size: [4, 2, 2], uv: [32, 0]}]},
		{name: "leg0", pivot: [-2, 5, 1], cubes: [
			{origin: [-2, 1, 0], size: [1, 4, 1], uv: [32, 8]},
			{origin: [-3, 0, -1], size: [3, 1, 2], uv: [40, 8]},
			{origin: [-3, 0, -2], size: [1, 1, 1], uv: [52, 8]},
			{origin: [-1, 0, -2], size: [1, 1, 1], uv: [52, 8]},
		] },
		{name: "leg1", pivot: [1, 5, 1], cubes: [
			{origin: [1, 1, 0], size: [1, 4, 1], uv: [32, 8]},
			{origin: [0, 0, -1], size: [3, 1, 2], uv: [40, 8]},
			{origin: [0, 0, -2], size: [1, 1, 1], uv: [52, 8]},
			{origin: [2, 0, -2], size: [1, 1, 1], uv: [52, 8]},
		] },
		{name: "wing0", pivot: [-3, 11, 0], cubes: [{origin: [-4, 7, -3], size: [1, 4, 6], uv: [16, 0], mirror: false}]},
		{name: "wing1", pivot: [3, 11, 0], cubes: [{origin: [3, 7, -3], size: [1, 4, 6], uv: [16, 0], mirror: true}]},
	]],
	sheep: [64, 80, [
		{name: "body", parent: "root", pivot: [0, 12, 0], cubes: [
			{origin: [-5.76, 6.4, -4.48], size: [11.52, 10.4, 10.88], uv: [0, 0], uvSize: [16, 16, 16]},
			{origin: [-6.72, 8.32, -2.88], size: [13.44, 9.92, 8], uv: [0, 0], uvSize: [16, 16, 16]},
		] },
	]],
	sheared: [64, 80, [
		{name: "root", pivot: [0, 0, 0]},
		{name: "body", parent: "root", pivot: [0, 12, 0], cubes: [{origin: [-4.5, 7.2, -4], size: [9, 7, 10.4], uv: [0, 64], uvSize: [8, 8, 6]}]},
		{name: "head", parent: "root", pivot: [0, 14, -3.2], cubes: [{origin: [-2.56, 12.48, -7.2], size: [5.12, 6.72, 4], uv: [0, 32], uvSize: [16, 16, 8]}]},
		{name: "leg0", parent: "root", pivot: [-3.84, 7.68, 3.52], cubes: [{origin: [-5.12, 0, 2.24], size: [2.56, 7.68, 2.56], uv: [48, 32], uvSize: [4, 16, 4]}]},
		{name: "leg1", parent: "root", pivot: [3.84, 7.68, 3.52], cubes: [{origin: [2.5599999999999996, 0, 2.24], size: [2.56, 7.68, 2.56], uv: [48, 32], uvSize: [4, 16, 4]}]},
		{name: "leg2", parent: "root", pivot: [-3.84, 7.68, -2.24], cubes: [{origin: [-5.12, 0, -3.5200000000000005], size: [2.56, 7.68, 2.56], uv: [48, 32], uvSize: [4, 16, 4]}]},
		{name: "leg3", parent: "root", pivot: [3.84, 7.68, -2.24], cubes: [{origin: [2.5599999999999996, 0, -3.5200000000000005], size: [2.56, 7.68, 2.56], uv: [48, 32], uvSize: [4, 16, 4]}]},
	]],
	zombie: [64, 32, [
		{name: "waist", pivot: [0, 12, 0]},
		{name: "body", parent: "waist", pivot: [0, 24, 0], cubes: [{origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16]}]},
		{name: "head", parent: "body", pivot: [0, 24, 0], cubes: [{origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0]}]},
		{name: "rightArm", parent: "body", pivot: [-5, 22, 0], cubes: [{origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16]}]},
		{name: "leftArm", parent: "body", pivot: [5, 22, 0], cubes: [{origin: [4, 12, -2], size: [4, 12, 4], uv: [40, 16], mirror: true}]},
		{name: "rightLeg", parent: "body", pivot: [-1.9, 12, 0], cubes: [{origin: [-3.9, 0, -2], size: [4, 12, 4], uv: [0, 16]}]},
		{name: "leftLeg", parent: "body", pivot: [1.9, 12, 0], cubes: [{origin: [-0.10000000000000009, 0, -2], size: [4, 12, 4], uv: [0, 16], mirror: true}]},
	]],
	skeleton: [64, 32, [
		{name: "waist", pivot: [0, 12, 0]},
		{name: "body", parent: "waist", pivot: [0, 24, 0], cubes: [{origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16]}]},
		{name: "head", parent: "body", pivot: [0, 24, 0], cubes: [{origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0]}]},
		{name: "rightArm", parent: "body", pivot: [-5, 22, 0], cubes: [{origin: [-6, 12, -1], size: [2, 12, 2], uv: [40, 16]}]},
		{name: "leftArm", parent: "body", pivot: [5, 22, 0], cubes: [{origin: [4, 12, -1], size: [2, 12, 2], uv: [40, 16], mirror: true}]},
		{name: "rightLeg", parent: "body", pivot: [-2, 12, 0], cubes: [{origin: [-3, 0, -1], size: [2, 12, 2], uv: [0, 16]}]},
		{name: "leftLeg", parent: "body", pivot: [2, 12, 0], cubes: [{origin: [1, 0, -1], size: [2, 12, 2], uv: [0, 16], mirror: true}]},
		{name: "rightItem", parent: "rightArm", pivot: [-6, 15, 1]},
	]],
	creeper: [64, 32, [
		{name: "body", pivot: [0, 6, 0], cubes: [{origin: [-4, 6, -2], size: [8, 12, 4], uv: [16, 16]}]},
		{name: "head", parent: "body", pivot: [0, 18, 0], cubes: [{origin: [-4, 18, -4], size: [8, 8, 8], uv: [0, 0]}]},
		{name: "leg0", parent: "body", pivot: [-2, 6, 4], cubes: [{origin: [-4, 0, 2], size: [4, 6, 4], uv: [0, 16]}]},
		{name: "leg1", parent: "body", pivot: [2, 6, 4], cubes: [{origin: [0, 0, 2], size: [4, 6, 4], uv: [0, 16]}]},
		{name: "leg2", parent: "body", pivot: [-2, 6, -4], cubes: [{origin: [-4, 0, -6], size: [4, 6, 4], uv: [0, 16]}]},
		{name: "leg3", parent: "body", pivot: [2, 6, -4], cubes: [{origin: [0, 0, -6], size: [4, 6, 4], uv: [0, 16]}]},
	]],
	player: [64, 32, [
		{name: "waist", pivot: [0, 12, 0]},
		{name: "body", parent: "waist", pivot: [0, 24, 0], cubes: [{origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16]}]},
		{name: "head", parent: "body", pivot: [0, 24, 0], cubes: [{origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0]}]},
		{name: "rightArm", parent: "body", pivot: [-5, 22, 0], cubes: [{origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16]}]},
		{name: "leftArm", parent: "body", pivot: [5, 22, 0], cubes: [{origin: [4, 12, -2], size: [4, 12, 4], uv: [40, 16], mirror: true}]},
		{name: "rightLeg", parent: "body", pivot: [-2, 12, 0], cubes: [{origin: [-4, 0, -2], size: [4, 12, 4], uv: [0, 16]}]},
		{name: "leftLeg", parent: "body", pivot: [2, 12, 0], cubes: [{origin: [0, 0, -2], size: [4, 12, 4], uv: [0, 16], mirror: true}]},
	]],
};

const faces = ["west", "north", "east", "south", "up", "down"];
function faceRects({ uv: [u, v], size, uvSize }) {
	const [w, h, d] = uvSize ?? size;
	return [[u, v + d, d, h], [u + d, v + d, w, h], [u + d + w, v + d, d, h],
		[u + 2 * d + w, v + d, w, h], [u + d, v, w, d], [u + d + w, v, w, d]];
}

export const fixtureMobColors = {
	cow: [172, 152, 132], pig: [213, 120, 141], chicken: [245, 170, 59],
	zombie: [87, 132, 72], skeleton: [192, 189, 185], creeper: [78, 150, 66], player: [50, 143, 100],
};
export const fixtureSmokeShades = [125, 167, 208];

function fixtureSkin(name, width, height, bones) {
	const pixels = new Uint8Array(width * height * 4);
	const paint = ([u, v, w, h], rgb, alpha = 255) => {
		for (let y = v; y < v + h; y++) for (let x = u; x < u + w; x++) {
			pixels.set([...rgb, alpha], (y * width + x) * 4);
		}
	};
	for (const bone of bones) for (const [index, cube] of (bone.cubes ?? []).entries()) {
		const color = {
			cow: bone.name === "head" && index === 1 ? fixtureMobColors.cow : [62, 49, 41],
			pig: bone.name === "head" && index === 1 ? fixtureMobColors.pig : [230, 155, 151],
			chicken: bone.name === "beak" ? fixtureMobColors.chicken : bone.name === "comb" ? [174, 61, 53] : [240, 234, 221],
			sheep: bone.name === "body" && cube.uv[1] === 0 ? [248, 248, 248] : [176, 153, 130],
			zombie: bone.name === "head" || bone.name.endsWith("Arm") ? fixtureMobColors.zombie : [21, 130, 146],
			skeleton: fixtureMobColors.skeleton,
			creeper: fixtureMobColors.creeper,
			player: bone.name === "head" ? [219, 172, 126] : bone.name.endsWith("Leg") ? [55, 60, 83] : fixtureMobColors.player,
		}[name];
		for (const [face, rect] of faceRects(cube).entries()) {
			if (name === "skeleton" && bone.name === "body" && face === 4) continue; // Open rib cage.
			const alpha = name === "sheep" && color[0] === 176 ? 3 : 255;
			paint(rect, color, alpha);
		}
	}
	if (["zombie", "skeleton", "player", "creeper"].includes(name)) {
		for (const x of [9, 13]) paint([x, 12, 2, 1], [25, 24, 29]);
	}
	return pixels;
}

function rleSkin(width, height, pixels) {
	const header = Buffer.alloc(18);
	header[2] = 10;
	header.writeUInt16LE(width, 12);
	header.writeUInt16LE(height, 14);
	header[16] = 32;
	header[17] = 0x28; // Top-left origin, 8 alpha bits.
	const packets = [];
	for (let pos = 0; pos < pixels.length;) {
		const [r, g, b, a] = pixels.subarray(pos, pos + 4);
		let count = 1;
		while (count < 128 && pos + count * 4 < pixels.length &&
			pixels.subarray(pos + count * 4, pos + count * 4 + 4).every((value, i) => value === pixels[pos + i])) count++;
		packets.push(Buffer.of(0x80 | (count - 1), b, g, r, a));
		pos += count * 4;
	}
	return Buffer.concat([header, ...packets]);
}

export function fixtureEntityEntries() {
	const entries = [];
	for (const [name, [width, height, originalBones]] of Object.entries(fixtureModels)) {
		const id = "geometry.fixture." + name;
		const texture = "textures/entity/fixture_" + name;
		const bones = originalBones.map(bone => bone.cubes ? { ...bone, cubes: bone.cubes.map(cube => {
			const { uvSize, ...rest } = cube;
			if (!uvSize) return rest;
			return { ...rest, uv: Object.fromEntries(faceRects(cube).map(([u, v, w, h], i) =>
				[faces[i], { uv: [u, v], uv_size: [w, h] }])) };
		}) } : bone);
		const legacy = ["sheep", "sheared", "zombie", "skeleton", "creeper"].includes(name);
		const base = name === "sheep" ? "geometry.fixture.sheared" : undefined;
		const document = legacy
			? { format_version: "1.8.0", [base ? id + ":" + base : id]: { texturewidth: width, textureheight: height, bones } }
			: { format_version: "1.21.0", "minecraft:geometry": [{
				description: { identifier: id, texture_width: width, texture_height: height }, bones,
			}] };
		entries.push(["resource_pack/models/entity/fixture_" + name + ".geo.json", JSON.stringify(document)]);
		if (name === "sheared") continue;
		const geometry = base ? { default: id, sheared: base } : { default: id };
		entries.push(["resource_pack/entity/" + name + ".entity.json", "// Original test entity\n" + JSON.stringify({
			"minecraft:client_entity": { description: { textures: { default: texture }, geometry } },
		})]);
		const skinBones = base ? [...fixtureModels.sheared[2], ...originalBones] : originalBones;
		const pixels = fixtureSkin(name, width, height, skinBones);
		entries.push(name === "sheep" ? ["resource_pack/" + texture + ".tga", rleSkin(width, height, pixels)]
			: ["resource_pack/" + texture + ".png", rgbaPng(width, height, (x, y) =>
				pixels.subarray((y * width + x) * 4, (y * width + x + 1) * 4))]);
	}
	return entries;
}

function fixtureEffects() {
	const texture = "textures/particle/fixture_effects";
	const sheet = rgbaPng(32, 32, (x, y) => {
		const u = x % 8, v = y % 8;
		if (u === 0 || v === 0 || u === 7 || v === 7 || (u + v) % 7 === 0) return [0, 0, 0, 0];
		if (y < 8) return [251, 212, 96, 255];
		return Array(3).fill(fixtureSmokeShades[(u + v + Math.floor(x / 8)) % 3]).concat(255);
	});
	const particle = (base_UV, step_UV) => JSON.stringify({
		particle_effect: {
			description: { basic_render_parameters: { texture } },
			components: { "minecraft:particle_appearance_billboard": {
				uv: { texture_width: 32, texture_height: 32, flipbook: {
					base_UV, size_UV: [8, 8], step_UV, max_frame: 3, stretch_to_lifetime: true,
				} },
			} },
		},
	});
	return [
		["resource_pack/textures/blocks/fire_0.png", rgbaPng(16, 48, (x, row) => {
			const frame = Math.floor(row / 16), y = row % 16;
			const gap = Math.abs(x - (5 + frame * 2));
			return gap < 2 + y / 3 && y > 3 + gap ? [252, 126 + 9 * ((x + y) % 7), 45, 255] : [0, 0, 0, 0];
		})],
		["resource_pack/" + texture + ".png", sheet],
		["resource_pack/particles/large_explosion_level.json", particle([8, 0], [8, 0])],
		["resource_pack/particles/basic_smoke.json", particle([24, 8], [-8, 0])],
	];
}

async function fixtureLayout() {
	const wasm = await readFile(new URL("../src/wasm/client.wasm", import.meta.url));
	const { instance } = await WebAssembly.instantiate(wasm, {});
	return gameTextureLayout(new ClientCore(instance));
}

export async function fixturePack(options) {
	return fixtureZip(await fixtureLayout(), options);
}

async function fixtureZip({ names, spriteStart }, { colors = {}, artVariant = false, omit = [] } = {}) {
	const itemNames = new Set(names.slice(spriteStart));
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
	const assets = [...images, ...fixtureArtEntries(artVariant), ...fixtureEntityEntries(), ...fixtureEffects()].filter(([path]) => !omit.includes(path));
	return zipBytes([...packEntries({ terrain, items }), ...assets]);
}

// Test PNGs contain one unfiltered RGBA IDAT immediately after the header.
export async function decodeFixtureArt(bytes, width, height) {
	const png = Buffer.from(bytes);
	const stride = width * 4 + 1;
	if (png.toString("ascii", 37, 41) !== "IDAT") throw new Error("Expected fixture PNG");
	const rows = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
	if (rows.length !== stride * height) throw new Error("Unexpected fixture PNG size");
	return Uint8Array.from(rows.filter((_, i) => i % stride !== 0));
}

export async function decodedFixturePack() {
	const layout = await fixtureLayout();
	const file = new File([await fixtureZip(layout)], fixtureFilename);
	return importTexturePack(file, layout, undefined, async (bytes, size, frame) => {
		const height = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);
		const image = await decodeFixtureArt(bytes, size, height);
		const tile = new Uint8Array(16 * 16 * 4);
		for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
			const source = (size * (frame * size + Math.floor((y + 0.5) * size / 16)) + Math.floor((x + 0.5) * size / 16)) * 4;
			tile.set(image.subarray(source, source + 4), (y * 16 + x) * 4);
		}
		return tile;
	}, decodeFixtureArt);
}

export async function zipBytes(entries = testEntries) {
	const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
	for (const [path, data] of entries) {
		await writer.add(path, new Uint8ArrayReader(typeof data === "string" ? new TextEncoder().encode(data) : data));
	}
	return writer.close();
}
