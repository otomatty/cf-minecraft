import type { MobAsset, MobBone } from "./model.ts";
import { paintMobSkin, type FillRect } from "./skin.ts";

const quadrupedWalk = { leg0: 80, leg1: -80, leg2: -80, leg3: 80 } as const;

const sheepStride = 0.32 * 180 / Math.PI;
export const sheep: MobAsset = {
	id: "minecraft:sheep",
	walkPitch: { leg0: sheepStride, leg1: -sheepStride, leg2: -sheepStride, leg3: sheepStride },
	bones: [
		{ name: "root", pivot: [0, 0, 0] },
		{ name: "body", parent: "root", pivot: [0, 12, 0], cubes: [
			{ origin: [-5.76, 6.4, -4.48], size: [11.52, 10.4, 10.88], uv: [0, 0], uvSize: [16, 16, 16] },
			{ origin: [-6.72, 8.32, -2.88], size: [13.44, 9.92, 8], uv: [0, 0], uvSize: [16, 16, 16] },
		] },
		{ name: "head", parent: "root", pivot: [0, 14, -3.2], cubes: [
			{ origin: [-2.56, 12.48, -7.2], size: [5.12, 6.72, 4], uv: [0, 32], uvSize: [16, 16, 8] },
		] },
		...[3.52, 3.52, -2.24, -2.24].map((z, i): MobBone => {
			const x = i % 2 === 0 ? -3.84 : 3.84;
			return {
				name: `leg${i}`, parent: "root", pivot: [x, 7.68, z],
				cubes: [{ origin: [x - 1.28, 0, z - 1.28], size: [2.56, 7.68, 2.56], uv: [48, 32], uvSize: [4, 16, 4] }],
			};
		}),
	],
	texture: paintMobSkin(64, 64, rect => {
		// Both fleece boxes share a net of 16×16 faces. The head and hooves use separate nets below.
		for (let v = 0; v < 56; v++) {
			for (let u = 0; u < 64; u++) {
				const x = u % 16, y = v % 16;
				const tuft = (x * 3 + y * 5) % 7 + (x + y * 2) % 5;
				const clump = (x % 5 === 2 && y % 4 === 1) || (x % 6 === 4 && y % 5 === 3);
				rect(u, v, 1, 1, (clump ? 0xd6d2c8 : 0xf8f4ec) - tuft * 0x010101);
			}
		}
		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				const grain = (x * 3 + y * 5) % 7 + (x + y * 2) % 5;
				const eye = y >= 5 && y <= 7 && ((x >= 3 && x <= 5) || (x >= 10 && x <= 12));
				let face = 0xb09e88 - (grain % 8) * 0x10000 - (grain % 6) * 0x100 - grain % 5;
				if (eye) face = y === 5 && (x === 4 || x === 11) ? 0xe8dcc4 : 0x2a221e;
				else if (y >= 10 && x >= 4 && x <= 11) face = 0x967054 - (grain % 6) * 0x10000 - (grain % 4) * 0x100;
				rect(8 + x, 40 + y, 1, 1, face);
				const leg = y >= 10 ? 0x4e3e30 + (grain % 5) * 0x10000 + (grain % 4) * 0x100
					: 0xd6ccba - (grain % 6) * 0x10000 - (grain % 5) * 0x100 - grain % 4;
				rect(48 + x, 36 + y, 1, 1, leg);
			}
		}
		rect(52, 32, 4, 4, 0xd6ccba);
		rect(56, 32, 4, 4, 0x4e3e30);
	}),
};

// The four legs share a skin. Bedrock numbers the rear pair first.
function legs(halfStance: number, height: number, rear: number, front: number, frontPivot: number, u: number): MobBone[] {
	return [rear, rear, front, front].map((z, i) => {
		const right = i % 2 === 1;
		const x = right ? halfStance : -halfStance;
		return {
			name: `leg${i}`, parent: "root", pivot: [x, height, i < 2 ? rear : frontPivot],
			cubes: [{ origin: [x - 2, 0, z - 2], size: [4, height, 4], uv: [u, 0], mirror: right }],
		};
	});
}

