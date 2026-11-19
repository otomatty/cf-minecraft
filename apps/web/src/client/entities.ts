import type { MobKind, RayHit } from "./client-core.ts";

/** Interpolate in double precision before converting camera-relative vertices to f32. */
export function interpolateEntity(previous: readonly number[], current: readonly number[], elapsedMs: number): [number, number, number] {
	const t = Math.max(0, Math.min(1, elapsedMs / 50));
	return [0, 1, 2].map(axis => previous[axis] + (current[axis] - previous[axis]) * t) as [number, number, number];
}

// Foot-centered hitboxes, matching the server's MobSpec.
const mobHitboxes: Record<MobKind, { width: number; height: number }> = {
	0: { width: 0.9, height: 1.3 },
	1: { width: 0.9, height: 0.9 },
	2: { width: 0.4, height: 0.7 },
	3: { width: 0.9, height: 1.3 },
};

interface MobPosition {
	id: number;
	kind: MobKind;
	position: readonly [number, number, number];
}

/** Find the first mob hit by a unit ray, using the server's foot-centered hitbox. */
export function aimedMob(origin: readonly number[], dir: readonly number[], mobs: readonly MobPosition[], reach: number): { id: number; distance: number } | null {
	let closest: { id: number; distance: number } | null = null;
	for (const { id, kind, position: [x, y, z] } of mobs) {
		const { width, height } = mobHitboxes[kind];
		const half = width / 2;
		const min = [x - half, y, z - half];
		const max = [x + half, y + height, z + half];
		let near = 0;
		let far = reach;
		for (let axis = 0; axis < 3; axis++) {
			if (dir[axis] === 0) {
				if (origin[axis] < min[axis] || origin[axis] > max[axis]) far = -1;
			} else {
				const a = (min[axis] - origin[axis]) / dir[axis];
				const b = (max[axis] - origin[axis]) / dir[axis];
				near = Math.max(near, Math.min(a, b));
				far = Math.min(far, Math.max(a, b));
			}
			if (near > far) break;
		}
		if (near <= far && (!closest || near < closest.distance)) closest = { id, distance: near };
	}
	return closest;
}

export function mobBeforeBlock(origin: readonly number[], dir: readonly number[], mobs: readonly MobPosition[], reach: number, block: RayHit | null): number | null {
	const mob = aimedMob(origin, dir, mobs, reach);
	if (!mob || !block) return mob?.id ?? null;
	// Recover the ray distance from the face of the selection box hit by Wasm.
	const axis = [1, 2, 0][block.face >> 1];
	const cell = [block.x, block.y, block.z];
	const face = (block.face & 1 ? block.max : block.min)[axis];
	const distance = (cell[axis] + face - origin[axis]) / dir[axis];
	return mob.distance < distance ? mob.id : null;
}

export interface RenderItem {
	position: [number, number, number];
	texture: number;
	flat?: boolean;
	/** Sky light first, block light second; lightmap UVs use the reverse order. */
	light: [sky: number, block: number];
}

export const MAX_RENDER_ITEMS = 1024;

/** Keep vertex uploads within the item buffer capacity, preserving input order. */
export function limitRenderItems(items: readonly RenderItem[]): readonly RenderItem[] {
	return items.slice(0, MAX_RENDER_ITEMS);
}

const corners = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]];
// Down, up, north, south, west, east; counterclockwise from outside each face.
const faces = [[0, 1, 2, 3], [7, 6, 5, 4], [1, 0, 4, 5], [3, 2, 6, 7], [0, 3, 7, 4], [2, 1, 5, 6]];

