import { BlobReader, ZipReader, type FileEntry } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { hasItemTexture } from "./item-textures.ts";
import { TEX_SIZE } from "./textures.ts";

const MiB = 1024 ** 2;
const maxArchive = 256 * MiB, maxExpanded = 512 * MiB, maxSelected = 32 * MiB;
const maxEntries = 32_768;
export interface TexturePack {
	version: string;
	tiles: Map<string, Uint8Array>;
}

// Internal name -> Bedrock atlas key, conventional PNG basename, variant index.
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

function pngPath(name: string, atlas: Record<string, unknown>, item: boolean): string | undefined {
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
	return path.endsWith(".png") ? path : path + ".png";
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

export function pngTileWidth(bytes: Uint8Array): number | undefined {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (bytes.length < 33 || !signature.every((byte, i) => bytes[i] === byte)) throw new Error("PNG が破損しています");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16), height = view.getUint32(20);
	if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 || !width || width > 512 ||
		!height || height > 4096 || width * height > 1024 ** 2) {
		throw new Error("PNG の寸法に対応していません");
	}
	if (height % width !== 0) return;
	for (let at = 8; at < bytes.length;) {
		if (bytes.length - at < 12) throw new Error("PNG が破損しています");
		const length = view.getUint32(at);
		if (length > bytes.length - at - 12) throw new Error("PNG が破損しています");
		if (view.getUint32(at + 4) === 0x6163544c) return;
		at += length + 12;
	}
	return width;
}

async function decodeTile(bytes: Uint8Array<ArrayBuffer>, width: number): Promise<Uint8Array> {
	const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), 0, 0, width, width);
	try {
		const canvas = new OffscreenCanvas(TEX_SIZE, TEX_SIZE);
		const ctx = canvas.getContext("2d")!;
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(bitmap, 0, 0, TEX_SIZE, TEX_SIZE);
		return new Uint8Array(ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE).data.buffer);
	} finally { bitmap.close(); }
}

const unofficialPack = "公式の Bedrock Samples の ZIP ではありません。手順 1 のページから、名前が -full.zip で終わるファイルをダウンロードしてください。";
const missingImages = "ブロックとアイテムの画像が入っていません。手順 1 のページで、名前が -full.zip で終わるファイルをダウンロードして、もう一度開いてください。";
const bedrockUuid = "66c6e9a8-3093-462a-9c36-dbb052165822";

export function isPackVersion(value: unknown): value is string {
	return typeof value === "string" && /^\d+(?:\.\d+){2,3}$/.test(value);
}

export function packLabel(pack: TexturePack): string {
	return `Bedrock Samples v${pack.version}`;
}

export type PackProgress = (done: number, total: number) => void;

export async function importTexturePack(
	file: File, names: readonly string[], onProgress?: PackProgress, decode = decodeTile,
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
			if (/^(?:[^/]+\/)?(?:version\.json|resource_pack\/(?:manifest\.json|textures\/(?:terrain_texture\.json|item_texture\.json|.+\.png)))$/.test(entry.filename)) {
				if (files.has(entry.filename)) throw new Error(unofficialPack);
				files.set(entry.filename, entry);
			}
		}
		const roots = [...files.keys()].filter(path => /^(?:[^/]+\/)?version\.json$/.test(path))
			.map(path => path.slice(0, -"version.json".length))
			.filter(root => ["resource_pack/manifest.json", "resource_pack/textures/terrain_texture.json", "resource_pack/textures/item_texture.json"]
				.every(path => files.has(root + path)));
		if (roots.length !== 1) throw new Error(unofficialPack);
		const [root] = roots;
		const resource = root + "resource_pack/";
		const readJson = (path: string) => readEntry(files.get(path)!, 2 * MiB);
		const versionBytes = await readJson(root + "version.json");
		const manifestBytes = await readJson(resource + "manifest.json");
		const terrainBytes = await readJson(resource + "textures/terrain_texture.json");
		const itemBytes = await readJson(resource + "textures/item_texture.json");
		let version: unknown, terrain: Record<string, unknown>, items: Record<string, unknown>;
		try {
			const info = parseJson(versionBytes), manifest = parseJson(manifestBytes);
			version = record(info) && record(info.latest) ? info.latest.version : undefined;
			if (!isPackVersion(version) || !record(manifest) || !record(manifest.header) || manifest.header.uuid !== bedrockUuid) {
				throw new Error(unofficialPack);
			}
			terrain = parseAtlas(terrainBytes);
			items = parseAtlas(itemBytes);
		} catch {
			throw new Error(unofficialPack);
		}
		const wanted = new Set(names);
		if (wanted.has("torch_item")) wanted.add("torch");
		const images = new Map<FileEntry, string[]>();
		let selected = 0;
		for (const name of wanted) {
			const item = hasItemTexture(name);
			const path = pngPath(name, item ? items : terrain, item);
			const entry = path && files.get(resource + path);
			if (!entry) continue;
			const aliases = images.get(entry);
			if (aliases) aliases.push(name);
			else {
				selected += entry.uncompressedSize;
				if (selected > maxSelected) throw new Error("使用する PNG の合計が 32 MiB を超えています");
				images.set(entry, [name]);
			}
		}
		const tiles = new Map<string, Uint8Array>();
		let done = 0;
		onProgress?.(done, images.size);
		for (const [entry, aliases] of images) {
			const bytes = await readEntry(entry, 4 * MiB);
			const width = pngTileWidth(bytes);
			if (width) {
				const pixels = await decode(bytes, width);
				for (const name of aliases) tiles.set(name, pixels);
			}
			onProgress?.(++done, images.size);
		}
		const torch = tiles.get("torch");
		if (torch && wanted.has("torch_item") && !tiles.has("torch_item")) tiles.set("torch_item", torch);
		if (!names.includes("torch")) tiles.delete("torch");
		if (!tiles.size) throw new Error(missingImages);
		return { version, tiles };
	} finally { await zip.close(); }
}
