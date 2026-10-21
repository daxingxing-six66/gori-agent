"use client";

import { LoaderCircle } from "lucide-react";
import { memo } from "react";
import { useIntl } from "react-intl";
import { ChatFailureDetails } from "@/features/chat/components/chat-failure-details";
import { ChatMessageRow } from "@/features/chat/components/chat-message";
import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { ChatRun, ChatToolExecution, ToolApproval } from "@/features/chat/model/chat";
import { conversationHistory } from "@/features/chat/model/conversation-history";
import { DeploymentHistoryCard } from "@/features/deploy/components/deployment-history-card";
import { deploymentEntryId } from "@/features/deploy/model/deployment-history-entry";
import { deploymentCompletionHistory } from "@/features/deploy/model/deployment-completion-history";
import { DiagnoseHistoryCard } from "@/features/diagnose/components/diagnose-history-card";
import { diagnoseCompletionHistory } from "@/features/diagnose/model/diagnose-completion-history";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";

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
	onOpenDeployment,
	onOpenFile,
	onOpenAttachment,
	onOpenDiagnose,
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
	onOpenDeployment?(id: string): void;
	onOpenFile?(path: string): void;
	onOpenAttachment?(attachment: SessionAttachment): void;
	onOpenDiagnose?(id: string): void;
}) {
	const intl = useIntl();
	const entries = loading ? [] : diagnoseCompletionHistory(deploymentCompletionHistory(conversationHistory(timeline), tools), tools);
	return (
		<div className="chat-timeline min-h-full [&>*+*]:mt-8 [&>.chat-tool-only+.chat-tool-only]:mt-1">
			{loading ? <div className="flex justify-center py-16 text-zinc-400"><LoaderCircle size={18} className="animate-spin" /></div> : null}
			{loadingOlderMessages ? <div className="flex justify-center py-1.5 text-zinc-400" role="status" aria-label={intl.formatMessage({ id: "chat.history.loadingOlder" })}><LoaderCircle size={14} className="animate-spin" /></div> : null}
			{!loading && !showActivity && entries.length === 0 ? <div className="grid min-h-[320px] place-items-center text-center"><div><p className="text-[13px] font-semibold text-zinc-700">{intl.formatMessage({ id: "chat.empty.title" })}</p><p className="mt-2 text-[10px] leading-5 text-zinc-400">{intl.formatMessage({ id: "chat.empty.description" })}</p></div></div> : null}
			{entries.map((item) => {
				if (item.kind === "diagnoseMessage") return <DiagnoseHistoryCard key={item.entry.key} identity={item} onOpen={() => onOpenDiagnose?.(item.taskId)} />;
				if (item.kind === "message") return <ChatMessageRow key={item.entry.key} entry={item.entry} tools={tools} approvals={approvals} approvalMutationId={approvalMutationId} targetHost={targetHost} hideFailure={Boolean(run?.status === "failed" && run.failure?.errorId && item.entry.message.role === "assistant" && item.entry.message.failure?.errorId === run.failure.errorId)} onResolveApproval={onResolveApproval} onOpenFile={onOpenFile} onOpenAttachment={onOpenAttachment} />;
				return <DeploymentHistoryCard key={`deployment:${deploymentEntryId(item)}`} entry={item} onOpen={() => onOpenDeployment?.(deploymentEntryId(item))} />;
			})}
			{showActivity ? <div role="status" aria-label={intl.formatMessage({ id: "chat.status.running" })} className="flex h-9 w-full items-center justify-center gap-1 text-[var(--text-secondary)]">
				{[0, 160, 320].map((delay) => <span key={delay} aria-hidden="true" className="h-1 w-1 rounded-full bg-current motion-safe:animate-pulse" style={{ animationDelay: `${delay}ms`, animationDuration: "1.2s" }} />)}
			</div> : null}
			{run?.status === "failed" ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[10px] text-rose-700"><p className="font-semibold">{intl.formatMessage({ id: "chat.run.failed" })}</p><ChatFailureDetails failure={run.failure} fallback={intl.formatMessage({ id: "chat.run.failed.fallback" })} />{run.failure?.retryable && latestUserText ? <button type="button" className="mt-2 font-semibold underline" onClick={() => onRestoreDraft(latestUserText)}>{intl.formatMessage({ id: "chat.run.restoreDraft" })}</button> : null}</div> : null}
		</div>
	);
});
