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
	const lightLen = data.sky?.length === 5832 && data.block?.length === 5832 ? 5832 : 0;
	const total = bytes + lightLen * 2;
	const ptr = x.mc_alloc(total);
	try {
		new Uint8Array(x.memory.buffer, ptr, bytes).set(new Uint8Array(data.padded.buffer));
		if (lightLen) {
			new Uint8Array(x.memory.buffer, ptr + bytes, lightLen).set(data.sky!);
			new Uint8Array(x.memory.buffer, ptr + bytes + lightLen, lightLen).set(data.block!);
		}
		const quads = x.mesh_padded(ptr, data.padded.length, lightLen ? ptr + bytes : 0, lightLen ? ptr + bytes + lightLen : 0);
		const vertices = new Uint32Array(x.memory.buffer, x.client_mesh_ptr(), quads * WORDS_PER_QUAD).slice();
		scope.postMessage({ type: "mesh", id: data.id, vertices }, [vertices.buffer]);
	} finally {
		x.mc_free(ptr, total);
	}
};
scope.postMessage({ type: "ready" }, []);
