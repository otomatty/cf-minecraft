import assert from "node:assert/strict";
import { test } from "node:test";
import { appendChatInput, appendChatLine, CHAT_VISIBLE_MS, formatChatLine, limitChatInput, recallChatInput, visibleChatLines, type ChatInputRecall, type ChatLine, type TimedChatLine } from "./chat.ts";

test("chat formats messages and presence lines as literal text", () => {
	const sender = "<b>名前</b>";
	assert.equal(formatChatLine({ kind: 0, sender, text: "<img src=x>" }), "<<b>名前</b>> <img src=x>");
	assert.equal(formatChatLine({ kind: 1, sender, text: "ignored" }), "<b>名前</b> が参加しました");
	assert.equal(formatChatLine({ kind: 2, sender, text: "" }), "<b>名前</b> が退出しました");
});

test("chat formats command results as literal text", () => {
	const sender = "<b>名前</b>";
	const text = "<img src=x>";
	assert.equal(formatChatLine({ kind: 3, sender: "", text }), text);
	assert.equal(formatChatLine({ kind: 4, sender, text }), "* <b>名前</b> <img src=x>");
	assert.equal(formatChatLine({ kind: 5, sender, text }), "<b>名前</b> からのささやき: <img src=x>");
	assert.equal(formatChatLine({ kind: 6, sender, text }), "<b>名前</b> へのささやき: <img src=x>");
});

test("chat input history retains the newest fifty submissions including commands", () => {
	let history: string[] = [];
	for (let i = 0; i < 55; i++) {
		history = appendChatInput(history, i % 2 === 0 ? `/me ${i}` : `message ${i}`);
	}
	assert.equal(history.length, 50);
	assert.equal(history[0], "message 5");
	assert.equal(history[49], "/me 54");
});

test("chat input history navigates both ways and restores the draft", () => {
	const history = ["hello", "/help"];
	let recall: ChatInputRecall | null = null;
	let value = "/unfinished";
	const move = (direction: -1 | 1) => {
		const next = recallChatInput(history, recall, value, direction);
		if (next) ({ recall, value } = next);
		return next?.value;
	};
	assert.equal(recallChatInput([], null, value, -1), null);
	assert.equal(move(1), undefined);
	assert.equal(move(-1), "/help");
	value = "edited history entry";
	assert.equal(move(-1), "hello");
	assert.equal(move(-1), undefined);
	assert.equal(move(1), "/help");
	assert.equal(move(1), "/unfinished");
	assert.equal(recall, null);
	assert.equal(move(1), undefined);
	value = "";
	assert.equal(move(-1), "/help");
	assert.equal(move(1), "");
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
