import { humanoid } from "./hostile.ts";
import type { MobAsset } from "./model.ts";
import { paintMobSkin } from "./skin.ts";

export const player: MobAsset = {
	id: "minecraft:player",
	bones: humanoid(4, [0, 0, 0], [0, 0, 0]),
	walkPitch: { rightArm: -20, leftArm: 20, rightLeg: 25, leftLeg: -25 },
	texture: paintMobSkin(64, 32, rect => {
		const hair = 0x392a25, hairHighlight = 0x543b30;
		const skin = 0xe9bc97, skinShade = 0xcf9b79;
		rect(8, 0, 8, 8, hair);
		rect(16, 0, 8, 8, skinShade);
		rect(0, 8, 32, 8, hair);
		rect(1, 10, 3, 5, skinShade);
		rect(16, 10, 3, 5, skinShade);
		rect(8, 10, 8, 6, skin);
		rect(8, 10, 2, 2, hair);
		rect(10, 10, 2, 1, hair);
		rect(15, 10, 1, 1, hair);
		rect(9, 2, 5, 1, hairHighlight);
		rect(10, 5, 4, 1, hairHighlight);
		rect(10, 8, 4, 1, hairHighlight);
		rect(24, 10, 2, 4, hairHighlight);
		rect(9, 12, 2, 1, 0x342c2a);
		rect(13, 12, 2, 1, 0x342c2a);
		rect(11, 14, 2, 1, 0x965c50);

		const jacket = 0x328c63, jacketShade = 0x286d52, seam = 0x54ad80;
		rect(20, 16, 16, 4, jacketShade);
		rect(16, 20, 24, 12, jacket);
		rect(16, 29, 24, 3, jacketShade);
		rect(21, 20, 6, 1, jacketShade);
		rect(23, 21, 2, 1, jacketShade);
		rect(24, 22, 1, 7, jacketShade);
		rect(21, 25, 2, 1, seam);
		rect(26, 25, 2, 1, seam);
		rect(30, 21, 8, 1, seam);
		rect(44, 16, 4, 4, jacket);
		rect(48, 16, 4, 4, skinShade);
		rect(40, 20, 16, 12, jacket);
		rect(40, 27, 16, 2, jacketShade);
		rect(40, 29, 16, 3, skin);
		rect(45, 22, 1, 4, seam);

		const trousers = 0x343e58, boot = 0x674a36, sole = 0x423127;
		rect(4, 16, 4, 4, trousers);
		rect(8, 16, 4, 4, sole);
		rect(0, 20, 16, 8, trousers);
		rect(5, 22, 1, 5, 0x46526c);
		rect(0, 28, 16, 3, boot);
		rect(5, 29, 2, 1, 0x8b6749);
		rect(0, 31, 16, 1, sole);
	}),
};
