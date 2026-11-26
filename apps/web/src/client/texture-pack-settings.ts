import { importTexturePack, isPackVersion, packArtDimensions, packLabel, type PackProgress, type TexturePack } from "./texture-pack.ts";
import { TEX_SIZE } from "./textures.ts";
import { WATER_FRAME_COUNT } from "./building-textures.ts";

const storageError = "テクスチャをこのブラウザに保存できません。サイトデータの保存を許可して、もう一度お試しください。";

export function installedPack(value: unknown, names: readonly string[]): TexturePack | undefined {
	const pack = (value as { pack?: Partial<TexturePack> } | null)?.pack;
	if (!isPackVersion(pack?.version) || !(pack.tiles instanceof Map) || !pack.tiles.size ||
		!(pack.waterFrames instanceof Map) || !(pack.art instanceof Map)) return;
	const known = new Set(names);
	const validTile = (pixels: unknown): pixels is Uint8Array => pixels instanceof Uint8Array && pixels.length === TEX_SIZE ** 2 * 4;
	for (const [name, pixels] of pack.tiles) {
		if (!known.has(name) || !validTile(pixels)) return;
	}
	for (const [name, frames] of pack.waterFrames) {
		if ((name !== "water" && name !== "water_flow") || !Array.isArray(frames) || !frames.length ||
			frames.length > WATER_FRAME_COUNT || frames[0] !== pack.tiles.get(name)) return;
		for (const frame of frames) if (!validTile(frame)) return;
	}
	for (const name of ["water", "water_flow"]) {
		if (pack.tiles.has(name) && !pack.waterFrames.has(name)) return;
	}
	for (const [path, pixels] of pack.art) {
		const size = packArtDimensions.get(path);
		if (!size || !(pixels instanceof Uint8Array) || pixels.length !== size[0] * size[1] * 4) return;
	}
	return { version: pack.version, tiles: pack.tiles, waterFrames: pack.waterFrames, art: pack.art };
}

async function storedPack(names: readonly string[], next?: TexturePack): Promise<TexturePack | undefined> {
	try {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = indexedDB.open("cf-minecraft.texture-pack", 1);
			open.onupgradeneeded = () => open.result.createObjectStore("settings");
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
			open.onblocked = () => {
				open.onsuccess = () => open.result.close();
				reject(new Error(storageError));
			};
		});
		try {
			return await new Promise<TexturePack | undefined>((resolve, reject) => {
				const tx = db.transaction("settings", "readwrite");
				const store = tx.objectStore("settings");
				let pack = next;
				tx.oncomplete = () => resolve(pack);
				tx.onabort = () => reject(tx.error);
				if (next) store.put({ pack: next }, "selection");
				else {
					const read = store.get("selection");
					read.onsuccess = () => {
						pack = installedPack(read.result, names);
						if (read.result !== undefined && !pack) store.delete("selection");
					};
				}
			});
		} finally { db.close(); }
	} catch {
		throw new Error(storageError);
	}
}

export function loadInstalledPack(names: readonly string[]): Promise<TexturePack | undefined> {
	return storedPack(names);
}

export async function installPack(file: File, names: readonly string[], onProgress?: PackProgress): Promise<TexturePack> {
	const pack = await importTexturePack(file, names, onProgress);
	await storedPack(names, pack);
	return pack;
}

export function setupTexturePack(
	panel: HTMLElement, names: readonly string[], initial: TexturePack, apply: (pack: TexturePack) => void,
): void {
	const file = panel.querySelector("input")!;
	const choose = panel.querySelector("button")!;
	const current = panel.querySelector("output")!;
	const message = panel.querySelector('[role="status"]')!;
	current.textContent = packLabel(initial);
	choose.onclick = () => file.click();
	file.onchange = async () => {
		const chosen = file.files?.[0];
		if (!chosen || choose.disabled) return;
		file.value = "";
		choose.disabled = file.disabled = true;
		message.textContent = "テクスチャを取り出しています…";
		try {
			const pack = await installPack(chosen, names, (done, total) => {
				if (total) message.textContent = `テクスチャを取り出しています… ${done} / ${total}`;
			});
			apply(pack);
			current.textContent = packLabel(pack);
			message.textContent = "テクスチャを適用しました";
		} catch (error) {
			message.textContent = `テクスチャを変更できませんでした。${error instanceof Error ? error.message : ""}`;
		} finally {
			choose.disabled = file.disabled = false;
		}
	};
}
