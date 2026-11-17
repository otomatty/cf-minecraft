// Block textures, drawn by code: every image is a small deterministic
// function, so the repository contains no binary art. These are original
// 16x16 designs, not copies of any existing game's textures.

export const TEX_SIZE = 16;

type Rgb = readonly [number, number, number];
type Painter = (x: number, y: number, rand: () => number) => Rgb;

/** Plains grass colour of the game's biome colour map; grayscale textures are multiplied by it. */
export const GRASS_TINT: Rgb = [0x91, 0xbd, 0x59];
export const LEAVES_TINT: Rgb = [0x70, 0xa8, 0x45];
export const WATER_TINT: Rgb = [0x45, 0x88, 0xc9];

/** Tinted UI copy; keep shared terrain pixels and every alpha value intact. */
export function textureIconPixels(name: string, pixels: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
	const icon = new Uint8ClampedArray(pixels);
	const tint = name === "oak_leaves" ? LEAVES_TINT : name === "water" ? WATER_TINT : name === "short_grass" || name === "grass_block_top" ? GRASS_TINT : undefined;
	if (tint) {
		for (let i = 0; i < icon.length; i += 4) {
			for (let c = 0; c < 3; c++) icon[i + c] = Math.round(pixels[i + c] * tint[c] / 255);
		}
	}
	return icon;
}

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
const gray = (v: number): Rgb => [v, v, v];

/** Coarse blotches: one random value per `cell`-sized block of pixels. */
function blotches(rand: () => number, cell: number): (x: number, y: number) => number {
	const n = Math.ceil(TEX_SIZE / cell);
	const grid = Array.from({ length: n * n }, () => rand());
	return (x, y) => grid[Math.floor(y / cell) * n + Math.floor(x / cell)];
}

function speckled(base: Rgb, amount: number, darkChance = 0, dark = 0.7): (rand: () => number) => Painter {
	return (rand) => {
		const blot = blotches(rand, 4);
		return (x, y, r) => {
			let f = 1 + (r() - 0.5) * amount + (blot(x, y) - 0.5) * amount * 0.6;
			if (r() < darkChance) f *= dark;
			return shade(base, f);
		};
	};
}

function cobblestone(rand: () => number): Painter {
	const stones = Array.from({ length: 11 }, () => ({ x: rand() * 16, y: rand() * 16, tone: 96 + rand() * 60 }));
	const wrap = (d: number) => Math.min(Math.abs(d), 16 - Math.abs(d));
	return (x, y, r) => {
		let best = Infinity;
		let second = Infinity;
		let tone = 0;
		for (const s of stones) {
			const d = Math.hypot(wrap(x + 0.5 - s.x), wrap(y + 0.5 - s.y));
			if (d < best) {
				second = best;
				best = d;
				tone = s.tone;
			} else if (d < second) {
				second = d;
			}
		}
		if (second - best < 0.9) return gray(62 + r() * 14);
		return gray(tone + (r() - 0.5) * 16);
	};
}

function planks(rand: () => number): Painter {
	const base: Rgb = [166, 133, 80];
	const joints = [3, 11, 6, 14];
	const boardTone = [rand(), rand(), rand(), rand()];
	return (x, y, r) => {
		const board = Math.floor(y / 4);
		if (y % 4 === 3) return shade(base, 0.62);
		if (x === joints[board]) return shade(base, 0.7);
		return shade(base, 0.92 + boardTone[board] * 0.14 + (r() - 0.5) * 0.08);
	};
}

function logSide(rand: () => number): Painter {
	const base: Rgb = [104, 82, 50];
	const column = Array.from({ length: 16 }, () => 0.8 + rand() * 0.4);
	return (x, _y, r) => shade(base, column[x] * (r() < 0.12 ? 0.72 : 1) + (r() - 0.5) * 0.08);
}

function logTop(): Painter {
	const bark: Rgb = [104, 82, 50];
	const light: Rgb = [181, 148, 92];
	const dark: Rgb = [150, 119, 71];
	return (x, y, r) => {
		const ring = Math.min(x, y, 15 - x, 15 - y);
		if (ring < 2) return shade(bark, 0.9 + r() * 0.2);
		return shade(ring % 2 === 0 ? light : dark, 0.95 + r() * 0.1);
	};
}

