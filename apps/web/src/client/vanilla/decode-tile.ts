/** Expand a lossless indexed frame to the row-major RGBA used by WebGPU and UI icons. */
export function decodeTile([colors, indices]: readonly string[]): Uint8Array<ArrayBuffer> {
	const palette = atob(colors), pixels = atob(indices);
	const rgba = new Uint8Array(16 * 16 * 4);
	for (let i = 0; i < pixels.length; i++) {
		const entry = pixels.charCodeAt(i) * 4;
		for (let c = 0; c < 4; c++) rgba[i * 4 + c] = palette.charCodeAt(entry + c);
	}
	return rgba;
}
