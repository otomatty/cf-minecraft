import type { MobKind, RayHit, WoolColor } from "./client-core.ts";
import { boxInFrustum } from "./math.ts";

import { chicken, coloredSheepSkins, cow, pig, sheep, shearedSheep } from "./mobs/farm.ts";
import { blastFrames, smokeFrames } from "./mobs/explosion.ts";
import { flameFrames } from "./mobs/flame.ts";
import { creeper, skeleton, zombie } from "./mobs/hostile.ts";
import type { MobAsset, MobBone, MobCube, Vec3 } from "./mobs/model.ts";
import { player } from "./mobs/player.ts";

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
	{ width: 0.6, height: 1.99 },
	{ width: 0.6, height: 1.7 },
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
	centered?: boolean;
	velocity?: Vec3;
	/** Sky light first, block light second; lightmap UVs use the reverse order. */
	light: [sky: number, block: number];
}

export interface RenderSprite {
	corners: readonly Vec3[];
	texture: number;
	light: RenderItem["light"];
}

export const MAX_RENDER_ITEMS = 1024;

/** Keep vertex uploads within the item buffer capacity, preserving input order. */
export function limitRenderItems(items: readonly RenderItem[]): readonly RenderItem[] {
	return items.slice(0, MAX_RENDER_ITEMS);
}

const corners = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]];
// Down, up, north, south, west, east; counterclockwise from outside each face.
const faces = [[0, 1, 2, 3], [7, 6, 5, 4], [1, 0, 4, 5], [3, 2, 6, 7], [0, 3, 7, 4], [2, 1, 5, 6]];

function writeSprite(out: number[], { corners, texture, light }: RenderSprite): void {
	for (const index of [0, 1, 2, 0, 2, 3, 1, 0, 3, 1, 3, 2]) {
		out.push(...corners[index], [0, 1, 1, 0][index], [1, 1, 0, 0][index], 1, texture,
			(light[1] + 0.5) / 16, (light[0] + 0.5) / 16);
	}
}

