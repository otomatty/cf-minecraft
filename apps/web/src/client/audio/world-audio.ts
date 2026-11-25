import { S2C, type ClientCore, type InventorySlot, type PlayerState } from "../client-core.ts";
import type { DigState } from "../dig.ts";
import type { Vec3 } from "../math.ts";
import type { BlockStateInfo } from "../placement.ts";
import type { GameAudio } from "./engine.ts";
import { arrowHitPosition, arrowStopped, blockSound, creeperIgnited, materialFor, mobRemovalSound, playerSounds } from "./events.ts";

const CORRELATION_MS = 250;
const STEP_DISTANCE = 1.65;
const DIG_INTERVAL_MS = 220;

function blockCell(data: Uint8Array): Vec3 | null {
	if (data[0] !== S2C.BlockUpdate || data.length < 13) return null;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return [view.getInt32(1), view.getInt32(5), view.getInt32(9)];
}

function itemCounts(inventory: readonly (InventorySlot | null)[]) {
	const counts = new Map<number, number>();
	for (const stack of inventory) {
		if (stack) counts.set(stack.item, (counts.get(stack.item) ?? 0) + stack.count);
	}
	return counts;
}

/** Observe the client mirror around packet application, including local block prediction. */
export class WorldAudio {
	private predictedBlocks = new Map<string, { state: number; at: number }>();
	private stuckArrows = new Set<number>();
	private hits: { position: Vec3; at: number }[] = [];
	private pickups: { item: number; count: number; position: Vec3; at: number }[] = [];
	private stepDistance = 0;
	private digStarted = -Infinity;
	private nextDig = 0;
	private core: ClientCore;
	private registry: readonly BlockStateInfo[];
	private audio: Pick<GameAudio, "play">;

	constructor(core: ClientCore, registry: readonly BlockStateInfo[], audio: Pick<GameAudio, "play">) {
		this.core = core;
		this.registry = registry;
		this.audio = audio;
	}

	reset(): void {
		this.predictedBlocks.clear();
		this.stuckArrows.clear();
		this.hits = [];
		this.pickups = [];
		this.resetMovement();
	}

	resetMovement(): void {
		this.stepDistance = 0;
		this.digStarted = -Infinity;
	}

	predictBlock(x: number, y: number, z: number, block: number): boolean {
		const state = this.core.getBlock(x, y, z);
		if (!this.core.predictBlock(x, y, z, block)) return false;
		const now = performance.now();
		for (const [key, pending] of this.predictedBlocks) {
			if (now - pending.at > 5000) this.predictedBlocks.delete(key);
		}
		const key = [x, y, z].join(",");
		if (!this.predictedBlocks.has(key)) this.predictedBlocks.set(key, { state, at: now });
		return true;
	}

	packet(data: Uint8Array, feet: Vec3, mobHurtAt: ReadonlyMap<number, number>): number {
		const { core, audio } = this;
		const cell = blockCell(data);
		const key = cell?.join(",");
		const now = performance.now();
		const pending = key === undefined ? undefined : this.predictedBlocks.get(key);
		const priorBlock = cell ? (pending && now - pending.at <= 5000 ? pending.state : core.getBlock(...cell)) : -1;
		const type = data[0];
		const removed = type === S2C.EntityRemove;
		const itemChanged = removed || type === S2C.EntityCount;
		const entityPacket = itemChanged || type === S2C.MobHurt || type === S2C.MobFuse || type === S2C.ArrowMove || type === S2C.ArrowSpawn;
		const entity = entityPacket && data.length >= 5 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1) : -1;
		const priorMob = removed || type === S2C.MobFuse ? core.mobs.find(mob => mob.id === entity) : undefined;
		const priorItem = itemChanged && !priorMob ? core.entities.find(item => item.id === entity) : undefined;
		const priorArrow = (removed && !priorMob && !priorItem) || type === S2C.ArrowMove
			? core.arrows.find(arrow => arrow.id === entity) : undefined;
		const priorVitals = type === S2C.PlayerStatus ? { health: core.health, food: core.food, dead: core.dead } : null;
		const priorInventory = type === S2C.Inventory && this.pickups.length ? core.inventory : null;

