import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Generator, ServerCore } from "../shared/server-core.ts";
import { OpfsStore, PendingChunkReads, PendingChunkSaves } from "./opfs-store.ts";
import { decodeArchive, encodeArchive } from "./world-archive.ts";
import { CorruptRegionError, RegionCodec } from "../shared/region-codec.ts";

// These integration tests use the real WASM format implementation.
// Run pnpm build:wasm, then node --test apps/web/src/client/opfs-store.test.ts.
// Node 22 has no Web Locks; model the browser's exclusive lock queue.
const locks = new Map<string, Promise<unknown>>();
Object.defineProperty(navigator, "locks", { configurable: true, value: {
	request(name: string, run: () => Promise<unknown>) {
		const next = (locks.get(name) ?? Promise.resolve()).then(run);
		locks.set(name, next.catch(() => {}));
		return next;
	},
} });

const module = new WebAssembly.Module(readFileSync(new URL("../wasm/server.wasm", import.meta.url)));

class MemoryDirectory {
	files = new Map<string, { bytes: Uint8Array; durable: Uint8Array; open: boolean }>();
	flushes = 0;
	failFlush = 0;
	failDelete = false;
	failAccess = 0;
	accessAttempts = 0;
	operations: string[] = [];

	seed(name: string, bytes: Uint8Array) {
		this.files.set(name, { bytes: bytes.slice(), durable: bytes.slice(), open: false });
	}
	crash() {
		for (const file of this.files.values()) { file.bytes = file.durable.slice(); file.open = false; }
		this.failFlush = 0;
		this.failDelete = false;
	}
	async *keys() { yield* this.files.keys(); }
	async getDirectoryHandle() { return this; }
	async removeEntry(name: string) {
		if (this.failDelete) throw new Error("crash before deletion");
		this.operations.push(`delete ${name}`);
		this.files.delete(name);
	}
	async getFileHandle(name: string, options = { create: false }) {
		if (!this.files.has(name)) {
			if (!options.create) throw new DOMException("missing", "NotFoundError");
			this.seed(name, new Uint8Array());
		}
		const file = this.files.get(name)!;
		return {
			getFile: async () => ({ size: file.bytes.length, arrayBuffer: async () => file.bytes.slice().buffer }),
			createSyncAccessHandle: async () => {
				this.accessAttempts++;
				if (this.failAccess-- > 0) throw new DOMException("locked by another tab", "NoModificationAllowedError");
				assert.equal(file.open, false, "access handles must be serialized");
				file.open = true;
				return {
					getSize: () => file.bytes.length,
					read: (bytes: Uint8Array, { at }: { at: number }) => {
						const n = Math.min(bytes.length, file.bytes.length - at, 997);
						bytes.set(file.bytes.subarray(at, at + n));
						return n;
					},
					write: (bytes: Uint8Array, { at }: { at: number }) => {
						const n = Math.min(bytes.length, 997);
						const next = new Uint8Array(Math.max(file.bytes.length, at + n));
						next.set(file.bytes);
						next.set(bytes.subarray(0, n), at);
						file.bytes = next;
						this.operations.push(`write ${name} ${at}`);
						return n;
					},
					flush: () => {
						this.flushes++;
						if (this.flushes === this.failFlush) throw new Error("crash at flush");
						file.durable = file.bytes.slice();
						this.operations.push(`flush ${name}`);
					},
					truncate: (size: number) => { file.bytes = file.bytes.slice(0, size); },
					close: () => { file.open = false; },
				};
			},
		};
	}
}

async function open(directory: MemoryDirectory): Promise<OpfsStore> {
	Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => directory } });
	const store = await OpfsStore.open("test", new RegionCodec(new WebAssembly.Instance(module, {})));
	assert.ok(store);
	return store;
}

const old = new TextEncoder().encode("old chunk"), newer = new TextEncoder().encode("new chunk");