/** Visual animation only. Subtract the camera in f64 before writing f32 vertices. */
export function itemVertices(items: readonly RenderItem[], camera: readonly number[], timeMs: number): Float32Array {
	const out: number[] = [];
	const angle = timeMs / 2000, c = Math.cos(angle), s = Math.sin(angle);
	for (const item of items) {
		const itemCorners = item.flat ? [[0,0,.5],[1,0,.5],[1,1,.5],[0,1,.5]] : corners;
		const itemFaces = item.flat ? [[0,1,2,3],[1,0,3,2]] : faces;
		for (const [face, indices] of itemFaces.entries()) {
			for (const i of [0, 1, 2, 0, 2, 3]) {
				const vertex = itemCorners[indices[i]];
				const x = (vertex[0] - 0.5) * 0.25, z = (vertex[2] - 0.5) * 0.25;
				out.push(
					item.position[0] - camera[0] + x * c - z * s,
					item.position[1] - camera[1] + vertex[1] * 0.25 + 0.04 + Math.sin(timeMs / 500) * 0.03,
					item.position[2] - camera[2] + x * s + z * c,
					[0, 1, 1, 0][i], [1, 1, 0, 0][i], (item.flat ? 1 : [0.5, 1, 0.8, 0.8, 0.6, 0.6][face]), item.texture,
					(item.light[1] + 0.5) / 16, (item.light[0] + 0.5) / 16,
				);
			}
		}
	}
	return new Float32Array(out);
}

export interface RenderMob {
	kind: MobKind;
	position: [number, number, number];
	yaw: number;
	moving: boolean;
	hurt: boolean;
	light: RenderItem["light"];
}

export const mobTextureNames = [
	"cow_hide", "cow_face", "cow_leg", "pig_skin", "pig_face", "pig_leg", "pig_snout",
	"chicken_plumage", "chicken_face", "chicken_beak", "chicken_wattle", "chicken_leg",
	"sheep_wool", "sheep_face", "sheep_leg",
] as const;
type MobTextureName = typeof mobTextureNames[number];
export type MobTextures = Record<MobTextureName, number>;

type MobBox = {
	min: [number, number, number];
	max: [number, number, number];
	legSwing?: number;
	front?: MobTextureName;
	texture?: MobTextureName;
};

const cowBoxes: readonly MobBox[] = [
	{ min: [-0.32, 0.49, -0.45], max: [0.32, 1.08, 0.23] },
	{ min: [-0.24, 0.77, 0.16], max: [0.24, 1.3, 0.45], front: "cow_face" },
	{ min: [-0.28, 0, -0.36], max: [-0.12, 0.54, -0.20], legSwing: 1 },
	{ min: [0.12, 0, -0.36], max: [0.28, 0.54, -0.20], legSwing: -1 },
	{ min: [-0.28, 0, 0.04], max: [-0.12, 0.54, 0.20], legSwing: -1 },
	{ min: [0.12, 0, 0.04], max: [0.28, 0.54, 0.20], legSwing: 1 },
];

const pigBoxes: readonly MobBox[] = [
	{ min: [-0.42, 0.24, -0.46], max: [0.42, 0.76, 0.32] },
	{ min: [-0.27, 0.39, 0.19], max: [0.27, 0.90, 0.49], front: "pig_face" },
	{ min: [-0.18, 0.43, 0.48], max: [0.18, 0.60, 0.60], front: "pig_snout" },
	{ min: [-0.35, 0, -0.38], max: [-0.16, 0.28, -0.19], legSwing: 1 },
	{ min: [0.16, 0, -0.38], max: [0.35, 0.28, -0.19], legSwing: -1 },
	{ min: [-0.35, 0, 0.11], max: [-0.16, 0.28, 0.30], legSwing: -1 },
	{ min: [0.16, 0, 0.11], max: [0.35, 0.28, 0.30], legSwing: 1 },
];

const chickenBoxes: readonly MobBox[] = [
	{ min: [-0.15, 0.18, -0.20], max: [0.15, 0.45, 0.12] },
	{ min: [-0.10, 0.39, 0.02], max: [0.10, 0.70, 0.15], front: "chicken_face" },
	{ min: [-0.07, 0.49, 0.145], max: [0.07, 0.56, 0.20], texture: "chicken_beak" },
	{ min: [-0.035, 0.405, 0.145], max: [0.035, 0.49, 0.177], texture: "chicken_wattle" },
	{ min: [-0.10, 0, -0.05], max: [-0.06, 0.20, 0.015], legSwing: 1 },
	{ min: [0.06, 0, -0.05], max: [0.10, 0.20, 0.015], legSwing: -1 },
	{ min: [-0.20, 0.235, -0.17], max: [-0.145, 0.39, 0.06] },
	{ min: [0.145, 0.235, -0.17], max: [0.20, 0.39, 0.06] },
];

