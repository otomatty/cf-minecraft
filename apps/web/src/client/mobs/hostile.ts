import type { MobAsset, Vec3 } from "./model.ts";
import { paintMobSkin } from "./skin.ts";

// Adult proportions and box UVs follow the v1.26.60.5 Bedrock sample models.
// Arms and legs share UVs on these 64×32 skins.
export function humanoid(limbWidth: 2 | 4, rightArm: Vec3, leftArm: Vec3, legOffset = 2): MobAsset["bones"] {
	const half = limbWidth / 2;
	return [
		{ name: "waist", pivot: [0, 12, 0] },
		{ name: "body", parent: "waist", pivot: [0, 24, 0],
			cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16] }] },
		{ name: "head", parent: "body", pivot: [0, 24, 0],
			cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0] }] },
		{ name: "rightArm", parent: "body", pivot: [-5, 22, 0], rotation: rightArm,
			cubes: [{ origin: [-4 - limbWidth, 12, -half], size: [limbWidth, 12, limbWidth], uv: [40, 16] }] },
		{ name: "leftArm", parent: "body", pivot: [5, 22, 0], rotation: leftArm,
			cubes: [{ origin: [4, 12, -half], size: [limbWidth, 12, limbWidth], uv: [40, 16], mirror: true }] },
		{ name: "rightLeg", parent: "body", pivot: [-legOffset, 12, 0],
			cubes: [{ origin: [-legOffset - half, 0, -half], size: [limbWidth, 12, limbWidth], uv: [0, 16] }] },
		{ name: "leftLeg", parent: "body", pivot: [legOffset, 12, 0],
			cubes: [{ origin: [legOffset - half, 0, -half], size: [limbWidth, 12, limbWidth], uv: [0, 16], mirror: true }] },
	];
}

export const zombie: MobAsset = {
	id: "minecraft:zombie",
	// Unarmed adult, between swings: arms extended with the mean idle yaw and roll.
	bones: humanoid(4, [-90, -5.73, 2.865], [-90, 5.73, -2.865], 1.9),
	walkPitch: { rightLeg: 25, leftLeg: -25 },
	texture: paintMobSkin(64, 32, (rect) => {
		const moss = [0x39612e, 0x406b32, 0x487235, 0x507b3a];
		const sage = [0x5e804d, 0x698b55, 0x71945b, 0x779b62];
		function mottle(u: number, v: number, width: number, height: number, shades: number[]) {
			for (let y = v; y < v + height; y++) for (let x = u; x < u + width; x++) {
				const patch = (x >> 1) * 7 + (y >> 1) * 13 + ((x * y + 3 * x + y) % 5);
				rect(x, y, 1, 1, shades[patch % shades.length]);
			}
		}

		// The dark green scalp frames one broad, lighter brow and two black eye slits.
		mottle(8, 0, 16, 8, moss);
		mottle(0, 8, 32, 8, moss);
		mottle(10, 9, 4, 2, sage);
		mottle(9, 10, 6, 3, sage);
		rect(10, 10, 3, 1, sage[2]);
		rect(11, 11, 3, 1, sage[1]);
		rect(8, 11, 1, 2, sage[0]);
		rect(15, 11, 1, 2, sage[0]);
		rect(9, 12, 2, 1, 0x191c19);
		rect(13, 12, 2, 1, 0x191c19);
		rect(9, 13, 2, 1, sage[1]);
		rect(13, 13, 2, 1, sage[0]);
		rect(11, 13, 2, 1, moss[0]);
		rect(10, 15, 3, 1, 0x38582e);

		const cyan = 0x08aaaa, seam = 0x039397, fold = 0x079fa2, light = 0x0db6b3;
		const violet = 0x4b3da6, violetShade = 0x3b3189, inseam = 0x312975;
		// Short cyan sleeves, a square neckline and a loose hem over violet trousers.
		rect(20, 16, 16, 4, cyan);
		rect(21, 16, 6, 4, moss[1]);
		rect(28, 16, 8, 4, violetShade);
		rect(16, 20, 24, 12, inseam);
		rect(16, 20, 24, 10, 0x067979);
		for (const u of [20, 32]) {
			rect(u, 20, 8, 10, cyan);
			rect(u, 30, 8, 2, violet);
			rect(u + 1, 22, 1, 5, fold);
			rect(u + 5, 24, 1, 5, light);
			rect(u + 6, 25, 1, 5, fold);
			rect(u, 28, 2, 2, fold);
			rect(u, 30, 5, 1, violetShade);
			rect(u + 5, 30, 3, 1, cyan);
			rect(u + 7, 31, 1, 1, fold);
		}
		rect(22, 20, 4, 1, moss[0]);
		rect(23, 21, 2, 1, moss[1]);
		rect(17, 23, 1, 6, 0x076c71);
		rect(29, 26, 2, 4, 0x068287);
		rect(44, 16, 4, 4, light);
		mottle(48, 16, 4, 4, moss);
		mottle(40, 24, 16, 8, moss);
		rect(40, 20, 16, 4, seam);
		for (const u of [44, 52]) {
			mottle(u, 24, 4, 8, sage);
			rect(u, 20, 4, 4, cyan);
			rect(u, 21, 2, 1, light);
			rect(u + 1, 23, 3, 1, fold);
			rect(u, 25, 1, 3, moss[2]);
		}

		rect(4, 16, 4, 4, violet);
		rect(8, 16, 4, 4, 0x303130);
		rect(0, 20, 16, 10, inseam);
		rect(0, 30, 16, 2, 0x494b4a);
		for (const u of [4, 12]) {
			rect(u, 20, 4, 10, violet);
			rect(u, 20, 1, 1, violetShade);
			rect(u + 1, 26, 2, 2, violetShade);
			rect(u + 3, 23, 1, 3, 0x433997);
			rect(u, 29, 4, 1, inseam);
			rect(u, 30, 4, 2, 0x737473);
			rect(u + 1, 30, 1, 1, 0x898885);
		}
		rect(1, 25, 2, 3, violetShade);
		rect(9, 27, 2, 1, violetShade);
	}),
};

