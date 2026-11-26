import { BlobReader, ZipReader, type FileEntry } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { hasItemTexture } from "./item-textures.ts";
import { TEX_SIZE } from "./textures.ts";
import { WATER_FRAME_COUNT } from "./building-textures.ts";

const MiB = 1024 ** 2;
const maxArchive = 256 * MiB, maxExpanded = 512 * MiB, maxSelected = 32 * MiB;
const maxEntries = 32_768;
export interface TexturePack {
	version: string;
	tiles: Map<string, Uint8Array>;
	/** Each water strip's first frame is also its tile for thumbnails and drops. */
	waterFrames: Map<string, Uint8Array[]>;
	/** Native-size RGBA pixels, keyed by path within the textures directory. */
	art: Map<string, Uint8Array>;
}

export const crackPaths = Array.from({ length: 10 }, (_, stage) => "environment/destroy_stage_" + stage);
const hudImages = [
	"heart", "heart_half", "heart_background", "heart_blink",
	"hunger_full", "hunger_half", "hunger_background", "hunger_blink", "bubble", "bubble_empty",
] as const;
export const packArtDimensions: ReadonlyMap<string, readonly [number, number]> = new Map<string, readonly [number, number]>([
	...crackPaths.map(path => [path, [TEX_SIZE, TEX_SIZE]] as const),
	["environment/sun", [32, 32]], ["environment/moon_phases", [128, 64]], ["environment/clouds", [256, 256]],
	...hudImages.map(name => ["ui/" + name, [9, 9]] as const),
]);

/** The sheet wanes on the left first. In-game phases illuminate the right first. */
export const moonSheetOrder = [0, 7, 6, 5, 4, 3, 2, 1] as const;

// Internal name -> Bedrock atlas key, conventional image basename, variant index.
type Binding = readonly [key: string, filename: string, variant?: number];
const bindings = new Map<string, Binding>([
	["grass_block_side", ["grass_side", "grass_side"]], ["grass_block_top", ["grass_top", "grass_top"]],
	["oak_planks", ["oak_planks", "planks_oak"]], ["oak_log", ["oak_log_side", "log_oak"]],
	["oak_log_top", ["oak_log_top", "log_oak_top"]], ["bricks", ["brick", "brick"]],
	["lamp_block", ["redstone_lamp_on", "redstone_lamp_on"]],
	["oak_leaves", ["oak_leaves", "leaves_oak"]], ["oak_leaves_dense", ["oak_leaves", "leaves_oak_opaque", 1]],
	["water", ["still_water_grey", "water_still_grey"]], ["water_flow", ["flowing_water_grey", "water_flow_grey"]],
	["lava", ["still_lava", "lava_still"]], ["red_flower", ["red_flower", "flower_rose"]],
	["yellow_flower", ["yellow_flower", "flower_dandelion"]], ["short_grass", ["tallgrass", "tallgrass"]],
	["snow_block", ["snow", "snow"]], ["sandstone", ["sandstone_side", "sandstone_normal"]],
	["coarse_dirt", ["coarse_dirt", "coarse_dirt"]], ["crafting_table_bottom", ["crafting_table_bottom", "planks_oak"]],
	["furnace_front", ["furnace_front", "furnace_front_off"]], ["farmland_dry", ["farmland", "farmland_dry", 1]],
	["farmland_moist", ["farmland", "farmland_wet"]], ["white_wool", ["wool", "wool_colored_white"]],
	["gray_wool", ["wool_colored_gray", "wool_colored_gray"]],
	["brown_wool", ["wool_colored_brown", "wool_colored_brown"]], ["black_wool", ["wool_colored_black", "wool_colored_black"]],
	["torch", ["torch_on", "torch_on"]], ["torch_item", ["torch", "torch"]],
	["wheat_seeds", ["seeds_wheat", "seeds_wheat"]], ["bow", ["bow_standby", "bow_standby"]],
	["bucket", ["bucket", "bucket_empty"]], ["water_bucket", ["bucket", "bucket_water", 2]],
	["lava_bucket", ["bucket", "bucket_lava", 3]],
]);
for (const [material, index] of [["wood", 0], ["stone", 1], ["iron", 2], ["copper", 6]] as const) {
	for (const tool of ["pickaxe", "axe", "shovel", "hoe"]) {
		bindings.set(`${material === "wood" ? "wooden" : material}_${tool}`, [tool, `${material}_${tool}`, index]);
	}
}
for (const [stage, index] of [["sprout", 0], ["shoot", 2], ["green", 5], ["ripe", 7]] as const) {
	bindings.set("wheat_" + stage, ["wheat", "wheat_stage_" + index, index]);
}
for (const meat of ["beef", "porkchop", "chicken", "mutton"]) {
	for (const state of ["raw", "cooked"]) bindings.set(`${state}_${meat}`, [`${meat}_${state}`, `${meat}_${state}`]);
}

