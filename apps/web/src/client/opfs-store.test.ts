import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OpfsStore } from "./opfs-store.ts";
import { RegionCodec } from "./region-codec.ts";

// These integration tests use the real WASM format implementation.
// Run pnpm build:wasm, then node --test apps/web/src/client/opfs-store.test.ts.
const module = new WebAssembly.Module(readFileSync(new URL("../wasm/server.wasm", import.meta.url)));

class MemoryDirectory {
	files = new Map<string, { bytes: Uint8Array; durable: Uint8Array; open: boolean }>();
	flushes = 0;
	failFlush = 0;
	failDelete = false;
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
			getFile: async () => ({ arrayBuffer: async () => file.bytes.slice().buffer }),
			createSyncAccessHandle: async () => {
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
