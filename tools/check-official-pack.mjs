import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { inflateSync } from "node:zlib";
import { ClientCore, gameTextureLayout } from "../apps/web/src/client/client-core.ts";
import { importTexturePack, packArtDimensions } from "../apps/web/src/client/texture-pack.ts";
import { TEX_SIZE } from "../apps/web/src/client/textures.ts";
import { crc32 } from "../apps/web/src/client/world-archive.ts";

// Validate native PNG payloads without the browser's image decoder.
function checkPng(bytes, width, height) {
	const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const depth = png[24], color = png[25], interlace = png[28];
	const formats = new Map([[0, [1, 1, 2, 4, 8, 16]], [2, [3, 8, 16]], [3, [1, 1, 2, 4, 8]],
		[4, [2, 8, 16]], [6, [4, 8, 16]]]);
	const [channels, ...depths] = formats.get(color) ?? [];
	if (!depths.includes(depth) || png[26] || png[27] || interlace > 1) throw new Error("Invalid PNG format");
	const data = [];
	let palette = false, complete = false;
	for (let at = 8; at < png.length;) {
		const length = png.readUInt32BE(at), end = at + 8 + length;
		const kind = png.toString("ascii", at + 4, at + 8);
		if (crc32(png.subarray(at + 4, end)) !== png.readUInt32BE(end)) throw new Error("Invalid PNG CRC");
		if (kind === "PLTE") palette = length > 0 && length % 3 === 0 && length <= 768;
		if (kind === "IDAT") data.push(png.subarray(at + 8, end));
		if (kind === "IEND") complete = length === 0 && end + 4 === png.length;
		at = end + 4;
	}
	if (!complete || !data.length || (color === 3 && !palette)) throw new Error("Incomplete PNG");
	const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
		[0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
	const rows = passes.flatMap(([x, y, dx, dy]) => {
		const columns = Math.ceil((width - x) / dx);
		const count = Math.ceil((height - y) / dy);
		return columns > 0 && count > 0 ? Array(count).fill(1 + Math.ceil(columns * channels * depth / 8)) : [];
	});
	const size = rows.reduce((sum, row) => sum + row, 0);
	const filtered = inflateSync(Buffer.concat(data), { maxOutputLength: size });
	let offset = 0;
	for (const row of rows) {
		if (filtered[offset] > 4) throw new Error("Invalid PNG row filter");
		offset += row;
	}
	if (filtered.length !== size) throw new Error("Invalid PNG pixel data");
	return new Uint8Array(width * height * 4);
}

function report(version, names, missing) {
	console.log(`Bedrock Samples v${version}`);
	console.log(`Resolved: ${names.length - missing.length}/${names.length}`);
	console.log(`Unresolved: ${missing.join(", ") || "none"}`);
	if (missing.length) process.exitCode = 1;
}

async function checkPack(path) {
	const wasm = await readFile(new URL("../apps/web/src/wasm/client.wasm", import.meta.url));
	const { instance } = await WebAssembly.instantiate(wasm, {});
	const layout = gameTextureLayout(new ClientCore(instance));
	const names = [...new Set(layout.names)];
	const art = [...packArtDimensions.keys()];
	const required = [...names, ...art];
	const file = new File([await openAsBlob(path)], basename(path));
	const pack = await importTexturePack(file, layout, undefined, async () => new Uint8Array(TEX_SIZE ** 2 * 4), checkPng);
	report(pack.version, required, [...names.filter(name => !pack.tiles.has(name)),
		...art.filter(path => !pack.art.has(path)).map(path => path + ".png")]);
	console.log(`Cracks, sky and HUD: ${pack.art.size}/${art.length}`);
}

const [path] = process.argv.slice(2);
if (process.argv.length !== 3) {
	console.error("Usage: node tools/check-official-pack.mjs <zip>");
	process.exitCode = 1;
} else {
	try {
		await checkPack(path);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
