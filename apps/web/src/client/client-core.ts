import type { BlockStateInfo } from "./placement.ts";
import type { LayerCounts } from "./mesh-layers.ts";
import type { LightMutation } from "./light-pool.ts";
import type { DigBounds } from "./dig.ts";

// Wrapper around the client WebAssembly module (crates/wasm-client): the
// local mirror of the world, packet codec, mesher and ray casts.

export interface ItemInfo { id: number; name: string; maxStack: number; block: number | null; texture: string | null; food: number | null }
export interface InventorySlot { item: number; count: number }

export interface ItemEntity { id: number; item: number; count: number; position: [number, number, number]; previous: [number, number, number] }
export type MobKind = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface ArrowEntity { id: number; position: [number, number, number]; previous: [number, number, number]; velocity: [number, number, number]; fresh: boolean }
export interface MobEntity { id: number; kind: MobKind; position: [number, number, number]; previous: [number, number, number]; yaw: number; hurt: number; fuse: number }
export interface ClientExports {
	client_enc_attack(id: number): number;
	client_enc_dig_start(x: number, y: number, z: number): number;
	client_enc_dig_abort(): number;
	client_mining_ticks(block: number, held: number): number;
	client_mining_drops(block: number, held: number): boolean;
	client_entities(): number;
	client_mobs(): number;
	client_arrows(): number;
	client_entity_light(x: number, y: number, z: number): number;
	client_enc_drop_item(x: number, y: number, z: number): number;
	client_game_mode(): number;
	client_health(): number;
	client_air(): number;
	client_food(): number;
	client_dead(): number;
	client_death_cause(): number;
	client_enc_respawn(): number;
	client_enc_use_item(): number;
	client_enc_stop_using_item(): number;
	client_enc_cancel_using_item(): number;
	client_enc_click_slot(slot: number, button: number, shift: number): number;
	client_enc_close_inventory(): number;
	client_enc_use_block(x: number, y: number, z: number): number;
	client_enc_use_bucket(x: number, y: number, z: number): number;
	client_screen(): number;
	client_furnace_time(index: number): number;
	client_selected_slot(): number;
	client_slot_item(slot: number): number;
	client_slot_count(slot: number): number;
	client_item_registry(): number;
	client_enc_select_slot(slot: number): number;
	client_enc_creative_set_slot(slot: number, item: number, count: number): number;
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
	client_mesh_count(layer: number): number;
	client_packet(ptr: number, len: number): number;
	client_predict_block(x: number, y: number, z: number, block: number): number;
	client_seed(): bigint;
	client_spawn(axis: number): number;
	client_view_distance(): number;
	client_game_time(): bigint;
	client_day_time(): bigint;
	client_chunk_count(): number;
	client_dirty_count(): number;
	client_hidden_dirty_count(): number;
	client_visible_count(): number;
	client_update_visibility(x: number, y: number, z: number, enabled: number): number;
	client_pop_dirty(x: number, y: number, z: number): number;
	client_padded(cx: number, sy: number, cz: number): number;
	client_padded_ptr(): number;
	mesh_padded(ptr: number, len: number, sky: number, block: number): number;
	client_light_step(x: number, z: number): number;
	client_light_pending(): number;
	client_external_light(enabled: number): void;
	client_light_generation(cx: number, cz: number, generation: number): void;
	client_light_export_mode(): void;
	client_take_light_updates(): number;
	client_apply_light_updates(ptr: number, len: number): number;
	client_padded_light(cx: number, sy: number, cz: number): number;
	client_padded_sky_ptr(): number;
	client_padded_block_ptr(): number;
	client_is_dirty(cx: number, sy: number, cz: number): number;
	client_requeue_dirty(cx: number, sy: number, cz: number): void;
	client_mesh(cx: number, sy: number, cz: number): number;
	client_take_unloaded(): number;
	client_get_block(x: number, y: number, z: number): number;
	client_torch_placement(x: number, y: number, z: number, face: number): number;
	client_selection_bounds(x: number, y: number, z: number): number;
	client_raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number;
	client_raycast_sources(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number;
	client_enc_hello(view: number): number;
	client_player_position(axis: number): number;
	client_enc_teleport(x: number, y: number, z: number): number;
	client_enc_pos(x: number, y: number, z: number, yaw: number, pitch: number): number;
	client_enc_set_block(x: number, y: number, z: number, block: number): number;
	client_biome_colors(): number;
	tint_biome_cells(seed: bigint, generator: number, cx: number, cz: number): number;
	tint_out_ptr(): number;
	client_texture_names(): number;
	client_block_names(): number;
	client_block_registry(): number;
}

/** Server-to-client packet ids (crates/protocol). */
export const S2C = { Welcome: 0, ChunkData: 1, UnloadChunk: 2, BlockUpdate: 3, TimeUpdate: 4, PlayerCorrect: 5, Inventory: 6, EntitySpawn: 7, EntityMove: 8, EntityCount: 9, EntityRemove: 10, DigProgress: 11, PlayerStatus: 12, MobSpawn: 13, MobMove: 14, MobHurt: 15, ArrowSpawn: 16, ArrowMove: 17, MobFuse: 18 } as const;

export const WORDS_PER_QUAD = 8;
export const LIGHT_FRAME_BUDGET_MS = 2;
export const MIN_Y = -64;

export const PLAYER_TICK_SECONDS = 1 / 20;

/** Keep every resolved tick in the report stream, even during frame catch-up. */
export function advancePlayerFrame(accumulatedSeconds: number, tick: () => void, report: () => void): number {
	while (accumulatedSeconds >= PLAYER_TICK_SECONDS) {
		tick();
		report();
		accumulatedSeconds -= PLAYER_TICK_SECONDS;
	}
	return accumulatedSeconds;
}

export interface PlayerState {
	position: [number, number, number];
	velocity: [number, number, number];
	onGround: boolean;
	flying: boolean;
}

export interface RayHit {
	/** Intersection Y relative to the hit cell, including 1 at its top edge. */
	hitY: number;
	/** Local selection bounds in block units. */
	min: readonly [number, number, number];
	max: readonly [number, number, number];
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
	get entities(): ItemEntity[] {
		const bytes = this.out(this.x.client_entities());
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const result: ItemEntity[] = [];
		// Each packed record has a seven-byte header followed by six f64 coordinates.
		for (let offset = 0; offset < bytes.length; offset += 55) {
			result.push({
				id: view.getUint32(offset), item: view.getUint16(offset + 4), count: view.getUint8(offset + 6),
				position: [view.getFloat64(offset + 7), view.getFloat64(offset + 15), view.getFloat64(offset + 23)],
				previous: [view.getFloat64(offset + 31), view.getFloat64(offset + 39), view.getFloat64(offset + 47)],
			});
		}
		return result;
	}

