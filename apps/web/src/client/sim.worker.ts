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
let stopGeneration: ((error: Error) => void) | null = null;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let initEpoch = 0;

async function startGeneration(wasmUrl: string, c: ServerCore): Promise<void> {
	const workers = generationWorkers;
	const cancelStartup: Array<(error: Error) => void> = [];
	const startups: Promise<void>[] = [];
	const queues: Array<Map<number, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>> = [];
	let stopped = false;
	const stop = (error: Error) => {
		if (stopped) return;
		stopped = true;
		for (const cancel of cancelStartup.splice(0)) cancel(error);
		for (const worker of workers.splice(0)) worker.terminate();
		for (const pending of queues) {
			for (const request of pending.values()) request.reject(error);
			pending.clear();
		}
		if (generationWorkers === workers) {
			if (generation && !generationFailed) console.warn("Generation workers disabled", error);
			generationFailed = true;
			c.setExternalGeneration(0);
			stopGeneration = null;
		}
	};
	stopGeneration = stop;
	try {
		const count = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 3) - 2));
		let id = 0;
		const requests: Array<(cx: number, cz: number) => Promise<Uint8Array>> = [];
		for (let i = 0; i < count; i++) {
			const worker = new Worker(new URL("./gen.worker.ts", import.meta.url), { type: "module" });
			workers.push(worker);
			const pending = new Map<number, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>();
			queues.push(pending);
			startups.push(new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => stop(new Error("Generation worker startup timed out")), 5000);
				cancelStartup.push(error => { clearTimeout(timer); reject(error); });
				worker.onerror = () => stop(new Error("Generation worker failed"));
				worker.onmessage = (event: MessageEvent<GenReply>) => {
					const msg = event.data;
					if (msg.type === "ready") { clearTimeout(timer); resolve(); }
					else if (msg.type === "error") stop(new Error(msg.message));
					else {
						pending.get(msg.id)?.resolve(msg.bytes);
						pending.delete(msg.id);
					}
				};
				worker.postMessage({ type: "init", wasmUrl, seed: seed.toString(), generator } satisfies GenRequest);
			}));
			requests.push((cx, cz) => new Promise((resolve, reject) => {
				if (stopped) { reject(new Error("Generation workers disabled")); return; }
				const requestId = ++id;
				pending.set(requestId, { resolve, reject });
				try { worker.postMessage({ type: "generate", id: requestId, cx, cz } satisfies GenRequest); }
				catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
			}));
		}
		await Promise.all(startups);
		if (generationWorkers !== workers || stopped) return;
		const limit = generationInFlightLimit(count);
		generation = new GenerationDispatcher((cx, cz) => requests[leastPendingWorker(queues)](cx, cz), limit, 5000);
		c.setExternalGeneration(limit);
	} catch (error) {
		stop(error instanceof Error ? error : new Error(String(error)));
		await Promise.allSettled(startups);
		console.warn("Generation workers unavailable", error);
	}
}

function pumpGeneration(c: ServerCore): void {
	generation?.pump(c);
	if (generation?.failed) stopGeneration?.(new Error("Generation request timed out"));
	if (generationFailed) c.setExternalGeneration(0);
}

const CLIENT = 1;
const AUTOSAVE_TICKS = 100;
const DIRTY_SAVE_TICKS = 20;
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
let gameMode: "creative" | "survival" = "creative";
let currentWorld = "";
let archiveQueue: Promise<unknown> = Promise.resolve();
let persistence: PendingChunkSaves | null = null;
let saving: Promise<void> | null = null;
let lastSaveTick = 0;
const reads = new PendingChunkReads((cx, cz) => persistence ? persistence.readChunk(cx, cz) : Promise.resolve(null));

function save(includeEntityChanges = true): Promise<void> {
	const c = core;
	const s = persistence;
	if (!c || !s) return Promise.resolve();
	if (includeEntityChanges) c.flushEntityChanges();
	// Drain synchronously so the snapshot is consistent, then write in order.
	const chunks: DirtyChunk[] = [];
	for (let d = c.takeDirty(); d !== null; d = c.takeDirty()) chunks.push(d);
	const meta: Meta = { gameMode, generator, seed: seed.toString(), gameTime: c.gameTime.toString(), dayTime: c.dayTime.toString() };
	lastSaveTick = Number(meta.gameTime);
	const pending = s.save(chunks, meta, c.inventoryData(CLIENT));
	saving = pending;
	return pending.finally(() => {
		if (saving === pending) saving = null;
	});
}

async function serveRequests(c: ServerCore): Promise<void> {
	await reads.serve(c.takeRequests(), c, Number(c.gameTime) % READ_RETRY_TICKS === 0);
}

async function init(msg: Extract<WorkerRequest, { type: "init" }>): Promise<void> {
	const epoch = ++initEpoch;
	clearInterval(tickTimer);
	generation?.reset();
	generation = null;
	stopGeneration?.(new Error("World reset"));
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
	const meta = store ? await store.initializeMeta(requestedSeed, msg.generator, msg.gameMode) : null;
	if (epoch !== initEpoch) return;
	seed = BigInt.asIntN(64, BigInt(meta?.seed ?? requestedSeed));
	generator = meta?.generator ?? msg.generator;
	gameMode = meta?.gameMode ?? msg.gameMode ?? "creative";
	c.start(seed, generator);
	c.setEntityPersistence(store !== null);
	c.setGameMode(gameMode);
	if (meta) c.setTime(BigInt(meta.gameTime), BigInt(meta.dayTime));
	if (msg.startTime !== null) c.setTime(c.gameTime, BigInt(msg.startTime));
	if (store) c.setStored(await store.list());
	if (epoch !== initEpoch) return;
	// Read failures must reach the init error handler before connecting or starting workers.
	const player = store ? await store.readPlayer() : null;
	if (epoch !== initEpoch) return;
	if (msg.genworkers !== false) await startGeneration(msg.wasmUrl, c);
	if (epoch !== initEpoch) return;
	c.connect(CLIENT, import.meta.env.DEV, undefined, player ?? undefined, "あなた");
	c.setOperator(CLIENT, true);
	saving = null;
	lastSaveTick = Number(c.gameTime);
	core = c;
	post({ type: "ready", generator, seed: seed.toString(), persistence: store ? "opfs" : "off" });

	const pacer = new TickPacer(performance.now());
	let spent: number[] = [];
	tickTimer = setInterval(() => {
		const due = pacer.due(performance.now());
		for (let i = 0; i < due; i++) {
			const start = performance.now();
			pumpGeneration(c);
			c.tick();
			pumpGeneration(c);
			const packets = c.takeOutbox();
			spent.push(performance.now() - start);

			if (packets.length > 0) {
				const list = packets.map((p) => p.data.slice().buffer);
				post({ type: "packets", list }, list);
			}
			void serveRequests(c);

			const t = Number(c.gameTime);
			const sinceSave = t - lastSaveTick;
			// Explicit saves use the store's serial queue. Avoid queuing periodic
			// snapshots while any save is still pending.
			if (persistence && !saving && (sinceSave >= AUTOSAVE_TICKS || (sinceSave >= DIRTY_SAVE_TICKS && c.dirtyChunks > 0))) void save(false);
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
		case "debugDayTime":
			if (import.meta.env.DEV && core && Number.isInteger(msg.tick) && msg.tick >= 0 && msg.tick < 24000) {
				core.setTime(core.gameTime, BigInt(msg.tick));
			}
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