test("OPFS migration resumes after either flush or source deletion is interrupted", async () => {
	for (const boundary of [1, 2, 3]) {
		const dir = new MemoryDirectory();
		dir.seed("c.-1.-33", old);
		if (boundary < 3) dir.failFlush = boundary;
		else dir.failDelete = true;
		await assert.rejects((await open(dir)).list(), /crash/);
		assert.ok(dir.files.has("c.-1.-33"));
		dir.crash();
		const store = await open(dir);
		assert.deepEqual(await store.list(), [[-1, -33]]);
		assert.deepEqual(await store.readChunk(-1, -33), old);
		assert.equal(dir.files.has("c.-1.-33"), false);
		assert.ok(dir.files.has("r.-1.-2"));
		assert.equal(dir.operations.at(-1), "delete c.-1.-33");
	}
});

test("OPFS prefers the committed region and handles concurrent short reads/writes", async () => {
	const dir = new MemoryDirectory();
	const store = await open(dir);
	await store.writeChunk(-32, 31, newer);
	dir.seed("c.-32.31", old);
	assert.deepEqual(await store.list(), [[-32, 31]]);
	assert.deepEqual(await store.readChunk(-32, 31), newer);
	await Promise.all(Array.from({ length: 32 }, (_, cx) => store.writeChunk(cx, 0, old)));
	const values = await Promise.all(Array.from({ length: 32 }, (_, cx) => store.readChunk(cx, 0)));
	for (const bytes of values) assert.deepEqual(bytes, old);
	assert.equal((await store.list()).length, 33);
	assert.deepEqual(await store.readChunk(100, 100), null);
});

test("OPFS overwrite preserves committed chunks after failed data or table flush", async () => {
	for (const boundary of [1, 2]) {
		const dir = new MemoryDirectory();
		let store = await open(dir);
		await store.writeChunk(0, 0, old);
		dir.failFlush = dir.flushes + boundary;
		await assert.rejects(store.writeChunk(0, 0, newer), /crash/);
		dir.crash();
		store = await open(dir);
		assert.deepEqual(await store.readChunk(0, 0), old);
		await store.writeChunk(0, 0, newer);
		assert.deepEqual(await store.readChunk(0, 0), newer);
	}
});


test("OPFS retries contended access handles for chunks and metadata", async () => {
	const dir = new MemoryDirectory();
	const store = await open(dir);
	dir.failAccess = 2;
	await store.writeChunk(0, 0, old);
	assert.equal(dir.accessAttempts, 3);
	assert.deepEqual(await store.readChunk(0, 0), old);
	dir.failAccess = 2;
	const meta = { seed: "1", gameTime: "2", dayTime: "3" };
	await store.writeMeta(meta);
	assert.deepEqual(await store.readMeta(), meta);
});

const meta = { seed: "1", gameTime: "2", dayTime: "3" };

test("failed saves retain drained chunks, read the latest snapshot, and recover on the next save", async (t) => {
	const dir = new MemoryDirectory();
	const store = await open(dir);
	const saves = new PendingChunkSaves(store);
	const warnings = t.mock.method(console, "warn", () => {});
	dir.failAccess = 100;
	await saves.save([{ cx: 0, cz: 0, data: old }, { cx: 1, cz: 0, data: old }], meta);
	assert.equal(dir.accessAttempts, 6);
	assert.equal(saves.retrying, true);
	assert.equal(warnings.mock.callCount(), 1);
	assert.deepEqual(await saves.readChunk(0, 0), old);
	dir.failAccess = 0;
	const saving = saves.save([{ cx: 0, cz: 0, data: newer }], meta);
	assert.deepEqual(await saves.readChunk(0, 0), newer);
	await saving;
	assert.equal(saves.retrying, false);
	assert.deepEqual(await store.readChunk(0, 0), newer);
	assert.deepEqual(await store.readChunk(1, 0), old);
	assert.deepEqual(await store.readMeta(), meta);
});

test("a snapshot arriving during a write remains pending until its own write succeeds", async (t) => {
	const store = await open(new MemoryDirectory());
	const saves = new PendingChunkSaves(store);
	const write = store.writeChunk.bind(store);
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	t.mock.method(store, "writeChunk", async (cx: number, cz: number, data: Uint8Array) => {
		if (data === old) { entered(); await blocked; }
		await write(cx, cz, data);
	});
	const first = saves.save([{ cx: 0, cz: 0, data: old }], meta);
	await started;
	const second = saves.save([{ cx: 0, cz: 0, data: newer }], meta);
	assert.deepEqual(await saves.readChunk(0, 0), newer);
	release();
	await Promise.all([first, second]);
	assert.deepEqual(await store.readChunk(0, 0), newer);
});

