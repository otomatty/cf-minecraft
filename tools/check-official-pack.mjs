import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ClientCore, gameTextureNames } from "../apps/web/src/client/client-core.ts";
import { importTexturePack, MissingPackImages } from "../apps/web/src/client/texture-pack.ts";
import { TEX_SIZE } from "../apps/web/src/client/textures.ts";

function report(version, names, missing) {
	console.log(`Bedrock Samples v${version}`);
	console.log(`Resolved: ${names.length - missing.length}/${names.length}`);
	console.log(`Unresolved: ${missing.join(", ") || "none"}`);
	if (missing.length) process.exitCode = 1;
}

async function checkPack(path) {
	const wasm = await readFile(new URL("../apps/web/src/wasm/client.wasm", import.meta.url));
	const { instance } = await WebAssembly.instantiate(wasm, {});
	const names = [...new Set(gameTextureNames(new ClientCore(instance)))];
	const file = new File([await openAsBlob(path)], basename(path));
	try {
		// The importer still checks ZIP integrity, PNG headers and strips, and decodes TGAs.
		const pack = await importTexturePack(file, names, undefined, async () => new Uint8Array(TEX_SIZE ** 2 * 4));
		report(pack.version, names, names.filter(name => !pack.tiles.has(name)));
	} catch (error) {
		if (!(error instanceof MissingPackImages)) throw error;
		report(error.version, names, names);
	}
}

const [path] = process.argv.slice(2);
if (process.argv.length !== 3) {
	console.error("Usage: node tools/check-official-pack.mjs <zip>");
	process.exitCode = 1;
} else {
	try {
		await checkPack(path);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
