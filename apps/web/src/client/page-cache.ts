import type { Transport } from "./transport.ts";

export type PageCacheAction = "flush" | "close" | "reload" | "resume";

/**
 * What to do when the browser hides this page or brings it back.
 *
 * `pagehide` with `persisted` means the page is entering the back-forward
 * cache, which freezes its workers. A single-player sim worker frozen while
 * it holds an OPFS sync access handle can crash the renderer: the next page
 * opens the same world files, Chrome evicts the frozen page, and that
 * eviction takes down the whole renderer. Close the worker on the way in
 * (after a best-effort flush, which will not finish) and reload on the way
 * out, because the worker is already gone.
 *
 * Multiplayer has no local sim worker, so it flushes when hidden and resumes
 * when restored. A page that is actually going away (`persisted === false`)
 * only flushes.
 */
export function pageCacheActions(phase: "pagehide" | "pageshow", persisted: boolean, kind: Transport["kind"]): readonly PageCacheAction[] {
	if (phase === "pagehide") return persisted && kind === "local" ? ["flush", "close"] : ["flush"];
	if (!persisted) return [];
	return kind === "local" ? ["reload"] : ["resume"];
}
