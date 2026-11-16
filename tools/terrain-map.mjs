// node tools/terrain-map.mjs <seed> <blocks_per_pixel> <out.ppm>
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
execFileSync("cargo", ["run", "--release", "-p", "worldgen", "--example", "terrain_map", "--", ...process.argv.slice(2)], {
	cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit",
});