// Adult temperate pig, geometry.pig.v3. The torso is already in its horizontal rest pose.
export const pig: MobAsset = {
	id: "minecraft:pig",
	walkPitch: quadrupedWalk,
	bones: [
		{ name: "root", pivot: [0, 0, 0] },
		{ name: "head", parent: "root", pivot: [0, 12, -7], cubes: [
			{ origin: [-4, 8, -15], size: [8, 8, 8], uv: [0, 0] },
			{ origin: [-2, 9, -16], size: [4, 3, 1], uv: [32, 0] },
		] },
		{ name: "body", parent: "root", pivot: [0, 10, -1], cubes: [
			{ origin: [-5, 6, -9], size: [10, 8, 16], uv: [0, 18] },
		] },
		...legs(3, 6, 6, -6, -6, 44),
	],
	texture: paintMobSkin(64, 64, rect => {
		const rose = 0xe69891, blush = 0xd88480, light = 0xf3aca4, shadow = 0xc77875;
		rect(0, 0, 32, 16, rose);
		rect(8, 0, 8, 8, light);
		rect(16, 0, 8, 8, blush);
		// Ear folds wrap over the crown and onto both cheeks.
		rect(8, 1, 2, 4, blush);
		rect(14, 1, 2, 4, blush);
		rect(1, 8, 4, 2, shadow);
		rect(19, 8, 4, 2, shadow);
		rect(2, 10, 2, 1, blush);
		rect(20, 10, 2, 1, blush);
		rect(9, 9, 4, 1, light);
		rect(8, 11, 2, 1, 0xffeee1);
		rect(14, 11, 2, 1, 0xffeee1);
		rect(8, 11, 1, 1, 0x372c2b);
		rect(15, 11, 1, 1, 0x372c2b);
		rect(0, 14, 32, 2, blush);
		// A raised muzzle with two nostrils separated by the bridge.
		rect(32, 0, 10, 4, 0xce7e7b);
		rect(33, 0, 4, 2, light);
		rect(33, 2, 1, 1, 0x924b4c);
		rect(36, 2, 1, 1, 0x924b4c);
		rect(44, 0, 16, 10, blush);
		rect(44, 4, 16, 2, rose);
		rect(44, 8, 16, 2, 0xaf7470);
		for (let x = 44; x < 60; x += 4) rect(x + 1, 9, 1, 1, 0x896461);
		rect(0, 18, 52, 24, rose);
		rect(16, 18, 10, 16, light);
		rect(17, 21, 2, 5, 0xed9f99);
		rect(23, 28, 2, 3, 0xed9f99);
		rect(26, 18, 10, 16, blush);
		rect(0, 40, 52, 2, blush);
		rect(2, 36, 4, 1, 0xeba39c);
		rect(6, 37, 2, 1, 0xeba39c);
		rect(32, 39, 5, 1, blush);
		rect(36, 38, 2, 1, blush);
		// Tail on the rump.
		rect(46, 36, 3, 1, shadow);
		rect(45, 37, 1, 2, shadow);
		rect(46, 39, 2, 1, shadow);
		rect(48, 37, 1, 2, shadow);
	}),
};

// Paint the two-tone edge of each white patch on the cow's hide.
function cowPatch(rect: FillRect, u: number, v: number, rows: string[]) {
	for (const [y, row] of rows.entries()) {
		for (const [x, pixel] of [...row].entries()) {
			if (pixel !== ".") rect(u + x, v + y, 1, 1, pixel === "w" ? 0xe8e2d7 : 0xbcb6ae);
		}
	}
}

