import type { CellTint } from "./tint-map.ts";

/** World fallback colours before the biome colour map is available. */
export const GRASS_TINT = [0x91, 0xbd, 0x59] as const;
export const LEAVES_TINT = [0x70, 0xa8, 0x45] as const;
export const WATER_TINT = [0x44, 0xaf, 0xf5] as const;

// The carried grass side uses Bedrock's overlay colour. The other multipliers
// fit the average colours of the corresponding carried and untinted textures.
export const CARRIED_GRASS_SIDE_TINT = [121, 192, 90] as const;
export const CARRIED_GRASS_TOP_TINT = [135, 205, 73] as const;
export const CARRIED_SHORT_GRASS_TINT = [131, 199, 69] as const;
export const CARRIED_LEAVES_TINT = [68, 178, 17] as const;

export type BlockItemTint = Pick<CellTint, "grass" | "leaves">;

/** Grass and foliage materials shared by block icons and drops. */
export function blockItemTint(name: string, tint?: BlockItemTint | null): readonly number[] | undefined {
	switch (name) {
		case "grass_block_top": return tint?.grass ?? CARRIED_GRASS_TOP_TINT;
		case "grass_block_side": return tint?.grass ?? CARRIED_GRASS_SIDE_TINT;
		case "short_grass": return tint?.grass ?? CARRIED_SHORT_GRASS_TINT;
		case "oak_leaves":
		case "oak_leaves_dense": return tint?.leaves ?? CARRIED_LEAVES_TINT;
		default: return undefined;
	}
}