test("OPFS rejects a corrupt chunk without preventing reads of other chunks", async (t) => {
	const dir = new MemoryDirectory();
	const store = await open(dir);
	await store.writeChunk(0, 0, old);
	await store.writeChunk(1, 0, newer);
	const file = dir.files.get("r.0.0")!;
	const sector = new DataView(file.bytes.buffer).getUint32(8, true);
	file.bytes[sector * 4096 + 5] ^= 1; // Damage the payload CRC, leaving the location table valid.
	await assert.rejects(store.readChunk(0, 0), CorruptRegionError);
	const warnings = t.mock.method(console, "warn", () => {});
	const target = readTarget();
	const reads = new PendingChunkReads((cx, cz) => store.readChunk(cx, cz));
	await reads.serve([[0, 0], [1, 0]], target);
	assert.deepEqual(target.missing, [[0, 0]]);
	assert.deepEqual(target.loaded, [[1, 0, newer]]);
	assert.equal(reads.retrying, false);
	assert.equal(warnings.mock.callCount(), 1);
	assert.deepEqual(await store.readChunk(1, 0), newer);
});

test("OPFS preserves empty chunks on read, listing, and migration", async () => {
	const dir = new MemoryDirectory();
	const store = await open(dir);
	const empty = new Uint8Array();
	await store.writeChunk(0, 0, empty);
	assert.deepEqual(await store.readChunk(0, 0), empty);
	assert.equal(await store.readChunk(1, 0), null);
	dir.seed("c.0.0", old);
	dir.seed("c.-1.0", empty);
	assert.deepEqual(await store.list(), [[0, 0], [-1, 0]]);
	assert.deepEqual(await store.readChunk(0, 0), empty);
	assert.deepEqual(await store.readChunk(-1, 0), empty);
	assert.equal(dir.files.has("c.0.0"), false);
	assert.equal(dir.files.has("c.-1.0"), false);
});

test("regenerating a missing stored chunk in the real core does not make it dirty", () => {
	const core = ServerCore.fromModule(module);
	core.start(1n, Generator.Flat);
	core.setStored([[0, 0]]);
	core.connect(1);
	core.packet(1, new Uint8Array([0, 1, 2])); // Hello: protocol 1, view distance 2.
	core.tick();
	assert.ok(core.takeRequests().some(([cx, cz]) => cx === 0 && cz === 0));
	core.chunkMissing(0, 0);
	for (let i = 0; i < 20; i++) core.tick();
	assert.ok(core.loadedChunks > 0);
	assert.equal(core.dirtyChunks, 0);
	assert.equal(core.takeDirty(), null);
});


test("migration flushes a readable but non-durable region before deleting its source", async () => {
	for (const failAdoptionFlush of [false, true]) {
		const dir = new MemoryDirectory();
		dir.seed("c.0.0", old);
		let store = await open(dir);
		dir.failFlush = 2;
		await assert.rejects(store.list(), /crash at flush/);
		assert.deepEqual(await store.readChunk(0, 0), old);
		if (failAdoptionFlush) {
			dir.failFlush = dir.flushes + 1;
			await assert.rejects(store.list(), /crash at flush/);
			assert.equal(dir.files.has("c.0.0"), true);
		} else {
			await store.list();
			assert.equal(dir.files.has("c.0.0"), false);
			assert.deepEqual(dir.operations.slice(-2), ["flush r.0.0", "delete c.0.0"]);
		}
		dir.crash();
		store = await open(dir);
		await store.list();
		assert.deepEqual(await store.readChunk(0, 0), old);
	}
});

