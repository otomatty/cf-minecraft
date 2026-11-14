import assert from "node:assert/strict";
import { test } from "node:test";
import { type ArchiveEntry, crc32, decodeArchive, encodeArchive, MAX_ARCHIVE_BYTES } from "./world-archive.ts";
const meta = { name: "meta.json", data: new TextEncoder().encode('{"seed":"2026"}') };

// Build unchecked archives independently, including inputs the encoder rejects.
function raw(entries: ArchiveEntry[]): Uint8Array {
	const bytes = new Uint8Array(12 + entries.reduce((n, entry) => n + 10 + entry.name.length + entry.data.length, 0));
	bytes.set(new TextEncoder().encode("MCWORLD")); bytes[7] = 1;
	const view = new DataView(bytes.buffer); view.setUint32(8, entries.length, true);
	let at = 12;
	for (const { name, data } of entries) {
		view.setUint16(at, name.length, true); at += 2;
		bytes.set(new TextEncoder().encode(name), at); at += name.length;
		view.setUint32(at, data.length, true); view.setUint32(at + 4, crc32(data), true); at += 8;
		bytes.set(data, at); at += data.length;
	}
	return bytes;
}
test("archive round trips metadata and positive/negative region names, including subarray input", () => {
	const entries = [meta, { name: "r.-1.2", data: new Uint8Array([0, 255, 3]) }, { name: "r.0.-2", data: new Uint8Array() }];
	const encoded = encodeArchive(entries);
	assert.deepEqual(encoded, raw(entries));
	const padded = new Uint8Array(encoded.length + 9); padded.set(encoded, 3);
	assert.deepEqual(decodeArchive(padded.subarray(3, 3 + encoded.length)), entries);
	assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});
test("archive supports metadata only", () => assert.deepEqual(decodeArchive(encodeArchive([meta])), [meta]));
test("encoder and decoder accept canonical region names with safe integer coordinates", () => {
	for (const name of ["r.0.0", "r.-1.2", "r.12.-34", "r.9007199254740991.-9007199254740991"]) {
		const entries = [meta, { name, data: new Uint8Array() }];
		assert.deepEqual(decodeArchive(encodeArchive(entries)), entries);
		assert.deepEqual(decodeArchive(raw(entries)), entries);
	}
});
test("encoder and decoder reject noncanonical and unsafe region coordinates", () => {
	for (const name of ["r.00.0", "r.-0.0", "r.01.-2", "r.0.-00", "r.9007199254740992.0", "r.0.-9007199254740992", "r.1e2.0", "r.+1.0"]) {
		const entries = [meta, { name, data: new Uint8Array() }];
		assert.throws(() => encodeArchive(entries), /ファイル名/, name);
		assert.throws(() => decodeArchive(raw(entries)), /ファイル名/, name);
	}
});
test("archive rejects bad magic, unsupported version, CRC, trailing bytes, and every truncation", () => {
	const original = raw([meta]);
	for (const offset of [0, 7, original.length - 1]) {
		const bytes = original.slice(); bytes[offset] ^= 1;
		assert.throws(() => decodeArchive(bytes));
	}
	for (let length = 0; length < original.length; length++) assert.throws(() => decodeArchive(original.subarray(0, length)));
	assert.throws(() => decodeArchive(new Uint8Array([...original, 0])));
});
test("encoder and decoder reject forbidden names, duplicates, and missing metadata", () => {
	for (const entries of [[meta, meta], [], [{ name: "r.0.0", data: new Uint8Array() }], ...["../meta.json", "r.1.2/evil", "r.1.2\n", "meta.json\n", "other"].map(name => [meta, { name, data: new Uint8Array() }])]) {
		assert.throws(() => encodeArchive(entries));
		assert.throws(() => decodeArchive(raw(entries)));
	}
});
test("archive rejects oversized counts, lengths, invalid UTF-8, and total size", () => {
	const original = raw([meta]);
	for (const [at, value, width] of [[8, 100001, 4], [12, 65535, 2], [23, 0xffffffff, 4]]) {
		const bytes = original.slice(), view = new DataView(bytes.buffer);
		if (width === 2) view.setUint16(at, value, true); else view.setUint32(at, value, true);
		assert.throws(() => decodeArchive(bytes));
	}
	const invalid = original.slice(); invalid[14] = 255;
	assert.throws(() => decodeArchive(invalid));
	assert.throws(() => encodeArchive(Array(100001).fill(meta)));
	// Size is checked before reading data or allocating the output.
	assert.throws(() => encodeArchive([{ name: "meta.json", data: { length: MAX_ARCHIVE_BYTES } as Uint8Array }]));
	assert.throws(() => decodeArchive({ length: MAX_ARCHIVE_BYTES + 1 } as Uint8Array));
});
