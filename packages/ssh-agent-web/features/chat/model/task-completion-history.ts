import { isRecord, type AssistantMessage, type ChatToolExecution, type ToolCallContent } from "./chat";
import type { ChatTimelineEntry } from "./chat-runtime-state";

interface CompletionHistoryAdapter<Entry> {
	message(entry: Entry): ChatTimelineEntry | undefined;
	cardId(entry: Entry): string | undefined;
	wrapMessage(entry: ChatTimelineEntry): Entry;
	match(tool: ToolCallContent, execution: ChatToolExecution | undefined, cards: ReadonlyMap<string, Entry>): Entry | undefined;
}

/** Replace verified completion tools with their durable cards without changing the original transcript. */
export function taskCompletionHistory<Entry>(entries: Entry[], tools: Record<string, ChatToolExecution>, adapter: CompletionHistoryAdapter<Entry>): Entry[] {
	const cards = new Map<string, Entry>();
	for (const entry of entries) { const id = adapter.cardId(entry); if (id !== undefined) cards.set(id, entry); }
	const replacements = new Map<string, Entry>();
	for (const entry of entries) {
		const source = adapter.message(entry);
		if (!source?.final || source.message.role !== "assistant") continue;
		for (const part of source.message.content) {
			if (part.type !== "toolCall") continue;
			const card = adapter.match(part, tools[part.id], cards);
			if (card !== undefined && adapter.cardId(card) !== undefined) replacements.set(part.id, card);
		}
	}
	if (replacements.size === 0) return entries;
	const replacedIds = new Set([...replacements.values()].map((entry) => adapter.cardId(entry)));
	const emittedIds = new Set<string>();
	return entries.flatMap((entry): Entry[] => {
		const id = adapter.cardId(entry);
		if (id !== undefined) return replacedIds.has(id) ? [] : [entry];
		const source = adapter.message(entry);
		if (!source?.final || source.message.role !== "assistant" ||
			!source.message.content.some((part) => part.type === "toolCall" && replacements.has(part.id))) return [entry];
		return replaceAssistantTools(source, source.message, replacements, emittedIds, adapter);
	});
}

function replaceAssistantTools<Entry>(source: ChatTimelineEntry, message: AssistantMessage, replacements: ReadonlyMap<string, Entry>, emittedIds: Set<string>, adapter: CompletionHistoryAdapter<Entry>): Entry[] {
	const projected: Entry[] = [];
	let content: AssistantMessage["content"] = [];
	const flush = () => {
		if (content.length === 0) return;
		projected.push(adapter.wrapMessage({ ...source, key: `${source.key}:content:${projected.length}`,
			message: { ...message, content, failure: undefined, errorMessage: undefined } }));
		content = [];
	};
	for (const part of message.content) {
		const card = part.type === "toolCall" ? replacements.get(part.id) : undefined;
		if (card === undefined) { content.push(part); continue; }
		flush();
		const id = adapter.cardId(card);
		if (id !== undefined && !emittedIds.has(id)) { projected.push(card); emittedIds.add(id); }
	}
	flush();
	// Keep an Assistant failure once, at the original end of its content.
	if (message.failure || message.errorMessage) projected.push(adapter.wrapMessage({
		...source, key: `${source.key}:failure`, message: { ...message, content: [] },
	}));
	return projected;
}

/** Live SSE carries AgentToolResult; restored history carries content blocks. Do not join runtime notes into JSON. */
export function completedToolResultObjects(execution: ChatToolExecution | undefined, toolName: string): Record<string, unknown>[] {
	if (execution?.toolName !== toolName || execution.status !== "completed" || execution.isError) return [];
	const content = isRecord(execution.result) ? execution.result.content : execution.result;
	if (!Array.isArray(content)) return [];
	return content.flatMap((block): Record<string, unknown>[] => {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return [];
		try { const value: unknown = JSON.parse(block.text); return isRecord(value) ? [value] : []; } catch { return []; }
	});
}