function readTarget() {
	return {
		loaded: [] as Array<[number, number, Uint8Array]>,
		missing: [] as Array<[number, number]>,
		loadChunk(cx: number, cz: number, data: Uint8Array) { this.loaded.push([cx, cz, data]); },
		chunkMissing(cx: number, cz: number) { this.missing.push([cx, cz]); },
	};
}

test("exhausted access retries leave the chunk requested until a later read succeeds", async (t) => {
	t.mock.method(console, "warn", () => {});
	const dir = new MemoryDirectory();
	const store = await open(dir);
	await store.writeChunk(-1, 2, newer);
	const reads = new PendingChunkReads((cx, cz) => store.readChunk(cx, cz));
	const target = readTarget();
	dir.failAccess = 100;
	await reads.serve([[-1, 2]], target);
	assert.equal(reads.retrying, true);
	assert.deepEqual(target.loaded, []);
	assert.deepEqual(target.missing, []);
	dir.failAccess = 0;
	await reads.serve([], target, true);
	assert.equal(reads.retrying, false);
	assert.deepEqual(target.loaded, [[-1, 2, newer]]);
	assert.deepEqual(target.missing, []);
});

test("pending reads retry only when due and never overlap for the same coordinate", async (t) => {
	t.mock.method(console, "warn", () => {});
	let release!: (data: Uint8Array) => void;
	const blocked = new Promise<Uint8Array>((resolve) => { release = resolve; });
	let attempts = 0;
	const reads = new PendingChunkReads(async () => {
		if (++attempts === 1) throw new Error("temporary I/O failure");
		return blocked;
	});
	const target = readTarget();
	await reads.serve([[3, 4]], target);
	await reads.serve([], target);
	assert.equal(attempts, 1);
	const retry = reads.serve([], target, true);
	await reads.serve([[3, 4]], target, true);
	assert.equal(attempts, 2);
	assert.equal(reads.retrying, true);
	release(newer);
	await retry;
	await reads.serve([], target, true);
	assert.equal(attempts, 2);
	assert.equal(reads.retrying, false);
	assert.deepEqual(target.loaded, [[3, 4, newer]]);
	assert.deepEqual(target.missing, []);
});

test("a pending read can resolve to missing, corrupt, or empty saved data", async (t) => {
	t.mock.method(console, "warn", () => {});
	for (const result of [null, new CorruptRegionError(), new Uint8Array()]) {
		let attempts = 0;
		const reads = new PendingChunkReads(async () => {
			if (++attempts === 1) throw new Error("temporary I/O failure");
			if (result instanceof Error) throw result;
			return result;
		});
		const target = readTarget();
		await reads.serve([[0, 0]], target);
		assert.deepEqual(target.missing, []);
		await reads.serve([], target, true);
		assert.equal(reads.retrying, false);
		assert.deepEqual(target.missing, result instanceof Uint8Array ? [] : [[0, 0]]);
		assert.deepEqual(target.loaded, result instanceof Uint8Array ? [[0, 0, result]] : []);
	}
});


test("archive export waits for queued region and metadata writes", async () => {
	const dir = new MemoryDirectory(), store = await open(dir);
	const writing = store.writeChunk(0, 0, old);
	const writingMeta = store.writeMeta(meta);
	const exporting = store.exportArchive();
	await Promise.all([writing, writingMeta]);
	const entries = decodeArchive(await exporting);
	assert.deepEqual(entries.map(e => e.name).sort(), ["meta.json", "r.0.0"]);
	assert.deepEqual(entries.find(e => e.name === "r.0.0")!.data, dir.files.get("r.0.0")!.durable);
	assert.deepEqual(JSON.parse(new TextDecoder().decode(entries.find(e => e.name === "meta.json")!.data)), meta);
});

function importRoot() {
	const dirs = new Map<string, MemoryDirectory>();
	const root = {
		async *keys() { yield* dirs.keys(); },
		async getDirectoryHandle(name: string, options?: { create?: boolean }) {
			if (!dirs.has(name)) {
				if (!options?.create) throw new DOMException("missing", "NotFoundError");
				dirs.set(name, new MemoryDirectory());
			}
			return dirs.get(name)!;
		},
		async removeEntry(name: string) { dirs.delete(name); },
	};
	Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => root } });
	return dirs;
}

