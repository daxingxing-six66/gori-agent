import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { DeploymentDiscussion, DeploymentRun } from "./deployment";

export type ConversationHistoryEntry =
	| { kind: "message"; entry: ChatTimelineEntry }
	| { kind: "discussion"; discussion: DeploymentDiscussion }
	| { kind: "deployment"; run: DeploymentRun; messages: ChatTimelineEntry[] };

export interface DeploymentHistoryState {
	runs: DeploymentRun[];
	/** undefined means that the first page has not loaded; null means that every page has loaded. */
	nextCursor: string | null | undefined;
}

export const emptyDeploymentHistory = (): DeploymentHistoryState => ({ runs: [], nextCursor: undefined });

export function deploymentHistoryTime(run: DeploymentRun): number {
	return run.createdAt;
}

export function mergeDeploymentHistory(preferred: DeploymentRun[], other: DeploymentRun[]): DeploymentRun[] {
	const byId = new Map<string, DeploymentRun>();
	for (const run of [...preferred, ...other]) {
		const current = byId.get(run.id);
		if (!current || current.updatedAt < run.updatedAt) byId.set(run.id, run);
	}
	return [...byId.values()].sort((left, right) => deploymentHistoryTime(right) - deploymentHistoryTime(left) || right.id.localeCompare(left.id));
}

export function addDeploymentHistoryRun(history: DeploymentHistoryState, run: DeploymentRun): DeploymentHistoryState {
	return { ...history, runs: mergeDeploymentHistory(history.runs, [run]) };
}

export function applyDeploymentHistoryPage(
	history: DeploymentHistoryState,
	page: { runs: DeploymentRun[]; nextCursor: string | null },
	requestedCursor?: string,
): DeploymentHistoryState {
	return {
		runs: mergeDeploymentHistory(page.runs, history.runs),
		nextCursor: requestedCursor === undefined
			? history.nextCursor === undefined ? page.nextCursor : history.nextCursor
			: history.nextCursor === requestedCursor ? page.nextCursor : history.nextCursor,
	};
}

/** Deployment snapshots are projected into the conversation, without changing Agent messages. */
export function conversationHistory(messages: ChatTimelineEntry[], deployments: DeploymentRun[], discussion?: DeploymentDiscussion | null): ConversationHistoryEntry[] {
	const deploymentByAgentRun = new Map<string, string | null>();
	const completionMessages = new Set<ChatTimelineEntry>();
	for (const run of deployments) {
		for (const agentRunId of [run.planningAgentRunId, ...(run.agentRunHistory ?? []), run.agentRunId]) {
			if (!agentRunId) continue;
			// Keep ambiguous/corrupt links visible as ordinary Chat messages.
			const existing = deploymentByAgentRun.get(agentRunId);
			deploymentByAgentRun.set(agentRunId, existing === undefined || existing === run.id ? run.id : null);
		}
		if (run.status !== "success" || !run.agentRunId) continue;
		// The execution Run's final answer belongs to the conversation. Earlier
		// tool calls and progress messages remain with the deployment record.
		const summary = messages.find((entry) => entry.runId === run.agentRunId && entry.final &&
			entry.message.role === "assistant" && entry.message.stopReason === "stop" &&
			entry.message.content.some((part) => part.type === "text" && part.text.trim().length > 0) &&
			!entry.message.content.some((part) => part.type === "toolCall"));
		if (summary) completionMessages.add(summary);
	}
	const grouped = new Map<string, ChatTimelineEntry[]>();
	const ungrouped: ChatTimelineEntry[] = [];
	for (const entry of messages) {
		if (entry.message.role === "system") continue;
		const deploymentId = entry.runId ? deploymentByAgentRun.get(entry.runId) : undefined;
		if (!deploymentId || completionMessages.has(entry)) {
			ungrouped.push(entry);
			continue;
		}
		const entries = grouped.get(deploymentId) ?? [];
		entries.push(entry);
		grouped.set(deploymentId, entries);
	}
	const entries = [
		...(discussion ? [{
			at: discussion.createdAt,
			order: -1,
			value: { kind: "discussion", discussion } as const,
		}] : []),
		...ungrouped.map((entry, order) => ({
			at: entry.message.timestamp,
			order,
			value: { kind: "message", entry } as const,
		})),
		...deployments.map((run, index) => ({
			at: deploymentHistoryTime(run),
			order: messages.length + index,
			value: { kind: "deployment", run, messages: grouped.get(run.id) ?? [] } as const,
		})),
	];
	return entries.sort((left, right) => left.at - right.at || left.order - right.order).map(({ value }) => value);
}
