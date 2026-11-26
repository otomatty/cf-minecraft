import { blockItemTint, WATER_TINT, type BlockItemTint } from "./block-tints.ts";
export { GRASS_TINT, LEAVES_TINT, WATER_TINT } from "./block-tints.ts";
export const TEX_SIZE = 16;
export const WATER_FRAME_COUNT = 32;

export interface TextureLayout {
	readonly names: readonly string[];
	readonly spriteStart: number;
}

/** Convert atlas pixels to a tinted UI copy. The grass side mask becomes opaque. */
export function textureIconPixels(name: string, pixels: Uint8Array, cellTint?: BlockItemTint | null): Uint8ClampedArray<ArrayBuffer> {
	const icon = new Uint8ClampedArray(pixels);
	const tint = name === "water" || name === "water_flow" ? WATER_TINT : blockItemTint(name, cellTint);
	if (tint && pixels !== missingTile) {
		for (let i = 0; i < icon.length; i += 4) {
			if (name === "grass_block_side") {
				for (let c = 0; c < 3; c++) icon[i + c] += Math.round(pixels[i + 3] * tint[c] / 255);
				icon[i + 3] = 255;
			} else {
				for (let c = 0; c < 3; c++) icon[i + c] = Math.round(pixels[i + c] * tint[c] / 255);
			}
		}
	}
	return icon;
}

/** Shared marker for an unresolved block face or item sprite. */
export const missingTile = (() => {
	const missing = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	for (let y = 0; y < TEX_SIZE; y++) {
		for (let x = 0; x < TEX_SIZE; x++) {
			const magenta = ((x >> 3) ^ (y >> 3)) ? 248 : 0;
			missing.set([magenta, 0, magenta, 255], (y * TEX_SIZE + x) * 4);
		}
	}
	return missing;
})();

/** Halves an RGBA image by averaging 2x2 blocks. */
export function downsample(src: Uint8Array, size: number, cutout = false): Uint8Array {
	const half = size >> 1;
	const out = new Uint8Array(half * half * 4);
	for (let y = 0; y < half; y++) {
		for (let x = 0; x < half; x++) {
			const top = (y * 2 * size + x * 2) * 4;
			const samples = [top, top + 4, top + size * 4, top + size * 4 + 4];
			const dst = (y * half + x) * 4;
			const alpha = samples.reduce((sum, i) => sum + src[i + 3], 0);
			out[dst + 3] = Math.round(alpha / 4);
			// Transparent texels carry no leaf, glass or petal colour.
			for (let c = 0; c < 3; c++) {
				const sum = samples.reduce((value, i) => value + src[i + c] * (cutout ? src[i + 3] : 1), 0);
				out[dst + c] = Math.round(sum / (cutout ? Math.max(1, alpha) : 4));
			}
		}
	}
	if (cutout) {
		// Preserve the closest representable number of pixels passing alpha >= 0.5.
		// Stable ranking also handles equal-alpha texels that uniform scaling cannot split.
		let covered = 0;
		for (let i = 3; i < src.length; i += 4) if (src[i] >= 128) covered++;
		const target = Math.round(covered / (size * size) * half * half);
		const ranked = Array.from({ length: half * half }, (_, i) => i)
			.sort((a, b) => out[b * 4 + 3] - out[a * 4 + 3]);
		ranked.forEach((pixel, rank) => {
			const i = pixel * 4 + 3;
			out[i] = rank < target ? Math.max(160, out[i]) : Math.min(96, out[i]);
		});
	}
	return out;
}
