/** Decode one 16×16 pixel-art tile. A dot leaves a transparent texel. */
export function pixelTile(rows: readonly string[], palette: Readonly<Record<string, number>>): Uint8Array<ArrayBuffer> {
	if (rows.length !== 16) throw new Error("A pixel tile must have 16 rows");
	const pixels = new Uint8Array(16 * 16 * 4);
	for (const [y, row] of rows.entries()) {
		if (row.length !== 16) throw new Error(`Pixel tile row ${y} has ${row.length} texels`);
		for (let x = 0; x < 16; x++) {
			const key = row[x];
			if (key === ".") continue;
			const rgb = palette[key];
			if (rgb === undefined) throw new Error(`Unknown pixel tile color '${key}' at ${x},${y}`);
			const i = (y * 16 + x) * 4;
			pixels[i] = rgb >>> 16;
			pixels[i + 1] = rgb >>> 8;
			pixels[i + 2] = rgb;
			pixels[i + 3] = 255;
		}
	}
	return pixels;
}