// Adult temperate cow, geometry.cow.v2. Horns and muzzle turn with the head.
export const cow: MobAsset = {
	id: "minecraft:cow",
	walkPitch: quadrupedWalk,
	bones: [
		{ name: "root", pivot: [0, 0, -1] },
		{ name: "head", parent: "root", pivot: [0, 20, -9], cubes: [
			{ origin: [-4, 16, -15], size: [8, 8, 6], uv: [0, 0] },
			{ origin: [-3, 16, -16], size: [6, 3, 1], uv: [34, 6] },
			{ origin: [-5, 22, -14], size: [1, 3, 1], uv: [30, 0] },
			{ origin: [4, 22, -14], size: [1, 3, 1], uv: [30, 0] },
		] },
		{ name: "body", parent: "root", pivot: [0, 19, 1], cubes: [
			{ origin: [-6, 12, -9], size: [12, 10, 18], uv: [0, 24] },
			{ origin: [-2, 11, 3], size: [4, 1, 6], uv: [20, 16] },
		] },
		...legs(4, 12, 6, -6, -7, 48),
	],
	texture: paintMobSkin(64, 64, rect => {
		const brown = 0x493a32, umber = 0x624d40, cream = 0xe8e2d7;
		rect(0, 0, 28, 14, brown);
		cowPatch(rect, 8, 0, ["wwws", ".www", ".sww", "..ws", ".www", "wws."]);
		cowPatch(rect, 8, 6, ["wws.", ".www", ".sw.", "..s."]);
		cowPatch(rect, 15, 7, ["sww", ".ww", ".sw", "..s"]);
		rect(6, 9, 2, 1, cream);
		rect(12, 9, 2, 1, cream);
		rect(6, 9, 1, 1, 0x211e1c);
		rect(13, 9, 1, 1, 0x211e1c);
		rect(0, 12, 6, 2, umber);
		rect(30, 0, 4, 4, 0xa59b8c);
		rect(30, 1, 4, 1, 0xd3cbb8);
		rect(34, 6, 14, 4, 0xb6a598);
		rect(35, 7, 6, 1, 0xd3c5b7);
		rect(35, 8, 2, 1, 0x6b5950);
		rect(39, 8, 2, 1, 0x6b5950);
		rect(48, 0, 16, 16, brown);
		cowPatch(rect, 48, 5, ["wws.....", ".wwww...", ".wwwwwws", "..swwwww", ".....sww"]);
		cowPatch(rect, 57, 7, ["..swwww", ".wwws..", "wws....", ".s....."]);
		rect(48, 13, 16, 3, 0x3a322e);
		rect(49, 14, 3, 1, 0x594f48);
		rect(55, 13, 4, 1, 0x685e56);
		rect(20, 16, 20, 7, 0xcb978e);
		rect(30, 16, 4, 6, 0xdbb0a9);
		rect(32, 18, 1, 2, 0xbc8a85);
		rect(0, 24, 60, 28, brown);
		// Broad patches break over the spine, flanks, belly and haunches.
		cowPatch(rect, 18, 24, ["swww.....", "wwwww....", "swwwww...", "..wwwww..", "...swwws.", "....wwwww"]);
		cowPatch(rect, 19, 35, ["....wwws.", "..swwwwww", ".wwwwwwww", "wwww..www", "wws....ws", "ws.......", "w........"]);
		rect(30, 24, 12, 18, umber);
		cowPatch(rect, 32, 28, ["wwwws", "swww.", ".ww..", ".swww", "..wws"]);
		cowPatch(rect, 0, 42, ["wws..........ww", "wwwws.......www", "swwwww......sww", "..wwwwws.....ww", "...wwwww...sww.", "..wwwww...wws..", "swwwws........."]);
		cowPatch(rect, 11, 46, ["....sw", "...sww", "..wwww", ".wwwww", ".swwww", "...sww"]);
		cowPatch(rect, 20, 42, ["wwws.", "wwwws", ".wwww", "..ww.", "..s.."]);
		cowPatch(rect, 30, 42, ["..sww.....", "..wwws....", ".wwwwww...", "wwwwwws...", "wwwww.....", "..wws.....", "..s......."]);
		cowPatch(rect, 39, 45, ["....sww..", "..wwwwwws", ".wwwwwwww", "swwwww.ww", "wwwws...w", "wws......", "ws......."]);
		cowPatch(rect, 52, 42, ["....swww", "..swwwww", ".wwwwwww", "swws.www", "s.....ws"]);
		rect(53, 46, 2, 3, umber);
		rect(53, 49, 2, 2, 0x302923);
	}),
};

