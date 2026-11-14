// Wrapper around the client WebAssembly module (crates/wasm-client): the
// local mirror of the world, packet codec, mesher and ray casts.

interface ClientExports {
	memory: WebAssembly.Memory;
	mc_alloc(len: number): number;
	mc_free(ptr: number, len: number): void;
	client_new(): void;
	client_player_reset(x: number, y: number, z: number): void;
	client_player_toggle_flight(): number;
	client_player_tick(forward: number, strafe: number, yaw: number, flags: number): void;
	client_reset_world(): void;
	client_out_ptr(): number;
	client_mesh_ptr(): number;
	client_packet(ptr: number, len: number): number;
	client_predict_block(x: number, y: number, z: number, block: number): number;
	client_seed(): bigint;
	client_spawn(axis: number): number;
	client_view_distance(): number;
	client_game_time(): bigint;
	client_day_time(): bigint;
	client_chunk_count(): number;
	client_dirty_count(): number;
	client_pop_dirty(x: number, y: number, z: number): number;
	client_mesh(cx: number, sy: number, cz: number): number;
	client_take_unloaded(): number;
	client_get_block(x: number, y: number, z: number): number;
	client_raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number;
	client_enc_hello(view: number): number;
	client_enc_pos(x: number, y: number, z: number, yaw: number, pitch: number): number;
	client_enc_set_block(x: number, y: number, z: number, block: number): number;
	client_texture_names(): number;
	client_block_names(): number;
}

/** Server-to-client packet ids (crates/protocol). */
export const S2C = { Welcome: 0, ChunkData: 1, UnloadChunk: 2, BlockUpdate: 3, TimeUpdate: 4 } as const;

export const WORDS_PER_QUAD = 8;
export const MIN_Y = -64;

export interface PlayerState {
	position: [number, number, number];
	velocity: [number, number, number];
	onGround: boolean;
	flying: boolean;
}

export interface RayHit {
	x: number;
	y: number;
	z: number;
	/** Face that was hit, in the game's Direction order: down, up, north, south, west, east. */
	face: number;
}

export const FACE_NORMALS: ReadonlyArray<readonly [number, number, number]> = [
	[0, -1, 0],
	[0, 1, 0],
	[0, 0, -1],
	[0, 0, 1],
	[-1, 0, 0],
	[1, 0, 0],
];

export class ClientCore {
	private readonly x: ClientExports;
	private readonly decoder = new TextDecoder();

	constructor(instance: WebAssembly.Instance) {
		this.x = instance.exports as unknown as ClientExports;
		this.x.client_new();
	}

	static async load(url: string): Promise<ClientCore> {
		const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {});
		return new ClientCore(instance);
	}

	private out(len: number): Uint8Array<ArrayBuffer> {
		const ptr = this.x.client_out_ptr();
		return new Uint8Array(this.x.memory.buffer).slice(ptr, ptr + len);
	}

	private outInts(count: number): Int32Array {
		return new Int32Array(this.out(count * 4).buffer);
	}

	/** Feeds one server packet to the mirror. Returns the packet id, or -1 if it was malformed. */
	packet(data: Uint8Array): number {
		const ptr = this.x.mc_alloc(data.length);
		new Uint8Array(this.x.memory.buffer).set(data, ptr);
		const id = this.x.client_packet(ptr, data.length);
		this.x.mc_free(ptr, data.length);
		return id === 0xffffffff ? -1 : id;
	}

	resetPlayer(x: number, y: number, z: number): void {
		this.x.client_player_reset(x, y, z);
	}

	toggleFlight(): boolean {
		return this.x.client_player_toggle_flight() !== 0;
	}

	tickPlayer(forward: number, strafe: number, yaw: number, jump: boolean, sprint: boolean, sneak: boolean): PlayerState {
		this.x.client_player_tick(forward, strafe, yaw, Number(jump) | (Number(sprint) << 1) | (Number(sneak) << 2));
		const bytes = this.out(50);
		const view = new DataView(bytes.buffer);
		return {
			position: [view.getFloat64(0, true), view.getFloat64(8, true), view.getFloat64(16, true)],
			velocity: [view.getFloat64(24, true), view.getFloat64(32, true), view.getFloat64(40, true)],
			onGround: bytes[48] !== 0,
			flying: bytes[49] !== 0,
		};
	}

	resetWorld(): void {
		this.x.client_reset_world();
	}

	get spawn(): [number, number, number] {
		return [this.x.client_spawn(0), this.x.client_spawn(1), this.x.client_spawn(2)];
	}

	get seed(): bigint {
		return this.x.client_seed();
	}

	get viewDistance(): number {
		return this.x.client_view_distance();
	}

	get gameTime(): number {
		return Number(this.x.client_game_time());
	}

	get dayTime(): number {
		return Number(this.x.client_day_time());
	}

	get chunkCount(): number {
		return this.x.client_chunk_count();
	}

	get dirtyCount(): number {
		return this.x.client_dirty_count();
	}

	/** Stale section nearest to the camera, as [chunk x, section index, chunk z]. */
	popDirty(x: number, y: number, z: number): [number, number, number] | null {
		if (this.x.client_pop_dirty(x, y, z) === 0) return null;
		const v = this.outInts(3);
		return [v[0], v[1], v[2]];
	}

	/**
	 * Meshes a section. The returned view aliases WebAssembly memory and is
	 * only valid until the next call into the module.
	 */
	mesh(cx: number, sy: number, cz: number): Uint32Array {
		const quads = this.x.client_mesh(cx, sy, cz);
		return new Uint32Array(this.x.memory.buffer, this.x.client_mesh_ptr(), quads * WORDS_PER_QUAD);
	}

	takeUnloaded(): Array<[number, number]> {
		const len = this.x.client_take_unloaded();
		const v = this.outInts(len / 4);
		const out: Array<[number, number]> = [];
		for (let i = 0; i < v.length; i += 2) out.push([v[i], v[i + 1]]);
		return out;
	}

	/** Block id, or -1 when the chunk is not loaded. */
	getBlock(x: number, y: number, z: number): number {
		const b = this.x.client_get_block(x, y, z);
		return b === 0xffffffff ? -1 : b;
	}

	raycast(origin: readonly number[], dir: readonly number[], max: number): RayHit | null {
		if (this.x.client_raycast(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], max) === 0) return null;
		const v = this.outInts(4);
		return { x: v[0], y: v[1], z: v[2], face: v[3] };
	}

	predictBlock(x: number, y: number, z: number, block: number): boolean {
		return this.x.client_predict_block(x, y, z, block) === 1;
	}

	encodeHello(viewDistance: number): Uint8Array<ArrayBuffer> {
		return this.out(this.x.client_enc_hello(viewDistance));
	}

	encodePos(x: number, y: number, z: number, yaw: number, pitch: number): Uint8Array<ArrayBuffer> {
		return this.out(this.x.client_enc_pos(x, y, z, yaw, pitch));
	}

	encodeSetBlock(x: number, y: number, z: number, block: number): Uint8Array<ArrayBuffer> {
		return this.out(this.x.client_enc_set_block(x, y, z, block));
	}

	textureNames(): string[] {
		return this.decoder.decode(this.out(this.x.client_texture_names())).split("\n");
	}

	blockNames(): string[] {
		return this.decoder.decode(this.out(this.x.client_block_names())).split("\n");
	}
}
