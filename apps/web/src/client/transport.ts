// How packets reach a server. Both transports carry the same bytes, so the
// rest of the client cannot tell single player from multiplayer.

import { S2C } from "./client-core.ts";
import { nextDelayMs, shouldReconnect } from "./reconnect.ts";

const WORLD_CHECK_TIMEOUT_MS = 10_000;

export interface ServerStats {
	gameTime: number;
	tps: number;
	msptMean: number;
	msptMax: number;
	loadedChunks: number;
	persistence: string;
	memoryBytes: number;
}

export interface TransportHandlers {
	onOpen(): void;
	onPacket(data: Uint8Array): void;
	onStats(stats: ServerStats): void;
	onReconnecting(info: { attempt: number; delayMs: number; reason: string }): void;
	onClose(reason: string, code?: number): void;
}

export interface Transport {
	readonly kind: "local" | "websocket";
	send(packet: Uint8Array<ArrayBuffer>): void;
	/** Asks the server to persist now (best effort). */
	flush(): void;
	resume?(): void;
	close(): void;
}

export type WorkerRequest =
	| { type: "init"; wasmUrl: string; world: string; seed: string | null; generator: number }
	| { type: "packet"; data: ArrayBuffer }
	| { type: "save" };

export type WorkerEvent =
	| { type: "ready"; seed: string; persistence: string }
	| { type: "packets"; list: ArrayBuffer[] }
	| { type: "stats"; stats: ServerStats }
	| { type: "error"; message: string };

/** Single player: the server core runs in a Web Worker of this page (the "integrated server"). */
export class LocalTransport implements Transport {
	readonly kind = "local";
	private readonly worker: Worker;

	constructor(wasmUrl: string, world: string, seed: string | null, generator: number, handlers: TransportHandlers) {
		this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
		this.worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
			const msg = event.data;
			switch (msg.type) {
				case "ready":
					handlers.onOpen();
					break;
				case "packets":
					for (const buf of msg.list) handlers.onPacket(new Uint8Array(buf));
					break;
				case "stats":
					handlers.onStats(msg.stats);
					break;
				case "error":
					handlers.onClose(msg.message);
					break;
			}
		};
		this.worker.onerror = (event) => handlers.onClose(event.message || "sim worker failed");
		this.post({ type: "init", wasmUrl, world, seed, generator });
	}

	private post(msg: WorkerRequest, transfer: Transferable[] = []): void {
		this.worker.postMessage(msg, transfer);
	}

	send(packet: Uint8Array<ArrayBuffer>): void {
		const data = packet.slice().buffer;
		this.post({ type: "packet", data }, [data]);
	}

	flush(): void {
		this.post({ type: "save" });
	}

	close(): void {
		this.worker.terminate();
	}
}

/** Multiplayer: a WebSocket to the world's Durable Object. One message = one packet. */
export class WebSocketTransport implements Transport {
	readonly kind = "websocket";
	private socket: WebSocket | null = null;
	private stopped = false;
	private attempt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private probe: AbortController | null = null;
	private readonly world: string;
	private readonly handlers: TransportHandlers;

	constructor(world: string, handlers: TransportHandlers) {
		this.world = world;
		this.handlers = handlers;
		this.connect();
	}

	private connect(): void {
		if (this.stopped) return;
		const scheme = location.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(`${scheme}//${location.host}/ws/${encodeURIComponent(this.world)}`);
		this.socket = socket;
		socket.binaryType = "arraybuffer";
		socket.onopen = () => {
			if (this.socket !== socket) return;
			if (!this.stopped) this.handlers.onOpen();
		};
		socket.onmessage = (event) => {
			if (this.socket !== socket) return;
			if (this.stopped || !(event.data instanceof ArrayBuffer)) return;
			const packet = new Uint8Array(event.data);
			this.handlers.onPacket(packet);
			if (packet[0] === S2C.Welcome) this.attempt = 0;
		};
		socket.onclose = (event) => {
			if (this.socket !== socket) return;
			if (this.stopped) return;
			const reason = event.reason || `connection closed (${event.code})`;
			if (shouldReconnect(event.code)) this.retry(reason);
			else this.finish(reason, event.code);
		};
	}

	private retry(reason: string): void {
		if (this.stopped) return;
		const delayMs = nextDelayMs(this.attempt++, Math.random);
		this.handlers.onReconnecting({ attempt: this.attempt, delayMs, reason });
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.reconnect();
		}, delayMs);
	}

	private async reconnect(): Promise<void> {
		if (this.stopped) return;
		const probe = new AbortController();
		this.probe = probe;
		try {
			const response = await fetch(`/api/worlds/${encodeURIComponent(this.world)}`, {
				cache: "no-store",
				signal: AbortSignal.any([probe.signal, AbortSignal.timeout(WORLD_CHECK_TIMEOUT_MS)]),
			});
			if (this.stopped) return;
			const reason = ({
				401: "ログインし直してください",
				403: "このワールドに招待されていません",
				404: "ワールドがありません",
			} as Record<number, string>)[response.status];
			if (reason) this.finish(reason);
			else if (response.status === 200) this.connect();
			else this.retry(`world check failed (${response.status})`);
		} catch {
			this.retry("world check failed");
		} finally {
			if (this.probe === probe) this.probe = null;
		}
	}

	private finish(reason: string, code?: number): void {
		this.close();
		this.handlers.onClose(reason, code);
	}

	send(packet: Uint8Array<ArrayBuffer>): void {
		if (!this.stopped && this.socket?.readyState === WebSocket.OPEN) this.socket.send(packet);
	}

	flush(): void {
		// The server autosaves on its own schedule.
	}

	resume(): void {
		if (this.stopped || this.timer !== null || this.probe !== null) return;
		if (this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
		void this.reconnect();
	}

	close(): void {
		this.stopped = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.probe?.abort();
		this.socket?.close();
	}
}