// Adult temperate chicken, geometry.chicken.v1.12. Separate toes leave gaps between claws.
export const chicken: MobAsset = {
	id: "minecraft:chicken",
	walkPitch: { leg0: 80, leg1: -80 },
	bones: [
		{ name: "body", pivot: [0, 8, 0], cubes: [{ origin: [-3, 5, -4], size: [6, 6, 8], uv: [0, 12] }] },
		{ name: "head", pivot: [0, 9, -4], cubes: [{ origin: [-2, 9, -6], size: [4, 6, 3], uv: [0, 0] }] },
		{ name: "comb", parent: "head", pivot: [0, 9, -4], cubes: [{ origin: [-1, 9, -7], size: [2, 2, 2], uv: [46, 0] }] },
		{ name: "beak", parent: "head", pivot: [0, 9, -4], cubes: [{ origin: [-2, 11, -8], size: [4, 2, 2], uv: [32, 0] }] },
		...[-3, 0].map((x, i): MobBone => ({
			name: `leg${i}`, pivot: [x + 1, 5, 1], cubes: [
				{ origin: [x + 1, 1, 0], size: [1, 4, 1], uv: [32, 8] },
				{ origin: [x, 0, -1], size: [3, 1, 2], uv: [40, 8] },
				{ origin: [x, 0, -2], size: [1, 1, 1], uv: [52, 8] },
				{ origin: [x + 2, 0, -2], size: [1, 1, 1], uv: [52, 8] },
			],
		})),
		...[-4, 3].map((x, i): MobBone => ({
			name: `wing${i}`, pivot: [i === 0 ? -3 : 3, 11, 0],
			cubes: [{ origin: [x, 7, -3], size: [1, 4, 6], uv: [16, 0], mirror: i === 1 }],
		})),
	],
	texture: paintMobSkin(64, 32, rect => {
		const white = 0xf0ede6, down = 0xdcdad5, quill = 0xc7c7c0;
		rect(0, 0, 14, 9, white);
		// Dark eyes sit just above the bill, with a pixel around each corner.
		rect(2, 4, 2, 1, 0x312f2c);
		rect(6, 4, 2, 1, 0x312f2c);
		rect(0, 7, 14, 2, down);
		rect(16, 0, 14, 10, white);
		rect(16, 9, 14, 1, quill);
		for (const side of [16, 23]) {
			rect(side + 1, 8, 2, 1, down);
			rect(side + 2, 7, 1, 1, down);
			rect(side + 4, 8, 2, 1, down);
			rect(side + 5, 7, 1, 1, down);
		}
		rect(32, 0, 12, 4, 0xe9aa42);
		rect(34, 0, 4, 2, 0xffcc65);
		rect(32, 3, 12, 1, 0xce882e);
		rect(46, 0, 8, 4, 0xbb3931);
		rect(48, 2, 2, 1, 0xdc5040);
		rect(32, 8, 4, 5, 0xd9a03a);
		rect(32, 10, 4, 1, 0xb9822f);
		rect(40, 8, 10, 3, 0xd9a03a);
		rect(42, 8, 3, 2, 0xefbd53);
		rect(52, 8, 4, 2, 0xc98f38);
		rect(0, 12, 28, 14, white);
		rect(14, 12, 6, 8, down);
		rect(0, 24, 28, 2, down);
		for (const x of [2, 10, 16, 23]) {
			rect(x, 23, 2, 1, down);
			rect(x + 1, 22, 1, 1, down);
		}
		rect(23, 21, 3, 1, 0xe5e2dc);
	}),
};
