import { RegionCodec } from "./region-codec.ts";

export interface Meta {
	seed: string;
	gameTime: string;
	dayTime: string;
}

/** Region files in OPFS. Sync access handles exist only in workers, which is where we are. */
export class OpfsStore {
	private readonly dir: FileSystemDirectoryHandle;

	private readonly codec: RegionCodec;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(dir: FileSystemDirectoryHandle, codec: RegionCodec) {
		this.dir = dir;
		this.codec = codec;
	}

	static async open(world: string, codec: RegionCodec): Promise<OpfsStore | null> {
		try {
			const root = await navigator.storage.getDirectory();
			return new OpfsStore(await root.getDirectoryHandle(`world-${world}`, { create: true }), codec);
		} catch {
			// Private browsing or an old browser: play without saving.
			return null;
		}
	}

	async list(): Promise<Array<[number, number]>> {
		// Keep the source until both the data and location entry are durable.
		const names: string[] = [];
		for await (const name of this.dir.keys()) names.push(name);
		for (const name of names) {
			const m = /^c\.(-?\d+)\.(-?\d+)$/.exec(name);
			if (!m) continue;
			const cx = Number(m[1]), cz = Number(m[2]);
			if (!(await this.readChunk(cx, cz))) {
				const data = await this.readFile(name);
				if (!data) throw new Error(`Cannot migrate ${name}`);
				await this.writeChunk(cx, cz, data);
			}
			await this.dir.removeEntry(name);
		}
		const out: Array<[number, number]> = [];
		for await (const name of this.dir.keys()) {
			const m = /^r\.(-?\d+)\.(-?\d+)$/.exec(name);
			if (!m) continue;
			const rx = Number(m[1]), rz = Number(m[2]);
			const indices = await this.region(rx * 32, rz * 32, 0);
			const view = new DataView(indices.buffer, indices.byteOffset, indices.byteLength);
			for (let at = 0; at < indices.length; at += 4) {
				const i = view.getUint32(at, true);
				out.push([rx * 32 + i % 32, rz * 32 + Math.floor(i / 32)]);
			}
		}
		return out;
	}

	private region(cx: number, cz: number, op: number, data: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
		const run = this.queue.then(async () => {
			const name = `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}`;
			let handle: FileSystemFileHandle;
			try {
				handle = await this.dir.getFileHandle(name, { create: op === 2 });
			} catch (error) {
				if (op !== 2 && error instanceof DOMException && error.name === "NotFoundError") return new Uint8Array();
				throw error;
			}
			const access = await handle.createSyncAccessHandle();
			try {
				const headerSize = 49152;
				const size = access.getSize();
				if (size > 0xffffffff) throw new Error("Region exceeds 4 GiB");
				const input = new Uint8Array(8 + headerSize + data.length);
				const view = new DataView(input.buffer);
				view.setUint32(0, size, true);
				view.setUint32(4, ((cz % 32 + 32) % 32) * 32 + (cx % 32 + 32) % 32, true);
				this.readAt(access, input.subarray(8, 8 + Math.min(size, headerSize)), 0);
				input.set(data, 8 + headerSize);
				const result = this.codec.call(op, input);
				const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
				if (op === 1 && result.length) {
					const bytes = new Uint8Array(resultView.getUint32(4, true));
					this.readAt(access, bytes, resultView.getUint32(0, true));
					return this.codec.call(3, bytes);
				}
				if (op === 2) {
					for (let at = 0; at < result.length;) {
						const offset = resultView.getUint32(at, true);
						const length = resultView.getUint32(at + 4, true);
						const bytes = result.subarray(at + 8, at + 8 + length);
						let written = 0;
						while (written < length) {
							const n = access.write(bytes.subarray(written), { at: offset + written });
							if (n === 0) throw new Error("Short region write");
							written += n;
						}
						access.flush();
						at += 8 + length;
					}
				}
				return result;
			} finally {
				access.close();
			}
		});
		this.queue = run.catch(() => {});
		return run;
	}

	private readAt(access: FileSystemSyncAccessHandle, bytes: Uint8Array, at: number): void {
		let read = 0;
		while (read < bytes.length) {
			const n = access.read(bytes.subarray(read), { at: at + read });
			if (n === 0) throw new Error("Short region read");
			read += n;
		}
	}

	private async readFile(name: string): Promise<Uint8Array | null> {
		try {
			const handle = await this.dir.getFileHandle(name);
			return new Uint8Array(await (await handle.getFile()).arrayBuffer());
		} catch {
			return null;
		}
	}

	private async writeFile(name: string, data: Uint8Array): Promise<void> {
		const handle = await this.dir.getFileHandle(name, { create: true });
		const access = await handle.createSyncAccessHandle();
		try {
			access.truncate(0);
			access.write(data, { at: 0 });
			access.flush();
		} finally {
			access.close();
		}
	}

	readChunk(cx: number, cz: number): Promise<Uint8Array | null> {
		return this.region(cx, cz, 1).then((data) => data.length ? data : null);
	}

	writeChunk(cx: number, cz: number, data: Uint8Array): Promise<void> {
		return this.region(cx, cz, 2, data).then(() => {});
	}

	async readMeta(): Promise<Meta | null> {
		const bytes = await this.readFile("meta.json");
		if (!bytes) return null;
		try {
			const meta = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Meta>;
			if (typeof meta.seed === "string" && /^-?\d{1,19}$/.test(meta.seed)) {
				return { seed: meta.seed, gameTime: meta.gameTime ?? "0", dayTime: meta.dayTime ?? "0" };
			}
		} catch {
			// Unreadable meta: treat the world as new.
		}
		return null;
	}

	writeMeta(meta: Meta): Promise<void> {
		return this.writeFile("meta.json", new TextEncoder().encode(JSON.stringify(meta)));
	}
}