export const skeleton: MobAsset = {
	id: "minecraft:skeleton",
	bones: [
		...humanoid(2, [-18, 0, 0], [0, 0, 0]),
		{ name: "rightItem", parent: "rightArm", pivot: [-6, 15, 1] },
		{ name: "bow", parent: "rightItem", pivot: [-5, 13, 0], rotation: [28, 24, 0],
			itemSprite: { texture: "bow", grip: [5.5, 6.5] } },
	],
	walkPitch: { rightLeg: 30, leftLeg: -30, rightArm: -21, leftArm: 21 },
	texture: paintMobSkin(64, 32, (rect) => {
		// Socket, recess, and increasingly light planes of gray bone.
		const gray = [0x48484a, 0x767677, 0x89898b, 0x98989a, 0xa6a6a7, 0xb6b6b7, 0xc5c5c6, 0xd3d3d4, 0xdedee0];
		function pattern(u: number, v: number, rows: readonly string[]) {
			for (const [y, row] of rows.entries()) {
				for (let x = 0; x < row.length; x++) {
					if (row[x] !== ".") rect(u + x, v + y, 1, 1, gray[Number(row[x])]);
				}
			}
		}

		// The forehead is broad. Narrow eye slots sit just above the nose and long mouth.
		pattern(8, 8, [
			"45565554", "56675665", "56777776", "67778776",
			"60056006", "45522554", "30000003", "56677665",
		]);
		pattern(8, 0, [
			"33344333", "44554554", "55655665", "56566565",
			"55545665", "45655656", "56656665", "55566555",
		]);
		pattern(16, 0, [
			"23333332", "3......2", "3......2", "3......3",
			"3......2", "2......2", "2......3", "23233332",
		]);
		const temple = ["44455555", "34455555", "34445556", "33455566",
			"23344556", "23345445", "22343334", "22334455"];
		pattern(0, 8, temple);
		pattern(16, 8, temple.map(row => [...row].reverse().join("")));
		pattern(24, 8, [
			"44445444", "34454444", "33444433", "33443433",
			"32333333", "23333232", "23232222", "22221222",
		]);

		// Ribs sweep towards the breastbone, ending well above the pelvis.
		// The lower spine shows through the empty abdomen on the rear face.
		pattern(20, 20, [
			"65....56", ".55..66.", "55576556", ".546655.",
			"4.4754.4", ".4.65.5.", "..54.5..", "........",
			"........", "........", "654..456", "46544564",
		]);
		pattern(32, 20, [
			"43455434", "...54...", "34366543", "...65...",
			"43456434", "...56...", "...45...", "...54...",
			"...35...", "...43...", "56544565", "44555444",
		]);
		const flank = ["3455", "....", "3455", "....", "3344", "....",
			"....", "....", "....", "....", "5566", "4334"];
		pattern(16, 20, flank);
		pattern(28, 20, flank.map(row => [...row].reverse().join("")));
		pattern(28, 16, ["44544544", "5..34..5", "5..45..5", "45455454"]);

		// Each limb is two texels across. Shade along the shaft and pick out its joint.
		for (const u of [0, 40]) {
			pattern(u + 2, 16, ["5664", "4543"]);
			pattern(u, 18, [
				"34454434", "34463434", "34353434", "34354434",
				u === 0 ? "44676555" : "33454544", "34465444",
				"23344432", "23344433", "23453433", "33453433",
				"23342332", "44453443",
			]);
		}
	}),
};

