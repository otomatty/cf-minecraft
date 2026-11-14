export class CorruptRegionError extends Error {
	constructor() {
		super("Invalid region storage data");
		this.name = "CorruptRegionError";
	}
}

// Byte transport only. The region format and write ordering live in crates/storage.
export class RegionCodec {
	private readonly x: {
		memory: WebAssembly.Memory;
		mc_alloc(len: number): number;
		mc_free(ptr: number, len: number): void;
		storage_call(op: number, ptr: number, len: number): number;
		server_out_ptr(): number;
	};

	constructor(instance: WebAssembly.Instance) {
		this.x = instance.exports as unknown as typeof this.x;
	}

	call(op: number, bytes: Uint8Array): Uint8Array {
		const ptr = this.x.mc_alloc(bytes.length);
		try {
			new Uint8Array(this.x.memory.buffer).set(bytes, ptr);
			const len = this.x.storage_call(op, ptr, bytes.length);
			if (len < 0) throw new CorruptRegionError();
			const out = this.x.server_out_ptr();
			return new Uint8Array(this.x.memory.buffer).slice(out, out + len);
		} finally {
			this.x.mc_free(ptr, bytes.length);
		}
	}
}
