/** Application close codes shared by the Worker, Durable Object and browser. */
export const LOGGED_IN_ELSEWHERE = 4000;
export const ACCESS_REVOKED = 4001;
export const TOO_MANY_PACKETS = 4002;
export const BAD_PACKET = 4003;
export const WORLD_FULL = 1013;
export const SERVICE_RESTART = 1012;

export function shouldReconnect(code: number): boolean {
	return ![LOGGED_IN_ELSEWHERE, ACCESS_REVOKED, TOO_MANY_PACKETS, BAD_PACKET].includes(code);
}
