import { decodeTile } from "./vanilla/decode-tile.ts";
import packed from "./vanilla/block-tiles.json" with { type: "json" };
import { CARRIED_GRASS_SIDE_TINT } from "./block-tints.ts";

export const FLUID_FRAMES = { water: 32, water_flow: 32, lava: 32, lava_flow: 16 } as const;
type TileName = keyof typeof packed;

export function fluidFrame(name: keyof typeof FLUID_FRAMES, frame: number): Uint8Array<ArrayBuffer> {
	const count = FLUID_FRAMES[name];
	const pixels = decodeTile(packed[name][((frame % count) + count) % count]);
	if (name === "water" || name === "water_flow") {
		// Water gets its biome colour in the shader and has its own translucent material.
		for (let i = 3; i < pixels.length; i += 4) pixels[i] = 170;
	}
	return pixels;
}

/** Bedrock encodes the tint mask in grass_side.tga alpha. The shader adds RGB + alpha × tint. */
export function grassSideAtlasPixels(): Uint8Array<ArrayBuffer> {
	const pixels = decodeTile(packed.grass_block_side[0]);
	for (let i = 0; i < pixels.length; i += 4) {
		if (!pixels[i + 3]) continue;
		pixels[i + 3] = pixels[i];
		pixels.fill(0, i, i + 3);
	}
	return pixels;
}

export function blockTexture(name: string): Uint8Array<ArrayBuffer> | undefined {
	if (name === "water" || name === "water_flow" || name === "lava" || name === "lava_flow") return fluidFrame(name, 0);
	if (name !== "grass_block_side") return Object.hasOwn(packed, name) ? decodeTile(packed[name as TileName][0]) : undefined;
	const pixels = grassSideAtlasPixels();
	for (let i = 0; i < pixels.length; i += 4) {
		for (let c = 0; c < 3; c++) pixels[i + c] += Math.round(pixels[i + 3] * CARRIED_GRASS_SIDE_TINT[c] / 255);
		pixels[i + 3] = 255;
	}
	return pixels;
}