function bricks(): Painter {
	const brick: Rgb = [150, 92, 76];
	const mortar: Rgb = [176, 170, 160];
	return (x, y, r) => {
		const row = Math.floor(y / 4);
		const vertical = row % 2 === 0 ? x % 8 === 7 : x % 8 === 3;
		if (y % 4 === 3 || vertical) return shade(mortar, 0.92 + r() * 0.12);
		return shade(brick, 0.88 + r() * 0.22);
	};
}

function bedrock(): Painter {
	const tones = [44, 62, 86, 86, 112, 150];
	return (_x, _y, r) => gray(tones[Math.floor(r() * tones.length)]);
}

function grassSide(rand: () => number): Painter {
	const dirt = speckled([134, 96, 67], 0.22, 0.1)(rand);
	const top = speckled([150, 150, 150], 0.3)(rand);
	const depth = Array.from({ length: 16 }, () => 2 + Math.floor(rand() * 3));
	return (x, y, r) => {
		if (y >= depth[x]) return dirt(x, y, r);
		const g = top(x, y, r);
		return [(g[0] * GRASS_TINT[0]) / 255, (g[1] * GRASS_TINT[1]) / 255, (g[2] * GRASS_TINT[2]) / 255];
	};
}

// Original angular mineral grains over the same stone recipe used below.
function ore(colors: readonly Rgb[], count: number): (rand: () => number) => Painter {
	return (rand) => {
		const base = speckled([125, 125, 125], 0.16, 0.08, 0.85)(rand);
		const grains = Array.from({ length: count }, () => ({
			x: 1 + Math.floor(rand() * 13), y: 1 + Math.floor(rand() * 13),
			width: 1 + Math.floor(rand() * 3), height: 1 + Math.floor(rand() * 2),
			color: colors[Math.floor(rand() * colors.length)],
		}));
		return (x, y, r) => {
			const stone = base(x, y, r);
			for (const g of grains) {
				if (x >= g.x && x < g.x + g.width && y >= g.y && y < g.y + g.height) {
					return shade(g.color, 0.85 + r() * 0.3);
				}
			}
			return stone;
		};
	};
}

const PAINTERS: Record<string, (rand: () => number) => Painter> = {
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
	coal_ore: ore([[32, 34, 39], [46, 45, 48]], 9),
	copper_ore: ore([[194, 100, 55], [219, 126, 65], [62, 153, 125]], 9),
	iron_ore: ore([[172, 117, 60], [148, 77, 51]], 8),
	gold_ore: ore([[243, 201, 50], [255, 224, 83]], 4),
	glass: () => (x, y) => [184 + (x + y) % 4 * 12, 220, 238],
	oak_leaves: speckled([190, 190, 190], 0.4),
	water: () => (x, y) => gray(185 + 25 * Math.sin((x * 2 + y + Math.sin(y)) * Math.PI / 8)),
	stone: speckled([125, 125, 125], 0.16, 0.08, 0.85),
	// Grayscale on purpose: tinted with the biome colour in the shader, as in the game.
	grass_block_top: speckled([150, 150, 150], 0.3),
	grass_block_side: grassSide,
	dirt: speckled([134, 96, 67], 0.22, 0.1),
	cobblestone,
	oak_planks: planks,
	bedrock,
	snow_block: speckled([229, 240, 246], 0.06, 0.06, 0.94),
	sandstone: () => (x, y, r) => shade([202, 180, 132], 0.92 + (y % 5) * 0.025 + (r() - 0.5) * 0.07 + (x % 7 === 0 ? 0.03 : 0)),
	gravel: (rand) => {
		const pebble = blotches(rand, 2);
		return (x, y, r) => shade([134, 129, 124], 0.65 + pebble(x, y) * 0.65 + r() * 0.12);
	},
	ice: () => (x, y) => shade([161, 211, 232], (x + 2 * y) % 13 < 2 ? 1.12 : 0.95),
	coarse_dirt: speckled([154, 128, 81], 0.32, 0.19, 0.72),
	sand: speckled([219, 207, 163], 0.1, 0.06, 0.92),
	oak_log: logSide,
	oak_log_top: logTop,
	bricks,
	lamp_block: () => (x, y) => {
		const frame = x === 0 || y === 0 || x === 15 || y === 15;
		const cross = Math.abs(x - 7.5) + Math.abs(y - 7.5) < 5;
		return frame ? [55, 67, 76] : cross ? [255, 248, 184] : [226, 167, 78];
	},
};

