import type { MobAsset, Vec3 } from "./model.ts";
import { vanillaSkin } from "./skin.ts";

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
	texture: vanillaSkin(new URL("./vanilla/zombie.png", import.meta.url), 32),
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
	texture: vanillaSkin(new URL("./vanilla/skeleton.png", import.meta.url), 32),
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
	texture: vanillaSkin(new URL("./vanilla/creeper.png", import.meta.url), 32),
};

export const husk: MobAsset = {
	...zombie,
	id: "minecraft:husk",
	texture: vanillaSkin(new URL("./vanilla/husk.png", import.meta.url), 32),
};

// The stray's second skin is packed below its base skin. The loose clothing
// uses the regular four-texel humanoid limbs and follows the skeleton pose.
const clothing = humanoid(4, [-18, 0, 0], [0, 0, 0], 1.9);
export const stray: MobAsset = {
	...skeleton,
	id: "minecraft:stray",
	texture: vanillaSkin(new URL("./vanilla/stray.png", import.meta.url), 64),
	bones: skeleton.bones.map(bone => {
		const layer = clothing.find(part => part.name === bone.name)?.cubes?.[0];
		if (!layer) return bone;
		return { ...bone, cubes: [...(bone.cubes ?? []), {
			...layer, uv: [layer.uv[0], layer.uv[1] + 32] as const, inflate: 0.25,
		}] };
	}),
};
