import { pixelTile } from "./pixel-tile.ts";

interface MaterialTile {
	rows: readonly string[];
	palette: Readonly<Record<string, number>>;
	opacity?: number;
}

const materials = new Map<string, MaterialTile>([
	["oak_planks", {
		palette: { a: 0x69502d, b: 0x80653a, c: 0x937444, d: 0xa1844c, e: 0xaf8d55, f: 0xb9945c, g: 0xc39f64 },
		rows: [
			"gfffggggfffeefgg",
			"eefdddeeffeddeee",
			"ddeeefeedccdeedd",
			"abbaaaabbbccbbaa",
			"gfggfffefffcggfg",
			"deeeffeeeddbfedd",
			"feeeddddeedbedef",
			"bcccbbaaabaabbbb",
			"ggfgfefffggggfeg",
			"fddddddeffeddeef",
			"ededffeeeddeeedd",
			"bbbaabbbbaaaaabb",
			"ffggcggfffggfgfe",
			"eefdbefeeeeddeff",
			"dddebdddeeeefeee",
			"baaaabbccbbaaaab",
		],
	}],
	["oak_log", {
		palette: { a: 0x392d1a, b: 0x4d3e27, c: 0x604b2c, d: 0x755c37, e: 0x907143, f: 0x987a4a },
		rows: [
			"ecdedbdebadddecd",
			"eccedbdebabddfcd",
			"dcdddbddbccddfbd",
			"cdddabdeddcddfbd",
			"dddeabdeedcddfbe",
			"dddeabddeddcbebd",
			"dddeabddeddcdebd",
			"ecdddbdeeadcddbc",
			"ecddcbdeeacddebc",
			"fcddccdfeacddebc",
			"fcddbcdfeacdeebd",
			"fcdebcddbacdedbd",
			"dddebcddbbcdedbd",
			"dddebcdebbcdedcd",
			"ecdedcddebddedcd",
			"ecdedcdebadddecd",
		],
	}],
	["oak_log_top", {
		palette: {
			a: 0x4c3d25, b: 0x614c2c, c: 0x755b37, d: 0x957442,
			e: 0xa2864e, f: 0xaf8e56, g: 0xba965e, h: 0xc19d65,
		},
		rows: [
			"abbbcbbbabbbccba",
			"bffgfgggfffgffeb",
			"bfdddddeeddddfgb",
			"bgdfghffffggedgb",
			"bgdfgdddddefedfb",
			"bfdffdgffgdfedfb",
			"bfdffdgfhgdfgdgb",
			"bfeggdgdefdfgdgb",
			"bgdfgdgddfdfgdgb",
			"cgdfgdggffdfgegb",
			"bgdfgeedddefgdgb",
			"bgdfgffeffgfgdfb",
			"bfddddddeedddefa",
			"bfgffgfffggfffga",
			"befffffggffffefb",
			"aabbbcabbbbcbbab",
		],
	}],
	["bricks", {
		palette: {
			a: 0x784235, b: 0x8b4c3c, c: 0x9b5845, d: 0xaf604b, e: 0xb8735f,
			f: 0xc38a76, m: 0xa2847b, n: 0x896e66,
		},
		rows: [
			"eedeeddnccdedddm",
			"ccdddcbmccdcbbcn",
			"abbbabanbbbaaban",
			"nmmnnnnmmnmmnnmm",
			"ddfnedddeedndeed",
			"ccbmcddcccdnbccc",
			"aaambabbaabmbbaa",
			"mnmmnmmnnnmmnnmm",
			"cedfeddndeeccddm",
			"cdcccbcmccddccbn",
			"baabaaambbacaaam",
			"nmmnnmmnmnmmnnmn",
			"eeemcdeddedndfed",
			"cbdnccddcbcmccdd",
			"baamaabbaaambaba",
			"mnmnnmmmnnnmmnnm",
		],
	}],
	["lamp_block", {
		palette: {
			k: 0x3c2115, r: 0x49391a, b: 0x8e622e, o: 0xe5994b,
			l: 0xf2bc72, h: 0xf7dcb4,
		},
		rows: [
			"kkkkrkkkkkkkrkkk",
			"krbolobkkboolbrk",
			"kbolhlbkkrohlhbk",
			"kolhlbkrkrkbhhlk",
			"klhlbkboobkkbolk",
			"kolbkbollobkrbok",
			"kbbrkollhhlbkrrk",
			"krkkbolhhhlobkkk",
			"kkkboolhlhllbkrk",
			"krbkrollhlobkrbk",
			"kbobkbolllbkbobk",
			"kolobkboobkbolok",
			"klhlobkrkrkolhlk",
			"kbolhlbkkbllhlok",
			"krbolobkkboooork",
			"kkkkkkkrkkkkkkkk",
		],
	}],
	["glass", {
		palette: { a: 0x7bafb9, b: 0x8bc0cc, c: 0xa8d3db, h: 0xd0eae9 },
		rows: [
			"hhhhhhhcchhhhhhh",
			"h..............c",
			"h..............b",
			"h....h.........b",
			"h...h..........b",
			"h..c...........b",
			"c..............c",
			"c..............b",
			"h..............b",
			"h..............c",
			"h..............b",
			"h..........h...b",
			"c.........c....a",
			"h..............a",
			"c..............b",
			"bbcbabbcbbabcbbc",
		],
	}],
	["ice", {
		palette: { a: 0x85adfd, b: 0x8bb3fe, c: 0x92b9fe, d: 0xa1c3ff, e: 0xbad3ff, f: 0xc7dcff },
		opacity: 190,
		rows: [
			"ccbbccccccbcddcc",
			"cbbbccccbaccdccc",
			"bbaccccbaabccccc",
			"baccbccabbbccccb",
			"bcccdccbbcddccbb",
			"ccceccbbcddcccab",
			"cbdccbbcddccabcc",
			"bbccabccdcccbbcc",
			"bccabccdccbbaccc",
			"cccbbceddcccbccc",
			"cccbceddcbabcccb",
			"cccbddccbbbcccbc",
			"cccdcccbabcccbcc",
			"ccdcccbabcccdccc",
			"ccccbbbcccdedbcc",
			"ccbbabcccdfdccbc",
		],
	}],
]);