// Current Bedrock block-face keys that differ from our names and the older variant arrays.
const currentBlockKeys = new Map([
	["stone", "flattened_stone"], ["dirt", "flattened_dirt"], ["sand", "flattened_sand"],
	["sandstone", "flattened_sandstone"], ["sandstone_top", "flattened_sandstone_top"],
	["sandstone_bottom", "flattened_sandstone_bottom"], ["white_wool", "wool_colored_white"],
	["furnace_front", "furnace_front_off"],
]);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array): unknown {
	// Bedrock Samples uses JSON with comments. Preserve quoted strings (including URLs).
	const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token[0] === '"' ? token : " ");
	return JSON.parse(json);
}

function parseAtlas(bytes: Uint8Array): Record<string, unknown> {
	const atlas = parseJson(bytes);
	if (!record(atlas) || !record(atlas.texture_data)) throw new Error("texture_data の形式が正しくありません");
	return atlas.texture_data;
}

function imagePath(name: string, atlas: Record<string, unknown>, item: boolean): string | undefined {
	const [key, basename, index = 0] = bindings.get(name) ?? [name, name];
	const atlasKey = [item ? undefined : currentBlockKeys.get(name), name, key]
		.find(candidate => candidate !== undefined && Object.hasOwn(atlas, candidate));
	let path: unknown = `textures/${item ? "items" : "blocks"}/${basename}`;
	if (atlasKey !== undefined) {
		const entry = atlas[atlasKey];
		const variant = atlasKey === key ? index : 0;
		if (!record(entry) || (variant > 0 && !Array.isArray(entry.textures))) return;
		path = Array.isArray(entry.textures) ? entry.textures[variant] : entry.textures;
		if (record(path)) path = path.path;
	}
	if (typeof path !== "string" || !path.startsWith("textures/")) return;
	if (path.split("/").some(part => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) return;
	return path.replace(/\.(png|tga)$/, "");
}

async function readEntry(entry: FileEntry, limit: number): Promise<Uint8Array<ArrayBuffer>> {
	if (entry.encrypted || ![0, 8].includes(entry.compressionMethod) || entry.uncompressedSize > limit) {
		throw new Error("対象ファイルのサイズまたは圧縮形式に対応していません");
	}
	const bytes = new Uint8Array(entry.uncompressedSize);
	let used = 0;
	await entry.getData(new WritableStream<Uint8Array>({
		write(chunk) {
			if (chunk.length > bytes.length - used) throw new Error("展開サイズが宣言と一致しません");
			bytes.set(chunk, used);
			used += chunk.length;
		},
	}), { checkSignature: true, useWebWorkers: false });
	if (used !== bytes.length) throw new Error("展開サイズが宣言と一致しません");
	return bytes;
}

function supportedDimensions(width: number, height: number): boolean {
	return width > 0 && width <= 512 && height > 0 && height <= 4096 && width * height <= 1024 ** 2;
}

function pngDimensions(bytes: Uint8Array): [number, number] {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (bytes.length < 33 || !signature.every((byte, i) => bytes[i] === byte)) throw new Error("PNG が破損しています");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16), height = view.getUint32(20);
	if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 || !supportedDimensions(width, height)) {
		throw new Error("PNG の寸法に対応していません");
	}
	return [width, height];
}

