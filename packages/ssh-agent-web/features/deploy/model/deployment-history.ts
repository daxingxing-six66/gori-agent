import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { DeploymentDiscussion, DeploymentRun } from "./deployment";
import { deploymentEntrySummary, deploymentFinishedAt, deploymentMessageIdentity, deploymentMessageResult, type ConversationHistoryEntry } from "./deployment-history-entry";

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

interface TimedEntry { at: number; value: ConversationHistoryEntry }

/** New finished messages use their durable finish sequence; old records use finish-time fallback. */
export function conversationHistory(messages: ChatTimelineEntry[], deployments: DeploymentRun[], discussion?: DeploymentDiscussion | null): ConversationHistoryEntry[] {
	const runs = new Map(deployments.map((run) => [run.id, run]));
	const { entries, deferred, formalIds } = collectConversationEntries(messages, runs);
	for (const run of deployments) {
		if (!formalIds.has(run.id)) deferred.push({ at: deploymentFinishedAt(run) ?? run.createdAt, value: { kind: "deployment", run } });
	}
	if (discussion && !formalIds.has(discussion.id) && !runs.has(discussion.id))
		deferred.push({ at: discussion.createdAt, value: { kind: "discussion", discussion } });
	return insertTimedEntries(entries, deferred);
}

function collectConversationEntries(messages: ChatTimelineEntry[], runs: Map<string, DeploymentRun>) {
	const formalIds = new Set<string>();
	const entries: ConversationHistoryEntry[] = [];
	const deferred: TimedEntry[] = [];
	const ordered = messages.every((entry) => entry.sequence === undefined)
		? [...messages].sort((a, b) => a.message.timestamp - b.message.timestamp) : messages;
	for (const entry of ordered) {
		if (entry.message.role === "system") continue;
		const identity = deploymentMessageIdentity(entry);
		if (!identity) { entries.push({ kind: "message", entry }); continue; }
		formalIds.add(identity.deploymentId);
		const run = runs.get(identity.deploymentId);
		const value: ConversationHistoryEntry = { kind: "deploymentMessage", entry, ...identity, run };
		const metadata = deploymentMessageResult(entry);
		const at = metadata?.position === "legacy_finished" ? metadata.finishedAt : !metadata ? deploymentFinishedAt(run) : undefined;
		if (at === undefined) entries.push(value);
		else deferred.push({ at, value });
	}
	return { entries, deferred, formalIds };
}

function insertTimedEntries(entries: ConversationHistoryEntry[], deferred: TimedEntry[]): ConversationHistoryEntry[] {
	for (const { at, value } of deferred.sort((a, b) => a.at - b.at)) {
		const finished = value.kind !== "message" && deploymentEntrySummary(value).finishedAt !== undefined;
		const index = entries.findIndex((entry) => {
			if (entry.kind !== "message" && entry.kind !== "deploymentMessage") return false;
			return finished ? entry.entry.message.timestamp > at : entry.entry.message.timestamp >= at;
		});
		entries.splice(index < 0 ? entries.length : index, 0, value);
	}
	return entries;
}
