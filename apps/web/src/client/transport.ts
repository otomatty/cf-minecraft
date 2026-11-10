// How packets reach a server. Both transports carry the same bytes, so the
// rest of the client cannot tell single player from multiplayer.

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
	onClose(reason: string): void;
}

export interface Transport {
	readonly kind: "local" | "websocket";
	send(packet: Uint8Array<ArrayBuffer>): void;
	/** Asks the server to persist now (best effort). */
	flush(): void;
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
	private readonly socket: WebSocket;

	constructor(world: string, handlers: TransportHandlers) {
		const scheme = location.protocol === "https:" ? "wss:" : "ws:";
		this.socket = new WebSocket(`${scheme}//${location.host}/ws/${encodeURIComponent(world)}`);
		this.socket.binaryType = "arraybuffer";
		this.socket.onopen = () => handlers.onOpen();
		this.socket.onmessage = (event) => {
			if (event.data instanceof ArrayBuffer) handlers.onPacket(new Uint8Array(event.data));
		};
		this.socket.onclose = (event) => handlers.onClose(event.reason || `connection closed (${event.code})`);
	}

	send(packet: Uint8Array<ArrayBuffer>): void {
		if (this.socket.readyState === WebSocket.OPEN) this.socket.send(packet);
	}

	flush(): void {
		// The server autosaves on its own schedule.
	}

	close(): void {
		this.socket.close();
	}
}
