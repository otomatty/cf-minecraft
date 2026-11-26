// Grassy hills with oak groves and a shore opening from north to east.
export const titleLandscape = {
	seed: 2026n, generator: 2, x: -432.5, z: 1864.5, radius: 6, yaw: 205, pitch: 12,
	dayTime: 6000, rotationMs: 180_000, clearance: 8,
} as const;

export function titleCameraHeight(minY: number, maxY: number, blockAt: (y: number) => number): number {
	for (let y = maxY; y >= minY; y--) {
		// Include foliage and water when finding a clear position.
		if (blockAt(y) > 0) return y + titleLandscape.clearance;
	}
	return minY + titleLandscape.clearance;
}

export function titleYaw(elapsedMs: number, reducedMotion: boolean): number {
	return titleLandscape.yaw + (reducedMotion ? 0 : elapsedMs % titleLandscape.rotationMs / titleLandscape.rotationMs * 360);
}

export function titleChunks(cx: number, cz: number, radius: number): [number, number][] {
	const chunks: [number, number][] = [];
	const distance = ([x, z]: [number, number]) => (x - cx) ** 2 + (z - cz) ** 2;
	for (let z = cz - radius; z <= cz + radius; z++) {
		for (let x = cx - radius; x <= cx + radius; x++) {
			const chunk: [number, number] = [x, z];
			if (distance(chunk) <= radius ** 2) chunks.push(chunk);
		}
	}
	return chunks.sort((a, b) => distance(a) - distance(b));
}
