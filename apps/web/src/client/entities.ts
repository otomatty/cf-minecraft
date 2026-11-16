/** Interpolate in double precision before converting camera-relative vertices to f32. */
export function interpolateEntity(previous: readonly number[], current: readonly number[], elapsedMs: number): [number, number, number] {
	const t = Math.max(0, Math.min(1, elapsedMs / 50));
	return [0, 1, 2].map(axis => previous[axis] + (current[axis] - previous[axis]) * t) as [number, number, number];
}

export interface RenderItem {
	position: [number, number, number];
	texture: number;
	/** Sky light first, block light second; lightmap UVs use the reverse order. */
	light: [sky: number, block: number];
}

export const MAX_RENDER_ITEMS = 1024;

/** Keep vertex uploads within the item buffer capacity, preserving input order. */
export function limitRenderItems(items: readonly RenderItem[]): readonly RenderItem[] {
	return items.slice(0, MAX_RENDER_ITEMS);
}

/** Visual animation only. Subtract the camera in f64 before writing f32 vertices. */
export function itemVertices(items: readonly RenderItem[], camera: readonly number[], timeMs: number): Float32Array {
	const out: number[] = [];
	const corners = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]];
	// Down, up, north, south, west, east; counterclockwise from outside each face.
	const faces = [[0, 1, 2, 3], [7, 6, 5, 4], [1, 0, 4, 5], [3, 2, 6, 7], [0, 3, 7, 4], [2, 1, 5, 6]];
	const angle = timeMs / 2000, c = Math.cos(angle), s = Math.sin(angle);
	for (const item of items) {
		for (const [face, indices] of faces.entries()) {
			for (const i of [0, 1, 2, 0, 2, 3]) {
				const vertex = corners[indices[i]];
				const x = (vertex[0] - 0.5) * 0.25, z = (vertex[2] - 0.5) * 0.25;
				out.push(
					item.position[0] - camera[0] + x * c - z * s,
					item.position[1] - camera[1] + vertex[1] * 0.25 + 0.04 + Math.sin(timeMs / 500) * 0.03,
					item.position[2] - camera[2] + x * s + z * c,
					[0, 1, 1, 0][i], [1, 1, 0, 0][i], [0.5, 1, 0.8, 0.8, 0.6, 0.6][face], item.texture,
					(item.light[1] + 0.5) / 16, (item.light[0] + 0.5) / 16,
				);
			}
		}
	}
	return new Float32Array(out);
}
