import { ACCESS_REVOKED, BAD_PACKET, LOGGED_IN_ELSEWHERE, PROTOCOL_MISMATCH, SERVICE_RESTART, TOO_MANY_PACKETS, WORLD_FULL } from "../shared/close-codes.ts";

export { shouldReconnect } from "../shared/close-codes.ts";

export const NO_WELCOME = "no welcome";
const PROTOCOL_RELOAD_KEY = "mc:protocol-reload";

/** Zero-based attempt: 500 ms initially, capped before applying 0.5–1.0 jitter. */
export function nextDelayMs(attempt: number, random: () => number): number {
	return Math.min(10_000, 500 * 2 ** Math.min(Math.max(0, attempt), 5)) * (0.5 + random() * 0.5);
}

export function reconnectMessage({ attempt, reason, code }: { attempt: number; reason: string; code?: number }): string {
	const waiting = `再接続しています(${attempt}回目)…`;
	if (code === WORLD_FULL) return `ワールドが満員です。空きを待って${waiting}`;
	if (code === SERVICE_RESTART) return `サーバーが再起動しています。${waiting}`;
	if (code === undefined && reason === NO_WELCOME) return `サーバーが応答しません。${waiting}`;
	return `サーバーとの接続が切れました。${waiting}`;
}

export function disconnectMessage(reason: string, code?: number): string {
	switch (code) {
		case LOGGED_IN_ELSEWHERE: return "サーバーとの接続が切れました: 別の場所で同じアカウントが接続しました";
		case ACCESS_REVOKED: return "サーバーとの接続が切れました: このワールドへの参加が取り消されました";
		case TOO_MANY_PACKETS: return "操作が多すぎたため、サーバーから切断されました";
		case BAD_PACKET: return "通信の内容が正しくないため、サーバーから切断されました";
		case PROTOCOL_MISMATCH: return "ゲームのバージョンがサーバーと違います。ページを再読み込みしてください";
		default: return `サーバーとの接続が切れました: ${reason}`;
	}
}

export function shouldReloadForProtocolMismatch(previous: string | null): boolean {
	return previous === null;
}

export function recordProtocolReload(getStorage: () => Pick<Storage, "getItem" | "setItem">): boolean {
	try {
		const storage = getStorage();
		if (!shouldReloadForProtocolMismatch(storage.getItem(PROTOCOL_RELOAD_KEY))) return false;
		storage.setItem(PROTOCOL_RELOAD_KEY, "1");
		return true;
	} catch {
		return false;
	}
}

export function clearProtocolReload(getStorage: () => Pick<Storage, "removeItem">): void {
	try {
		getStorage().removeItem(PROTOCOL_RELOAD_KEY);
	} catch { /* Storage may be unavailable. */ }
}