	get mobs(): MobEntity[] {
		const bytes = this.out(this.x.client_mobs());
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const result: MobEntity[] = [];
		// Nine bytes for ID, kind and yaw, six f64 coordinates, a u32 hurt sequence and a fuse byte.
		for (let offset = 0; offset < bytes.length; offset += 62) {
			result.push({
				// Wasm only stores kinds accepted by the protocol decoder.
				id: view.getUint32(offset), kind: view.getUint8(offset + 4) as MobKind, yaw: view.getFloat32(offset + 5),
				position: [view.getFloat64(offset + 9), view.getFloat64(offset + 17), view.getFloat64(offset + 25)],
				previous: [view.getFloat64(offset + 33), view.getFloat64(offset + 41), view.getFloat64(offset + 49)],
				hurt: view.getUint32(offset + 57),
				fuse: view.getUint8(offset + 61),
			});
		}
		return result;
	}

	get arrows(): ArrowEntity[] {
		const bytes = this.out(this.x.client_arrows());
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const result: ArrowEntity[] = [];
		const readVec = (offset: number): [number, number, number] =>
			[view.getFloat64(offset), view.getFloat64(offset + 8), view.getFloat64(offset + 16)];
		for (let offset = 0; offset < bytes.length; offset += 77) {
			result.push({
				id: view.getUint32(offset),
				position: readVec(offset + 4),
				previous: readVec(offset + 28),
				velocity: readVec(offset + 52),
				fresh: view.getUint8(offset + 76) === 1,
			});
		}
		return result;
	}

	entityLight(position: readonly number[]): [number, number] {
		const value = this.x.client_entity_light(Math.floor(position[0]), Math.floor(position[1]), Math.floor(position[2]));
		return [value >> 4, value & 15];
	}

	encodeDropItem(dir: readonly number[]): Uint8Array<ArrayBuffer> {
		return this.out(this.x.client_enc_drop_item(dir[0], dir[1], dir[2]));
	}

	private readonly x: ClientExports;
	private readonly decoder = new TextDecoder();
	observeLight: ((change: LightMutation) => void) | undefined;

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
		if (id === S2C.ChunkData || id === S2C.UnloadChunk || id === S2C.BlockUpdate) this.observeLight?.({ type: "packet", data: data.slice() });
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
		this.observeLight?.({ type: "reset" });
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

