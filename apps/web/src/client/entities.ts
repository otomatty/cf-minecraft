/** Interpolate in double precision before converting camera-relative vertices to f32. */
export function interpolateEntity(previous: readonly number[], current: readonly number[], elapsedMs: number): [number, number, number] {
	const t = Math.max(0, Math.min(1, elapsedMs / 50));
	return [0, 1, 2].map(axis => previous[axis] + (current[axis] - previous[axis]) * t) as [number, number, number];
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

export interface RenderCow {
	position: [number, number, number];
	yaw: number;
	moving: boolean;
	light: RenderItem["light"];
}

type CowBox = {
	min: [number, number, number];
	max: [number, number, number];
	legSwing?: number;
};

const cowBoxes: readonly CowBox[] = [
	{ min: [-0.32, 0.49, -0.45], max: [0.32, 1.08, 0.23] },
	{ min: [-0.24, 0.77, 0.16], max: [0.24, 1.3, 0.45] },
	{ min: [-0.28, 0, -0.36], max: [-0.12, 0.54, -0.20], legSwing: 1 },
	{ min: [0.12, 0, -0.36], max: [0.28, 0.54, -0.20], legSwing: -1 },
	{ min: [-0.28, 0, 0.04], max: [-0.12, 0.54, 0.20], legSwing: -1 },
	{ min: [0.12, 0, 0.04], max: [0.28, 0.54, 0.20], legSwing: 1 },
];
export const COW_VERTEX_COUNT = cowBoxes.length * 36;

export function cowVertices(
	cows: readonly RenderCow[], camera: readonly number[], timeMs: number,
	textures: { hide: number; face: number; leg: number },
): Float32Array {
	const vertices: number[] = [];
	for (const cow of cows) {
		const yaw = cow.yaw * Math.PI / 180, yawCos = Math.cos(yaw), yawSin = Math.sin(yaw);
		const stride = cow.moving ? Math.sin(timeMs / 100) * 0.32 : 0;
		const [ox, oy, oz] = cow.position.map((value, axis) => value - camera[axis]);
		for (const [boxIndex, { min, max, legSwing }] of cowBoxes.entries()) {
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
				const texture = legSwing ? textures.leg : boxIndex === 1 && face === 3 ? textures.face : textures.hide;
				for (const i of [0, 1, 2, 0, 2, 3]) {
					vertices.push(
						...points[indices[i]], [0, 1, 1, 0][i], [1, 1, 0, 0][i],
						[0.5, 1, 0.8, 0.8, 0.6, 0.6][face], texture,
						(cow.light[1] + 0.5) / 16, (cow.light[0] + 0.5) / 16,
					);
				}
			}
		}
	}
	return new Float32Array(vertices);
}
