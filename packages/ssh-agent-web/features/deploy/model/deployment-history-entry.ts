import { isRecord } from "@/features/chat/model/chat";
import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { DeploymentDiscussion, DeploymentRun } from "./deployment";

export type DeploymentConversationEntry =
	| { kind: "deploymentMessage"; entry: ChatTimelineEntry; deploymentId: string; title: string; run?: DeploymentRun }
	| { kind: "discussion"; discussion: DeploymentDiscussion }
	| { kind: "deployment"; run: DeploymentRun };
export type ConversationHistoryEntry = { kind: "message"; entry: ChatTimelineEntry } | DeploymentConversationEntry;
export type DeploymentHistoryStatus = DeploymentRun["status"] | "discussing";
interface DeploymentMessageResult {
	outcome: "success" | "failed" | "cancelled";
	finishedAt: number;
	startedAt?: number;
	position?: string;
}

export function deploymentMessageIdentity(entry: ChatTimelineEntry): { deploymentId: string; title: string } | undefined {
	const details = deploymentMessageDetails(entry);
	if (details && typeof details.deploymentId === "string" && typeof details.title === "string")
		return { deploymentId: details.deploymentId, title: details.title };
	return undefined;
}

export function deploymentMessageResult(entry: ChatTimelineEntry): DeploymentMessageResult | undefined {
	const details = deploymentMessageDetails(entry);
	if (!details || (details.outcome !== "success" && details.outcome !== "failed" && details.outcome !== "cancelled") || !timestamp(details.finishedAt)) return undefined;
	return {
		outcome: details.outcome,
		finishedAt: details.finishedAt,
		...(timestamp(details.startedAt) ? { startedAt: details.startedAt } : {}),
		...(typeof details.position === "string" ? { position: details.position } : {}),
	};
}

export function deploymentFinishedAt(run?: DeploymentRun): number | undefined {
	return run && ["success", "failed", "cancelled"].includes(run.status) ? run.finishedAt : undefined;
}

export function deploymentEntryId(entry: DeploymentConversationEntry): string {
	switch (entry.kind) {
		case "deploymentMessage": return entry.deploymentId;
		case "discussion": return entry.discussion.id;
		case "deployment": return entry.run.id;
	}
}

/** One projection for card presentation and finish-tool matching, including legacy records. */
export function deploymentEntrySummary(entry: DeploymentConversationEntry): {
	title: string; status: DeploymentHistoryStatus; startedAt?: number; finishedAt?: number;
} {
	if (entry.kind === "discussion") return { title: entry.discussion.module.name, status: "discussing", startedAt: entry.discussion.createdAt };
	const run = entry.run;
	const result = entry.kind === "deploymentMessage" ? deploymentMessageResult(entry.entry) : undefined;
	return {
		title: entry.kind === "deploymentMessage" ? entry.title : entry.run.plan.module.name,
		status: result?.outcome ?? run?.status ?? (entry.kind === "deploymentMessage" ? deploymentMessageStatus(entry.entry) : undefined) ?? "discussing",
		startedAt: result?.startedAt ?? run?.startedAt ?? run?.createdAt,
		finishedAt: result?.finishedAt ?? deploymentFinishedAt(run),
	};
}

function deploymentMessageStatus(entry: ChatTimelineEntry): DeploymentHistoryStatus | undefined {
	const status = deploymentMessageDetails(entry)?.status;
	return status === "preparing" || status === "running" || status === "recovering" || status === "success" ||
		status === "failed" || status === "cancelled" || status === "discussing" ? status : undefined;
}

function deploymentMessageDetails(entry: ChatTimelineEntry): Record<string, unknown> | undefined {
	const message = entry.message;
	return message.role === "custom" && message.customType === "deployment" && isRecord(message.details) ? message.details : undefined;
}
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
