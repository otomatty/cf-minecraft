import type { MobAsset } from "./model.ts";
import { vanillaSkin } from "./skin.ts";

export const cow: MobAsset = {
	id: "minecraft:cow",
	texture: vanillaSkin(new URL("./vanilla/cow.png", import.meta.url), 64),
	walkPitch: { leg0: 80, leg1: -80, leg2: -80, leg3: 80 },
	bones: [
		{ name: "root", pivot: [0, 0, -1] },
		{ name: "head", parent: "root", pivot: [0, 20, -9], cubes: [
			{ origin: [-4, 16, -15], size: [8, 8, 6], uv: [0, 0] },
			{ origin: [-3, 16, -16], size: [6, 3, 1], uv: [1, 33] },
			{ origin: [-5, 22, -14], size: [1, 3, 1], uv: [22, 0] },
			{ origin: [4, 22, -14], size: [1, 3, 1], uv: [22, 0] },
		] },
		{ name: "body", parent: "root", pivot: [0, 19, 1], cubes: [
			{ origin: [-6, 29, 14], size: [12, 18, 10], uv: [18, 4], pitch90Around: [0, 18, 20] },
			{ origin: [-2, 29, 13], size: [4, 6, 1], uv: [52, 0], pitch90Around: [0, 18, 20] },
		] },
		{ name: "leg0", parent: "root", pivot: [-4, 12, 6], cubes: [
			{ origin: [-6, 0, 4], size: [4, 12, 4], uv: [0, 16] },
		] },
		{ name: "leg1", parent: "root", pivot: [4, 12, 6], cubes: [
			{ origin: [2, 0, 4], size: [4, 12, 4], uv: [0, 16], mirror: true },
		] },
		{ name: "leg2", parent: "root", pivot: [-4, 12, -7], cubes: [
			{ origin: [-6, 0, -8], size: [4, 12, 4], uv: [0, 16] },
		] },
		{ name: "leg3", parent: "root", pivot: [4, 12, -7], cubes: [
			{ origin: [2, 0, -8], size: [4, 12, 4], uv: [0, 16], mirror: true },
		] },
	],
};

export const pig: MobAsset = {
	id: "minecraft:pig",
	texture: vanillaSkin(new URL("./vanilla/pig.png", import.meta.url), 64),
	walkPitch: { leg0: 80, leg1: -80, leg2: -80, leg3: 80 },
	bones: [
		{ name: "root", pivot: [0, 0, 0] },
		{ name: "head", parent: "root", pivot: [0, 12, -7], cubes: [
			{ origin: [-4, 8, -15], size: [8, 8, 8], uv: [0, 0] },
			{ origin: [-2, 9, -16], size: [4, 3, 1], uv: [16, 16] },
		] },
		{ name: "body", parent: "root", pivot: [0, 0, 0], cubes: [
			{ origin: [-5, 2, -5], size: [10, 16, 8], uv: [28, 8], pitch90Around: [0, 10, -1] },
		] },
		{ name: "leg0", parent: "root", pivot: [-3, 6, 6], cubes: [
			{ origin: [-5, 0, 4], size: [4, 6, 4], uv: [0, 16] },
		] },
		{ name: "leg1", parent: "root", pivot: [3, 6, 6], cubes: [
			{ origin: [1, 0, 4], size: [4, 6, 4], uv: [0, 16], mirror: true },
		] },
		{ name: "leg3", parent: "root", pivot: [3, 6, -6], cubes: [
			{ origin: [1, 0, -8], size: [4, 6, 4], uv: [0, 16], mirror: true },
		] },
		{ name: "leg2", parent: "root", pivot: [-3, 6, -6], cubes: [
			{ origin: [-5, 0, -8], size: [4, 6, 4], uv: [0, 16] },
		] },
	],
};

export const chicken: MobAsset = {
	id: "minecraft:chicken",
	texture: vanillaSkin(new URL("./vanilla/chicken.png", import.meta.url), 32),
	walkPitch: { leg0: 80, leg1: -80 },
	bones: [
		{ name: "body", pivot: [0, 8, 0], cubes: [
			{ origin: [-3, 4, -3], size: [6, 8, 6], uv: [0, 9], pitch90Around: [0, 8, 0] },
		] },
		{ name: "head", pivot: [0, 9, -4], cubes: [
			{ origin: [-2, 9, -6], size: [4, 6, 3], uv: [0, 0] },
		] },
		{ name: "comb", parent: "head", pivot: [0, 9, -4], cubes: [
			{ origin: [-1, 9, -7], size: [2, 2, 2], uv: [14, 4] },
		] },
		{ name: "beak", parent: "head", pivot: [0, 9, -4], cubes: [
			{ origin: [-2, 11, -8], size: [4, 2, 2], uv: [14, 0] },
		] },
		{ name: "leg0", pivot: [-2, 5, 1], cubes: [
			{ origin: [-3, 0, -2], size: [3, 5, 3], uv: [26, 0] },
		] },
		{ name: "leg1", pivot: [1, 5, 1], cubes: [
			{ origin: [0, 0, -2], size: [3, 5, 3], uv: [26, 0] },
		] },
		{ name: "wing0", pivot: [-3, 11, 0], cubes: [
			{ origin: [-4, 7, -3], size: [1, 4, 6], uv: [24, 13] },
		] },
		{ name: "wing1", pivot: [3, 11, 0], cubes: [
			{ origin: [3, 7, -3], size: [1, 4, 6], uv: [24, 13] },
		] },
	],
};

export const sheep: MobAsset = {
	id: "minecraft:sheep",
	texture: vanillaSkin(new URL("./vanilla/sheep.png", import.meta.url), 64),
	walkPitch: { leg0: 80, leg1: -80, leg2: -80, leg3: 80 },
	bones: [
		{ name: "body", pivot: [0, 19, 2], cubes: [
			{ origin: [-4, 13, -5], size: [8, 16, 6], uv: [28, 8], pitch90Around: [0, 19, 2] },
			{ origin: [-4, 13, -5], size: [8, 16, 6], uv: [28, 40], pitch90Around: [0, 19, 2], inflate: 1.75 },
		] },
		{ name: "head", pivot: [0, 18, -8], cubes: [
			{ origin: [-3, 16, -14], size: [6, 6, 8], uv: [0, 0] },
			{ origin: [-3, 16, -12], size: [6, 6, 6], uv: [0, 32], inflate: 0.6 },
		] },
		{ name: "leg0", parent: "body", pivot: [-3, 12, 7], cubes: [
			{ origin: [-5, 0, 5], size: [4, 12, 4], uv: [0, 16] },
			{ origin: [-5, 6, 5], size: [4, 6, 4], uv: [0, 48], inflate: 0.5 },
		] },
		{ name: "leg1", parent: "body", pivot: [3, 12, 7], cubes: [
			{ origin: [1, 0, 5], size: [4, 12, 4], uv: [0, 16] },
			{ origin: [1, 6, 5], size: [4, 6, 4], uv: [0, 48], inflate: 0.5 },
		] },
		{ name: "leg2", parent: "body", pivot: [-3, 12, -5], cubes: [
			{ origin: [-5, 0, -7], size: [4, 12, 4], uv: [0, 16] },
			{ origin: [-5, 6, -7], size: [4, 6, 4], uv: [0, 48], inflate: 0.5 },
		] },
		{ name: "leg3", parent: "body", pivot: [3, 12, -5], cubes: [
			{ origin: [1, 0, -7], size: [4, 12, 4], uv: [0, 16] },
			{ origin: [1, 6, -7], size: [4, 6, 4], uv: [0, 48], inflate: 0.5 },
		] },
	],
};