function staticPng(bytes: Uint8Array): boolean {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let at = 8; at < bytes.length;) {
		if (bytes.length - at < 12) throw new Error("PNG が破損しています");
		const length = view.getUint32(at);
		if (length > bytes.length - at - 12) throw new Error("PNG が破損しています");
		if (view.getUint32(at + 4) === 0x6163544c) return false;
		at += length + 12;
	}
	return true;
}

export function pngTileWidth(bytes: Uint8Array): number | undefined {
	const [width, height] = pngDimensions(bytes);
	if (height % width === 0 && staticPng(bytes)) return width;
}

async function decodeTile(bytes: Uint8Array<ArrayBuffer>, width: number, frame: number): Promise<Uint8Array> {
	const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), 0, frame * width, width, width);
	try {
		const canvas = new OffscreenCanvas(TEX_SIZE, TEX_SIZE);
		const ctx = canvas.getContext("2d")!;
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(bitmap, 0, 0, TEX_SIZE, TEX_SIZE);
		return new Uint8Array(ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE).data.buffer);
	} finally { bitmap.close(); }
}

async function decodeArt(bytes: Uint8Array<ArrayBuffer>, width: number, height: number): Promise<Uint8Array> {
	const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
	try {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d")!;
		ctx.drawImage(bitmap, 0, 0);
		return new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
	} finally { bitmap.close(); }
}

function prepareArt(path: string, pixels: Uint8Array): Uint8Array {
	const celestial = path === "environment/sun" || path === "environment/moon_phases";
	if (!celestial && !path.startsWith("environment/destroy_stage_")) return pixels;
	for (let i = 0; i < pixels.length; i += 4) {
		if (celestial) {
			// Black contributes no light. Fade the low-intensity halo into the sky.
			const brightness = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
			pixels[i + 3] = Math.round(pixels[i + 3] * Math.min(brightness / 56, 1));
		} else if (pixels[i + 3] <= 1) {
			pixels.fill(0, i, i + 4);
		}
	}
	return pixels;
}

