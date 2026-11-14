/// <reference lib="webworker" />
// The integrated server: the same core the Durable Object runs, hosted in a
// Web Worker for single player. Edited chunks are saved to the origin private
// file system (OPFS), in crash-safe compressed region files.

import { type DirtyChunk, ServerCore } from "../shared/server-core.ts";
import { TICK_MS, TickPacer } from "../shared/tick-pacer.ts";
import type { ServerStats, WorkerEvent, WorkerRequest } from "./transport.ts";
import { type Meta, OpfsStore, PendingChunkReads, PendingChunkSaves } from "./opfs-store.ts";
import { RegionCodec } from "../shared/region-codec.ts";
import { finishWorldImport } from "./world-import.ts";

const CLIENT = 1;
const AUTOSAVE_TICKS = 100;
const STATS_TICKS = 20;
const READ_RETRY_TICKS = 20;

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(event: WorkerEvent, transfer: Transferable[] = []): void {
	scope.postMessage(event, transfer);
}

let core: ServerCore | null = null;
let store: OpfsStore | null = null;
let seed = 0n;
let currentWorld = "";
let archiveQueue: Promise<unknown> = Promise.resolve();
let persistence: PendingChunkSaves | null = null;
const reads = new PendingChunkReads((cx, cz) => persistence ? persistence.readChunk(cx, cz) : Promise.resolve(null));

function save(): Promise<void> {
	const c = core;
	const s = persistence;
	if (!c || !s) return Promise.resolve();
	// Drain synchronously so the snapshot is consistent, then write in order.
	const chunks: DirtyChunk[] = [];
	for (let d = c.takeDirty(); d !== null; d = c.takeDirty()) chunks.push(d);
	const meta: Meta = { seed: seed.toString(), gameTime: c.gameTime.toString(), dayTime: c.dayTime.toString() };
	return s.save(chunks, meta);
}

async function serveRequests(c: ServerCore): Promise<void> {
	await reads.serve(c.takeRequests(), c, Number(c.gameTime) % READ_RETRY_TICKS === 0);
}

async function init(msg: Extract<WorkerRequest, { type: "init" }>): Promise<void> {
	currentWorld = msg.world;
	const { instance } = await WebAssembly.instantiateStreaming(fetch(msg.wasmUrl), {});
	const c = new ServerCore(instance);

	store = await OpfsStore.open(msg.world, new RegionCodec(instance));
	persistence = store ? new PendingChunkSaves(store) : null;
	const meta = store ? await store.readMeta() : null;
	// An existing world keeps its seed; otherwise the page's choice or a random one.
	seed = BigInt.asIntN(64, meta ? BigInt(meta.seed) : msg.seed !== null ? BigInt(msg.seed) : crypto.getRandomValues(new BigInt64Array(1))[0]);
	c.start(seed, msg.generator);
	if (meta) c.setTime(BigInt(meta.gameTime), BigInt(meta.dayTime));
	if (msg.startTime !== null) c.setTime(c.gameTime, BigInt(msg.startTime));
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
					persistence: store ? ((persistence?.retrying || reads.retrying) ? "opfs (retrying)" : "opfs") : "off",
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
		case "export":
		case "import":
			archiveQueue = archiveQueue.then(async () => {
				if (!core || !store || !persistence) throw new Error("ブラウザの保存機能が使えないため、読み込み・書き出しができません");
				if (msg.type === "export") {
					await save();
					if (persistence.retrying) throw new Error("保存に失敗したため書き出せません。もう一度お試しください");
					const data = (await store.exportArchive()).buffer;
					post({ type: "exported", id: msg.id, data }, [data]);
				} else {
					if (msg.world === currentWorld) throw new Error("現在開いているワールドには読み込めません");
					await store.importArchive(msg.world, new Uint8Array(msg.data));
					await finishWorldImport(msg, save, persistence, post);
				}
			}).catch(error => post({ type: "archiveError", id: msg.id, message: error instanceof Error ? error.message : String(error) }));
			break;
		case "save":
			void save();
			break;
	}
};
