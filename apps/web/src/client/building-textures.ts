import { pixelTile } from "./pixel-tile.ts";

interface MaterialTile {
	rows: readonly string[];
	palette: Readonly<Record<string, number>>;
	opacity?: number;
}

const farmlandRows = [
	"ddedddedccdededd",
	"ccddcdcedddcdccd",
	"bbcbccfcbcccfcbc",
	"aaagabbaabaagbaa",
	"ddccddeedddcdedd",
	"cdeddccdccedccdc",
	"cbccfcbccbbccbcb",
	"abgabaagbaaababa",
	"dedddcddeddedded",
	"dcddeccdccddccdc",
	"bccbcbfcccbccbbc",
	"aabagaabaagaaaab",
	"dddeeddeddccdded",
	"ccdcdccddeddcdcc",
	"bccbcbcbfccbccfc",
	"baagbaagbaagaaba",
];

const materials = new Map<string, MaterialTile>([
	["torch", {
		palette: { a: 0x64351d, b: 0x946039, c: 0xbc8850, d: 0x4c2b1e, f: 0xff7927, g: 0xffbc42, h: 0xffe88c },
		rows: [
			"ggghhhgggghhhggg",
			"ggghhhgggghhhggg",
			"ggghhhgggghhhggg",
			"ggghhhgggghhhggg",
			"ggghhhgggghhhggg",
			"ggghhhgggghhhggg",
			"gghhghghgghhhggg",
			"fffggfffgfgffggf",
			"daaddaddaddaddad",
			"aabbbaaabbbabbaa",
			"abbcbabcbabbcbab",
			"bccbbcbbcbbcccbb",
			"bbcbacbbcbbabbbb",
			"aabcbabbbabbabaa",
			"aabacaabaababaab",
			"daabdaabdaadbaad",
		],
	}],
	["obsidian", {
		palette: { a: 0x17131f, b: 0x201929, c: 0x2a2138, d: 0x362944, e: 0x4b395a, f: 0x665171 },
		rows: [
			"cdddeccbbcbacccd",
			"ddeeccbbbaaabccd",
			"deccbbabaaabccdd",
			"ccbbbaaaabccddec",
			"bbbaaabbccddeccb",
			"baabbbccddecbbbb",
			"abccdddeeccbbbaa",
			"bcddefeccbbbaaab",
			"cdeffecbbbaaabcc",
			"defedccbaaabbccd",
			"eeddccbbabccddde",
			"ddccbbabbcddeecc",
			"ccbbbaabcddeccbb",
			"cbbaaabcddeccbbb",
			"bbaabccdeccbbbac",
			"baabcdeecbbabccc",
		],
	}],
	["lava", {
		palette: { a: 0x8d2514, b: 0xc33b12, c: 0xf05c16, d: 0xff8d20, e: 0xffbd39, f: 0xffe277 },
		rows: [
			"ccddeeddccbbccdc",
			"cdeeffeddcbabcdd",
			"deffeedccbabbcdd",
			"edeeddccbabbcddd",
			"ddcccbbaabbcdeed",
			"ccbbbaabbccdeffd",
			"cbaabbbccddeefec",
			"bbabcdddeeeeedcb",
			"babcdeeffeeddcba",
			"bccdeeffeedcbbab",
			"cdddeeedccbaabbc",
			"deeddccbbbaabcdd",
			"efedccbaabbcddee",
			"feeddcbbccddeeff",
			"eedddccddeeeedde",
			"dddeeeddeeddcccd",
		],
	}],
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
			a: 0x392d1a, b: 0x4d3e27, c: 0x755c37, d: 0x957442, e: 0xab8850,
			f: 0xba965e, g: 0xcea970, h: 0xdbb879,
		},
		rows: [
			"bcbbbbccbbbbcbba",
			"cbeffggggfgfffba",
			"bfggdddddgggffba",
			"bfgdggghgddggfba",
			"bgdggeeedhgdfeba",
			"bgdgdehhgdfgdgba",
			"bgdgdhcegdhfdgba",
			"bgdgdehggdhgdgba",
			"bgdggeeeddhgdcba",
			"bggdgghhghgddcaa",
			"bfggdddgggdcceba",
			"bfgggggdddggdfba",
			"befgfgggggggffba",
			"bbfffgfgggfffcba",
			"abbcbbbcbbbbbbba",
			"aabaaabaaaabaaaa",
		],
	}],
	["crafting_table_top", {
		palette: {
			k: 0x49351f, a: 0x69502d, b: 0x937444, c: 0xaf8d55, d: 0xc39f64,
			e: 0xd8b57a, s: 0x4b4948, t: 0x8c9294, u: 0xc8cfd0,
		},
		rows: [
			"kkkkkkkkkkkkkkkk",
			"kdedddddedddddak",
			"kdcccccbccdccbak",
			"kduuttcccccccbak",
			"kasssttaaaaabbak",
			"kdesstdddddddcak",
			"kdccksccctuccbak",
			"kdcckscccttcbcak",
			"kabaksaaatubaaak",
			"kdddksdddtudddak",
			"kdccksccctuccbak",
			"kdecbbccctututuk",
			"kaaaaaabatttttsk",
			"kdddeeedddddddak",
			"kdccbbaccccccbak",
			"kkkkkkkkkkkkkkkk",
		],
	}],
	["crafting_table_side", {
		palette: {
			k: 0x49351f, a: 0x69502d, b: 0x80653a, c: 0x937444, d: 0xaf8d55,
			e: 0xc39f64, s: 0x565858, t: 0x969b9d, u: 0xc6cdcd,
		},
		rows: [
			"eeeeeeeeeeeeeddd",
			"edddddcedddddddc",
			"baaabaaaaaabaakk",
			"baaddddsddddcakk",
			"baadeeeccdsdcakk",
			"baadbbbacdeacakk",
			"baadbccacdeacakk",
			"baadbaaucdeacakk",
			"bbaduuuusdeacakk",
			"baaduuttcdsscakk",
			"baadutstcdutcakk",
			"baaduttcddutsakk",
			"baadtstdcdtscakk",
			"baadtscbcdccbakk",
			"baakkkkkkkkkkakk",
			"aaakkkkkkkkkkkkk",
		],
	}],
	["crafting_table_bottom", {
		palette: { k: 0x49351f, a: 0x69502d, b: 0x80653a, c: 0x937444, d: 0xaf8d55, e: 0xc39f64 },
		rows: [
			"baabddddedddbaab",
			"adedcccccccbaded",
			"adcdcccbcccbadcd",
			"bdddcbccccbbaddb",
			"baaaaaabaaaaaabk",
			"bdddcdedddddddck",
			"bdccccbcccbbbcck",
			"bccccccbcccccbbk",
			"baabaaabaaaaaabk",
			"bdddddedddddddck",
			"bdccccccbcccbcck",
			"bccccbcccbbbbbbk",
			"baabaaaaaaabbaak",
			"adedddcccccbaded",
			"adcdccccbbcbadcd",
			"bddbkkkkkkkkbddk",
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
	["furnace_front", {
		palette: {
			k: 0x211f22, s: 0x393638, a: 0x505051, b: 0x616161, c: 0x6f6e6f,
			d: 0x888788, e: 0xa5a5a6, f: 0xb5b5b5, o: 0xec8c45,
		},
		rows: [
			"feefeeeeeffeeeed",
			"edddddccdddddddc",
			"bbbbbbbabbbbbbba",
			"edddddassdeeeeda",
			"dcccdcsssbccdcba",
			"caabbbseedsbbbaa",
			"deeedeeccbsdeeda",
			"dcccdecskksdcdba",
			"dcbbecskkkksdcba",
			"abbadskkkkksbbaa",
			"deedbskkkkksdeda",
			"dccdbsksookscdba",
			"dcbabskosssscbba",
			"baaaeddddddcbbaa",
			"deddbsbsbsbcdcba",
			"bbbbbbbbbaabbaaa",
		],
	}],
	["furnace_side", {
		palette: { a: 0x505051, b: 0x616161, c: 0x6f6e6f, d: 0x7f7f7f, e: 0x909090, f: 0xa5a5a6 },
		rows: [
			"ffeeeefdfeeeeeed",
			"eddddddbedcdddcb",
			"eddcdccbeddcddcb",
			"dccbccbbdcccccba",
			"aaaaaaaaaaaabaaa",
			"eddeaeeeffedafed",
			"dcdbaeddddcbadcb",
			"dccbaedddccbadcb",
			"dcbbaeccdccbadba",
			"cccbaedcccbbaeba",
			"bbaaaacccbaaaaba",
			"eeeefeafeefffeed",
			"edddccaedddddccb",
			"edccccbeddcddccb",
			"dccccbadccccccbb",
			"bbbbbaabbbaabbaa",
		],
	}],
	["furnace_top", {
		palette: { k: 0x282729, a: 0x505051, b: 0x616161, c: 0x6f6e6f, d: 0x7f7f7f, e: 0x909090, f: 0xa5a5a6 },
		rows: [
			"ffeeefeeeeffeeed",
			"edddddcdddddddcc",
			"edcddccddddcdccb",
			"edcddeeeedddcccb",
			"edcdeddccccbaccb",
			"edcdedaaaaabaccb",
			"edcdedakkkkbaccb",
			"edcdedakkkkbaccb",
			"edcdecakkkkbaccb",
			"edcdedakkkkbaccb",
			"edcdedabbbbbaccb",
			"edcdebaaaaaaaccb",
			"edccccccccccccbb",
			"edddccccccdcccbb",
			"dcccbccccccccbbb",
			"bbbbaabbbbbabbaa",
		],
	}],
	["white_wool", {
		palette: { a: 0xb9bbc0, b: 0xcdd0d2, c: 0xd9dbdc, d: 0xe3e3e2, e: 0xededea, f: 0xf6f4ef, g: 0xfcfaf5 },
		rows: [
			"dedccdeffedcdefe",
			"effedefgffedcefe",
			"fgfedfgfffedcdff",
			"ffedceffeedbcdef",
			"eddcbdeedcbdccde",
			"ccdeffedccdeffed",
			"cdefgffeddeggfed",
			"defgffedcdefgffd",
			"deffedbccdeffedc",
			"cdeedcacdceedbcc",
			"dcbbddefedcbbdef",
			"defcdefgffeddegg",
			"effedefgfffcdefg",
			"ffedcdeffedcceff",
			"eedbccdeedcbccde",
			"edccdeddccadeffd",
		],
	}],
	["farmland_dry", {
		palette: { a: 0x593d29, b: 0x79553b, c: 0x976c4b, d: 0xb8885c, e: 0xc2966a, f: 0x888684, g: 0x644730 },
		rows: farmlandRows,
	}],
	["farmland_moist", {
		palette: { a: 0x36251e, b: 0x514038, c: 0x694a39, d: 0x80583f, e: 0x946c50, f: 0x695e57, g: 0x2b2221 },
		rows: farmlandRows,
	}],
	["wheat_sprout", {
		palette: { d: 0x31502a, s: 0x466831, l: 0x608443, b: 0x80a359, h: 0x9dbc6b, g: 0xb2c878 },
		rows: [
			"................",
			"................",
			"................",
			"................",
			"................",
			"................",
			"................",
			"................",
			"................",
			".........h......",
			".....g...hl.....",
			".h...bl..bl...g.",
			".hl..lb..lsb.hb.",
			".bsl.bs..ls..bl.",
			".ld.bls..bd..ls.",
			".sd..ld..sd..ld.",
		],
	}],
	["wheat_shoot", {
		palette: { d: 0x31502a, s: 0x466831, l: 0x608443, b: 0x80a359, h: 0x9dbc6b, g: 0xb2c878 },
		rows: [
			"................",
			"................",
			"................",
			"................",
			"................",
			".........h......",
			".....g...hl.....",
			".h...hl..bl...g.",
			".hl..bl..ls..hb.",
			".bl..ls..lsb.bl.",
			".bsb.ls..lsh.ls.",
			".lshbls.bls..lsb",
			".ls.gls.hls..lsh",
			"hbs..bd..bd..ls.",
			".ld..ls..ls..bd.",
			".sd..ld..sd..ld.",
		],
	}],
	["wheat_green", {
		palette: { d: 0x31502a, s: 0x466831, l: 0x608443, b: 0x80a359, h: 0x9dbc6b, g: 0xb2c878, p: 0xc0ce83 },
		rows: [
			"................",
			".........g......",
			".....g...ph.....",
			".p...gh..hb.....",
			".gh..hb..bl...p.",
			".hb..bl..ls..gh.",
			".bl..lsb.ls..hb.",
			".lsb.lsh.lsb.bl.",
			".lsh.lsb.lsg.ls.",
			".lsbbls..lsh.lsh",
			"hls.gls.bls..lsg",
			"gls.hls.hls..lsh",
			"hls..bs..bs..bs.",
			".bs..ld..ld..ld.",
			".ld..ls..ls..ls.",
			".sd..ld..sd..ld.",
		],
	}],
	["wheat_ripe", {
		palette: {
			d: 0x69502d, s: 0x886831, l: 0xa58240, b: 0xb49d54, o: 0xb78532,
			g: 0xd4a449, y: 0xe9c267, h: 0xf8db83,
		},
		rows: [
			".........y......",
			"....yg...hyg....",
			".y..hyg..oyh..y.",
			".hygoyh..gyg.gyh",
			".oyhgyg..ooy.hyo",
			".gygooy..lso.gyg",
			".ooyols..ls..yoo",
			".lso.lsb.lsb.osl",
			".lsb.lsy.lsy.ls.",
			".lsyblsg.lsb.lsy",
			"blsgyls.blsy.lsg",
			"yls.gls.yls..lsb",
			"gls..bs.gls.bls.",
			".bs..ld..bs.yls.",
			".ld..ls..ls..ls.",
			".sd..ld..sd..ld.",
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
