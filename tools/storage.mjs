// Compare the complete native and WASM write plans, including compressed bytes.
// Run after pnpm build:wasm:
// cargo run --quiet -p storage --example fixture > target/storage-fixture.bin
// node tools/storage.mjs target/storage-fixture.bin
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RegionCodec } from "../apps/web/src/shared/region-codec.ts";

const native = readFileSync(process.argv[2] ?? "target/storage-fixture.bin");
const { instance } = await WebAssembly.instantiate(readFileSync(new URL("../apps/web/src/wasm/server.wasm", import.meta.url)), {});
const codec = new RegionCodec(instance);
const input = new Uint8Array(8 + 49152 + 65536);
new DataView(input.buffer).setUint32(4, 1023, true);
for (let i = 0; i < 65536; i++) input[8 + 49152 + i] = (i * 31 + Math.floor(i / 17)) % 256;
const wasm = codec.call(2, input);
assert.deepEqual(wasm, new Uint8Array(native));
console.log(`OK: native and WASM storage plans agree (${wasm.length} bytes)`);
