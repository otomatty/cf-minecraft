import { chicken, cow, pig, sheep } from "./farm.ts";
import { creeper, skeleton, zombie } from "./hostile.ts";
import type { MobAsset } from "./model.ts";

/** Shared by entity presentation code. Keys are independent of save and protocol IDs. */
export const mobAssets: ReadonlyMap<string, MobAsset> = new Map(
	[pig, cow, chicken, sheep, zombie, skeleton, creeper].map(asset => [asset.id, asset]),
);