test("archive import preserves chunks and metadata, refuses overwrite, writes metadata last", async () => {
	const store = await open(new MemoryDirectory());
	await store.writeChunk(-1, 33, newer);
	await store.writeMeta(meta);
	const bytes = await store.exportArchive();
	const dirs = importRoot();
	await store.importArchive("copied", bytes);
	const dir = dirs.get("world-copied")!;
	assert.equal(dir.operations.at(-1), "flush meta.json");
	assert.deepEqual(await (await open(dir)).readChunk(-1, 33), newer);
	assert.deepEqual(await (await open(dir)).readMeta(), meta);
	// Restore the root after the read helpers installed their mock.
	Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => ({ async *keys() { yield "world-copied"; } }) } });
	await assert.rejects(store.importArchive("copied", bytes), /既に存在/);
});

test("invalid archives, metadata, region tables and world names never create a directory", async (t) => {
	// Exercise a codec validation failure independently of the accepted short-file format.
	t.mock.method(RegionCodec.prototype, "call", () => { throw new CorruptRegionError(); });
	const store = await open(new MemoryDirectory());
	const dirs = importRoot();
	const metadata = new TextEncoder().encode(JSON.stringify(meta));
	for (const entries of [
		[{ name: "meta.json", data: new Uint8Array([123]) }],
		[{ name: "meta.json", data: new TextEncoder().encode('{"seed":"1","gameTime":3}') }],
		[{ name: "meta.json", data: metadata }, { name: "r.0.0", data: new Uint8Array([1]) }],
	]) await assert.rejects(store.importArchive("invalid", encodeArchive(entries)));
	await assert.rejects(store.importArchive("../bad", encodeArchive([{ name: "meta.json", data: metadata }])));
	const broken = encodeArchive([{ name: "meta.json", data: metadata }]); broken[broken.length - 1] ^= 1;
	await assert.rejects(store.importArchive("invalid", broken));
	assert.equal(dirs.size, 0);
});

test("failed archive writes remove the incomplete world", async () => {
	const store = await open(new MemoryDirectory());
	await store.writeChunk(0, 0, old); await store.writeMeta(meta);
	const bytes = await store.exportArchive();
	for (const boundary of [1, 2]) {
		const dirs = importRoot();
		const original = navigator.storage.getDirectory;
		Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => {
			const root = await original();
			return { keys: () => root.keys(), removeEntry: (name: string) => root.removeEntry(name), getDirectoryHandle: async (name: string, options: { create: boolean }) => {
				const dir = await root.getDirectoryHandle(name, options) as unknown as MemoryDirectory;
				dir.failFlush = boundary;
				return dir;
			} };
		} } });
		await assert.rejects(store.importArchive("failed", bytes), /crash/);
		assert.equal(dirs.size, 0);
	}
});


test("concurrent imports of the same world serialize and only one succeeds", async () => {
	const store = await open(new MemoryDirectory());
	const dirs = importRoot();
	const bytes = encodeArchive([{ name: "meta.json", data: new TextEncoder().encode(JSON.stringify(meta)) }]);
	const results = await Promise.allSettled([store.importArchive("race", bytes), store.importArchive("race", bytes)]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	assert.equal(results.filter(result => result.status === "rejected").length, 1);
	assert.equal(dirs.size, 1);
});


test("OPFS opens, saves, and imports without Web Locks", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")!;
	Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
	try {
		const store = await open(new MemoryDirectory());
		await store.writeChunk(-1, 33, newer);
		await store.writeMeta(meta);
		assert.deepEqual(await store.readChunk(-1, 33), newer);
		assert.deepEqual(await store.readMeta(), meta);
		const bytes = await store.exportArchive();
		const dirs = importRoot();
		await store.importArchive("without-locks", bytes);
		const imported = await open(dirs.get("world-without-locks")!);
		assert.deepEqual(await imported.readChunk(-1, 33), newer);
		assert.deepEqual(await imported.readMeta(), meta);
	} finally {
		Object.defineProperty(navigator, "locks", descriptor);
	}
});

