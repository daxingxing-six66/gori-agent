import { isRecord, type AssistantMessage, type ChatToolExecution } from "@/features/chat/model/chat";
import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import { deploymentEntryId, deploymentEntrySummary, type ConversationHistoryEntry, type DeploymentConversationEntry } from "./deployment-history-entry";

type Replacements = Map<string, DeploymentConversationEntry>;

/** UI-only substitution. Persisted messages, tool results and cancellation keep their original meaning. */
export function deploymentCompletionHistory(entries: ConversationHistoryEntry[], tools: Record<string, ChatToolExecution>): ConversationHistoryEntry[] {
	const replacements = finishReplacements(entries, tools);
	if (replacements.size === 0) return entries;
	const replacedIds = new Set([...replacements.values()].map(deploymentEntryId));
	const emittedIds = new Set<string>();
	return entries.flatMap((entry): ConversationHistoryEntry[] => {
		if (entry.kind !== "message") return replacedIds.has(deploymentEntryId(entry)) ? [] : [entry];
		const source = entry.entry;
		if (!source.final || source.message.role !== "assistant" || !hasReplacement(source.message, replacements)) return [entry];
		return replaceAssistantFinish(source, source.message, replacements, emittedIds);
	});
}

function finishReplacements(entries: ConversationHistoryEntry[], tools: Record<string, ChatToolExecution>): Replacements {
	const cards = new Map<string, DeploymentConversationEntry>();
	for (const entry of entries) if (entry.kind !== "message") cards.set(deploymentEntryId(entry), entry);
	const replacements: Replacements = new Map();
	for (const entry of entries) {
		if (entry.kind !== "message" || !entry.entry.final || entry.entry.message.role !== "assistant") continue;
		for (const part of entry.entry.message.content) {
			if (part.type !== "toolCall" || part.name !== "deployment_finish") continue;
			const result = completedFinish(tools[part.id]);
			if (!result || part.arguments.outcome !== result.outcome) continue;
			const card = cards.get(result.deploymentId);
			if (card && deploymentEntrySummary(card).status === result.outcome) replacements.set(part.id, card);
		}
	}
	return replacements;
}

function hasReplacement(message: AssistantMessage, replacements: Replacements): boolean {
	return message.content.some((part) => part.type === "toolCall" && replacements.has(part.id));
}

function replaceAssistantFinish(source: ChatTimelineEntry, message: AssistantMessage, replacements: Replacements, emittedIds: Set<string>): ConversationHistoryEntry[] {
	const projected: ConversationHistoryEntry[] = [];
	let content: AssistantMessage["content"] = [];
	const flush = () => {
		if (content.length === 0) return;
		projected.push({ kind: "message", entry: {
			...source, key: `${source.key}:content:${projected.length}`,
			message: { ...message, content, failure: undefined, errorMessage: undefined },
		} });
		content = [];
	};
	for (const part of message.content) {
		const card = part.type === "toolCall" ? replacements.get(part.id) : undefined;
		if (!card) { content.push(part); continue; }
		flush();
		const id = deploymentEntryId(card);
		if (!emittedIds.has(id)) { projected.push(card); emittedIds.add(id); }
	}
	flush();
	// Keep the original Assistant failure once, at its original boundary.
	if (message.failure || message.errorMessage) projected.push({ kind: "message", entry: {
		...source, key: `${source.key}:failure`, message: { ...message, content: [] },
	} });
	return projected;
}

function completedFinish(execution?: ChatToolExecution): { deploymentId: string; outcome: "success" | "failed" } | undefined {
	if (execution?.toolName !== "deployment_finish" || execution.status !== "completed" || execution.isError) return undefined;
	// SSE contains AgentToolResult; restored history contains its content blocks.
	// Parse individual blocks rather than joining text: extra runtime notes are not JSON.
	const content = isRecord(execution.result) ? execution.result.content : execution.result;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		let value: unknown;
		try { value = JSON.parse(block.text); } catch { continue; }
		if (isRecord(value) && typeof value.deploymentId === "string" && value.deploymentId.length > 0 && value.deploymentMode === false &&
			(value.outcome === "success" || value.outcome === "failed")) return { deploymentId: value.deploymentId, outcome: value.outcome };
	}
	return undefined;
}
