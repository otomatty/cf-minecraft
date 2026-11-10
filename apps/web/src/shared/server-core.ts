// Host-side wrapper around the server WebAssembly module (crates/wasm-server).
// Shared by every JavaScript host: the browser's sim worker, the Durable
// Object and Node tooling. It only moves bytes; all game logic is in the core.

interface ServerExports {
	memory: WebAssembly.Memory;
	mc_alloc(len: number): number;
	mc_free(ptr: number, len: number): void;
	server_abi_version(): number;
	server_new(seed: bigint, generator: number): void;
	server_set_time(gameTime: bigint, dayTime: bigint): void;
	server_connect(client: number): void;
	server_disconnect(client: number): void;
	server_packet(client: number, ptr: number, len: number): void;
	server_tick(): void;
	server_out_ptr(): number;
	server_take_outbox(): number;
	server_set_stored(ptr: number, len: number): void;
	server_take_requests(): number;
	server_load_chunk(cx: number, cz: number, ptr: number, len: number): number;
	server_chunk_missing(cx: number, cz: number): void;
	server_take_dirty(): number;
	server_dirty_chunks(): number;
	server_state_hash(): bigint;
	server_game_time(): bigint;
	server_day_time(): bigint;
	server_loaded_chunks(): number;
	server_client_count(): number;
	server_run_scenario(seed: bigint, ticks: number): bigint;
}

export const SERVER_ABI_VERSION = 1;

export const Generator = { Flat: 0, DebugHills: 1 } as const;

export interface OutPacket {
	client: number;
	data: Uint8Array;
}

export interface DirtyChunk {
	cx: number;
	cz: number;
	data: Uint8Array;
}

export function hashToHex(hash: bigint): string {
	return BigInt.asUintN(64, hash).toString(16).padStart(16, "0");
}

export class ServerCore {
	private readonly x: ServerExports;

	constructor(instance: WebAssembly.Instance) {
		this.x = instance.exports as unknown as ServerExports;
		const abi = this.x.server_abi_version();
		if (abi !== SERVER_ABI_VERSION) {
			throw new Error(`server.wasm ABI ${abi}, host expects ${SERVER_ABI_VERSION}`);
		}
	}

	/** The module has no imports, so instantiation needs nothing from the host. */
	static fromModule(module: WebAssembly.Module): ServerCore {
		return new ServerCore(new WebAssembly.Instance(module, {}));
	}

	private bytes(): Uint8Array {
		// The view must be recreated after every call: memory may have grown.
		return new Uint8Array(this.x.memory.buffer);
	}

	private withInput<T>(data: Uint8Array, fn: (ptr: number, len: number) => T): T {
		const ptr = this.x.mc_alloc(data.length);
		try {
			this.bytes().set(data, ptr);
			return fn(ptr, data.length);
		} finally {
			this.x.mc_free(ptr, data.length);
		}
	}

	private output(len: number): Uint8Array {
		const ptr = this.x.server_out_ptr();
		return this.bytes().slice(ptr, ptr + len);
	}

	start(seed: bigint, generator: number): void {
		this.x.server_new(BigInt.asIntN(64, seed), generator);
	}

	setTime(gameTime: bigint, dayTime: bigint): void {
		this.x.server_set_time(gameTime, dayTime);
	}

	connect(client: number): void {
		this.x.server_connect(client);
	}

	disconnect(client: number): void {
		this.x.server_disconnect(client);
	}

	packet(client: number, data: Uint8Array): void {
		this.withInput(data, (ptr, len) => this.x.server_packet(client, ptr, len));
	}

	tick(): void {
		this.x.server_tick();
	}

	takeOutbox(): OutPacket[] {
		const buf = this.output(this.x.server_take_outbox());
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		const packets: OutPacket[] = [];
		let at = 0;
		while (at < buf.length) {
			const client = view.getUint32(at, true);
			const len = view.getUint32(at + 4, true);
			packets.push({ client, data: buf.subarray(at + 8, at + 8 + len) });
			at += 8 + len;
		}
		return packets;
	}

	setStored(coords: ReadonlyArray<readonly [number, number]>): void {
		const data = new Uint8Array(coords.length * 8);
		const view = new DataView(data.buffer);
		coords.forEach(([cx, cz], i) => {
			view.setInt32(i * 8, cx, true);
			view.setInt32(i * 8 + 4, cz, true);
		});
		this.withInput(data, (ptr, len) => this.x.server_set_stored(ptr, len));
	}

	takeRequests(): Array<[number, number]> {
		const buf = this.output(this.x.server_take_requests());
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		const out: Array<[number, number]> = [];
		for (let at = 0; at < buf.length; at += 8) {
			out.push([view.getInt32(at, true), view.getInt32(at + 4, true)]);
		}
		return out;
	}

	loadChunk(cx: number, cz: number, data: Uint8Array): boolean {
		return this.withInput(data, (ptr, len) => this.x.server_load_chunk(cx, cz, ptr, len)) === 1;
	}

	chunkMissing(cx: number, cz: number): void {
		this.x.server_chunk_missing(cx, cz);
	}

	/** One chunk that needs saving, or null. The core considers it saved once returned. */
	takeDirty(): DirtyChunk | null {
		const len = this.x.server_take_dirty();
		if (len === 0) return null;
		const buf = this.output(len);
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		return { cx: view.getInt32(0, true), cz: view.getInt32(4, true), data: buf.subarray(8) };
	}

	get dirtyChunks(): number {
		return this.x.server_dirty_chunks();
	}

	get gameTime(): bigint {
		return this.x.server_game_time();
	}

	get dayTime(): bigint {
		return this.x.server_day_time();
	}

	get loadedChunks(): number {
		return this.x.server_loaded_chunks();
	}

	get clientCount(): number {
		return this.x.server_client_count();
	}

	get memoryBytes(): number {
		return this.x.memory.buffer.byteLength;
	}

	stateHash(): string {
		return hashToHex(this.x.server_state_hash());
	}

	/** Scripted session in a throwaway server; see crates/sim/src/scenario.rs. */
	runScenario(seed: bigint, ticks: number): string {
		return hashToHex(this.x.server_run_scenario(BigInt.asIntN(64, seed), ticks));
	}
}