function tgaFrames(bytes: Uint8Array, maxFrames: number): Uint8Array[] {
	if (bytes.length < 18) return [];
	const type = bytes[2], descriptor = bytes[17];
	// Reject right-to-left and interleaved images. Bit 5 marks the vertical origin.
	if (bytes[1] !== 0 || (type !== 2 && type !== 10) || bytes[16] !== 32 || (descriptor & 0xd0)) return [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint16(12, true), height = view.getUint16(14, true);
	if (!supportedDimensions(width, height)) return [];
	const total = width * height;
	let source = 18 + bytes[0];
	const pixels = new Uint8Array(total * 4);
	for (let pixel = 0; pixel < total;) {
		if (source >= bytes.length) return [];
		const packet = type === 10 ? bytes[source++] : 0;
		const repeat = (packet & 0x80) !== 0;
		const count = type === 2 ? total : (packet & 0x7f) + 1;
		const end = source + 4 * (repeat ? 1 : count);
		if (pixel + count > total || end > bytes.length) return [];
		for (let i = 0; i < count; i++, pixel++) {
			const dest = pixel * 4, p = source + (repeat ? 0 : i * 4);
			pixels[dest] = bytes[p + 2];
			pixels[dest + 1] = bytes[p + 1];
			pixels[dest + 2] = bytes[p];
			pixels[dest + 3] = bytes[p + 3];
		}
		source = end;
	}
	const size = Math.min(width, height);
	const frames: Uint8Array[] = [];
	for (let frame = 0; frame < Math.min(maxFrames, Math.floor(height / size)); frame++) {
		const tile = new Uint8Array(TEX_SIZE ** 2 * 4);
		for (let y = 0; y < TEX_SIZE; y++) {
			const row = frame * size + Math.floor((y + 0.5) * size / TEX_SIZE);
			const offset = (descriptor & 0x20 ? row : height - 1 - row) * width;
			for (let x = 0; x < TEX_SIZE; x++) {
				const p = (offset + Math.floor((x + 0.5) * size / TEX_SIZE)) * 4;
				tile.set(pixels.subarray(p, p + 4), (y * TEX_SIZE + x) * 4);
			}
		}
		frames.push(tile);
	}
	return frames;
}

const unofficialPack = "公式の Bedrock Samples の ZIP ではありません。手順 1 のページから、名前が -full.zip で終わるファイルをダウンロードしてください。";
const missingImages = "ブロックとアイテムの画像が入っていません。手順 1 のページで、名前が -full.zip で終わるファイルをダウンロードして、もう一度開いてください。";
const bedrockUuid = "66c6e9a8-3093-462a-9c36-dbb052165822";

export class MissingPackImages extends Error {
	readonly version: string;

	constructor(version: string) {
		super(missingImages);
		this.version = version;
	}
}

export function isPackVersion(value: unknown): value is string {
	return typeof value === "string" && /^\d+(?:\.\d+){2,3}(?:-preview)?$/.test(value);
}

export function packLabel(pack: TexturePack): string {
	return `Bedrock Samples v${pack.version}`;
}

export type PackProgress = (done: number, total: number) => void;

export async function importTexturePack(
	file: File, names: readonly string[], onProgress?: PackProgress, decode = decodeTile, decodeNative = decodeArt,
): Promise<TexturePack> {
	if (!/\.zip$/i.test(file.name)) throw new Error(unofficialPack);
	if (file.size > maxArchive) throw new Error("256 MiB 以下の .zip を選んでください");
	const zip = new ZipReader(new BlobReader(file), { strictness: "strict", filenameValidation: "strict" });
	try {
		const files = new Map<string, FileEntry>();
		let count = 0, expanded = 0;
		for await (const entry of zip.getEntriesGenerator()) {
			expanded += entry.uncompressedSize;
			if (++count > maxEntries || expanded > maxExpanded) throw new Error("アーカイブの件数または展開サイズが上限を超えています");
			if (entry.filename.length > 512 || /[\\:\x00-\x1f]/.test(entry.filename)) throw new Error("パック内のパスが不正です");
			if (entry.directory || entry.symlink) continue;
			const parts = entry.filename.split("/");
			if (parts.includes("__MACOSX") || parts.at(-1)!.startsWith("._")) continue;
			if (/^(?:[^/]+\/)?resource_pack\/(?:manifest\.json|textures\/(?:terrain_texture\.json|item_texture\.json|.+\.(?:png|tga)))$/.test(entry.filename)) {
				if (files.has(entry.filename)) throw new Error(unofficialPack);
				files.set(entry.filename, entry);
			}
		}
		const roots = [...files.keys()].filter(path => path.endsWith("resource_pack/manifest.json"))
			.map(path => path.slice(0, -"resource_pack/manifest.json".length))
			.filter(root => ["resource_pack/textures/terrain_texture.json", "resource_pack/textures/item_texture.json"]
				.every(path => files.has(root + path)));
		if (roots.length !== 1) throw new Error(unofficialPack);
		const [root] = roots;
		const resource = root + "resource_pack/";
		const readJson = (path: string) => readEntry(files.get(path)!, 2 * MiB);
		const manifestBytes = await readJson(resource + "manifest.json");
		const terrainBytes = await readJson(resource + "textures/terrain_texture.json");
		const itemBytes = await readJson(resource + "textures/item_texture.json");
		let version: string, terrain: Record<string, unknown>, items: Record<string, unknown>;
		try {
			const manifest = parseJson(manifestBytes);
			const header = record(manifest) && record(manifest.header) ? manifest.header : undefined;
			const engine = header?.min_engine_version;
			if (header?.uuid !== bedrockUuid || !Array.isArray(engine) || engine.length !== 3 ||
				!engine.every(part => Number.isInteger(part) && part >= 0)) {
				throw new Error(unofficialPack);
			}
			const engineParts = engine.map(part => String(BigInt(part)));
			const named = /^bedrock-samples-v(\d+(?:\.\d+){2,3})(-preview)?-full\.zip$/i.exec(file.name);
			version = named && named[1].split(".").slice(0, 3).every((part, i) => part.replace(/^0+(?=\d)/, "") === engineParts[i])
				? (named[1] + (named[2] ?? "")).toLowerCase() : engineParts.join(".");
			terrain = parseAtlas(terrainBytes);
			items = parseAtlas(itemBytes);
		} catch {
			throw new Error(unofficialPack);
		}
		const wanted = new Set(names);
		if (wanted.has("torch_item")) wanted.add("torch");
		if (wanted.has("grass_block_side")) wanted.add("dirt");
		const images = new Map<FileEntry, string[]>();
		let selected = 0;
		for (const name of wanted) {
			const item = hasItemTexture(name);
			const path = imagePath(name, item ? items : terrain, item);
			const entry = path && (files.get(resource + path + ".png") ?? files.get(resource + path + ".tga"));
			if (!entry) continue;
			const aliases = images.get(entry);
			if (aliases) aliases.push(name);
			else {
				selected += entry.uncompressedSize;
				if (selected > maxSelected) throw new Error("使用する画像の合計が 32 MiB を超えています");
				images.set(entry, [name]);
			}
		}
		const tiles = new Map<string, Uint8Array>();
		const waterFrames = new Map<string, Uint8Array[]>();
		const art = new Map<string, Uint8Array>();
		const artEntries = [...packArtDimensions].flatMap(([path, dimensions]) => {
			const entry = files.get(resource + "textures/" + path + ".png");
			return entry ? [{ path, dimensions, entry }] : [];
		});
		let done = 0;
		const total = images.size + artEntries.length;
		onProgress?.(done, total);
		for (const [entry, aliases] of images) {
			const bytes = await readEntry(entry, 4 * MiB);
			const animated = aliases.includes("water") || aliases.includes("water_flow");
			const maxFrames = animated ? WATER_FRAME_COUNT : 1;
			let frames: Uint8Array[];
			if (entry.filename.endsWith(".tga")) frames = tgaFrames(bytes, maxFrames);
			else {
				const width = pngTileWidth(bytes);
				frames = [];
				if (width) {
					const height = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);
					for (let frame = 0; frame < Math.min(maxFrames, height / width); frame++) {
						frames.push(await decode(bytes, width, frame));
					}
				}
			}
			onProgress?.(++done, total);
			if (!frames.length) continue;
			for (const name of aliases) {
				if (name === "water" || name === "water_flow") {
					const alpha = name === "water" ? 156 : 166;
					const water = frames.map(frame => {
						const pixels = frame.slice();
						for (let i = 3; i < pixels.length; i += 4) pixels[i] = alpha;
						return pixels;
					});
					waterFrames.set(name, water);
					tiles.set(name, water[0]);
				} else {
					tiles.set(name, frames[0]);
				}
			}
		}
		for (const { path, dimensions: [width, height], entry } of artEntries) {
			try {
				const extra = images.has(entry) ? 0 : entry.uncompressedSize;
				if (entry.uncompressedSize > 4 * MiB || selected + extra > maxSelected) {
					throw new Error("追加画像の展開サイズが上限を超えています");
				}
				selected += extra;
				const bytes = await readEntry(entry, 4 * MiB);
				const [w, h] = pngDimensions(bytes);
				if (w === width && h === height && staticPng(bytes)) {
					const pixels = await decodeNative(bytes, width, height);
					if (pixels.length === width * height * 4) art.set(path, prepareArt(path, pixels));
				}
			} catch {
				// Optional art falls back independently when a file is unreadable.
			}
			onProgress?.(++done, total);
		}
		const torch = tiles.get("torch");
		if (torch && wanted.has("torch_item") && !tiles.has("torch_item")) tiles.set("torch_item", torch);
		const fringe = tiles.get("grass_block_side"), dirt = tiles.get("dirt");
		if (fringe && dirt) {
			const side = dirt.slice();
			for (let i = 0; i < side.length; i += 4) {
				if (fringe[i + 3]) side.fill(0, i, i + 3);
				side[i + 3] = fringe[i + 3] ? fringe[i] : 0;
			}
			tiles.set("grass_block_side", side);
		} else tiles.delete("grass_block_side");
		if (!names.includes("torch")) tiles.delete("torch");
		if (!names.includes("dirt")) tiles.delete("dirt");
		if (!tiles.size) throw new MissingPackImages(version);
		return { version, tiles, waterFrames, art };
	} finally { await zip.close(); }
}
