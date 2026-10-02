import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { DeploymentRun } from "./deployment";

export type ConversationHistoryEntry =
	| { kind: "message"; entry: ChatTimelineEntry }
	| { kind: "deployment"; run: DeploymentRun };

export interface DeploymentHistoryState {
	runs: DeploymentRun[];
	/** undefined means that the first page has not loaded; null means that every page has loaded. */
	nextCursor: string | null | undefined;
}

export const emptyDeploymentHistory = (): DeploymentHistoryState => ({ runs: [], nextCursor: undefined });

export function deploymentHistoryTime(run: DeploymentRun): number {
	return run.startedAt ?? run.stages.build.startedAt ?? run.createdAt;
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
export function conversationHistory(messages: ChatTimelineEntry[], deployments: DeploymentRun[]): ConversationHistoryEntry[] {
	const entries = [
		...messages.filter((entry) => entry.message.role !== "system").map((entry, order) => ({
			at: entry.message.timestamp,
			order,
			value: { kind: "message", entry } as const,
		})),
		...deployments.map((run, index) => ({
			at: deploymentHistoryTime(run),
			order: messages.length + index,
			value: { kind: "deployment", run } as const,
		})),
	];
	return entries.sort((left, right) => left.at - right.at || left.order - right.order).map(({ value }) => value);
}