		const id = core.packet(data);
		if (id === S2C.BlockUpdate && cell && key !== undefined) {
			this.predictedBlocks.delete(key);
			const state = core.getBlock(...cell);
			const before = this.registry[priorBlock], after = this.registry[state];
			const sound = blockSound(before?.name, after?.name);
			const source: Vec3 = [cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5];
			if (sound) audio.play(sound, source);
			else if (before?.name.endsWith("_slab") && before.stateName !== after?.stateName
				&& before.first === after?.first && state === before.first + 2) {
				audio.play({ kind: "place", material: materialFor(before.name) }, source);
			}
		} else if (id === S2C.EggSound) {
			const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
			audio.play({ kind: view.getUint8(25) ? "eggBreak" : "eggThrow" },
				[view.getFloat64(1), view.getFloat64(9), view.getFloat64(17)]);
		} else if (id === S2C.Shear) {
			audio.play({ kind: "shear" });
		} else if (id === S2C.ToolBreak) {
			audio.play({ kind: "toolBreak" });
		} else if (id === S2C.PlayerStatus && priorVitals) {
			for (const sound of playerSounds(priorVitals, core)) {
				audio.play(sound);
				if (sound.kind === "playerHurt") this.rememberHit([feet[0], feet[1] + 0.9, feet[2]], now);
			}
		} else if (id === S2C.MobHurt) {
			const mob = core.mobs.find(mob => mob.id === entity);
			if (mob) {
				audio.play({ kind: "mobHurt", mob: mob.kind }, mob.position);
				this.rememberHit([mob.position[0], mob.position[1] + 0.65, mob.position[2]], now);
			}
		} else if (id === S2C.MobFuse && priorMob?.kind === 6 && creeperIgnited(priorMob.fuse, data[5])) {
			audio.play({ kind: "fuse" }, priorMob.position);
		} else if (id === S2C.ArrowSpawn || id === S2C.ArrowMove) {
			const arrow = core.arrows.find(arrow => arrow.id === entity);
			if (arrow?.fresh && id === S2C.ArrowSpawn) audio.play({ kind: "arrowShoot" }, arrow.position);
			else if (arrow && priorArrow && arrowStopped(priorArrow, arrow) && !this.stuckArrows.has(entity)) {
				this.stuckArrows.add(entity);
				audio.play({ kind: "arrowStick" }, arrow.position);
			}
		} else if (priorItem && (id === S2C.EntityRemove || id === S2C.EntityCount) && !core.dead) {
			const remaining = id === S2C.EntityRemove ? 0 : core.entities.find(item => item.id === entity)?.count;
			const [x, y, z] = priorItem.position;
			if (remaining !== undefined && remaining < priorItem.count &&
				Math.abs(x - feet[0]) <= 1.6 && Math.abs(z - feet[2]) <= 1.6 && Math.abs(y - feet[1] - 0.9) <= 1.8) {
				this.pickups = this.pickups.filter(pickup => now - pickup.at <= CORRELATION_MS);
				this.pickups.push({ item: priorItem.item, count: priorItem.count - remaining, position: priorItem.position, at: now });
			}
		} else if (id === S2C.EntityRemove) {
			if (priorMob) {
				const sound = mobRemovalSound(priorMob, now - (mobHurtAt.get(entity) ?? -Infinity));
				if (sound) audio.play(sound, priorMob.position);
				// A lethal arrow can remove a mob without a final MobHurt packet.
				if (sound?.kind !== "explosion") this.rememberHit([priorMob.position[0], priorMob.position[1] + 0.65, priorMob.position[2]], now);
			} else if (priorArrow && !this.stuckArrows.delete(entity)) {
				const nearbyHits = this.hits.filter(hit => now - hit.at <= CORRELATION_MS);
				const point = arrowHitPosition(priorArrow, nearbyHits.map(hit => hit.position));
				if (point) audio.play({ kind: "arrowHit" }, point);
			}
		} else if (id === S2C.Inventory && priorInventory) {
			const before = itemCounts(priorInventory), after = itemCounts(core.inventory);
			for (const pickup of this.pickups) {
				if (now - pickup.at > CORRELATION_MS) continue;
				const gained = (after.get(pickup.item) ?? 0) - (before.get(pickup.item) ?? 0);
				if (gained <= 0) continue;
				audio.play({ kind: "pickup" }, pickup.position);
				after.set(pickup.item, (after.get(pickup.item) ?? 0) - pickup.count);
			}
			this.pickups = [];
		}
		return id;
	}

	private rememberHit(position: Vec3, now: number): void {
		this.hits = this.hits.filter(hit => now - hit.at <= CORRELATION_MS);
		this.hits.push({ position, at: now });
	}

	walk(before: Vec3, player: PlayerState, walking: boolean): void {
		if (!walking || player.flying) {
			this.stepDistance = 0;
			return;
		}
		const [x, y, z] = player.position;
		const at = (height: number) => this.registry[this.core.getBlock(Math.floor(x), Math.floor(height), Math.floor(z))]?.name;
		const water = /^(flowing_)?water$/.test(at(y + 0.4) ?? "");
		if (!player.onGround && !water) {
			this.stepDistance = 0;
			return;
		}
		const distance = water ? Math.hypot(x - before[0], y - before[1], z - before[2]) : Math.hypot(x - before[0], z - before[2]);
		this.stepDistance += distance;
		if (this.stepDistance < STEP_DISTANCE) return;
		this.stepDistance %= STEP_DISTANCE;
		const floor = at(y - 0.05);
		const block = water ? "water" : floor && floor !== "air" ? floor : at(y - 0.55);
		if (block && block !== "air") {
			this.audio.play({ kind: "step", material: materialFor(block) }, player.position);
		}
	}

	dig(active: DigState["active"], now: number): void {
		if (!active) {
			this.digStarted = -Infinity;
			return;
		}
		if (active.started !== this.digStarted) {
			this.digStarted = active.started;
			this.nextDig = active.started + 100;
		}
		if (now < this.nextDig) return;
		this.nextDig = now + DIG_INTERVAL_MS;
		const block = this.registry[active.state];
		if (block) this.audio.play({ kind: "dig", material: materialFor(block.name) }, [active.x + 0.5, active.y + 0.5, active.z + 0.5]);
	}
}
