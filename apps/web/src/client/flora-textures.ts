import { CARRIED_GRASS_SIDE_TINT } from "./block-tints.ts";
import { pixelTile } from "./pixel-tile.ts";
import { terrainTexture } from "./terrain-textures.ts";

const empty = "................";

// The biome supplies the hue for live grass and leaves.
const turf = {
	a: 0x6e6e6e, b: 0x797979, c: 0x818181, d: 0x868686, e: 0x8b8b8b,
	f: 0x909090, g: 0x979797, h: 0x9e9e9e, i: 0xa5a5a5, j: 0xababab,
	k: 0xb3b3b3, l: 0xc1c1c1,
};

const foliage = {
	a: 0x626262, b: 0x707070, c: 0x828282, d: 0x929292,
	e: 0xa2a2a2, f: 0xc0c0c0,
};

const grassTop = pixelTile([
	"fghecdjgfeighddg",
	"hgfdajkafggcehji",
	"ceichggdeihjgdlf",
	"kkelcfichaheggch",
	"hfcgcjilgfdejjbd",
	"chiihgdecekhhggk",
	"fccdjjfjhhjcfbkh",
	"gceifdcijbfjhgcd",
	"ihecfdhjbdeeihfg",
	"dggikckddighejbe",
	"ebkhgdbajchcgfgc",
	"cehcfieghdkgcjfc",
	"hhdcefkjjfdgedcf",
	"dcgjjfdchhgbgeki",
	"fgcgedchgfcebfjc",
	"ghcbcdhigfdhfcig",
], turf);

const grassFringe = pixelTile([
	"ifjhjgkfihheighk",
	"gifgigkebgif.jfj",
	"f.heb.hf..hi.fh.",
	"..f....c.....g..",
	empty, empty, empty, empty, empty, empty, empty, empty, empty, empty, empty, empty,
], turf);

const oakLeafRows = [
	"dea..b..bfefa.af",
	"ba.dfed.ac...ced",
	"..aefeb...a.ceba",
	"ed.cefab.dec..cf",
	"fea...ba.fefdbdf",
	"ed..befdb.dfc..e",
	"cb..feed.ab....b",
	"...dedb.defada.a",
	"c.aac..cefed.efc",
	"efd.d..abfd..fed",
	"ed.fefdb.....eda",
	"b..defc....a.a.d",
	"edf..b.dedbfd.af",
	"fed..befe..feedc",
	"edb.a.edba.fda..",
	".ba.dedac..ba..d",
];
const oakLeaves = pixelTile(oakLeafRows, foliage);
const oakLeavesDense = pixelTile(oakLeafRows.map(row => row.replaceAll(".", "g")), { ...foliage, g: 0x484848 });

const shortGrass = pixelTile([
	empty, empty,
	"...f.....f..e...",
	"f...f....e..e...",
	".e..e...ed..e.f.",
	".e..df..ed..d.e.",
	"..e..e..ed.d..e.",
	"f.d..df.ed.f..e.",
	"e.ed.ce.dc.ec.e.",
	"ec.d.cd.ed.fdc.e",
	"dc.fe.dbec.eec.e",
	"dc.efedbdc.cdcfe",
	"bd.ededbdd.cdced",
	"bdcdbedbebadcb.d",
	"bdbdbedbdcacccdb",
	"bdbbcdacdaadcbcb",
], foliage);

const poppyColors = {
	k: 0x1e4021, s: 0x265b25, l: 0x437f2f,
	r: 0x922019, t: 0xbc2426, p: 0xeb2f2a, f: 0xf0372e,
};

const poppy = pixelTile([
	empty, empty, empty, empty, empty,
	"........pt......",
	".......fptpp....",
	".....pptprp.....",
	"......trrt......",
	"......rtk.......",
	"........s.......",
	"........s.......",
	".....k..s.......",
	".....lk.s..l....",
	".......ks.lk....",
	".......sks......",
], poppyColors);

const dandelionColors = {
	k: 0x197707, s: 0x288119, l: 0x4b8e28, h: 0x58a92b,
	o: 0xcb8719, y: 0xfbd137, g: 0xffe749, b: 0xffee53,
};

const dandelion = pixelTile([
	empty, empty, empty, empty, empty, empty, empty,
	".......gb.......",
	"......ggygg.....",
	".....gyoyg......",
	".......gyg......",
	".......ls.......",
	".....h.sk.h.....",
	"......llkhl.....",
	".......sks......",
	"......kks.......",
], dandelionColors);

const tiles = new Map<string, Uint8Array>([
	["grass_block_top", grassTop],
	["oak_leaves", oakLeaves],
	["oak_leaves_dense", oakLeavesDense],
	["short_grass", shortGrass],
	["red_flower", poppy],
	["yellow_flower", dandelion],
]);

/** The opaque side's RGB stores untinted soil and its alpha stores grass brightness. */
export function grassSideAtlasPixels(): Uint8Array {
	const pixels = terrainTexture("dirt")!;
	for (let i = 0; i < pixels.length; i += 4) {
		if (grassFringe[i + 3]) {
			pixels.fill(0, i, i + 3);
			pixels[i + 3] = grassFringe[i];
		} else {
			pixels[i + 3] = 0;
		}
	}
	return pixels;
}

export function floraTexture(name: string): Uint8Array | undefined {
	if (name !== "grass_block_side") return tiles.get(name)?.slice();
	const pixels = grassSideAtlasPixels();
	for (let i = 0; i < pixels.length; i += 4) {
		const light = pixels[i + 3] / 255;
		for (let c = 0; c < 3; c++) pixels[i + c] += Math.round(light * CARRIED_GRASS_SIDE_TINT[c]);
		pixels[i + 3] = 255;
	}
	return pixels;
}
