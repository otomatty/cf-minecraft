import assert from "node:assert/strict";
import { test } from "node:test";
import { appendChatLine, CHAT_VISIBLE_MS, formatChatLine, limitChatInput, visibleChatLines, type ChatLine, type TimedChatLine } from "./chat.ts";

test("chat formats messages and presence lines as literal text", () => {
	const sender = "<b>名前</b>";
	assert.equal(formatChatLine({ kind: 0, sender, text: "<img src=x>" }), "<<b>名前</b>> <img src=x>");
	assert.equal(formatChatLine({ kind: 1, sender, text: "ignored" }), "<b>名前</b> が参加しました");
	assert.equal(formatChatLine({ kind: 2, sender, text: "" }), "<b>名前</b> が退出しました");
});

test("chat retains the newest fifty lines and shows expired lines only with input open", () => {
	let history: TimedChatLine[] = [];
	for (let i = 0; i < 55; i++) {
		const line: ChatLine = { kind: 0, sender: "あなた", text: String(i) };
		history = appendChatLine(history, line, i);
	}
	assert.deepEqual(history.map(({ line }) => line.text), Array.from({ length: 50 }, (_, i) => String(i + 5)));
	assert.deepEqual(visibleChatLines(history, true, CHAT_VISIBLE_MS + 54), history);
	assert.deepEqual(visibleChatLines(history, false, CHAT_VISIBLE_MS + 53), [history[49]]);
	assert.deepEqual(visibleChatLines(history, false, CHAT_VISIBLE_MS + 54), []);
});

test("chat input counts Unicode code points without cutting surrogate pairs", () => {
	assert.equal(limitChatInput(""), "");
	assert.equal(limitChatInput("hello あ🙂"), "hello あ🙂");
	assert.equal(limitChatInput("a".repeat(257)), "a".repeat(256));
	const text = "あ🙂".repeat(128);
	assert.equal(limitChatInput(text + "🙂"), text);
});
