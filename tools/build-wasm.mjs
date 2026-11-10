// Builds the two WebAssembly modules and copies them next to the web app.
//
// Normal setup: `rustup target add wasm32-unknown-unknown`.
// Set MC_CARGO to use a different cargo (for example a distribution build
// that ships its own wasm32 standard library).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cargo = process.env.MC_CARGO ?? "cargo";
const target = "wasm32-unknown-unknown";

execFileSync(
	cargo,
	["build", "--release", "--target", target, "-p", "wasm-server", "-p", "wasm-client"],
	{ cwd: root, stdio: "inherit" },
);

const outDir = join(root, "apps/web/src/wasm");
mkdirSync(outDir, { recursive: true });
for (const [from, to] of [
	["wasm_server.wasm", "server.wasm"],
	["wasm_client.wasm", "client.wasm"],
]) {
	const src = join(root, "target", target, "release", from);
	copyFileSync(src, join(outDir, to));
	console.log(`${to}: ${(statSync(src).size / 1024).toFixed(1)} KiB`);
}