function creeperLeg(name: string, x: number, z: number): MobAsset["bones"][number] {
	return { name, parent: "body", pivot: [x, 6, z],
		cubes: [{ origin: [x - 2, 0, z - 2], size: [4, 6, 4], uv: [0, 16] }] };
}

export const creeper: MobAsset = {
	id: "minecraft:creeper",
	walkPitch: { leg0: 23, leg1: -23, leg2: -23, leg3: 23 },
	bones: [
		{ name: "body", pivot: [0, 6, 0],
			cubes: [{ origin: [-4, 6, -2], size: [8, 12, 4], uv: [16, 16] }] },
		{ name: "head", parent: "body", pivot: [0, 18, 0],
			cubes: [{ origin: [-4, 18, -4], size: [8, 8, 8], uv: [0, 0] }] },
		creeperLeg("leg0", -2, 4), creeperLeg("leg1", 2, 4),
		creeperLeg("leg2", -2, -4), creeperLeg("leg3", 2, -4),
	],
	texture: paintMobSkin(64, 32, (rect) => {
		const greens = [0x406633, 0x517d3c, 0x609343, 0x72a84a, 0x85b653, 0xa2c774, 0xc3d59b];
		const moss = (u: number, v: number, width: number, height: number) => {
			for (let y = v; y < v + height; y++) {
				for (let x = u; x < u + width; x++) {
					const patch = ((x >> 1) * 13 + (y >> 1) * 7 + (x >> 1) * (y >> 1)) % 5;
					const fleck = (x * 7 + y * 11 + x * y) % 3;
					rect(x, y, 1, 1, greens[patch + fleck]);
				}
			}
		};
		moss(8, 0, 16, 8);
		moss(0, 8, 32, 8);
		moss(20, 16, 16, 4);
		moss(16, 20, 24, 12);
		moss(4, 16, 8, 4);
		moss(0, 20, 16, 6);
		rect(0, 25, 16, 1, 0x364d30);
		rect(4, 24, 1, 1, 0x364d30);
		rect(7, 24, 1, 1, 0x364d30);
		const dark = 0x232d22;
		rect(9, 10, 2, 2, dark);
		rect(13, 10, 2, 2, dark);
		rect(11, 12, 2, 2, dark);
		rect(10, 13, 4, 2, dark);
		rect(10, 15, 1, 1, dark);
		rect(13, 15, 1, 1, dark);
	}),
};
