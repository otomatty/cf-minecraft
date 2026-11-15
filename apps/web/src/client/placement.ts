import type { RayHit } from "./client-core.ts";
import { FACE_NORMALS } from "./client-core.ts";

export interface BlockStateInfo {
	name: string;
	stateName: string;
	first: number;
	count: number;
	model: "cube" | "boxes" | "cross";
	occludes: boolean;
	texture: string;
}

/** Returns a concrete edit, or null if the client cannot place here. */
export function placementState(
	registry: readonly BlockStateInfo[], selected: number, hit: RayHit,
	getBlock: (x: number, y: number, z: number) => number,
): { x: number; y: number; z: number; state: number } | null {
	const block = registry[selected];
	const normal = FACE_NORMALS[hit.face];
	if (!block || block.name === "air" || !normal || !Number.isFinite(hit.hitY)) return null;
	const slab = block.count === 3;
	const target = getBlock(hit.x, hit.y, hit.z);
	if (slab && registry[target]?.first === block.first
		&& ((target === block.first && hit.face === 1) || (target === block.first + 1 && hit.face === 0))) {
		return { x: hit.x, y: hit.y, z: hit.z, state: block.first + 2 };
	}
	const [x, y, z] = [hit.x + normal[0], hit.y + normal[1], hit.z + normal[2]];
	let state = block.first;
	if (slab) state += hit.face === 0 || (hit.face > 1 && hit.hitY >= 0.5) ? 1 : 0;
	const current = getBlock(x, y, z);
	if (slab && registry[current]?.first === block.first && current < block.first + 2 && current !== state) {
		state = block.first + 2;
	} else if (registry[current]?.name !== "air" && registry[current]?.name !== "water") {
		return null;
	}
	if (block.model === "cross" && !registry[getBlock(x, y - 1, z)]?.occludes) return null;
	return { x, y, z, state };
}