test("archive import reports corrupt regions in Japanese before creating a directory", async (t) => {
	t.mock.method(RegionCodec.prototype, "call", () => { throw new CorruptRegionError(); });
	const store = await open(new MemoryDirectory());
	const dirs = importRoot();
	const bytes = encodeArchive([
		{ name: "meta.json", data: new TextEncoder().encode(JSON.stringify(meta)) },
		{ name: "r.-1.2", data: new Uint8Array([1]) },
	]);
	await assert.rejects(store.importArchive("corrupt", bytes), {
		message: "リージョンファイル r.-1.2 が壊れています",
		cause: new CorruptRegionError(),
	});
	assert.equal(dirs.size, 0);
});


test("archive import accepts empty and short region files like normal reads", async () => {
	for (const data of [new Uint8Array(), new Uint8Array([1, 2, 3]), new Uint8Array(49151)]) {
		const source = new MemoryDirectory();
		source.seed("r.-1.2", data);
		const store = await open(source);
		await store.writeMeta(meta);
		assert.deepEqual(await store.list(), []);
		const bytes = await store.exportArchive();
		const dirs = importRoot();
		await store.importArchive("short-region", bytes);
		const dir = dirs.get("world-short-region")!;
		assert.deepEqual(dir.files.get("r.-1.2")!.durable, data);
		const imported = await open(dir);
		assert.deepEqual(await imported.list(), []);
		assert.deepEqual(await imported.readMeta(), meta);
	}
});

test("existing and imported metadata normalize seeds and times to signed i64", async () => {
	for (const values of [
		{ seed: "9223372036854775808", gameTime: "18446744073709551615", dayTime: "-9223372036854775809" },
		{ seed: "-9999999999999999999", gameTime: "99999999999999999999", dayTime: "-99999999999999999999" },
		{ seed: "2026" },
	]) {
		const normalized = {
			seed: BigInt.asIntN(64, BigInt(values.seed)).toString(),
			gameTime: BigInt.asIntN(64, BigInt(values.gameTime ?? "0")).toString(),
			dayTime: BigInt.asIntN(64, BigInt(values.dayTime ?? "0")).toString(),
		};
		const dir = new MemoryDirectory();
		dir.seed("meta.json", new TextEncoder().encode(JSON.stringify(values)));
		const store = await open(dir);
		assert.deepEqual(await store.readMeta(), normalized);
		const bytes = await store.exportArchive();
		const dirs = importRoot();
		await store.importArchive("normalized", bytes);
		const imported = await open(dirs.get("world-normalized")!);
		assert.deepEqual(await imported.readMeta(), normalized);
	}
});

test("invalid times fall back to zero for existing worlds but are refused on import", async () => {
	for (const field of ["gameTime", "dayTime"]) {
		for (const value of ["not-a-number", 3, false, {}, "123456789012345678901"]) {
			const dir = new MemoryDirectory();
			dir.seed("meta.json", new TextEncoder().encode(JSON.stringify({ ...meta, [field]: value })));
			const store = await open(dir);
			assert.deepEqual(await store.readMeta(), { ...meta, [field]: "0" });
			const bytes = await store.exportArchive();
			const dirs = importRoot();
			await assert.rejects(store.importArchive("invalid-time", bytes), /meta.json の時刻が不正です/);
			assert.equal(dirs.size, 0);
		}
	}
});

test("real WASM standalone compression uses the fixed native bytes and decodes empty data", () => {
	const codec = new RegionCodec(new WebAssembly.Instance(module, {}));
	const data = new TextEncoder().encode("Durable Object chunk");
	const encoded = codec.call(4, data);
	assert.deepEqual(encoded, new Uint8Array([
		28, 0, 0, 0, 1, 213, 246, 228, 128, 120, 156, 115, 41, 45, 74, 76, 202, 73,
		85, 240, 79, 202, 74, 77, 46, 81, 72, 206, 40, 205, 203, 6, 0, 76, 246, 7, 112,
	]));
	assert.deepEqual(codec.call(3, encoded), data);
	assert.deepEqual(codec.call(3, codec.call(4, new Uint8Array())), new Uint8Array());
});
