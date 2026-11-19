import type { MobKind, RayHit } from "./client-core.ts";

import { chicken, cow, pig, sheep } from "./mobs/farm.ts";
import { zombie } from "./mobs/hostile.ts";
import type { MobAsset, MobBone, MobCube, Vec3 } from "./mobs/model.ts";

/** Interpolate in double precision before converting camera-relative vertices to f32. */
export function interpolateEntity(previous: readonly number[], current: readonly number[], elapsedMs: number): [number, number, number] {
	const t = Math.max(0, Math.min(1, elapsedMs / 50));
	return [0, 1, 2].map(axis => previous[axis] + (current[axis] - previous[axis]) * t) as [number, number, number];
}

// Foot-centered hitboxes, matching the server's MobSpec.
const mobHitboxes = [
	{ width: 0.9, height: 1.3 },
	{ width: 0.9, height: 0.9 },
	{ width: 0.4, height: 0.7 },
	{ width: 0.9, height: 1.3 },
	{ width: 0.6, height: 1.95 },
] as const satisfies Record<MobKind, { width: number; height: number }>;

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

// Protocol kinds index both this table and the GPU skin array. The 64×32 skins
// occupy the upper half of a layer at their original texel scale.
export const mobAssetsByKind = [cow, pig, chicken, sheep, zombie] as const satisfies Record<MobKind, MobAsset>;
export const MOB_SKIN_SIZE = 64;

// Corners for each face in image order: top-left, top-right, bottom-right, bottom-left.
// The six rectangles in a Bedrock box UV net are west, front, east, back, top, bottom.
const skinFaceCorners = [
	[7, 4, 0, 3], [4, 5, 1, 0], [5, 6, 2, 1], [6, 7, 3, 2], [7, 6, 5, 4], [0, 1, 2, 3],
];
const skinFaceShades = [0.6, 0.8, 0.6, 0.8, 1, 0.5];

function compileCube(cube: MobCube) {
	const [u, v] = cube.uv, [w, h, d] = cube.uvSize ?? cube.size;
	const rects = [
		[u, v + d, d, h], [u + d, v + d, w, h], [u + d + w, v + d, d, h],
		[u + 2 * d + w, v + d, w, h], [u + d, v, w, d], [u + d + w, v, w, d],
	];
	const points: Vec3[] = corners.map(([x, y, z]) =>
		[cube.origin[0] + x * cube.size[0], cube.origin[1] + y * cube.size[1], cube.origin[2] + z * cube.size[2]]);
	const vertices = skinFaceCorners.flatMap((indices, face) => {
		const mirroredSide = cube.mirror && (face === 0 || face === 2);
		const [left, top, width, height] = rects[mirroredSide ? 2 - face : face];
		// Model -Z becomes game +Z. Reverse the winding so these quads still face out.
		return [0, 3, 2, 0, 2, 1].map(i => {
			const rightEdge = i === 1 || i === 2;
			return {
				corner: indices[i], shade: skinFaceShades[face],
				u: (left + (rightEdge !== !!cube.mirror ? width : 0)) / MOB_SKIN_SIZE,
				v: (top + (i >= 2 ? height : 0)) / MOB_SKIN_SIZE,
			};
		});
	});
	return { points, vertices };
}

type Transform = (point: Vec3) => Vec3;
const radians = Math.PI / 180;

function bonePose(bone: MobBone, stridePitch: number, parent: Transform): Transform {
	const [pitch, yaw, roll] = bone.rotation ?? [0, 0, 0];
	if (pitch + stridePitch === 0 && yaw === 0 && roll === 0) return parent;
	const [px, py, pz] = bone.pivot;
	const rx = -(pitch + stridePitch) * radians, ry = -yaw * radians, rz = roll * radians;
	const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
	const cz = Math.cos(rz), sz = Math.sin(rz);
	return ([x, y, z]) => {
		x -= px; y -= py; z -= pz;
		const y1 = cx * y - sx * z, z1 = sx * y + cx * z;
		const x2 = cy * x + sy * z1, z2 = cy * z1 - sy * x;
		return parent([px + cz * x2 - sz * y1, py + sz * x2 + cz * y1, pz + z2]);
	};
}

const mobMeshes = mobAssetsByKind.map((asset, kind) => {
	const poses: Transform[] = [];
	const restPoints: Vec3[] = [];
	const bones = asset.bones.map(bone => {
		const parent = asset.bones.findIndex(other => other.name === bone.parent);
		const pose = bonePose(bone, 0, poses[parent] ?? (point => point));
		poses.push(pose);
		const cubes = bone.cubes?.map(compileCube) ?? [];
		for (const cube of cubes) restPoints.push(...cube.points.map(pose));
		return { bone, parent, walkPitch: asset.walkPitch[bone.name] ?? 0, cubes };
	});
	const floats = bones.reduce((sum, { cubes }) => sum + cubes.length * 36 * 9, 0);
	const { height, width } = mobHitboxes[kind];
	const scale = Math.min(1 / 16, height / Math.max(...restPoints.map(point => point[1])));
	const z = restPoints.map(point => point[2]);
	const front = Math.min(...z), back = Math.max(...z);
	// Centre long models over the interaction box so a side view can target the head.
	const centerZ = Math.max(-front, back) * scale > width / 2 ? (front + back) / 2 : 0;
	return { bones, floats, scale, centerZ };
});

export function mobVertices(mobs: readonly RenderMob[], camera: readonly number[], timeMs: number): Float32Array {
	const out = new Float32Array(mobs.reduce((sum, mob) => sum + mobMeshes[mob.kind].floats, 0));
	let i = 0;
	for (const mob of mobs) {
		const { bones, scale, centerZ } = mobMeshes[mob.kind];
		const yaw = mob.yaw * radians, c = Math.cos(yaw) * scale, s = Math.sin(yaw) * scale;
		const [ox, oy, oz] = mob.position.map((value, axis) => value - camera[axis]);
		const world: Transform = ([x, y, z]) => [ox + c * x + s * (z - centerZ), oy + y * scale, oz + s * x - c * (z - centerZ)];
		const stride = mob.moving ? Math.sin(timeMs / 100) : 0;
		const shadeSign = mob.hurt ? -1 : 1;
		const blockLight = (mob.light[1] + 0.5) / 16, skyLight = (mob.light[0] + 0.5) / 16;
		const poses: Transform[] = [];
		for (const { bone, parent, walkPitch, cubes } of bones) {
			const pose = bonePose(bone, walkPitch * stride, parent < 0 ? world : poses[parent]);
			poses.push(pose);
			for (const cube of cubes) {
				const points = cube.points.map(pose);
				for (const vertex of cube.vertices) {
					const [x, y, z] = points[vertex.corner];
					out[i++] = x;
					out[i++] = y;
					out[i++] = z;
					out[i++] = vertex.u;
					out[i++] = vertex.v;
					out[i++] = vertex.shade * shadeSign;
					out[i++] = mob.kind;
					out[i++] = blockLight;
					out[i++] = skyLight;
				}
			}
		}
	}
	return out;
}
