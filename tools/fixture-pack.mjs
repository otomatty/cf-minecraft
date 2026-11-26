import { writeFile } from "node:fs/promises";
import { fixturePack } from "../apps/web/test/texture-pack-fixture.mjs";

const [output] = process.argv.slice(2);
if (!output || process.argv.length !== 3) {
	console.error("Usage: node tools/fixture-pack.mjs <output.zip>");
	process.exitCode = 1;
} else {
	await writeFile(output, await fixturePack());
}
