// Presentation only; never used by the deterministic simulation. See docs/sky.md.
export type SkyColor = readonly [number, number, number];
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const mod = (x: number, n: number) => ((x % n) + n) % n;

export function celestialAngle(dayTime: number): number {
	const f = mod(dayTime / 24000 - 0.25, 1);
	return f + (1 - (Math.cos(f * Math.PI) + 1) / 2 - f) / 3;
}

/** Extrapolate between 1-second time packets at 20 TPS, freezing on a stale connection. */
export function partialDayTicks(now: number, receivedAt: number, connected: boolean): number {
	return connected ? Math.max(0, Math.min(20, (now - receivedAt) / 50)) : 0;
}

/** Only nonnegative, exactly representable integer ticks are accepted from the URL. */
export function parseStartTime(value: string | null): number | null {
	if (value === null || !/^\d+$/.test(value)) return null;
	const tick = Number(value);
	return Number.isSafeInteger(tick) ? tick : null;
}

export function skyState(dayTime: number, viewDistance = 8) {
	const angle = celestialAngle(dayTime);
	const sunHeight = Math.cos(angle * Math.PI * 2);
	const brightness = clamp(sunHeight * 2 + 0.5);
	const skyColor: SkyColor = [0x78 / 255 * brightness, 0xa7 / 255 * brightness, brightness];
	const baseFog = [0xc0 / 255 * (brightness * 0.94 + 0.06), 0xd8 / 255 * (brightness * 0.94 + 0.06), brightness * 0.91 + 0.09];
	const skyMix = 1 - Math.pow(0.25 + 0.75 * clamp(viewDistance / 32), 0.25);
	const fogColor = baseFog.map((c, i) => c + (skyColor[i] - c) * skyMix) as [number, number, number];
	const twilight = Math.abs(sunHeight) <= 0.4 ? sunHeight / 0.4 * 0.5 + 0.5 : 0;
	const band = Math.abs(sunHeight) <= 0.4 ? (1 - (1 - Math.sin(twilight * Math.PI)) * 0.99) ** 2 : 0;
	const sunsetColor: SkyColor = [0.7 + twilight * 0.3, 0.2 + twilight * twilight * 0.7, 0.2];
	return {
		angle, sunHeight, skyColor, fogColor, sunsetColor, sunsetStrength: band,
		skyBrightness: brightness,
		starBrightness: clamp(1 - (sunHeight * 2 + 0.25)) ** 2 * 0.5,
		moonPhase: mod(Math.floor(dayTime / 24000), 8),
		// Temporary ambient floor until the light engine supplies a per-block lightmap.
		skylight: 0.18 + 0.82 * clamp(sunHeight * 2 + 0.2),
	};
}
