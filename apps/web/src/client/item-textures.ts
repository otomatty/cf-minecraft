import packed from "./vanilla/item-tiles.json" with { type: "json" };
import { decodeTile } from "./vanilla/decode-tile.ts";

export function hasItemTexture(name: string): name is keyof typeof packed {
	return Object.hasOwn(packed, name);
}

export function itemTexture(name: string): Uint8Array<ArrayBuffer> | undefined {
	return hasItemTexture(name) ? decodeTile(packed[name]) : undefined;
}
