export { shouldReconnect } from "../shared/close-codes.ts";

/** Zero-based attempt: 500 ms initially, capped before applying 0.5–1.0 jitter. */
export function nextDelayMs(attempt: number, random: () => number): number {
	return Math.min(10_000, 500 * 2 ** Math.min(Math.max(0, attempt), 5)) * (0.5 + random() * 0.5);
}
