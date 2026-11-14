/** Portable world archive. All integers are little endian; CRC is CRC-32/IEEE. */
export interface ArchiveEntry { name: string; data: Uint8Array }
export const MAX_ARCHIVE_BYTES = 1024 ** 3;
const MAX_ENTRIES = 100_000;
const magic = new TextEncoder().encode("MCWORLD");
const validName = (name: string) => name === "meta.json" || /^r\.-?\d+\.-?\d+$/.test(name);
const table = Uint32Array.from({ length: 256 }, (_, n) => {
	for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
	return n >>> 0;
});
export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
	return (crc ^ 0xffffffff) >>> 0;
}
function checkName(name: string, seen: Set<string>): void {
	if (!validName(name) || seen.has(name)) throw new Error("アーカイブのファイル名が不正または重複しています");
	seen.add(name);
}
export function encodeArchive(entries: readonly ArchiveEntry[]): Uint8Array<ArrayBuffer> {
	if (entries.length > MAX_ENTRIES) throw new Error("アーカイブの項目数が上限を超えています");
	const seen = new Set<string>();
	const names = entries.map(({ name }) => {
		checkName(name, seen);
		const bytes = new TextEncoder().encode(name);
		if (bytes.length > 65535) throw new Error("ファイル名が長すぎます");
		return bytes;
	});
	if (!seen.has("meta.json")) throw new Error("meta.json がありません");
	const size = entries.reduce((n, entry, i) => n + 10 + names[i].length + entry.data.length, 12);
	if (size > MAX_ARCHIVE_BYTES) throw new Error("アーカイブは 1 GiB 以下にしてください");
	const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
	bytes.set(magic); bytes[7] = 1; view.setUint32(8, entries.length, true);
	let at = 12;
	entries.forEach(({ data }, i) => {
		const name = names[i];
		view.setUint16(at, name.length, true); at += 2;
		bytes.set(name, at); at += name.length;
		view.setUint32(at, data.length, true); view.setUint32(at + 4, crc32(data), true); at += 8;
		bytes.set(data, at); at += data.length;
	});
	return bytes;
}
export function decodeArchive(bytes: Uint8Array): ArchiveEntry[] {
	if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("アーカイブは 1 GiB 以下にしてください");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = 0;
	const take = (length: number) => {
		if (length > bytes.length - at) throw new Error("アーカイブが途中で切れています");
		const start = at; at += length; return start;
	};
	take(12);
	if (!magic.every((byte, i) => bytes[i] === byte)) throw new Error("MCWORLD ファイルではありません");
	if (bytes[7] !== 1) throw new Error("対応していないアーカイブの版です");
	const count = view.getUint32(8, true);
	if (count > MAX_ENTRIES) throw new Error("アーカイブの項目数が上限を超えています");
	const entries: ArchiveEntry[] = [], seen = new Set<string>();
	for (let i = 0; i < count; i++) {
		const length = view.getUint16(take(2), true);
		const nameStart = take(length);
		const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(nameStart, nameStart + length));
		checkName(name, seen);
		const header = take(8), size = view.getUint32(header, true), crc = view.getUint32(header + 4, true);
		const start = take(size), data = bytes.subarray(start, start + size);
		if (crc32(data) !== crc) throw new Error("アーカイブの CRC が一致しません");
		entries.push({ name, data });
	}
	if (at !== bytes.length) throw new Error("アーカイブの末尾に余分なデータがあります");
	if (!seen.has("meta.json")) throw new Error("meta.json がありません");
	return entries;
}
