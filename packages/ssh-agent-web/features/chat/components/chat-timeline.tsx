"use client";

import { LoaderCircle } from "lucide-react";
import { memo, type ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChatFailureDetails } from "@/features/chat/components/chat-failure-details";
import { ChatMessageRow } from "@/features/chat/components/chat-message";
import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { ChatRun, ChatToolExecution, ToolApproval } from "@/features/chat/model/chat";
import { DeploymentHistoryCard } from "@/features/deploy/components/deployment-history-card";
import { DeploymentModelActivity } from "@/features/deploy/components/deployment-model-activity";
import { conversationHistory } from "@/features/deploy/model/deployment-history";
import type { DeploymentDiscussion, DeploymentRun } from "@/features/deploy/model/deployment";

export const ChatTimeline = memo(function ChatTimeline({
	showActivity,
	loading,
	loadingOlderMessages,
	timeline,
	tools,
	approvals,
	approvalMutationId,
	targetHost,
	run,
	latestUserText,
	onResolveApproval,
	onRestoreDraft,
	deployments,
	discussion,
	discussionPanel,
	expandedDeploymentId,
	expandedDeployment,
	onOpenDeployment,
	hasOlderMessages,
	hasOlderDeployments,
	loadingOlderDeployments,
	onLoadOlderDeployments,
}: {
	showActivity: boolean;
	loading: boolean;
	loadingOlderMessages: boolean;
	timeline: ChatTimelineEntry[];
	tools: Record<string, ChatToolExecution>;
	approvals: Record<string, ToolApproval>;
	approvalMutationId: string | null;
	targetHost?: string;
	run: ChatRun | null;
	latestUserText: string;
	onResolveApproval(approval: ToolApproval, approved: boolean): void;
	onRestoreDraft(message: string): void;
	deployments?: DeploymentRun[];
	discussion?: DeploymentDiscussion | null;
	discussionPanel?: ReactNode;
	expandedDeploymentId?: string | null;
	expandedDeployment?: ((activity: ReactNode) => ReactNode) | null;
	onOpenDeployment?(id: string): void;
	hasOlderMessages?: boolean;
	hasOlderDeployments?: boolean;
	loadingOlderDeployments?: boolean;
	onLoadOlderDeployments?(): void;
}) {
	const intl = useIntl();
	const entries = conversationHistory(timeline, deployments ?? [], discussion);
	const runInsideDeployment = Boolean(run && deployments?.some((deployment) =>
		deployment.agentRunId === run.id || deployment.planningAgentRunId === run.id));
	return (
		<div className="mx-auto min-h-full max-w-[820px] px-5 pb-10 pt-10 [&>*+*]:mt-8 [&>.chat-tool-only+.chat-tool-only]:mt-1 lg:px-8">
			{loading ? <div className="flex justify-center py-16 text-zinc-400"><LoaderCircle size={18} className="animate-spin" /></div> : null}
			{hasOlderDeployments ? <button type="button" disabled={loadingOlderDeployments} onClick={onLoadOlderDeployments} className="mx-auto block rounded-lg border border-line px-3 py-1.5 text-xs text-secondary hover:bg-surface-hover disabled:opacity-50">{intl.formatMessage({ id: loadingOlderDeployments ? "deploy.history.loadingOlder" : "deploy.history.loadOlder" })}</button> : null}
			{loadingOlderMessages ? <div className="flex justify-center py-1.5 text-zinc-400" role="status" aria-label={intl.formatMessage({ id: "chat.history.loadingOlder" })}><LoaderCircle size={14} className="animate-spin" /></div> : null}
			{!loading && !showActivity && entries.length === 0 ? <div className="grid min-h-[320px] place-items-center text-center"><div><p className="text-[13px] font-semibold text-zinc-700">{intl.formatMessage({ id: "chat.empty.title" })}</p><p className="mt-2 text-[10px] leading-5 text-zinc-400">{intl.formatMessage({ id: "chat.empty.description" })}</p></div></div> : null}
			{entries.map((item) => {
				if (item.kind === "message") return <ChatMessageRow key={item.entry.key} entry={item.entry} tools={tools} approvals={approvals} approvalMutationId={approvalMutationId} targetHost={targetHost} hideFailure={Boolean(run?.status === "failed" && run.failure?.errorId && item.entry.message.role === "assistant" && item.entry.message.failure?.errorId === run.failure.errorId)} onResolveApproval={onResolveApproval} />;
				if (item.kind === "discussion") return <div key={`discussion:${item.discussion.id}`} data-deployment-discussion-id={item.discussion.id}>{discussionPanel}</div>;
				const expanded = expandedDeploymentId === item.run.id;
				const activity = <DeploymentModelActivity entries={item.messages} tools={tools} approvals={approvals} approvalMutationId={approvalMutationId} targetHost={targetHost} onResolveApproval={onResolveApproval} expanded={expanded} hasOlderMessages={Boolean(hasOlderMessages)} />;
				return <div key={`deployment:${item.run.id}`} data-deployment-id={item.run.id}>
					{expanded ? expandedDeployment?.(activity) : <DeploymentHistoryCard run={item.run} onOpen={() => onOpenDeployment?.(item.run.id)} actions={activity} />}
				</div>;
			})}
			{showActivity ? <div role="status" aria-label={intl.formatMessage({ id: "chat.status.running" })} className="flex h-9 w-full items-center justify-center gap-1 text-[var(--text-secondary)]">
				{[0, 160, 320].map((delay) => <span key={delay} aria-hidden="true" className="h-1 w-1 rounded-full bg-current motion-safe:animate-pulse" style={{ animationDelay: `${delay}ms`, animationDuration: "1.2s" }} />)}
			</div> : null}
			{run?.status === "failed" && !runInsideDeployment ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[10px] text-rose-700"><p className="font-semibold">{intl.formatMessage({ id: "chat.run.failed" })}</p><ChatFailureDetails failure={run.failure} fallback={intl.formatMessage({ id: "chat.run.failed.fallback" })} />{run.failure?.retryable && latestUserText ? <button type="button" className="mt-2 font-semibold underline" onClick={() => onRestoreDraft(latestUserText)}>{intl.formatMessage({ id: "chat.run.restoreDraft" })}</button> : null}</div> : null}
		</div>
	);
});
