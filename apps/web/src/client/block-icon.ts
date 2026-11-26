import type { BlockItemTint } from "./block-tints.ts";
import type { BlockStateInfo } from "./placement.ts";
import { TEX_SIZE, textureIconPixels } from "./textures.ts";

export const ICON_SIZE = 40;
const texel = (uv: number) => Math.max(0, Math.min(TEX_SIZE - 1, Math.floor(uv)));

/** Orthographic inventory view of the same boxes and cropped faces used in the world. */
export function blockIconPixels(info: BlockStateInfo, atlas: ReadonlyMap<string, Uint8Array>, tint?: BlockItemTint | null): Uint8ClampedArray<ArrayBuffer> {
	const icon = new Uint8ClampedArray(ICON_SIZE * ICON_SIZE * 4);
	const tile = (face: number) => {
		const name = info.faces[face];
		return textureIconPixels(name, atlas.get(name)!, tint);
	};
	if (info.model === "cross") {
		const plant = tile(1);
		for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
			const src = ((y >> 1) * TEX_SIZE + (x >> 1)) * 4;
			icon.set(plant.subarray(src, src + 4), ((y + 4) * ICON_SIZE + x + 4) * 4);
		}
		return icon;
	}

	const top = tile(1), south = tile(3), east = tile(5);
	// Screen projection: (x-z, (x+z-16)/2 - (y-8)*1.25), centred on (8,8,8).
	// At any pixel, z is the ray parameter and increases towards the viewer.
	const rise = 1 / 1.25;
	for (let py = 0; py < ICON_SIZE; py++) for (let px = 0; px < ICON_SIZE; px++) {
		const x0 = px + 0.5 - ICON_SIZE / 2;
		const y0 = 8 + ((x0 - 16) / 2 - (py + 0.5 - ICON_SIZE / 2)) / 1.25;
		let closest = -Infinity;
		for (const [min, max] of info.boxes) {
			const enter = Math.max(min[0] - x0, (min[1] - y0) / rise, min[2]);
			const exitX = max[0] - x0, exitY = (max[1] - y0) / rise;
			const z = Math.min(exitX, exitY, max[2]);
			if (z <= enter || z <= closest) continue;
			const x = x0 + z, y = y0 + rise * z;
			const isTop = z === exitY, isEast = !isTop && z === exitX;
			const pixels = isTop ? top : isEast ? east : south;
			const u = isEast ? 16 - z : x, v = isTop ? z : 16 - y;
			const src = (texel(v) * TEX_SIZE + texel(u)) * 4;
			if (!pixels[src + 3]) continue;
			const shade = isTop ? 1 : isEast ? 0.68 : 0.84;
			const dst = (py * ICON_SIZE + px) * 4;
			for (let c = 0; c < 3; c++) icon[dst + c] = pixels[src + c] * shade;
			icon[dst + 3] = pixels[src + 3];
			closest = z;
		}
	}
	return icon;
}