const sheepBoxes: readonly MobBox[] = [
	// Wool torso, rounder and larger than the cow's 0.64 by 0.59 body.
	{ min: [-0.36, 0.40, -0.40], max: [0.36, 1.05, 0.28] },
	// A second wool layer that sticks out around the torso.
	{ min: [-0.42, 0.52, -0.32], max: [0.42, 1.14, 0.18] },
	{ min: [-0.16, 0.78, 0.20], max: [0.16, 1.20, 0.45], front: "sheep_face" },
	{ min: [-0.32, 0, -0.30], max: [-0.16, 0.48, -0.14], legSwing: 1 },
	{ min: [0.16, 0, -0.30], max: [0.32, 0.48, -0.14], legSwing: -1 },
	{ min: [-0.32, 0, 0.06], max: [-0.16, 0.48, 0.22], legSwing: -1 },
	{ min: [0.16, 0, 0.06], max: [0.32, 0.48, 0.22], legSwing: 1 },
];

const mobModels: Record<MobKind, { boxes: readonly MobBox[]; hide: MobTextureName; leg: MobTextureName }> = {
	0: { boxes: cowBoxes, hide: "cow_hide", leg: "cow_leg" },
	1: { boxes: pigBoxes, hide: "pig_skin", leg: "pig_leg" },
	2: { boxes: chickenBoxes, hide: "chicken_plumage", leg: "chicken_leg" },
	3: { boxes: sheepBoxes, hide: "sheep_wool", leg: "sheep_leg" },
};

export function mobVertices(
	mobs: readonly RenderMob[], camera: readonly number[], timeMs: number, textures: MobTextures,
): Float32Array {
	const vertices: number[] = [];
	for (const mob of mobs) {
		const { boxes, hide, leg } = mobModels[mob.kind];
		const yaw = mob.yaw * Math.PI / 180, yawCos = Math.cos(yaw), yawSin = Math.sin(yaw);
		const stride = mob.moving ? Math.sin(timeMs / 100) * 0.32 : 0;
		const [ox, oy, oz] = mob.position.map((value, axis) => value - camera[axis]);
		for (const { min, max, legSwing, front, texture } of boxes) {
			const angle = stride * (legSwing ?? 0);
			const swingCos = Math.cos(angle), swingSin = Math.sin(angle);
			const pivotZ = (min[2] + max[2]) / 2;
			const points = corners.map(([cx, cy, cz]) => {
				const x = cx ? max[0] : min[0];
				const y = (cy ? max[1] : min[1]) - max[1];
				const z = (cz ? max[2] : min[2]) - pivotZ;
				const legY = y * swingCos - z * swingSin + max[1];
				const legZ = y * swingSin + z * swingCos + pivotZ;
				return [ox + x * yawCos - legZ * yawSin, oy + legY, oz + x * yawSin + legZ * yawCos];
			});
			for (const [face, indices] of faces.entries()) {
				const layer = textures[legSwing ? leg : (face === 3 ? front : undefined) ?? texture ?? hide];
				// The item shader reads the sign as the hurt flag and the magnitude as face shading.
				const shade = [0.5, 1, 0.8, 0.8, 0.6, 0.6][face] * (mob.hurt ? -1 : 1);
				for (const i of [0, 1, 2, 0, 2, 3]) {
					vertices.push(
						...points[indices[i]], [0, 1, 1, 0][i], [1, 1, 0, 0][i],
						shade, layer,
						(mob.light[1] + 0.5) / 16, (mob.light[0] + 0.5) / 16,
					);
				}
			}
		}
	}
	return new Float32Array(vertices);
}
