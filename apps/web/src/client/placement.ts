import type { RayHit } from "./client-core.ts";
import { FACE_NORMALS } from "./client-core.ts";

export interface BlockStateInfo {
	digTicks?: number | null;
	name: string;
	stateName: string;
	first: number;
	count: number;
	model: "cube" | "boxes" | "cross" | "stairs" | "fence";
	occludes: boolean;
	texture: string;
	/** Texture names in mesher order: down, up, north, south, west, east. */
	faces: [string, string, string, string, string, string];
	boxes: [[number, number, number], [number, number, number]][];
}

/**
 * Returns a concrete edit, or null if the client cannot place here.
 * Stair facing follows yaw (degrees): 0=south (+Z), 90=west (-X),
 * 180=north (-Z), 270=east (+X). Quadrants start at -45/45/135/225;
 * an exact boundary chooses the next quadrant as yaw increases. Yaw wraps.
 * The high step faces away from the player. Bottom faces place top stairs;
 * top faces place bottom stairs; side hits at local Y >= 0.5 place top stairs.
 */
export function placementState(
	registry: readonly BlockStateInfo[], selected: number, hit: RayHit, yaw: number,
	getBlock: (x: number, y: number, z: number) => number,
): { x: number; y: number; z: number; state: number } | null {
	const block = registry[selected];
	const normal = FACE_NORMALS[hit.face];
	if (!block || block.name === "air" || !normal || !Number.isFinite(hit.hitY)) return null;
	const slab = block.count === 3;
	const stairs = block.model === "stairs";
	if (stairs && !Number.isFinite(yaw)) return null;
	const target = getBlock(hit.x, hit.y, hit.z);
	if (slab && registry[target]?.first === block.first
		&& ((target === block.first && hit.face === 1) || (target === block.first + 1 && hit.face === 0))) {
		return { x: hit.x, y: hit.y, z: hit.z, state: block.first + 2 };
	}
	const [x, y, z] = [hit.x + normal[0], hit.y + normal[1], hit.z + normal[2]];
	let state = block.first;
	if (stairs) {
		const normalized = ((yaw % 360) + 360) % 360;
		// State offsets for south, west, north, east; each owns bottom then top.
		state += [2, 4, 0, 6][Math.floor((normalized + 45) / 90) % 4];
	}
	if (slab || stairs) state += hit.face === 0 || (hit.face > 1 && hit.hitY >= 0.5) ? 1 : 0;
	const current = getBlock(x, y, z);
	if (slab && registry[current]?.first === block.first && current < block.first + 2 && current !== state) {
		state = block.first + 2;
	} else if (!["air", "water", "flowing_water"].includes(registry[current]?.name)) {
		return null;
	}
	if (block.model === "cross") {
		const below = registry[getBlock(x, y - 1, z)];
		if (block.name === "wheat") {
			if (registry[current]?.name !== "air" || below?.name !== "farmland") return null;
		} else if (!below?.occludes) return null;
	}
	return { x, y, z, state };
}

/** Right-click uses a table or furnace before attempting placement, including with an empty hand. */
export function blockInteraction(blockName: string | undefined, shift: boolean): "open" | "place" {
    return (blockName === "crafting_table" || blockName === "furnace") && !shift ? "open" : "place";
}

export function canTill(heldName: string | undefined, blockName: string | undefined, aboveName: string | undefined): boolean {
	return (blockName === "grass_block" || blockName === "dirt") && aboveName === "air"
		&& heldName !== undefined && /^(wooden|stone|copper|iron)_hoe$/.test(heldName);
}

export function usesFluidSourceRay(heldName: string | undefined): boolean {
	return heldName === "bucket";
}

/** Empty buckets use a fluid-source-inclusive hit. Filled buckets use a normal hit. */
export function bucketTarget(
    heldName: string, hit: RayHit | null, blockName: (x: number, y: number, z: number) => string | undefined,
    shift: boolean,
): [number, number, number] | null {
    if (!hit) return null;
    const { x, y, z, face } = hit;
    const target = blockName(x, y, z);
    if (heldName === "bucket") return target === "water" || target === "lava" ? [x, y, z] : null;
    const normal = FACE_NORMALS[face];
    const flow = heldName === "water_bucket" ? "flowing_water" : heldName === "lava_bucket" ? "flowing_lava" : null;
    if (!flow || !normal || blockInteraction(target, shift) === "open") return null;
    const adjacent: [number, number, number] = [x + normal[0], y + normal[1], z + normal[2]];
    const current = blockName(...adjacent);
    return current === "air" || current === flow ? adjacent : null;
}
