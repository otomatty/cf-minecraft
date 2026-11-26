import type { ArrowEntity, MobKind } from "../client-core.ts";
import { right, type Vec3 } from "../math.ts";

export type Material = "stone" | "wood" | "earth" | "sand" | "glass" | "wool" | "plant" | "water" | "lava";

export function materialFor(block: string): Material {
	if (/(^|_)water$/.test(block)) return "water";
	if (/(^|_)lava$/.test(block)) return "lava";
	if (/(leaves|flower|sapling|short_grass|tall_grass|wheat|fern)(_|$)/.test(block)) return "plant";
	if (/^(sand|gravel|snow_block)$/.test(block)) return "sand";
	if (/(glass|ice)(_|$)/.test(block)) return "glass";
	if (/(^|_)wool$/.test(block)) return "wool";
	if (/(^|_)(grass_block|dirt|farmland)$/.test(block)) return "earth";
	if (/(^|_)(oak|spruce|birch|jungle|acacia|mangrove|cherry|wood|log|planks|torch)(_|$)/.test(block)
		|| block === "crafting_table") return "wood";
	return "stone";
}

type BlockSound = { kind: "break" | "place" | "dig" | "step"; material: Material };
type MobSound = { kind: "mobHurt" | "mobDeath"; mob: MobKind };
export type Sound = BlockSound | MobSound | {
	kind: "playerHurt" | "eat" | "death" | "pickup" | "arrowShoot" | "arrowStick" | "arrowHit" | "eggThrow" | "eggBreak" | "fuse" | "explosion" | "toolBreak" | "shear" | "click";
};

export function blockSound(before: string | undefined, after: string | undefined): BlockSound | null {
	if (!before || !after || before === after) return null;
	// The fluid simulation creates and removes flowing cells without a player edit.
	if (after.startsWith("flowing_") || (after === "air" && before.startsWith("flowing_"))) return null;
	return after === "air"
		? { kind: "break", material: materialFor(before) }
		: { kind: "place", material: materialFor(after) };
}

export function playerSounds(before: { health: number; food: number; dead: boolean },
	after: { health: number; food: number; dead: boolean }): Sound[] {
	if (before.dead) return [];
	const sounds: Sound[] = [];
	if (after.health < before.health) sounds.push({ kind: "playerHurt" });
	if (after.food > before.food) sounds.push({ kind: "eat" });
	if (after.dead) sounds.push({ kind: "death" });
	return sounds;
}

export function creeperIgnited(before: number, after: number): boolean {
	// A newly streamed creeper can already have a partly burned fuse.
	return before === 0 && after === 1;
}

export function mobRemovalSound(mob: { kind: MobKind; fuse: number }, sinceHurt: number): Sound | null {
	if (mob.kind === 6 && mob.fuse >= 29) return { kind: "explosion" };
	if (sinceHurt <= 750) return { kind: "mobDeath", mob: mob.kind };
	return null;
}

export function arrowStopped(before: ArrowEntity, after: ArrowEntity): boolean {
	// A block impact keeps the flight direction for rendering. In flight the
	// velocity changes every tick through drag and gravity.
	return before.velocity.some(v => v !== 0) &&
		(after.velocity.every(v => v === 0) || after.velocity.every((v, i) => v === before.velocity[i]));
}

export function arrowHitPosition(arrow: ArrowEntity, targets: readonly Vec3[]): Vec3 | null {
	const [x, y, z] = arrow.position;
	const [dx, dy, dz] = arrow.velocity;
	const speedSquared = dx * dx + dy * dy + dz * dz;
	if (speedSquared === 0) return null;
	let closest: Vec3 | null = null;
	let bestDistance = 1.1;
	for (const [tx, ty, tz] of targets) {
		const t = Math.max(0, Math.min(1, ((tx - x) * dx + (ty - y) * dy + (tz - z) * dz) / speedSquared));
		const point: Vec3 = [x + dx * t, y + dy * t, z + dz * t];
		const distance = Math.hypot(tx - point[0], ty - point[1], tz - point[2]);
		if (distance < bestDistance) {
			bestDistance = distance;
			closest = point;
		}
	}
	return closest;
}

export const VOLUME_CONTROLS = ["master", "effects", "music"] as const;
export type Volumes = Record<typeof VOLUME_CONTROLS[number], number>;
export const DEFAULT_VOLUMES: Readonly<Volumes> = { master: 80, effects: 100, music: 60 };

export function distanceGain(distance: number): number {
	return Math.max(0, 1 - distance / 32);
}

export function soundGain(volumes: Volumes, channel: "effects" | "music", distance = 0): number {
	return (volumes.master / 100) * (volumes[channel] / 100) * distanceGain(distance);
}

export function spatialSound(camera: { x: number; y: number; z: number; yaw: number }, source: Vec3) {
	const dx = source[0] - camera.x, dy = source[1] - camera.y, dz = source[2] - camera.z;
	const distance = Math.hypot(dx, dy, dz);
	const [rx, , rz] = right(camera.yaw);
	const lateral = dx * rx + dz * rz;
	return { distance, pan: lateral ? Math.max(-1, Math.min(1, lateral / distance)) : 0 };
}

export const MAX_VOICES = 24;

/** Number of existing voices to stop before starting one more. */
export function voicesToStop(active: number): number {
	return Math.max(0, active + 1 - MAX_VOICES);
}
