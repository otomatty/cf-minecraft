import type { MobSkin } from "./model.ts";

export function vanillaSkin(url: URL, height: 32 | 64): MobSkin {
	return { url, width: 64, height };
}