/** RGBA pixels of one texture. Unknown names get a magenta/black checker so gaps are obvious. */
export function paintTexture(name: string): Uint8Array {
	const tool = /^(wooden|stone|copper|iron)_(pickaxe|axe|shovel)$/.exec(name);
	if (tool) return paintTool(tool[1], tool[2]);
	const rand = mulberry32(hashName(name));
	const plant = name === "red_flower" || name === "yellow_flower" || name === "short_grass";
	const make = PAINTERS[name];
	const painter: Painter = make
		? make(rand)
		: (x, y) => ((x >> 3) ^ (y >> 3)) & 1 ? [248, 0, 248] : [0, 0, 0];
	const px = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	for (let y = 0; y < TEX_SIZE; y++) {
		for (let x = 0; x < TEX_SIZE; x++) {
			const flower = Math.abs(x - 7.5) <= 3 && y >= 2 && y <= 7;
			const stem = (x === 7 || x === 8) && y >= 7;
			const blade = y >= 5 && (x === 7 || x === 8 || Math.abs(x - 7.5) === Math.floor((15 - y) / 3) + 0.5);
			const visible = name === "short_grass" ? blade : flower || stem;
			const [r, g, b] = plant ? (name === "short_grass" ? gray(170 + rand() * 50) : flower ? (name === "red_flower" ? [220, 48, 60] : [245, 210, 48]) : [65, 145, 52]) : painter(x, y, rand);
			const i = (y * TEX_SIZE + x) * 4;
			px[i] = clamp(r);
			px[i + 1] = clamp(g);
			px[i + 2] = clamp(b);
			px[i + 3] = name === "coal" ? (x >= 3 && x <= 12 && y >= 3 && y <= 12 && x+y >= 8 && x+y <= 23 ? 255 : 0) : name.endsWith("_ingot") ? (x >= 2 && x <= 13 && y >= 5 && y <= 11 && x+y >= 8 ? 255 : 0) : name === "stick" ? (y >= 2 && y <= 13 && (x === 7 || x === 8) ? 255 : 0) : plant ? (visible ? 255 : 0) : name === "glass"
				? (x === 0 || y === 0 || x === 15 || y === 15 || (x === y + 3 && y > 3 && y < 9) ? 255 : 0)
				: name === "oak_leaves" ? ((x * 7 + y * 11 + (x >> 1) * (y >> 1)) % 17 < 5 ? 0 : 255)
				: name === "ice" ? 150 + (x + y) % 24
				: name === "water" ? 168 + (x + y * 3) % 20 : 255;
		}
	}
	return px;
}

/** Halves an RGBA image by averaging 2x2 blocks. */
export function downsample(src: Uint8Array, size: number, cutout = false): Uint8Array {
	const half = size >> 1;
	const out = new Uint8Array(half * half * 4);
	for (let y = 0; y < half; y++) {
		for (let x = 0; x < half; x++) {
			for (let c = 0; c < 4; c++) {
				const a = src[((y * 2) * size + x * 2) * 4 + c];
				const b = src[((y * 2) * size + x * 2 + 1) * 4 + c];
				const d = src[((y * 2 + 1) * size + x * 2) * 4 + c];
				const e = src[((y * 2 + 1) * size + x * 2 + 1) * 4 + c];
				out[(y * half + x) * 4 + c] = (a + b + d + e + 2) >> 2;
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

/** Original upright silhouettes: a two-pixel grip and three distinct heads. */
function paintTool(tier: string, kind: string): Uint8Array {
	const colors: Record<string, Rgb> = { wooden: [168, 115, 58], stone: [120, 134, 148], copper: [209, 119, 73], iron: [204, 221, 226] };
	const pixels = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
	for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
		const handle = (x === 7 || x === 8) && y >= 5;
		const head = kind === "pickaxe" ? ((y === 3 || y === 4) && x >= 3 && x <= 12) || (y === 5 && (x === 3 || x === 12))
			: kind === "axe" ? x >= 4 && x <= 9 && y >= 2 && y <= 6 && (x !== 4 || y >= 3)
			: x >= 5 && x <= 10 && y >= 2 && y <= 6 && (y !== 6 || x >= 6 && x <= 9);
		if (!handle && !head) continue;
		const color = head ? shade(colors[tier], (x + y) % 3 === 0 ? .82 : 1) : x === 7 ? [111, 75, 43] : [151, 101, 54];
		const i = (y * TEX_SIZE + x) * 4;
		pixels.set([clamp(color[0]), clamp(color[1]), clamp(color[2]), 255], i);
	}
	return pixels;
}
