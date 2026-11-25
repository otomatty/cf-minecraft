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
	server_connect(client: number, allowTeleport: number, hasPosition: number, x: number, y: number, z: number, ptr: number, len: number): void;
	server_set_game_mode(mode: number): void;
	server_inventory_data(client: number): number;
	server_client_biome(client: number): number;
	server_client_position(client: number): number;
	server_return_crafting(client: number): void;
	server_set_display_name(client: number, ptr: number, len: number): void;
	server_set_operator(client: number, operator: number): void;
	server_disconnect(client: number): void;
	server_packet(client: number, ptr: number, len: number): void;
	server_tick(): void;
	server_out_ptr(): number;
	server_take_protocol_mismatches(): number;
	server_take_outbox(): number;
	server_set_stored(ptr: number, len: number): void;
	server_take_requests(): number;
	server_set_external_generation(maxInFlight: number): void;
	server_take_generation_requests(): number;
	server_deliver_generated(cx: number, cz: number, ptr: number, len: number): number;
	server_generate_now(cx: number, cz: number): void;
	gen_chunk(seed: bigint, generator: number, cx: number, cz: number): number;
	gen_out_ptr(): number;
	server_load_chunk(cx: number, cz: number, ptr: number, len: number): number;
	server_chunk_missing(cx: number, cz: number): void;
	server_take_dirty(): number;
	server_set_entity_persistence(enabled: number): void;
	server_flush_entity_changes(): void;
	server_dirty_chunks(): number;
	server_state_hash(): bigint;
	server_game_time(): bigint;
	server_day_time(): bigint;
	server_loaded_chunks(): number;
	server_client_count(): number;
	server_noise_fingerprint(seed: bigint): bigint;
	server_terrain_fingerprint(seed: bigint): bigint;
	server_run_scenario(seed: bigint, ticks: number): bigint;
}

export const SERVER_ABI_VERSION = 9;

export const Generator = { Flat: 0, DebugHills: 1, Terrain: 2 } as const;

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

	clientBiome(client: number): string {
		return new TextDecoder().decode(this.output(this.x.server_client_biome(client)));
	}

	setTime(gameTime: bigint, dayTime: bigint): void {
		this.x.server_set_time(gameTime, dayTime);
	}

	connect(client: number, allowTeleport = false, position?: readonly [number, number, number], inventory?: Uint8Array, displayName?: string): void {
		this.withInput(inventory ?? new Uint8Array(), (ptr, len) => this.x.server_connect(client, Number(allowTeleport), Number(position !== undefined), ...(position ?? [0, 0, 0] as const), ptr, len));
		if (displayName !== undefined) {
			this.withInput(new TextEncoder().encode(displayName), (ptr, len) => this.x.server_set_display_name(client, ptr, len));
		}
	}

	setGameMode(mode: "creative" | "survival"): void {
		this.x.server_set_game_mode(mode === "survival" ? 1 : 0);
	}

	setOperator(client: number, operator: boolean): void {
		this.x.server_set_operator(client, Number(operator));
	}

	inventoryData(client: number): Uint8Array | undefined {
		const len = this.x.server_inventory_data(client);
		return len ? this.output(len) : undefined;
	}

	clientPosition(client: number): [number, number, number] | undefined {
		const len = this.x.server_client_position(client);
		if (len === 0) return undefined;
		const bytes = this.output(len);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return [view.getFloat64(0, true), view.getFloat64(8, true), view.getFloat64(16, true)];
	}

	returnCrafting(client: number): void {
		this.x.server_return_crafting(client);
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

	takeProtocolMismatches(): number[] {
		const len = this.x.server_take_protocol_mismatches();
		if (len === 0) return [];
		const view = new DataView(this.x.memory.buffer, this.x.server_out_ptr(), len);
		const clients: number[] = [];
		for (let at = 0; at < len; at += 4) clients.push(view.getUint32(at, true));
		return clients;
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

	setExternalGeneration(maxInFlight: number): void {
		this.x.server_set_external_generation(maxInFlight);
	}

	takeGenerationRequests(): Array<[number, number]> {
		return this.coordinates(this.x.server_take_generation_requests());
	}

	deliverGenerated(cx: number, cz: number, data: Uint8Array): boolean {
		return this.withInput(data, (ptr, len) => this.x.server_deliver_generated(cx, cz, ptr, len)) === 1;
	}

	generateNow(cx: number, cz: number): void {
		this.x.server_generate_now(cx, cz);
	}

	takeRequests(): Array<[number, number]> {
		return this.coordinates(this.x.server_take_requests());
	}

	private coordinates(len: number): Array<[number, number]> {
		const buf = this.output(len);
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

	setEntityPersistence(enabled: boolean): void {
		this.x.server_set_entity_persistence(Number(enabled));
	}

	/** Include marked chunks in an explicit save. */
	flushEntityChanges(): void {
		this.x.server_flush_entity_changes();
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

	terrainFingerprint(seed: bigint): string {
		return hashToHex(this.x.server_terrain_fingerprint(BigInt.asIntN(64, seed)));
	}

	noiseFingerprint(seed: bigint): string {
		return hashToHex(this.x.server_noise_fingerprint(BigInt.asIntN(64, seed)));
	}
}

/** Generation-only instance of server.wasm; no server state is initialized. */
export class ChunkGenCore {
	private readonly x: ServerExports;

	constructor(instance: WebAssembly.Instance) {
		this.x = instance.exports as unknown as ServerExports;
		const abi = this.x.server_abi_version();
		if (abi !== SERVER_ABI_VERSION) {
			throw new Error(`server.wasm ABI ${abi}, host expects ${SERVER_ABI_VERSION}`);
		}
	}

	static fromModule(module: WebAssembly.Module): ChunkGenCore {
		return new ChunkGenCore(new WebAssembly.Instance(module, {}));
	}

	generate(seed: bigint, generator: number, cx: number, cz: number): Uint8Array {
		const len = this.x.gen_chunk(BigInt.asIntN(64, seed), generator, cx, cz);
		const ptr = this.x.gen_out_ptr();
		return new Uint8Array(this.x.memory.buffer).slice(ptr, ptr + len);
	}
}
