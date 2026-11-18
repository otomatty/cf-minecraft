/// <reference lib="webworker" />
import { ChunkGenCore } from "../shared/server-core.ts";

export type GenRequest = { type: "init"; wasmUrl: string; seed: string; generator: number } | { type: "generate"; id: number; cx: number; cz: number };
export type GenReply = { type: "ready" } | { type: "result"; id: number; bytes: Uint8Array<ArrayBuffer> } | { type: "error"; message: string };
const scope = self as unknown as DedicatedWorkerGlobalScope;
let core: ChunkGenCore;
let seed: bigint;
let generator: number;
scope.onmessage = async (event: MessageEvent<GenRequest>) => {
	try {
		const msg = event.data;
		if (msg.type === "init") {
			const { instance } = await WebAssembly.instantiateStreaming(fetch(msg.wasmUrl), {});
			core = new ChunkGenCore(instance);
			seed = BigInt(msg.seed);
			generator = msg.generator;
			scope.postMessage({ type: "ready" } satisfies GenReply);
		} else {
			const bytes = new Uint8Array(core.generate(seed, generator, msg.cx, msg.cz));
			scope.postMessage({ type: "result", id: msg.id, bytes } satisfies GenReply, [bytes.buffer]);
		}
	} catch (error) { scope.postMessage({ type: "error", message: String(error) } satisfies GenReply); }
};
