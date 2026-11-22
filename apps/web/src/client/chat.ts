export interface ChatLine {
	kind: 0 | 1 | 2 | 3 | 4 | 5 | 6;
	sender: string;
	text: string;
}

export interface TimedChatLine {
	line: ChatLine;
	receivedAt: number;
}

export interface ChatInputRecall {
	index: number;
	draft: string;
}

export const CHAT_VISIBLE_MS = 10_000;
const CHAT_HISTORY_LIMIT = 50;
const CHAT_INPUT_HISTORY_LIMIT = 50;
const CHAT_INPUT_LIMIT = 256;

export function formatChatLine({ kind, sender, text }: ChatLine): string {
	switch (kind) {
		case 0: return `<${sender}> ${text}`;
		case 1: return `${sender} が参加しました`;
		case 2: return `${sender} が退出しました`;
		case 3: return text;
		case 4: return `* ${sender} ${text}`;
		case 5: return `${sender} からのささやき: ${text}`;
		case 6: return `${sender} へのささやき: ${text}`;
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

export function appendChatInput(history: readonly string[], text: string): string[] {
	return [...history.slice(-(CHAT_INPUT_HISTORY_LIMIT - 1)), text];
}

export function recallChatInput(history: readonly string[], recall: ChatInputRecall | null, current: string, direction: -1 | 1): { recall: ChatInputRecall | null; value: string } | null {
	const index = (recall?.index ?? history.length) + direction;
	if (index < 0 || index > history.length) return null;
	if (index === history.length && recall) return { recall: null, value: recall.draft };
	return { recall: { index, draft: recall?.draft ?? current }, value: history[index] };
}