	externalLight(enabled: boolean): void { this.x.client_external_light(Number(enabled)); }
	lightGeneration(cx: number, cz: number, generation: number): void { this.x.client_light_generation(cx, cz, generation); }
	exportLight(): void { this.x.client_light_export_mode(); }
	takeLightUpdates(): Uint8Array<ArrayBuffer> { return this.out(this.x.client_take_light_updates()); }
	applyLightUpdates(records: Uint8Array[]): void {
		const len = records.reduce((n, record) => n + record.length, 0);
		const ptr = this.x.mc_alloc(len);
		try {
			const bytes = new Uint8Array(this.x.memory.buffer, ptr, len);
			let offset = 0;
			for (const record of records) { bytes.set(record, offset); offset += record.length; }
			this.x.client_apply_light_updates(ptr, len);
		} finally { this.x.mc_free(ptr, len); }
	}

	get lightPending(): number { return this.x.client_light_pending(); }

	stepLight(x: number, z: number): number {
		const start = performance.now();
		while (this.lightPending && performance.now() - start < LIGHT_FRAME_BUDGET_MS) {
			if (!this.x.client_light_step(x, z)) break;
		}
		return performance.now() - start;
	}

	paddedLight(cx: number, sy: number, cz: number): { sky: Uint8Array<ArrayBuffer>; block: Uint8Array<ArrayBuffer> } {
		const len = this.x.client_padded_light(cx, sy, cz);
		const bytes = new Uint8Array(this.x.memory.buffer, this.x.client_padded_sky_ptr(), len * 2).slice();
		return { sky: bytes.subarray(0, len), block: bytes.subarray(len) };
	}

	get dirtyCount(): number {
		return this.x.client_dirty_count();
	}

	get hiddenDirty(): number { return this.x.client_hidden_dirty_count(); }
	get visibleSections(): number { return this.x.client_visible_count(); }

