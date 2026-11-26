/** Model-space texels, with the face towards -Z. */
export type Vec3 = readonly [number, number, number];
type Vec2 = readonly [number, number];

export const faceNames = ["west", "north", "east", "south", "up", "down"] as const;
type Face = typeof faceNames[number];
export type FaceUv = Partial<Record<Face, { uv: Vec2; uv_size?: Vec2 }>>;

export interface MobCube {
	origin: Vec3;
	size: Vec3;
	uv: Vec2 | FaceUv;
	mirror?: boolean;
	inflate?: number;
	pivot?: Vec3;
	rotation?: Vec3;
}

export interface MobBone {
	name: string;
	parent?: string;
	/** Absolute model-space pivot. Child bones inherit the parent transform. */
	pivot: Vec3;
	rotation?: Vec3;
	/** Legacy bind pose applies to the bone's own cubes, whose child pivots are already posed. */
	bind_pose_rotation?: Vec3;
	mirror?: boolean;
	inflate?: number;
	neverRender?: boolean;
	cubes?: MobCube[];
}

export interface NativeImage {
	width: number;
	height: number;
	pixels: Uint8Array;
}

export interface MobAsset {
	texture: NativeImage;
	uvWidth: number;
	uvHeight: number;
	bones: MobBone[];
}

export const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const bounded = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 4096;

export function vector<N extends number>(value: unknown, length: N): value is number[] & { length: N } {
	return Array.isArray(value) && value.length === length && Array.from(value).every(bounded);
}

const vec2 = (value: unknown): value is Vec2 => vector(value, 2);
const vec3 = (value: unknown): value is Vec3 => vector(value, 3);

export function imageDimensions(width: unknown, height: unknown): boolean {
	return bounded(width) && bounded(height) && Number.isInteger(width) && Number.isInteger(height) &&
		width > 0 && width <= 512 && height > 0 && width * height <= 1024 ** 2;
}

export function nativeImage(value: unknown): value is NativeImage {
	return record(value) && imageDimensions(value.width, value.height) &&
		value.pixels instanceof Uint8Array && value.pixels.length === Number(value.width) * Number(value.height) * 4;
}

function validUv(uv: unknown): uv is MobCube["uv"] {
	if (vec2(uv)) return true;
	return record(uv) && Object.keys(uv).length > 0 && Object.entries(uv).every(([face, rect]) =>
		faceNames.some(name => name === face) && record(rect) && vec2(rect.uv) &&
		(rect.uv_size === undefined || vec2(rect.uv_size)) && rect.uv_rotation === undefined &&
		rect.material_instance === undefined);
}

function validCube(cube: unknown): cube is MobCube {
	return record(cube) && vec3(cube.origin) && vec3(cube.size) && cube.size.every(n => n >= 0) &&
		validUv(cube.uv) && (cube.mirror === undefined || typeof cube.mirror === "boolean") &&
		(cube.inflate === undefined || bounded(cube.inflate)) &&
		(cube.pivot === undefined || vec3(cube.pivot)) && (cube.rotation === undefined || vec3(cube.rotation));
}

type FaceRect = readonly [u: number, v: number, width: number, height: number];

/** Rectangles in faceNames order. Signed sizes retain per-face flips. */
export function cubeFaces(cube: MobCube, boneMirror = false): (FaceRect | undefined)[] {
	const [w, h, d] = cube.size;
	if (!vec2(cube.uv)) {
		const faces = cube.uv;
		const sizes: Vec2[] = [[d, h], [w, h], [d, h], [w, h], [w, d], [w, d]];
		return faceNames.map((face, index) => {
			const rect = faces[face];
			return rect && [...rect.uv, ...(rect.uv_size ?? sizes[index])];
		});
	}
	const [u, v] = cube.uv;
	const rects: FaceRect[] = [
		[u, v + d, d, h], [u + d, v + d, w, h], [u + d + w, v + d, d, h],
		[u + 2 * d + w, v + d, w, h], [u + d, v, w, d], [u + d + w, v, w, d],
	];
	if (!(cube.mirror ?? boneMirror)) return rects;
	[rects[0], rects[2]] = [rects[2], rects[0]];
	return rects.map(([x, y, width, height]) => [x + width, y, -width, height]);
}

function validBone(bone: unknown): bone is MobBone {
	return record(bone) && typeof bone.name === "string" && bone.name.length > 0 &&
		(bone.parent === undefined || typeof bone.parent === "string") && vec3(bone.pivot) &&
		(bone.rotation === undefined || vec3(bone.rotation)) &&
		(bone.bind_pose_rotation === undefined || vec3(bone.bind_pose_rotation)) &&
		(bone.mirror === undefined || typeof bone.mirror === "boolean") &&
		(bone.inflate === undefined || bounded(bone.inflate)) &&
		(bone.neverRender === undefined || typeof bone.neverRender === "boolean") &&
		bone.poly_mesh === undefined && bone.texture_meshes === undefined &&
		(bone.cubes === undefined || (Array.isArray(bone.cubes) && bone.cubes.length <= 128 && Array.from(bone.cubes).every(validCube)));
}

