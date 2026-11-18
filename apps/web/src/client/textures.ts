import { CARRIED_GRASS_TOP_TINT, CARRIED_LEAVES_TINT, CARRIED_SHORT_GRASS_TINT, WATER_TINT } from "./block-tints.ts";
import { buildingTexture } from "./building-textures.ts";
import { floraTexture } from "./flora-textures.ts";
import { terrainTexture } from "./terrain-textures.ts";

export { GRASS_TINT, LEAVES_TINT, WATER_TINT } from "./block-tints.ts";
export const TEX_SIZE = 16;

const iconTints = new Map<string, readonly number[]>([
	["grass_block_top", CARRIED_GRASS_TOP_TINT], ["short_grass", CARRIED_SHORT_GRASS_TINT],
	["oak_leaves", CARRIED_LEAVES_TINT], ["water", WATER_TINT], ["water_flow", WATER_TINT],
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

/** Original pixel art in atlas row order, with a checker for missing materials. */
export function paintTexture(name: string): Uint8Array {
	const tool = /^(wooden|stone|copper|iron)_(pickaxe|axe|shovel|hoe)$/.exec(name);
	if (tool) return paintTool(tool[1], tool[2]);
	const pixels = terrainTexture(name) ?? buildingTexture(name) ?? floraTexture(name)
		?? cropTexture(name) ?? bucketTexture(name) ?? equipmentTexture(name);
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

type Rgb = readonly [number, number, number];
type Painter = (x: number, y: number, rand: () => number) => Rgb;

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hashName(name: string): number {
	let h = 2166136261;
	for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
	return h >>> 0;
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const shade = (c: Rgb, f: number): Rgb => [c[0] * f, c[1] * f, c[2] * f];

function bucketTexture(name: string): Uint8Array | undefined {
	if (name !== "bucket" && name !== "water_bucket" && name !== "lava_bucket") return undefined;
	const pixels = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	const paint = (x: number, y: number, color: Rgb) =>
		pixels.set([...color, 255], (y * TEX_SIZE + x) * 4);
	for (let y = 3; y <= 13; y++) {
		const inset = y === 3 || y >= 11 ? 1 + Math.floor((y - 3) / 6) : 0;
		const left = 2 + inset;
		const right = 13 - inset;
		for (let x = left; x <= right; x++) {
			let color: Rgb = x === left || x === right || y === 13 ? [55, 63, 72]
				: x < 6 ? [183, 194, 203] : x < 10 ? [137, 150, 162] : [102, 115, 126];
			if (y === 3) color = [203, 212, 217];
			if ((y === 4 || y === 5) && x > left && x < right) {
				if (name === "lava_bucket") color = y === 4 ? [255, 182, 55] : [221, 71, 18];
				else color = name === "bucket" ? [64, 76, 85] : y === 4 ? [101, 207, 237] : [42, 148, 203];
			}
			paint(x, y, color);
		}
	}
	return pixels;
}

function cropTexture(name: string): Uint8Array | undefined {
	const stage = ["wheat_sprout", "wheat_shoot", "wheat_green", "wheat_ripe"].indexOf(name);
	if (stage < 0) return undefined;
	const pixels = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	const paint = (x: number, y: number, color: Rgb) =>
		pixels.set([...color, 255], (y * TEX_SIZE + x) * 4);
	for (const [i, base] of [3, 6, 9, 12].entries()) {
		const tip = 12 - stage * 3 + i % 2;
		const lean = i % 2 === 0 ? -1 : 1;
		for (let y = tip; y < TEX_SIZE; y++) {
			const x = y < 12 ? base + lean : base;
			paint(x, y, stage === 3 ? [154, 119, 51] : [56, 108, 49]);
			if (stage === 3 && y < tip + 5) {
				paint(x + lean, y, y % 2 ? [221, 164, 72] : [247, 198, 101]);
				paint(x, y, [191, 139, 59]);
			} else if (y === tip + 1 || (stage > 0 && y === 12)) {
				paint(x + lean, y, [100, 156, 61]);
			}
		}
	}
	return pixels;
}

const furrow = (color: Rgb): Painter => (x, y, rand) => {
	const ridge = (x + Math.floor((y + x % 3) / 5)) % 5;
	return shade(color, (ridge === 0 ? .65 : ridge === 1 ? .83 : 1.1) + rand() * .19);
};

const EQUIPMENT_AND_WORKSTATIONS: Record<string, (rand: () => number) => Painter> = {
	farmland_dry: () => furrow([137, 91, 58]),
	farmland_moist: () => furrow([86, 56, 48]),
	wheat_seeds: () => (x, y) => (x + y) % 3 === 0 ? [220, 195, 107] : [158, 125, 56],
	wheat: () => (x, y) => x === 7 || y > 10 ? [154, 104, 44] : [230, 180, 72],
	bread: () => (x, y) => {
		if (y >= 11 || x === 2 || x === 13) return [151, 79, 38];
		if (y < 8 && (x + y === 12 || x + y === 16)) return [251, 211, 139];
		return shade([222, 147, 67], 1.1 - y * .018);
	},
	apple: () => (x, y) => {
		if (y <= 4 && x >= 9) return [85, 157, 58];
		if (y <= 4) return [111, 67, 39];
		if (x >= 4 && x <= 6 && y <= 8) return [248, 111, 99];
		return shade([211, 43, 54], 1.15 - (x + y) * .016);
	},
    coal: () => (x,y,r) => shade([47, 48, 55], .7 + r()*.6 + (x+y)%3*.08),
    copper_ingot: () => (x,y) => shade([204, 113, 70], y < 7 ? 1.2 : .8 + x*.012),
    iron_ingot: () => (x,y) => shade([179, 190, 202], y < 7 ? 1.2 : .8 + x*.012),
    furnace_top: () => (x,y,r) => shade([111, 116, 125], x < 2 || y < 2 || x > 13 || y > 13 ? .68 : .9+r()*.2),
    furnace_side: () => (x,y,r) => shade([108, 113, 121], y%5 === 0 || (x+(Math.floor(y/5)%2)*4)%8 === 0 ? .65 : .9+r()*.2),
    furnace_front: () => (x,y,r) => x >= 3 && x <= 12 && y >= 6 && y <= 12 ? [31, 29, 34] : shade([112, 118, 126], y === 4 || y === 14 ? .65 : .9+r()*.2),
    stick: () => (x) => x % 2 ? [185, 139, 77] : [116, 79, 42],
    crafting_table_top: () => (x,y,r) => shade([174, 128, 70], x < 2 || y < 2 || x > 13 || y > 13 ? .62 : x % 5 === 2 || y % 5 === 2 ? .75 : .94+r()*.12),
    crafting_table_side: () => (x,y,r) => shade([146, 103, 57], x < 3 || x > 12 ? .66 : y < 3 ? 1.2 : y === 7 || y === 12 ? .72 : .94+r()*.12),
    crafting_table_bottom: () => (x,y) => shade([124, 87, 49], x === y || x+y === 15 ? .65 : y%4 === 0 ? .82 : 1),
};

function equipmentTexture(name: string): Uint8Array | undefined {
	if (!Object.hasOwn(EQUIPMENT_AND_WORKSTATIONS, name)) return undefined;
	const rand = mulberry32(hashName(name));
	const paint = EQUIPMENT_AND_WORKSTATIONS[name](rand);
	const pixels = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	for (let y = 0; y < TEX_SIZE; y++) {
		for (let x = 0; x < TEX_SIZE; x++) {
			const [r, g, b] = paint(x, y, rand);
			let visible = true;
			switch (name) {
				case "wheat_seeds":
					visible = [[4, 5], [9, 4], [7, 9], [11, 10], [4, 12]]
						.some(([sx, sy]) => (x === sx && y === sy) || (x === sx + 1 && y === sy - 1));
					break;
				case "wheat":
					visible = (x === 7 && y >= 2 && y <= 14)
						|| (x >= 5 && x <= 9 && y >= 3 && y <= 10 && (x + y) % 3 !== 0);
					break;
				case "bread":
					visible = x >= 2 && x <= 13 && y >= 4 && y <= 12 && x + y >= 8 && x - y <= 7
						&& x + y <= 24;
					break;
				case "apple":
					visible = (x === 8 && y >= 2 && y <= 4)
						|| (x >= 9 && x <= 12 && y >= 2 && y <= 4 && x + y <= 14)
						|| ((x - 7.5) ** 2 + (y - 9) ** 2 <= 30 && y >= 5 && y <= 13);
					break;
				case "coal":
					visible = x >= 3 && x <= 12 && y >= 3 && y <= 12 && x + y >= 8 && x + y <= 23;
					break;
				case "copper_ingot":
				case "iron_ingot":
					visible = x >= 2 && x <= 13 && y >= 5 && y <= 11 && x + y >= 8;
					break;
				case "stick":
					visible = y >= 2 && y <= 13 && (x === 7 || x === 8);
			}
			pixels.set([clamp(r), clamp(g), clamp(b), visible ? 255 : 0], (y * TEX_SIZE + x) * 4);
		}
	}
	return pixels;
}

/** Original branching fissures: each stage adds a branch to the same 16x16 pattern. */
export function paintCracks(stage: number): Uint8Array {
	if (!Number.isInteger(stage) || stage < 0 || stage > 9) throw new RangeError("crack stage");
	const pixels = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	for (let branch = 0; branch <= stage; branch++) {
		for (let step = 0; step < 9; step++) {
			const x = (3 + branch * 5 + step + Math.floor(step / 3)) % TEX_SIZE;
			const y = (1 + branch * 3 + step * (branch % 2 ? 2 : 1)) % TEX_SIZE;
			const at = (y * TEX_SIZE + x) * 4;
			pixels.set([28, 23, 31, 210], at);
		}
	}
	return pixels;
}

/** Original upright silhouettes: a two-pixel grip and distinct heads. */
function paintTool(tier: string, kind: string): Uint8Array {
	const colors: Record<string, Rgb> = { wooden: [168, 115, 58], stone: [120, 134, 148], copper: [209, 119, 73], iron: [204, 221, 226] };
	const pixels = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
		const handle = (x === 7 || x === 8) && y >= (kind === "hoe" ? 4 : 5);
		const head = kind === "pickaxe" ? ((y === 3 || y === 4) && x >= 3 && x <= 12) || (y === 5 && (x === 3 || x === 12))
			: kind === "axe" ? x >= 4 && x <= 9 && y >= 2 && y <= 6 && (x !== 4 || y >= 3)
			: kind === "hoe" ? (y === 3 && x >= 7 && x <= 12) || (x >= 11 && x <= 12 && y >= 4 && y <= 6)
			: x >= 5 && x <= 10 && y >= 2 && y <= 6 && (y !== 6 || x >= 6 && x <= 9);
		if (!handle && !head) continue;
		const color = head ? shade(colors[tier], (x + y) % 3 === 0 ? .82 : 1) : x === 7 ? [111, 75, 43] : [151, 101, 54];
		const i = (y * TEX_SIZE + x) * 4;
		pixels.set([clamp(color[0]), clamp(color[1]), clamp(color[2]), 255], i);
	}
	return pixels;
}
