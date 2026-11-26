import type { Vec3 } from "./model.ts";

/** MobKind follows protocol order. The player and the sheared variant have their own pack assets. */
export const mobNames = ["cow", "pig", "chicken", "sheep", "zombie", "skeleton", "creeper"] as const;
export const entityNames = [...mobNames, "player"] as const;
export type EntityName = typeof entityNames[number];
export type EntityAssetKey = EntityName | "sheep/sheared";
export const entityAssetKeys = [...entityNames, "sheep/sheared"] as const;

const quadrupedWalk = (pitch: number) => ({ leg0: pitch, leg1: -pitch, leg2: -pitch, leg3: pitch });
const humanoidWalk = (leg: number, arm: number) =>
	({ rightLeg: leg, leftLeg: -leg, rightArm: -arm, leftArm: arm });

interface Pose {
	walkPitch: Readonly<Partial<Record<string, number>>>;
	restRotation?: Readonly<Partial<Record<string, Vec3>>>;
}

export const entityPoses: Readonly<Record<EntityName, Pose>> = {
	cow: { walkPitch: quadrupedWalk(80) },
	pig: { walkPitch: quadrupedWalk(80) },
	chicken: { walkPitch: { leg0: 80, leg1: -80 } },
	sheep: { walkPitch: quadrupedWalk(0.32 * 180 / Math.PI) },
	zombie: {
		walkPitch: { rightLeg: 25, leftLeg: -25 },
		restRotation: { rightArm: [-90, -5.73, 2.865], leftArm: [-90, 5.73, -2.865] },
	},
	skeleton: { walkPitch: humanoidWalk(30, 21), restRotation: { rightArm: [-18, 0, 0] } },
	creeper: { walkPitch: quadrupedWalk(23) },
	player: { walkPitch: humanoidWalk(25, 20) },
};

export const skeletonBow = { bone: "rightItem", texture: "bow", grip: [5.5, 6.5], rotation: [28, 24, 0] as Vec3 } as const;

const fleeceColors = [[255, 255, 255], [155, 156, 160], [148, 108, 82], [81, 82, 90]] as const;

export function sheepPixels(source: Uint8Array, woolColor: number): Uint8Array {
	const color = fleeceColors[woolColor] ?? fleeceColors[0];
	const pixels = source.slice();
	for (let i = 0; i < pixels.length; i += 4) {
		// The sheep TGA uses alpha as a dye mask. 0 is empty, 255 accepts color,
		// and low nonzero values mark visible, mostly untinted face and hoof pixels.
		const mask = pixels[i + 3];
		if (mask === 0) continue;
		for (let channel = 0; channel < 3; channel++) {
			pixels[i + channel] = Math.round(pixels[i + channel] * (1 - (mask / 255) * (1 - color[channel] / 255)));
		}
		pixels[i + 3] = 255;
	}
	return pixels;
}
