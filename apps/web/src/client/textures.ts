import { decodeTile } from "./vanilla/decode-tile.ts";
import mining from "./vanilla/mining-tiles.json" with { type: "json" };
import { CARRIED_GRASS_TOP_TINT, CARRIED_LEAVES_TINT, CARRIED_SHORT_GRASS_TINT, WATER_TINT } from "./block-tints.ts";
import { blockTexture } from "./block-textures.ts";
import { itemTexture } from "./item-textures.ts";

export { GRASS_TINT, LEAVES_TINT, WATER_TINT } from "./block-tints.ts";
export const TEX_SIZE = 16;

const iconTints = new Map<string, readonly number[]>([
	["grass_block_top", CARRIED_GRASS_TOP_TINT], ["short_grass", CARRIED_SHORT_GRASS_TINT],
	["oak_leaves", CARRIED_LEAVES_TINT], ["oak_leaves_dense", CARRIED_LEAVES_TINT],
	["water", WATER_TINT], ["water_flow", WATER_TINT],
]);

/** Tinted UI copy; keep shared terrain pixels and every alpha value intact. */
export function textureIconPixels(name: string, pixels: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
	const icon = new Uint8ClampedArray(pixels);
	const tint = iconTints.get(name);
	if (tint) {
		for (let i = 0; i < icon.length; i += 4) {
			for (let c = 0; c < 3; c++) icon[i + c] = Math.round(pixels[i + c] * tint[c] / 255);
		}
	}
	return icon;
}

/** Block and item art in atlas row order, with a checker for missing materials. */
export function paintTexture(name: string): Uint8Array {
	const pixels = blockTexture(name) ?? itemTexture(name);
	if (pixels) return pixels;
	const missing = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	for (let y = 0; y < TEX_SIZE; y++) {
		for (let x = 0; x < TEX_SIZE; x++) {
			const magenta = ((x >> 3) ^ (y >> 3)) ? 248 : 0;
			missing.set([magenta, 0, magenta, 255], (y * TEX_SIZE + x) * 4);
		}
	}
	return missing;
}

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

/** Original pixel art: layer 0 sun, layers 1..8 lunar phases, layer 9 repeating clouds. */
export function paintSkyTexture(layer: number): Uint8Array<ArrayBuffer> {
	const pixels = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	for (let y = 0; y < TEX_SIZE; y++) {
		for (let x = 0; x < TEX_SIZE; x++) {
			const i = (y * TEX_SIZE + x) * 4;
			const u = (x + 0.5) / TEX_SIZE * 2 - 1;
			const v = (y + 0.5) / TEX_SIZE * 2 - 1;
			if (layer === 9) {
				// Periodic low-frequency waves, quantised into blocky islands.
				const wave = Math.sin(x / TEX_SIZE * Math.PI * 4) + Math.cos(y / TEX_SIZE * Math.PI * 6)
					+ Math.sin((x + y) / TEX_SIZE * Math.PI * 2);
				pixels.set([255, 255, 255, wave > 0.15 ? 210 : 0], i);
			} else if (layer === 0) {
				const edge = Math.max(Math.abs(u), Math.abs(v));
				pixels.set([255, edge < 0.65 ? 247 : 204, edge < 0.65 ? 205 : 103, edge < 0.92 ? 255 : 0], i);
			} else {
				const phase = layer - 1;
				const radius = u * u + v * v;
				const depth = Math.sqrt(Math.max(0, 1 - radius));
				const lit = depth * Math.cos(phase * Math.PI / 4) + u * Math.sin(phase * Math.PI / 4) > 0;
				const crater = ((x * 13 + y * 7 + x * y) % 19) < 4 ? 0.72 : 1;
				const shade = (lit ? 225 : 24) * crater;
				pixels.set([shade * 0.94, shade * 0.97, shade, radius < 0.88 ? 255 : 0], i);
			}
		}
	}
	return pixels;
}

/** Bedrock mining overlays in stage order, from the first hit to the last. */
export function paintCracks(stage: number): Uint8Array {
	if (!Number.isInteger(stage) || stage < 0 || stage >= mining.stages.length) throw new RangeError("crack stage");
	return decodeTile(mining.stages[stage]);
}
