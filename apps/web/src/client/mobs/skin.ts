import type { MobSkin } from "./model.ts";

export type FillRect = (x: number, y: number, width: number, height: number, rgb: number) => void;

/** Store the drawing instructions and allocate pixels only when the skin is requested. */
export function paintMobSkin(width: number, height: number, draw: (rect: FillRect) => void): MobSkin {
	return {
		width, height,
		pixels() {
			const pixels = new Uint8Array(width * height * 4);
			draw((x, y, w, h, rgb) => {
				if (![x, y, w, h].every(Number.isInteger) || w <= 0 || h <= 0
					|| x < 0 || y < 0 || x + w > width || y + h > height) {
					throw new RangeError(`Invalid skin rectangle (${x}, ${y}, ${w}, ${h}) in ${width}×${height}`);
				}
				const rgba = [rgb >>> 16, (rgb >>> 8) & 255, rgb & 255, 255];
				for (let row = y; row < y + h; row++) {
					for (let col = x; col < x + w; col++) pixels.set(rgba, (row * width + col) * 4);
				}
			});
			return pixels;
		},
	};
}