function arrowCorners(position: Vec3, velocity: Vec3, camera: readonly number[]): Vec3[] {
	const [vx, vy, vz] = velocity;
	const length = Math.hypot(vx, vy, vz);
	const forward: Vec3 = length ? [vx / length, vy / length, vz / length] : [0, 0, 1];
	const origin: Vec3 = [position[0] - camera[0], position[1] - camera[1], position[2] - camera[2]];
	const across = ([x, y, z]: Vec3): Vec3 =>
		[forward[1] * z - forward[2] * y, forward[2] * x - forward[0] * z, forward[0] * y - forward[1] * x];
	let side = across(origin);
	if (Math.hypot(...side) < 1e-6) side = across(Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
	const scale = 0.4 / Math.SQRT2;
	const sideLength = Math.hypot(...side);
	// The texture's shaft runs from bottom left to top right. Anchor the tip at the projectile.
	return [[0, 1], [1, 1], [1, 0], [0, 0]].map(([u, v]) => {
		const along = scale * (u - v - 0.75);
		const offset = scale * (u + v - 1) / sideLength;
		const coordinate = (axis: number) => origin[axis] + forward[axis] * along + side[axis] * offset;
		return [coordinate(0), coordinate(1), coordinate(2)];
	});
}

/** Visual animation only. Subtract the camera in f64 before writing f32 vertices. */
export function itemVertices(items: readonly RenderItem[], camera: readonly number[], timeMs: number, sprites: readonly RenderSprite[] = []): Float32Array {
	const out: number[] = [];
	const angle = timeMs / 2000, c = Math.cos(angle), s = Math.sin(angle);
	for (const item of items) {
		if (item.velocity) {
			writeSprite(out, { ...item, corners: arrowCorners(item.position, item.velocity, camera) });
			continue;
		}
		const itemCorners = item.flat ? [[0,0,.5],[1,0,.5],[1,1,.5],[0,1,.5]] : corners;
		const itemFaces = item.flat ? [[0,1,2,3],[1,0,3,2]] : faces;
		const y = item.position[1] - camera[1];
		for (const [face, indices] of itemFaces.entries()) {
			for (const i of [0, 1, 2, 0, 2, 3]) {
				const vertex = itemCorners[indices[i]];
				const x = (vertex[0] - 0.5) * 0.25, z = (vertex[2] - 0.5) * 0.25;
				out.push(
					item.position[0] - camera[0] + x * c - z * s,
					item.centered ? y + (vertex[1] - 0.5) * 0.25 : y + vertex[1] * 0.25 + 0.04 + Math.sin(timeMs / 500) * 0.03,
					item.position[2] - camera[2] + x * s + z * c,
					[0, 1, 1, 0][i], [1, 1, 0, 0][i], (item.flat ? 1 : [0.5, 1, 0.8, 0.8, 0.6, 0.6][face]), item.texture,
					(item.light[1] + 0.5) / 16, (item.light[0] + 0.5) / 16,
				);
			}
		}
	}
	for (const sprite of sprites.slice(0, MAX_RENDER_ITEMS - items.length)) writeSprite(out, sprite);
	return new Float32Array(out);
}

interface RenderPose {
	position: [number, number, number];
	yaw: number;
	moving: boolean;
	light: RenderItem["light"];
}

export interface RenderMob extends RenderPose {
	kind: MobKind;
	hurt: boolean;
	fuse?: number;
	burning?: boolean;
	woolColor?: WoolColor;
	sheared?: boolean;
}

export interface RenderPlayer extends RenderPose {
	id: number;
	name: string;
	pitch: number;
}

export function mobInFrustum({ kind, position: [x, y, z] }: RenderMob, eye: readonly number[], planes: Float32Array): boolean {
	const { width, height } = mobHitboxes[kind];
	// Animated limbs, held items and swelling can extend past the hitbox.
	const half = width / 2 + 0.75;
	return boxInFrustum(planes, x - eye[0] - half, y - eye[1] - 0.125, z - eye[2] - half,
		2 * half, height + 0.625, 2 * half);
}

/** Cross two cutout sprites through the hitbox, leaving the upper body visible between tongues. */
export function flameVertices(mobs: readonly RenderMob[], camera: readonly number[], timeMs: number, firstFrame: number): Float32Array {
	const out: number[] = [];
	const frame = Math.floor(timeMs / 90);
	for (const { burning, kind, position } of mobs) {
		if (!burning) continue;
		const [x, y, z] = position.map((value, axis) => value - camera[axis]);
		const { width, height } = mobHitboxes[kind];
		const half = width * 0.62;
		for (const direction of [-1, 1]) {
			const dz = direction * half;
			writeSprite(out, {
				corners: [[x - half, y, z - dz], [x + half, y, z + dz],
					[x + half, y + height, z + dz], [x - half, y + height, z - dz]],
				texture: firstFrame + (frame + (direction === 1 ? 1 : 0)) % flameFrames.length,
				light: [0, 0], // The flame pass uses the sprite color directly.
			});
		}
	}
	return new Float32Array(out);
}

export const MAX_EXPLOSION_PARTICLES = 256;

export interface ExplosionParticle {
	position: Vec3;
	velocity: Vec3;
	startedAt: number;
	lifetime: number;
	size: number;
	smoke: boolean;
}

export function spawnExplosionParticles(center: Vec3, now: number): ExplosionParticle[] {
	const particles: ExplosionParticle[] = [];
	for (const [smoke, count] of [[false, 5], [true, 16]] as const) {
		for (let i = 0; i < count; i++) {
			const angle = (i + Math.random()) * 2 * Math.PI / count;
			const x = Math.cos(angle), z = Math.sin(angle);
			const offset = 0.15 + Math.random() * 0.45;
			const speed = 0.35 + Math.random() * (smoke ? 0.65 : 3);
			particles.push({
				position: [center[0] + x * offset, center[1] + (Math.random() - 0.3) * 0.65, center[2] + z * offset],
				velocity: [x * speed, 0.4 + Math.random() * 0.6, z * speed],
				startedAt: now + (smoke ? 45 + Math.random() * 100 : 0),
				lifetime: smoke ? 1050 + Math.random() * 300 : 150 + Math.random() * 90,
				size: smoke ? 0.65 + Math.random() * 0.55 : 1.2 + Math.random() * 0.65,
				smoke,
			});
		}
	}
	return particles;
}

/** Camera-facing cutouts in the same unlit pass as the flames. */
export function explosionVertices(particles: readonly ExplosionParticle[], camera: Vec3,
	side: Vec3, up: Vec3, now: number, firstFrame: number): Float32Array {
	const out: number[] = [];
	for (const { position, velocity, startedAt, lifetime, size, smoke } of particles) {
		const age = now - startedAt;
		const progress = age / lifetime;
		const half = size * (1 - 0.45 * progress) / 2;
		const frameCount = smoke ? smokeFrames.length : blastFrames.length;
		const texture = firstFrame + (smoke ? blastFrames.length : 0) + Math.floor(progress * frameCount);
		const point = (horizontal: number, vertical: number): Vec3 => {
			const coordinate = (axis: number) => position[axis] - camera[axis] + velocity[axis] * age / 1000
				+ half * (side[axis] * horizontal + up[axis] * vertical);
			return [coordinate(0), coordinate(1), coordinate(2)];
		};
		writeSprite(out, {
			corners: [point(-1, -1), point(1, -1), point(1, 1), point(-1, 1)],
			texture,
			light: [0, 0],
		});
	}
	return new Float32Array(out);
}

// Protocol mob kinds index the first layers; the player skin follows them.
// The 64×32 skins occupy the upper half of a layer at their original texel scale.
export const mobAssetsByKind = [cow, pig, chicken, sheep, zombie, skeleton, creeper] as const satisfies Record<MobKind, MobAsset>;
const playerSkinLayer = mobAssetsByKind.length;
const coloredSheepLayer = playerSkinLayer + 1;
const shearedSheepLayer = coloredSheepLayer + coloredSheepSkins.length;
export const entitySkins = [...mobAssetsByKind.map(asset => asset.texture), player.texture,
	...coloredSheepSkins, shearedSheep.texture];
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

function compileMob(asset: MobAsset, { height, width }: { height: number; width: number }) {
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
	const scale = Math.min(1 / 16, height / Math.max(...restPoints.map(point => point[1])));
	const z = restPoints.map(point => point[2]);
	const front = Math.min(...z), back = Math.max(...z);
	// Centre long models over the interaction box so a side view can target the head.
	const centerZ = Math.max(-front, back) * scale > width / 2 ? (front + back) / 2 : 0;
	return { bones, floats, scale, centerZ };
}

const mobMeshes = mobAssetsByKind.map((asset, kind) => compileMob(asset, mobHitboxes[kind]));
const shearedSheepMesh = compileMob(shearedSheep, mobHitboxes[3]);
const playerMesh = compileMob(player, { height: 2, width: 0.6 });

function meshFor(entity: RenderMob | RenderPlayer) {
	if (!("kind" in entity)) return playerMesh;
	return entity.kind === 3 && entity.sheared ? shearedSheepMesh : mobMeshes[entity.kind];
}

function skinFor(entity: RenderMob | RenderPlayer): number {
	if (!("kind" in entity)) return playerSkinLayer;
	if (entity.kind !== 3) return entity.kind;
	if (entity.sheared) return shearedSheepLayer;
	return entity.woolColor ? coloredSheepLayer + entity.woolColor - 1 : 3;
}

export function mobVertices(mobs: readonly (RenderMob | RenderPlayer)[], camera: readonly number[], timeMs: number,
	sprites?: { output: RenderSprite[]; textures: ReadonlyMap<string, number> }): Float32Array {
	const out = new Float32Array(mobs.reduce((sum, mob) => sum + meshFor(mob).floats, 0));
	let i = 0;
	for (const mob of mobs) {
		const { bones, scale, centerZ } = meshFor(mob);
		const skinLayer = skinFor(mob);
		const headPitch = "pitch" in mob ? mob.pitch : 0;
		const fuse = Math.min(("fuse" in mob ? mob.fuse : undefined) ?? 0, 30);
		const swell = 1 + 0.2 * fuse / 30;
		const flash = Math.floor(fuse / 4) % 2 === 1;
		const drawn = scale * swell;
		const yaw = mob.yaw * radians, c = Math.cos(yaw) * drawn, s = Math.sin(yaw) * drawn;
		const [ox, oy, oz] = mob.position.map((value, axis) => value - camera[axis]);
		const world: Transform = ([x, y, z]) => [ox + c * x + s * (z - centerZ), oy + y * drawn, oz + s * x - c * (z - centerZ)];
		const stride = mob.moving ? Math.sin(timeMs / 100) : 0;
		const shadeSign = "hurt" in mob && mob.hurt ? -1 : 1;
		const blockLight = (mob.light[1] + 0.5) / 16, skyLight = (mob.light[0] + 0.5) / 16;
		const poses: Transform[] = [];
		for (const { bone, parent, walkPitch, cubes } of bones) {
			const pitch = walkPitch * stride + (bone.name === "head" ? headPitch : 0);
			const pose = bonePose(bone, pitch, parent < 0 ? world : poses[parent]);
			poses.push(pose);
			if (sprites && bone.itemSprite) {
				const texture = sprites.textures.get(bone.itemSprite.texture);
				if (texture !== undefined) {
					const [x, y, z] = bone.pivot;
					const [u, v] = bone.itemSprite.grip;
					sprites.output.push({
						corners: [[0, 16], [16, 16], [16, 0], [0, 0]].map(([col, row]) =>
							pose([x, y + v - row, z + col - u])),
						texture, light: mob.light,
					});
				}
			}
			for (const cube of cubes) {
				const points = cube.points.map(pose);
				for (const vertex of cube.vertices) {
					const [x, y, z] = points[vertex.corner];
					out[i++] = x;
					out[i++] = y;
					out[i++] = z;
					out[i++] = vertex.u;
					out[i++] = vertex.v;
					const shade = vertex.shade * shadeSign;
					out[i++] = flash ? shade + Math.sign(shade) * 2 : shade;
					out[i++] = skinLayer;
					out[i++] = blockLight;
					out[i++] = skyLight;
				}
			}
		}
	}
	return out;
}
