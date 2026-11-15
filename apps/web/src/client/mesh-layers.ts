/** Mesh ABI: four two-word vertices per quad, grouped opaque/cutout/translucent.
 * Word 0: x/y/z:9 each (sixteenths), face:3, AO:2.
 * Word 1: texture:12, tint:1, sky/block:4 each, u/v:5 each, water surface:1.
 */
export type LayerCounts = readonly [number, number, number];
export const QUAD_WORDS = 8;
export type Point = readonly [number, number, number];

export function splitMeshLayers(words: Uint32Array, counts: LayerCounts): [Uint32Array, Uint32Array, Uint32Array] {
	if (counts.some(n => !Number.isSafeInteger(n) || n < 0) || counts.reduce((a, b) => a + b, 0) * QUAD_WORDS !== words.length) {
		throw new Error("Invalid mesh layer counts");
	}
	let offset = 0;
	return counts.map(count => {
		const start = offset;
		offset += count * QUAD_WORDS;
		return words.subarray(start, offset);
	}) as [Uint32Array, Uint32Array, Uint32Array];
}

export function quadCenters(words: Uint32Array): Float32Array {
	const centers = new Float32Array(words.length / QUAD_WORDS * 3);
	for (let q = 0; q < words.length / QUAD_WORDS; q++) {
		for (let v = 0; v < 4; v++) {
			const a = words[q * QUAD_WORDS + v * 2];
			const waterDrop = (words[q * QUAD_WORDS + v * 2 + 1] >>> 31) / 9;
			centers[q * 3] += (a & 511) / 64;
			centers[q * 3 + 1] += (((a >>> 9) & 511) / 16 - waterDrop) / 4;
			centers[q * 3 + 2] += ((a >>> 18) & 511) / 64;
		}
	}
	return centers;
}

const distance2 = (a: Point, b: Point) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Fresh array, stable ties. Used far-first for drawing and near-first for budgeted sorting. */
export function sortSections<T extends { origin: Point }>(sections: readonly T[], camera: Point, farFirst = true): T[] {
	const distance = (s: T) => distance2([s.origin[0] + 8, s.origin[1] + 8, s.origin[2] + 8], camera);
	return [...sections].sort((a, b) => (distance(b) - distance(a)) * (farFirst ? 1 : -1));
}

/** Camera is section-local. Reorder indices, keeping vertex data and AO diagonals intact. */
export function sortedQuadIndices(centers: Float32Array, camera: Point): Uint32Array<ArrayBuffer> {
	const distances = Array.from({ length: centers.length / 3 }, (_, q) =>
		distance2([centers[q * 3], centers[q * 3 + 1], centers[q * 3 + 2]], camera));
	const order = distances.map((_, q) => q).sort((a, b) => distances[b] - distances[a]);
	const indices = new Uint32Array(order.length * 6);
	order.forEach((q, i) => {
		const vertex = q * 4;
		const offset = i * 6;
		indices[offset] = vertex;
		indices[offset + 1] = vertex + 1;
		indices[offset + 2] = vertex + 2;
		indices[offset + 3] = vertex;
		indices[offset + 4] = vertex + 2;
		indices[offset + 5] = vertex + 3;
	});
	return indices;
}

/** Input is the frame's far-first draw order. One section's sort/upload is indivisible. */
export function updateTranslucentSort<T extends { origin: Point; sortedAt: string }>(
	farFirst: readonly T[], camera: Point, update: (section: T, localCamera: Point) => void,
	now: () => number = () => performance.now(), budgetMs = 1,
): void {
	const key = camera.map(Math.floor).join(",");
	const start = now();
	for (let i = farFirst.length - 1; i >= 0; i--) {
		const section = farFirst[i];
		if (section.sortedAt === key) continue;
		if (now() - start >= budgetMs) break;
		update(section, [camera[0] - section.origin[0], camera[1] - section.origin[1], camera[2] - section.origin[2]]);
		section.sortedAt = key;
	}
}
