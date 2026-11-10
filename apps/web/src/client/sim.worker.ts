/// <reference lib="webworker" />
// The integrated server: the same core the Durable Object runs, hosted in a
// Web Worker for single player. Edited chunks are saved to the origin private
// file system (OPFS), one file per chunk for now; region files come in M1.

import { type DirtyChunk, ServerCore } from "../shared/server-core.ts";
import { TICK_MS, TickPacer } from "../shared/tick-pacer.ts";
import type { ServerStats, WorkerEvent, WorkerRequest } from "./transport.ts";

const CLIENT = 1;
const AUTOSAVE_TICKS = 100;
const STATS_TICKS = 20;

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(event: WorkerEvent, transfer: Transferable[] = []): void {
	scope.postMessage(event, transfer);
}

interface Meta {
	seed: string;
	gameTime: string;
	dayTime: string;
}

/** Chunk files in OPFS. Sync access handles exist only in workers, which is where we are. */
class OpfsStore {
	private readonly dir: FileSystemDirectoryHandle;

	private constructor(dir: FileSystemDirectoryHandle) {
		this.dir = dir;
	}

	static async open(world: string): Promise<OpfsStore | null> {
		try {
			const root = await navigator.storage.getDirectory();
			return new OpfsStore(await root.getDirectoryHandle(`world-${world}`, { create: true }));
		} catch {
			// Private browsing or an old browser: play without saving.
			return null;
		}
	}

	async list(): Promise<Array<[number, number]>> {
		const out: Array<[number, number]> = [];
		for await (const name of this.dir.keys()) {
			const m = /^c\.(-?\d+)\.(-?\d+)$/.exec(name);
			if (m) out.push([Number(m[1]), Number(m[2])]);
		}
		return out;
	}

	private async readFile(name: string): Promise<Uint8Array | null> {
		try {
			const handle = await this.dir.getFileHandle(name);
			return new Uint8Array(await (await handle.getFile()).arrayBuffer());
		} catch {
			return null;
		}
	}

	private async writeFile(name: string, data: Uint8Array): Promise<void> {
		const handle = await this.dir.getFileHandle(name, { create: true });
		const access = await handle.createSyncAccessHandle();
		try {
			access.truncate(0);
			access.write(data, { at: 0 });
			access.flush();
		} finally {
			access.close();
		}
	}

	readChunk(cx: number, cz: number): Promise<Uint8Array | null> {
		return this.readFile(`c.${cx}.${cz}`);
	}

	writeChunk(cx: number, cz: number, data: Uint8Array): Promise<void> {
		return this.writeFile(`c.${cx}.${cz}`, data);
	}

	async readMeta(): Promise<Meta | null> {
		const bytes = await this.readFile("meta.json");
		if (!bytes) return null;
		try {
			const meta = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Meta>;
			if (typeof meta.seed === "string" && /^-?\d{1,19}$/.test(meta.seed)) {
				return { seed: meta.seed, gameTime: meta.gameTime ?? "0", dayTime: meta.dayTime ?? "0" };
			}
		} catch {
			// Unreadable meta: treat the world as new.
		}
		return null;
	}

	writeMeta(meta: Meta): Promise<void> {
		return this.writeFile("meta.json", new TextEncoder().encode(JSON.stringify(meta)));
	}
}

let core: ServerCore | null = null;
let store: OpfsStore | null = null;
let seed = 0n;
let saving: Promise<void> = Promise.resolve();

function save(): Promise<void> {
	const c = core;
	const s = store;
	if (!c || !s) return saving;
	// Drain synchronously so the snapshot is consistent, then write in order.
	const chunks: DirtyChunk[] = [];
	for (let d = c.takeDirty(); d !== null; d = c.takeDirty()) chunks.push(d);
	const meta: Meta = { seed: seed.toString(), gameTime: c.gameTime.toString(), dayTime: c.dayTime.toString() };
	saving = saving.then(async () => {
		for (const chunk of chunks) await s.writeChunk(chunk.cx, chunk.cz, chunk.data);
		await s.writeMeta(meta);
	});
	return saving;
}

async function serveRequests(c: ServerCore): Promise<void> {
	for (const [cx, cz] of c.takeRequests()) {
		const data = store ? await store.readChunk(cx, cz) : null;
		if (data) c.loadChunk(cx, cz, data);
		else c.chunkMissing(cx, cz);
	}
}

async function init(msg: Extract<WorkerRequest, { type: "init" }>): Promise<void> {
	const { instance } = await WebAssembly.instantiateStreaming(fetch(msg.wasmUrl), {});
	const c = new ServerCore(instance);

	store = await OpfsStore.open(msg.world);
	const meta = store ? await store.readMeta() : null;
	// An existing world keeps its seed; otherwise the page's choice or a random one.
	seed = meta ? BigInt(meta.seed) : msg.seed !== null ? BigInt(msg.seed) : crypto.getRandomValues(new BigInt64Array(1))[0];
	c.start(seed, msg.generator);
	if (meta) c.setTime(BigInt(meta.gameTime), BigInt(meta.dayTime));
	if (store) c.setStored(await store.list());
	c.connect(CLIENT);
	core = c;
	post({ type: "ready", seed: seed.toString(), persistence: store ? "opfs" : "off" });

	const pacer = new TickPacer(performance.now());
	let spent: number[] = [];
	setInterval(() => {
		const due = pacer.due(performance.now());
		for (let i = 0; i < due; i++) {
			const start = performance.now();
			c.tick();
			const packets = c.takeOutbox();
			spent.push(performance.now() - start);

			if (packets.length > 0) {
				const list = packets.map((p) => p.data.slice().buffer);
				post({ type: "packets", list }, list);
			}
			void serveRequests(c);

			const t = Number(c.gameTime);
			if (t % AUTOSAVE_TICKS === 0) void save();
			if (t % STATS_TICKS === 0) {
				const stats: ServerStats = {
					gameTime: t,
					tps: pacer.measuredTps,
					msptMean: spent.reduce((a, b) => a + b, 0) / spent.length,
					msptMax: Math.max(...spent),
					loadedChunks: c.loadedChunks,
					persistence: store ? "opfs" : "off",
					memoryBytes: c.memoryBytes,
				};
				spent = [];
				post({ type: "stats", stats });
			}
		}
	}, TICK_MS);
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const msg = event.data;
	switch (msg.type) {
		case "init":
			init(msg).catch((err) => post({ type: "error", message: String(err) }));
			break;
		case "packet":
			core?.packet(CLIENT, new Uint8Array(msg.data));
			break;
		case "save":
			void save();
			break;
	}
};