function orderedBones(value: unknown, width: number, height: number): MobBone[] | undefined {
	if (!Array.isArray(value) || value.length > 128) return;
	const bones = Array.from<unknown>(value);
	if (!bones.every(validBone)) return;
	const pending = new Map(bones.map(bone => [bone.name, bone]));
	if (pending.size !== value.length) return;
	const ordered = new Map<string, MobBone>();
	let cubes = 0, hasVolume = false;
	while (pending.size) {
		const before = pending.size;
		for (const [name, bone] of pending) {
			if (bone.parent !== undefined && !ordered.has(bone.parent)) continue;
			for (const cube of bone.neverRender ? [] : bone.cubes ?? []) {
				const inflate = cube.inflate ?? bone.inflate ?? 0;
				const sizes = cube.size.map(size => size + 2 * inflate);
				if (++cubes > 128 || sizes.some(size => size < 0)) return;
				hasVolume ||= sizes[1] > 0 || cube.rotation !== undefined ||
					bone.rotation !== undefined || bone.bind_pose_rotation !== undefined;
				for (const rect of cubeFaces(cube, bone.mirror)) {
					if (!rect) continue;
					const [u, v, w, h] = rect;
					if (u < 0 || v < 0 || u > width || v > height ||
						u + w < 0 || v + h < 0 || u + w > width || v + h > height) return;
				}
			}
			ordered.set(name, bone);
			pending.delete(name);
		}
		if (pending.size === before) return;
	}
	if (hasVolume) return [...ordered.values()];
}

export function validMobAsset(value: unknown): value is MobAsset {
	if (!record(value) || !nativeImage(value.texture) || !imageDimensions(value.uvWidth, value.uvHeight)) return false;
	const bones = orderedBones(value.bones, Number(value.uvWidth), Number(value.uvHeight));
	return !!bones && Array.isArray(value.bones) && bones.every((bone, index) =>
		bone === (value.bones as unknown[])[index]);
}

export interface GeometryDefinition {
	width: unknown;
	height: unknown;
	bones: unknown;
	base?: string;
}

/** Index geometry IDs independently of the filenames that contain them. */
export function geometryDefinitions(document: unknown): Map<string, GeometryDefinition> {
	const definitions = new Map<string, GeometryDefinition>();
	if (!record(document)) return definitions;
	if (Array.isArray(document["minecraft:geometry"])) {
		for (const entry of document["minecraft:geometry"]) {
			if (!record(entry) || !record(entry.description) || typeof entry.description.identifier !== "string") continue;
			const { identifier, texture_width: width, texture_height: height } = entry.description;
			definitions.set(identifier, { width, height, bones: entry.bones });
		}
	} else {
		for (const [key, entry] of Object.entries(document)) {
			if (!key.startsWith("geometry.") || !record(entry)) continue;
			const [id, base, extra] = key.split(":");
			if (extra !== undefined || base === "") continue;
			definitions.set(id, { width: entry.texturewidth, height: entry.textureheight, bones: entry.bones, base });
		}
	}
	return definitions;
}

function inheritBones(base: unknown, child: unknown): unknown {
	if (!Array.isArray(base) || !Array.isArray(child) || base.length + child.length > 256) return;
	const byName = new Map<unknown, Record<string, unknown>>();
	for (const bone of base) {
		if (!record(bone) || byName.has(bone.name)) return;
		byName.set(bone.name, bone);
	}
	const seen = new Set();
	for (const bone of child) {
		if (!record(bone) || seen.has(bone.name)) return;
		seen.add(bone.name);
		const parent = byName.get(bone.name);
		// Legacy geometry augments inherited cube lists (e.g. wool over the sheep's face and legs).
		const cubes = Array.isArray(parent?.cubes) && Array.isArray(bone.cubes)
			? [...parent.cubes, ...bone.cubes] : bone.cubes ?? parent?.cubes;
		byName.set(bone.name, { ...parent, ...bone, cubes });
	}
	return [...byName.values()];
}

export function resolveGeometry(id: string, definitions: ReadonlyMap<string, GeometryDefinition>, texture: NativeImage): MobAsset | undefined {
	const chain: GeometryDefinition[] = [], seen = new Set<string>();
	for (let name: string | undefined = id; name !== undefined;) {
		const definition: GeometryDefinition | undefined = definitions.get(name);
		if (!definition || seen.has(name) || chain.length >= 16) return;
		seen.add(name);
		chain.unshift(definition);
		name = definition.base;
	}
	let width: unknown, height: unknown, bones: unknown = [];
	for (const definition of chain) {
		if (definition.width !== undefined) width = definition.width;
		if (definition.height !== undefined) height = definition.height;
		bones = inheritBones(bones, definition.bones === undefined ? [] : definition.bones);
		if (!bones) return;
	}
	// Some legacy models omit canvas dimensions. Their UVs use image pixels directly.
	if (width === undefined) width = texture.width;
	if (height === undefined) height = texture.height;
	if (typeof width !== "number" || typeof height !== "number" || !imageDimensions(width, height)) return;
	const uvWidth = width, uvHeight = height;
	const sorted = orderedBones(Array.isArray(bones)
		? bones.map(bone => ({ ...bone, pivot: bone.pivot === undefined ? [0, 0, 0] : bone.pivot }))
		: bones, uvWidth, uvHeight);
	if (sorted) return { texture, uvWidth, uvHeight, bones: sorted };
}
