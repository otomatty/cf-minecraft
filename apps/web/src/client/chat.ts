export interface ChatLine {
	kind: 0 | 1 | 2;
	sender: string;
	text: string;
}

export interface TimedChatLine {
	line: ChatLine;
	receivedAt: number;
}

export const CHAT_VISIBLE_MS = 10_000;
const CHAT_HISTORY_LIMIT = 50;
const CHAT_INPUT_LIMIT = 256;

export function formatChatLine({ kind, sender, text }: ChatLine): string {
	switch (kind) {
		case 0: return `<${sender}> ${text}`;
		case 1: return `${sender} が参加しました`;
		case 2: return `${sender} が退出しました`;
	}
}

export function appendChatLine(history: readonly TimedChatLine[], line: ChatLine, receivedAt: number): TimedChatLine[] {
	return [...history.slice(-(CHAT_HISTORY_LIMIT - 1)), { line, receivedAt }];
}

export function visibleChatLines(history: readonly TimedChatLine[], open: boolean, now: number): readonly TimedChatLine[] {
	return open ? history : history.filter(({ receivedAt }) => now - receivedAt < CHAT_VISIBLE_MS);
}

export function limitChatInput(text: string): string {
	return Array.from(text).slice(0, CHAT_INPUT_LIMIT).join("");
}
