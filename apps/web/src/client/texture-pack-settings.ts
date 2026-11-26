import type { TexturePack } from "./texture-pack.ts";
import { TEX_SIZE } from "./textures.ts";

interface Selection { pack: TexturePack; active: boolean }

// One transaction holds both the decoded tiles and whether they are enabled.
async function selection(next?: Selection | null): Promise<Selection | undefined> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const open = indexedDB.open("cf-minecraft.texture-pack", 1);
		open.onupgradeneeded = () => open.result.createObjectStore("settings");
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
	});
	try {
		return await new Promise<Selection | undefined>((resolve, reject) => {
			const tx = db.transaction("settings", next === undefined ? "readonly" : "readwrite");
			const store = tx.objectStore("settings");
			const read = next === undefined ? store.get("selection") : undefined;
			if (next === null) store.delete("selection");
			else if (next) store.put(next, "selection");
			tx.oncomplete = () => resolve(read?.result);
			tx.onabort = () => reject(tx.error ?? new Error("端末に保存できません"));
		});
	} finally { db.close(); }
}

export function setupTexturePack(panel: HTMLElement, names: readonly string[], apply: (tiles: ReadonlyMap<string, Uint8Array>) => void): void {
	const file = panel.querySelector("input")!;
	const enable = panel.querySelector<HTMLButtonElement>("#texture-apply")!;
	const standard = panel.querySelector<HTMLButtonElement>("#texture-standard")!;
	const remove = panel.querySelector<HTMLButtonElement>("#texture-delete")!;
	const current = panel.querySelector("output")!;
	const message = panel.querySelector('[role="status"]')!;
	let saved: Selection | undefined, pending: TexturePack | undefined, busy = false;

	function refresh(): void {
		file.disabled = busy;
		enable.disabled = busy || (!pending && (!saved || saved.active));
		standard.disabled = busy || !saved?.active;
		remove.disabled = busy || (!saved && !pending);
		current.textContent = saved?.active ? `使用中：${saved.pack.name}（${saved.pack.tiles.size} 枚）` : "使用中：標準素材";
		if (saved && !saved.active) current.textContent += ` ／ 保存済み：${saved.pack.name}`;
	}

	async function run(action: () => Promise<void>): Promise<void> {
		if (busy) return;
		busy = true;
		refresh();
		try { await action(); }
		catch (error) { message.textContent = `テクスチャ設定を変更できませんでした。${error instanceof Error ? error.message : ""}`; }
		finally { busy = false; refresh(); }
	}

	async function commit(next: Selection | null): Promise<void> {
		await selection(next);
		saved = next ?? undefined;
		pending = undefined;
		file.value = "";
		apply(saved?.active ? saved.pack.tiles : new Map());
		message.textContent = "";
	}

	file.onchange = () => void run(async () => {
		const chosen = file.files?.[0];
		pending = undefined;
		if (!chosen) { message.textContent = ""; return; }
		message.textContent = "パックを確認中…";
		const { importTexturePack } = await import("./texture-pack.ts");
		pending = await importTexturePack(chosen, names);
		message.textContent = `${pending.name}（${pending.tiles.size} 枚）を読み込みました。「適用」で切り替えます。`;
	});
	enable.onclick = () => void run(async () => {
		const pack = pending ?? saved?.pack;
		if (pack) await commit({ pack, active: true });
	});
	standard.onclick = () => void run(async () => { if (saved) await commit({ ...saved, active: false }); });
	remove.onclick = () => void run(() => commit(null));
	void run(async () => {
		const stored = await selection();
		if (!stored) return;
		if (typeof stored.active !== "boolean" || typeof stored.pack?.name !== "string" || !(stored.pack.tiles instanceof Map) ||
			![...stored.pack.tiles].every(([name, pixels]) => names.includes(name) && pixels instanceof Uint8Array && pixels.length === TEX_SIZE ** 2 * 4)) {
			await selection(null);
			return;
		}
		saved = stored;
		if (stored.active) apply(stored.pack.tiles);
	});
}