export const WATER_FRAME_COUNT = 32;
const TAU = Math.PI * 2;

// The same glint can straddle opposite tile edges. Keep both halves as it moves.
function wrapDistance(delta: number): number {
	return delta - 16 * Math.round(delta / 16);
}

function waterGlints(flowing: boolean) {
	let seed = flowing ? 981 : 3127;
	function random(): number {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 0x100000000;
	}
	return Array.from({ length: flowing ? 42 : 23 }, () => ({
		x: 16 * random(), y: 16 * random(), phase: TAU * random(),
		rx: flowing ? 0.95 + 1.1 * random() : 1.8 + 2.7 * random(),
		ry: flowing ? 1.15 + 2 * random() : 0.7 + 0.75 * random(),
		intensity: flowing ? 20 + 58 * random() : 9 + 51 * random(),
	}));
}
const stillGlints = waterGlints(false);
const flowGlints = waterGlints(true);

/** Original looping water artwork. Still highlights shimmer in place; side streaks fall. */
export function waterTextureFrame(frame: number, flowing = false): Uint8Array<ArrayBuffer> {
	const t = ((Math.trunc(frame) % WATER_FRAME_COUNT + WATER_FRAME_COUNT) % WATER_FRAME_COUNT) / WATER_FRAME_COUNT;
	const angle = TAU * t;
	const light = new Float32Array(16 * 16).fill(flowing ? 144 : 154);
	for (const glint of flowing ? flowGlints : stillGlints) {
		const phase = glint.phase + angle;
		const x = glint.x + (flowing ? 0.45 : 1.1) * Math.cos(phase);
		const y = glint.y + (flowing ? 32 * t : 0.35 * Math.sin(phase));
		const power = glint.intensity * (0.82 + 0.18 * Math.sin(phase));
		for (let py = 0; py < 16; py++) {
			const dy = wrapDistance(py - y) / glint.ry;
			if (Math.abs(dy) >= 1) continue;
			for (let px = 0; px < 16; px++) {
				const dx = wrapDistance(px - x) / glint.rx;
				const center = Math.max(0, 1 - dx * dx - dy * dy);
				light[py * 16 + px] += power * center * center;
			}
		}
	}
	const pixels = new Uint8Array(16 * 16 * 4);
	for (let p = 0; p < light.length; p++) {
		const tone = Math.min(255, Math.round(light[p]));
		const i = p * 4;
		pixels[i] = pixels[i + 1] = pixels[i + 2] = tone;
		pixels[i + 3] = flowing ? 166 : 156;
	}
	return pixels;
}

export function buildingTexture(name: string): Uint8Array | undefined {
	if (name === "water" || name === "water_flow") return waterTextureFrame(0, name === "water_flow");
	const tile = materials.get(name);
	if (!tile) return undefined;
	const pixels = pixelTile(tile.rows, tile.palette);
	if (tile.opacity !== undefined) {
		for (let i = 3; i < pixels.length; i += 4) pixels[i] = tile.opacity;
	}
	return pixels;
}
