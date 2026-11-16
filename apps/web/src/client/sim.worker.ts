/// <reference lib="webworker" />
// The integrated server: the same core the Durable Object runs, hosted in a
// Web Worker for single player. Edited chunks are saved to the origin private
// file system (OPFS), in crash-safe compressed region files.

import { type DirtyChunk, Generator, ServerCore } from "../shared/server-core.ts";
import { TICK_MS, TickPacer } from "../shared/tick-pacer.ts";
import type { ServerStats, WorkerEvent, WorkerRequest } from "./transport.ts";
import { type Meta, OpfsStore, PendingChunkReads, PendingChunkSaves } from "./opfs-store.ts";
import { RegionCodec } from "../shared/region-codec.ts";
import { confirmSaved, finishWorldImport } from "./world-import.ts";

import { GenerationDispatcher } from "../shared/gen-dispatch.ts";
import type { GenReply, GenRequest } from "./gen.worker.ts";
import { generationInFlightLimit, leastPendingWorker } from "./gen-scheduling.ts";

let generation: GenerationDispatcher | null = null;
let generationWorkers: Worker[] = [];
let generationFailed = false;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let initEpoch = 0;

async function startGeneration(wasmUrl: string, c: ServerCore): Promise<void> {
	const workers = generationWorkers;
	const cancelStartup: Array<() => void> = [];
	try {
		const count = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 3) - 2));
		let id = 0;
		const queues: Array<Map<number, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>> = [];
		const requests: Array<(cx: number, cz: number) => Promise<Uint8Array>> = [];
		const startups: Promise<void>[] = [];
		for (let i = 0; i < count; i++) {
			const worker = new Worker(new URL("./gen.worker.ts", import.meta.url), { type: "module" });
			workers.push(worker);
			const pending = new Map<number, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>();
			queues.push(pending);
			startups.push(new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Generation worker startup timed out")), 5000);
				cancelStartup.push(() => clearTimeout(timer));
				const fail = (error: Error) => {
					clearTimeout(timer);
					reject(error);
					for (const request of pending.values()) request.reject(error);
					pending.clear();
					if (generationWorkers === workers) {
						if (generation && !generationFailed) console.warn("Generation workers disabled", error);
						generationFailed = true;
					}
				};
				worker.onerror = () => fail(new Error("Generation worker failed"));
				worker.onmessage = (event: MessageEvent<GenReply>) => {
					const msg = event.data;
					if (msg.type === "ready") { clearTimeout(timer); resolve(); }
					else if (msg.type === "error") fail(new Error(msg.message));
					else {
						pending.get(msg.id)?.resolve(msg.bytes);
						pending.delete(msg.id);
					}
				};
				worker.postMessage({ type: "init", wasmUrl, seed: seed.toString(), generator } satisfies GenRequest);
			}));
			requests.push((cx, cz) => new Promise((resolve, reject) => {
				const requestId = ++id;
				pending.set(requestId, { resolve, reject });
				try { worker.postMessage({ type: "generate", id: requestId, cx, cz } satisfies GenRequest); }
				catch (error) { pending.delete(requestId); reject(error); }
			}));
		}
		await Promise.all(startups);
		if (generationWorkers !== workers) return;
		const limit = generationInFlightLimit(count);
		generation = new GenerationDispatcher((cx, cz) => requests[leastPendingWorker(queues)](cx, cz), limit, 5000);
		c.setExternalGeneration(limit);
	} catch (error) {
		for (const cancel of cancelStartup) cancel();
		for (const worker of workers) worker.terminate();
		console.warn("Generation workers unavailable", error);
	}
}

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
let generator: number = Generator.Terrain;
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
	const meta: Meta = { generator, seed: seed.toString(), gameTime: c.gameTime.toString(), dayTime: c.dayTime.toString() };
	return s.save(chunks, meta);
}

async function serveRequests(c: ServerCore): Promise<void> {
	await reads.serve(c.takeRequests(), c, Number(c.gameTime) % READ_RETRY_TICKS === 0);
}

async function init(msg: Extract<WorkerRequest, { type: "init" }>): Promise<void> {
	const epoch = ++initEpoch;
	clearInterval(tickTimer);
	generation?.reset();
	generation = null;
	for (const worker of generationWorkers) worker.terminate();
	generationWorkers = [];
	generationFailed = false;
	core = null;
	currentWorld = msg.world;
	const { instance } = await WebAssembly.instantiateStreaming(fetch(msg.wasmUrl), {});
	if (epoch !== initEpoch) return;
	const c = new ServerCore(instance);

	const openedStore = await OpfsStore.open(msg.world, new RegionCodec(instance));
	if (epoch !== initEpoch) return;
	store = openedStore;
	persistence = store ? new PendingChunkSaves(store) : null;
	const requestedSeed = msg.seed ?? crypto.getRandomValues(new BigInt64Array(1))[0].toString();
	const meta = store ? await store.initializeMeta(requestedSeed, msg.generator) : null;
	if (epoch !== initEpoch) return;
	seed = BigInt.asIntN(64, BigInt(meta?.seed ?? requestedSeed));
	generator = meta?.generator ?? msg.generator;
	c.start(seed, generator);
	if (meta) c.setTime(BigInt(meta.gameTime), BigInt(meta.dayTime));
	if (msg.startTime !== null) c.setTime(c.gameTime, BigInt(msg.startTime));
	if (store) c.setStored(await store.list());
	if (epoch !== initEpoch) return;
	if (msg.genworkers !== false) await startGeneration(msg.wasmUrl, c);
	if (epoch !== initEpoch) return;
	c.connect(CLIENT, import.meta.env.DEV);
	core = c;
	post({ type: "ready", generator, seed: seed.toString(), persistence: store ? "opfs" : "off" });

	const pacer = new TickPacer(performance.now());
	let spent: number[] = [];
	tickTimer = setInterval(() => {
		const due = pacer.due(performance.now());
		for (let i = 0; i < due; i++) {
			const start = performance.now();
			generation?.pump(c);
			c.tick();
			generation?.pump(c);
			if (generationFailed) c.setExternalGeneration(0);
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
					generation: generation?.stats() ?? null,
					biome: c.clientBiome(CLIENT),
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
		case "saveNow":
			archiveQueue = archiveQueue.then(async () => {
				if (!core || !store || !persistence) {
					post({ type: "saved", id: msg.id });
					return;
				}
				await confirmSaved(save, persistence);
				post({ type: "saved", id: msg.id });
			}).catch(error => post({ type: "archiveError", id: msg.id, message: error instanceof Error ? error.message : String(error) }));
			break;
		case "save":
			void save();
			break;
	}
};