	/** undefined: unchanged; null: unrestricted; otherwise renderer section keys. */
	updateVisibility(x: number, y: number, z: number, enabled: boolean): Set<string> | null | undefined {
		const count = this.x.client_update_visibility(x, y, z, Number(enabled));
		if (count === -1) return undefined;
		if (count === -2) return null;
		const values = this.outInts(count * 3);
		const keys = new Set<string>();
		for (let i = 0; i < values.length; i += 3) keys.add(`${values[i]},${values[i + 1]},${values[i + 2]}`);
		return keys;
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

	meshCounts(): LayerCounts {
		return [this.x.client_mesh_count(0), this.x.client_mesh_count(1), this.x.client_mesh_count(2)];
	}

	padded(cx: number, sy: number, cz: number): Uint16Array<ArrayBuffer> {
		const len = this.x.client_padded(cx, sy, cz);
		return new Uint16Array(this.x.memory.buffer, this.x.client_padded_ptr(), len).slice();
	}

	isDirty(cx: number, sy: number, cz: number): boolean {
		return this.x.client_is_dirty(cx, sy, cz) !== 0;
	}

	requeueDirty(cx: number, sy: number, cz: number): void {
		this.x.client_requeue_dirty(cx, sy, cz);
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

	torchPlacement(hit: RayHit): number {
		return this.x.client_torch_placement(hit.x, hit.y, hit.z, hit.face);
	}

	selectionBounds(x: number, y: number, z: number): DigBounds | null {
		const len = this.x.client_selection_bounds(x, y, z);
		if (!len) return null;
		const v = this.out(len);
		return { min: [v[0] / 16, v[1] / 16, v[2] / 16], max: [v[3] / 16, v[4] / 16, v[5] / 16] };
	}

	raycast(origin: readonly number[], dir: readonly number[], max: number, includeSources = false): RayHit | null {
		const cast = includeSources ? this.x.client_raycast_sources : this.x.client_raycast;
		if (cast(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], max) === 0) return null;
		const v = this.outInts(10);
		return { x: v[0], y: v[1], z: v[2], face: v[3], hitY: new DataView(this.out(48).buffer).getFloat64(40, true), min: [v[4] / 16, v[5] / 16, v[6] / 16], max: [v[7] / 16, v[8] / 16, v[9] / 16] };
	}

	predictBlock(x: number, y: number, z: number, block: number): boolean {
		const changed = this.x.client_predict_block(x, y, z, block) === 1;
		if (changed) this.observeLight?.({ type: "predict", x, y, z, block });
		return changed;
	}

	encodeHello(viewDistance: number): Uint8Array<ArrayBuffer> {
		return this.out(this.x.client_enc_hello(viewDistance));
	}

	encodePos(x: number, y: number, z: number, yaw: number, pitch: number): Uint8Array<ArrayBuffer> {
		return this.out(this.x.client_enc_pos(x, y, z, yaw, pitch));
	}

	/** Report the latest collision-resolved physics state, independent of rendering. */
	encodePlayerPos(yaw: number, pitch: number): Uint8Array<ArrayBuffer> {
		return this.encodePos(...this.playerPosition, yaw, pitch);
	}

	get playerPosition(): [number, number, number] {
		return [this.x.client_player_position(0), this.x.client_player_position(1), this.x.client_player_position(2)];
	}

	encodeTeleport(x: number, y: number, z: number): Uint8Array<ArrayBuffer> {
		return this.out(this.x.client_enc_teleport(x, y, z));
	}

	encodeAttack(id: number): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_attack(id)); }
	encodeDigStart(x: number, y: number, z: number): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_dig_start(x,y,z)); }
	miningDrops(block: number, held: number): boolean { return Boolean(this.x.client_mining_drops(block, held)); }
	miningTicks(block: number, held: number): number | null { const ticks = this.x.client_mining_ticks(block, held); return ticks < 0 ? null : ticks; }
	encodeDigAbort(): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_dig_abort()); }
	encodeSetBlock(x: number, y: number, z: number, block: number): Uint8Array<ArrayBuffer> {
		return this.out(this.x.client_enc_set_block(x, y, z, block));
	}

	biomeColors(): Uint8Array<ArrayBuffer> {
		return this.out(this.x.client_biome_colors());
	}

	tintCells(seed: bigint, generator: number, cx: number, cz: number): Uint8Array<ArrayBuffer> {
		const len = this.x.tint_biome_cells(seed, generator, cx, cz);
		return new Uint8Array(this.x.memory.buffer, this.x.tint_out_ptr(), len).slice();
	}

	textureNames(): string[] {
		return this.decoder.decode(this.out(this.x.client_texture_names())).split("\n");
	}

	get gameMode(): "creative" | "survival" { return this.x.client_game_mode() === 1 ? "survival" : "creative"; }
	get health(): number { return this.x.client_health(); }
	get air(): number { return this.x.client_air(); }
	get food(): number { return this.x.client_food(); }
	get dead(): boolean { return this.x.client_dead() !== 0; }
	get deathCause(): number { return this.x.client_death_cause(); }
	encodeRespawn(): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_respawn()); }
	encodeUseItem(): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_use_item()); }
	encodeStopUsingItem(): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_stop_using_item()); }
	encodeCancelUsingItem(): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_cancel_using_item()); }
	get screen(): number { return this.x.client_screen(); }
	get table(): Array<InventorySlot | null> { return this.inventorySlots.slice(42, 51); }
	get craftingResult(): InventorySlot | null { return this.inventorySlots[40]; }
	encodeUseBucket(x: number, y: number, z: number): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_use_bucket(x, y, z)); }
	encodeUseBlock(x: number, y: number, z: number): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_use_block(x, y, z)); }
	get selectedSlot(): number { return this.x.client_selected_slot(); }
	get inventory(): Array<InventorySlot | null> { return this.inventorySlots.slice(0, 36); }
	// Display indices 0..50 retain protocol 7 layout; 51..53 are furnace input/fuel/output.
	get furnace(): Array<InventorySlot | null> { return this.inventorySlots.slice(51, 54); }
	get furnaceTimes(): number[] { return [0, 1, 2].map(i => this.x.client_furnace_time(i)); }
	get inventorySlots(): Array<InventorySlot | null> {
		return Array.from({ length: 54 }, (_, i) => {
			const item = this.x.client_slot_item(i);
			return item ? { item, count: this.x.client_slot_count(i) } : null;
		});
	}
	encodeClickSlot(slot: number, button: number, shift: boolean): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_click_slot(slot, button, Number(shift))); }
	encodeCloseInventory(): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_close_inventory()); }
	itemRegistry(): ItemInfo[] { return JSON.parse(this.decoder.decode(this.out(this.x.client_item_registry()))); }
	encodeSelectSlot(slot: number): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_select_slot(slot)); }
	encodeCreativeSetSlot(slot: number, item: number, count: number): Uint8Array<ArrayBuffer> { return this.out(this.x.client_enc_creative_set_slot(slot, item, count)); }

	blockRegistry(): BlockStateInfo[] {
		return JSON.parse(this.decoder.decode(this.out(this.x.client_block_registry())));
	}

	blockNames(): string[] {
		return this.decoder.decode(this.out(this.x.client_block_names())).split("\n");
	}
}
