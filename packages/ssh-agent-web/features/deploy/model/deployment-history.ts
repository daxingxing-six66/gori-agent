import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { DeploymentDiscussion, DeploymentRun } from "./deployment";

export type ConversationHistoryEntry =
	| { kind: "message"; entry: ChatTimelineEntry }
	| { kind: "deploymentMessage"; entry: ChatTimelineEntry; deploymentId: string; title: string; run?: DeploymentRun }
	| { kind: "discussion"; discussion: DeploymentDiscussion }
	| { kind: "deployment"; run: DeploymentRun };

export interface DeploymentHistoryState {
	runs: DeploymentRun[];
	/** undefined means that the first page has not loaded; null means that every page has loaded. */
	nextCursor: string | null | undefined;
}

export const emptyDeploymentHistory = (): DeploymentHistoryState => ({ runs: [], nextCursor: undefined });

export function newestDeploymentRun(first?: DeploymentRun | null, second?: DeploymentRun | null): DeploymentRun | null {
	if (!first) return second ?? null;
	if (!second || first.updatedAt >= second.updatedAt) return first;
	return second;
}

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

/** Formal entries retain Chat sequence order; only legacy records need a timestamp fallback. */
export function conversationHistory(messages: ChatTimelineEntry[], deployments: DeploymentRun[], discussion?: DeploymentDiscussion | null): ConversationHistoryEntry[] {
	const formalIds = new Set<string>();
	const ordered = messages.every((entry) => entry.sequence === undefined) ? [...messages].sort((a, b) => a.message.timestamp - b.message.timestamp) : messages;
	const entries: ConversationHistoryEntry[] = ordered.filter((entry) => entry.message.role !== "system").map((entry) => {
		const message = entry.message;
		if (message.role === "custom" && message.customType === "deployment" && message.details && typeof message.details === "object" &&
			"deploymentId" in message.details && typeof message.details.deploymentId === "string" &&
			"title" in message.details && typeof message.details.title === "string") {
			const deploymentId = message.details.deploymentId;
			const title = message.details.title;
			formalIds.add(deploymentId);
			return { kind: "deploymentMessage", entry, deploymentId, title, run: deployments.find((run) => run.id === deploymentId) };
		}
		return { kind: "message", entry };
	});
	const legacy: { at: number; value: ConversationHistoryEntry }[] = deployments.filter((run) => !formalIds.has(run.id)).map((run) => ({
		at: run.createdAt, value: { kind: "deployment", run },
	}));
	if (discussion && !formalIds.has(discussion.id)) legacy.push({ at: discussion.createdAt, value: { kind: "discussion", discussion } });
	for (const item of legacy.sort((a, b) => a.at - b.at)) {
		const index = entries.findIndex((entry) => (entry.kind === "message" || entry.kind === "deploymentMessage") && entry.entry.message.timestamp >= item.at);
		entries.splice(index < 0 ? entries.length : index, 0, item.value);
	}
	return entries;
}
