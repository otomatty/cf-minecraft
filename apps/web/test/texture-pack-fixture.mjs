// Original solid-colour pixels, generated in memory for host and browser tests.
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
export const testEntries = [
	["sample/textures/terrain_texture.json", '// local test\n{"texture_data":{"stone":{"textures":[{"path":"textures/blocks/sample"}]},"grass_side":{"textures":"textures/blocks/sample"}}}'],
	["sample/textures/blocks/sample.png", solidPng(stoneRGB)],
	["sample/textures/items/apple.png", solidPng(appleRGB)],
];
export async function zipBytes(entries = testEntries) {
	const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
	for (const [path, data] of entries) {
		await writer.add(path, new Uint8ArrayReader(typeof data === "string" ? new TextEncoder().encode(data) : data));
	}
	return writer.close();
}
