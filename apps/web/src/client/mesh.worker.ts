import clientWasmUrl from "../wasm/client.wasm?url";
import { type ClientExports, WORDS_PER_QUAD } from "./client-core.ts";
import type { MeshReply, MeshRequest } from "./mesh-pool.ts";

const scope = self as unknown as {
	onmessage: ((event: MessageEvent<MeshRequest>) => void) | null;
	postMessage(message: MeshReply, transfer: Transferable[]): void;
};
const { instance } = await WebAssembly.instantiateStreaming(fetch(clientWasmUrl), {});
const x = instance.exports as unknown as ClientExports;
// Deliberately no client_new: this instance owns only a mesh output buffer.
scope.onmessage = ({ data }) => {
	const bytes = data.padded.byteLength;
	const ptr = x.mc_alloc(bytes);
	try {
		new Uint8Array(x.memory.buffer, ptr, bytes).set(new Uint8Array(data.padded.buffer));
		const quads = x.mesh_padded(ptr, data.padded.length);
		const vertices = new Uint32Array(x.memory.buffer, x.client_mesh_ptr(), quads * WORDS_PER_QUAD).slice();
		scope.postMessage({ type: "mesh", id: data.id, vertices }, [vertices.buffer]);
	} finally {
		x.mc_free(ptr, bytes);
	}
};
scope.postMessage({ type: "ready" }, []);
